import { withTenant, type TenantContext } from '@superwork/db'
import { env } from '@superwork/config'
import { loadActor, type Actor } from '@superwork/auth'
import {
  applyTriage,
  detectInjection,
  getMeeting,
  listConversations,
  listMessages,
  listParticipants,
  listSegments,
  logInteraction,
  proposeCommitment,
  recordDecision,
  record as recordUsageRecord,
  relationship360,
  seriesContext,
  writeActivity,
  type ConversationView,
} from '@superwork/core'
import { completeWithFallback, resolveDueHint, type MeetingSummary, type TriageResult } from '@superwork/ai'
import { insertRun, markUntrusted, recordMessage, recordStep, saveReport, setRunStatus } from '../persistence.js'
import type { RunSession } from '../runtime.js'

/**
 * Services behind the Inbox, Meetings and CRM screens.
 *
 * Each opens a real agent run so its cost, steps and outputs are auditable in the same
 * place as everything else. None of them creates a task directly: action items become
 * *proposals* that a person accepts, and task creation goes through the ordinary
 * plan → approval → undo path so it stays reversible.
 */

async function openRun(
  session: RunSession,
  input: { request: string; route: string; principalUserId?: string; trigger?: string },
): Promise<string> {
  return withTenant(session, async (ctx) => {
    const [org] = await ctx.sql<{ is_demo: boolean }[]>`
      SELECT is_demo FROM organizations WHERE id = ${ctx.organizationId}`
    const runId = await insertRun(ctx, {
      principalUserId: input.principalUserId ?? session.userId,
      agentId: null,
      mode: 'assist',
      request: input.request,
      uiContext: { route: input.route },
      trigger: input.trigger ?? 'user',
      budget: { maxSteps: 12, maxToolCalls: 0, maxCostCents: 10, maxWallClockMs: 60_000 },
      aiMode: env().AI_MODE,
      isDemo: org?.is_demo ?? false,
    })
    await setRunStatus(ctx, runId, 'running')
    return runId
  })
}

// ---------------------------------------------------------------------------
// Inbox triage
// ---------------------------------------------------------------------------

export interface TriageOutcome {
  runId: string
  classified: number
  commitmentsProposed: number
  flagged: number
  costCents: number
  results: { conversationId: string; subject: string; category: string; priority: string; reason: string }[]
}

/**
 * Classifies untriaged conversations and proposes any commitments found in them.
 * Classification is a cheap-model job done in one pass per thread, not a full agent run
 * per message (§26.5).
 */
export async function triageInbox(
  session: RunSession,
  options: { conversationIds?: string[]; limit?: number } = {},
): Promise<TriageOutcome> {
  const runId = await openRun(session, { request: 'Triage the inbox', route: '/inbox' })

  const targets = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    if (options.conversationIds?.length) {
      const all = await listConversations(ctx, actor, { view: 'all', limit: 200 })
      return all.filter((c) => options.conversationIds!.includes(c.id))
    }
    const queue = await listConversations(ctx, actor, { view: 'queue', limit: options.limit ?? 25 })
    return queue.filter((c) => !c.triagedAt)
  })

  const results: TriageOutcome['results'] = []
  let commitmentsProposed = 0
  let flagged = 0
  let costCents = 0

  for (const conversation of targets) {
    const detail = await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const messages = await listMessages(ctx, actor, conversation.id)
      return { messages, last: messages[messages.length - 1] ?? null }
    })
    if (!detail.last) continue
    if (detail.last.injectionFlagged) flagged += 1

    const response = await completeWithFallback({
      taskClass: 'inbox.classify',
      system: 'Classify this conversation for an operations queue. Output the structured result only.',
      blocks: [
        {
          zone: 'external',
          trust: 'untrusted_external',
          label: `Last message in "${conversation.subject}"`,
          text: detail.last.body.slice(0, 2000),
          sourceId: detail.last.id,
        },
      ],
      userMessage: `Classify "${conversation.subject}".`,
      grounding: {
        conversation: {
          subject: conversation.subject,
          lastMessage: detail.last.body.slice(0, 2000),
          lastDirection: detail.last.direction,
          daysWaiting: conversation.daysWaiting,
          slaDays: conversation.slaDays,
          companyName: conversation.companyName,
          injectionFlagged: detail.last.injectionFlagged,
        },
      },
    })

    const triage = response.json as TriageResult
    costCents += response.usage?.costCents ?? 0

    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await applyTriage(ctx, actor, {
        conversationId: conversation.id,
        category: triage.category,
        priority: triage.priority,
        sentiment: triage.sentiment,
        agentRunId: runId,
      })
      // This call reached the run's totals and never reached metering, so triage spend was
      // invisible to the cap it counted against.
      if (response.usage) {
        await recordMessage(ctx, runId, {
          taskClass: 'inbox.classify',
          content: JSON.stringify(triage),
          simulated: response.simulated,
          usage: response.usage,
        })
      }
    })

    results.push({
      conversationId: conversation.id,
      subject: conversation.subject,
      category: triage.category,
      priority: triage.priority,
      reason: triage.reason,
    })

    commitmentsProposed += await proposeCommitmentsFromConversation(session, conversation, runId)
  }

  await withTenant(session, async (ctx) => {
    await recordStep(ctx, runId, {
      ordinal: 0,
      phase: 'act',
      label: `Classified ${results.length} ${results.length === 1 ? 'conversation' : 'conversations'}`,
      status: 'succeeded',
      detail: { flagged, commitmentsProposed },
    })
    await saveReport(ctx, runId, {
      narrative:
        `${results.length} ${results.length === 1 ? 'conversation' : 'conversations'} classified` +
        (commitmentsProposed ? `, ${commitmentsProposed} possible commitments proposed for confirmation` : '') +
        (flagged ? `. ${flagged} contained content aimed at me and were routed to a person.` : '.'),
      outcome: { created: 0, updated: results.length, drafted: 0, sent: 0, skipped: [], failed: [] },
      citations: [],
      needsAttention: [],
      undoable: false,
      degraded: null,
      simulated: env().AI_MODE !== 'live',
      injectionWarnings: [],
    })
    await setRunStatus(ctx, runId, 'succeeded')
    // Counts the run. Its cost is on the per-call message rows; carrying it here as well
    // is what doubled month-to-date spend (ADR 0040).
    await recordUsageRecord(ctx, { unit: 'agent_run', quantity: 1, costCents: 0, agentRunId: runId })
  })

  return { runId, classified: results.length, commitmentsProposed, flagged, costCents, results }
}

async function proposeCommitmentsFromConversation(
  session: RunSession,
  conversation: ConversationView,
  runId: string,
): Promise<number> {
  const messages = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    return listMessages(ctx, actor, conversation.id)
  })

  let proposed = 0
  for (const message of messages.slice(-3)) {
    // Never mine an injected message for promises.
    if (message.injectionFlagged) continue

    const response = await completeWithFallback({
      taskClass: 'inbox.extract_commitments',
      system:
        'Identify explicit promises in this message. A promise needs an actor and an obligation. ' +
        'Do not infer intent from politeness.',
      blocks: [
        {
          zone: 'external',
          trust: 'untrusted_external',
          label: 'Message body',
          text: message.body.slice(0, 3000),
          sourceId: message.id,
        },
      ],
      userMessage: 'Extract commitments.',
      grounding: { text: message.body },
    })

    const detected = (response.json as { commitments?: { obligation: string; direction: 'we_owe' | 'they_owe'; dueHint: string | null; confidence: number; excerpt: string }[] })?.commitments ?? []

    for (const item of detected) {
      // Ours if we sent the message; theirs if they did — direction is grounded in who
      // actually spoke, not in the model's reading of the pronoun alone.
      const direction = message.direction === 'outbound' ? item.direction : flip(item.direction)

      await withTenant(session, async (ctx) => {
        const actor = await loadActor(ctx)
        await proposeCommitment(ctx, actor, {
          obligation: item.obligation,
          direction,
          ownerUserId: direction === 'we_owe' ? conversation.ownerId : null,
          companyId: conversation.companyId,
          dueAt: resolveDueHint(item.dueHint, message.sentAt),
          confidence: item.confidence,
          sourceMessageId: message.id,
          sourceExcerpt: item.excerpt,
          agentRunId: runId,
        })
        if (response.usage) {
          await recordMessage(ctx, runId, {
            taskClass: 'inbox.extract_commitments',
            content: JSON.stringify(item),
            simulated: response.simulated,
            usage: response.usage,
          })
        }
      })
      proposed += 1
    }
  }
  return proposed
}

function flip(direction: 'we_owe' | 'they_owe'): 'we_owe' | 'they_owe' {
  return direction === 'we_owe' ? 'they_owe' : 'we_owe'
}

// ---------------------------------------------------------------------------
// Meeting summarization
// ---------------------------------------------------------------------------

export interface MeetingOutcome {
  runId: string
  summary: string
  decisionsRecorded: number
  actionItemsProposed: number
  commitmentsProposed: number
  sentiment: string
  openQuestions: { question: string; anchor: string }[]
  risks: { risk: string; anchor: string }[]
  actionItems: {
    title: string
    ownerName: string | null
    mentionedOwner: string | null
    direction: 'we_owe' | 'they_owe'
    dueHint: string | null
    anchor: string
    segmentId: string
  }[]
  /** Moments in the transcript that tried to instruct the assistant (§5.9.6). */
  injectionWarnings: { anchor: string; speaker: string; patterns: string[] }[]
  costCents: number
}

/**
 * Turns a transcript into a summary, a decision log and *proposed* action items.
 * Nothing here creates a task — action items are offered for review, and accepting them
 * runs through the ordinary plan → approval path so the result stays undoable (§12.5).
 */
export async function summarizeMeetingRun(session: RunSession, meetingId: string): Promise<MeetingOutcome> {
  const runId = await openRun(session, { request: 'Summarize the meeting', route: `/meetings/${meetingId}` })

  const context = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const meeting = await getMeeting(ctx, actor, meetingId)
    const segments = await listSegments(ctx, meetingId)
    const participants = await listParticipants(ctx, meetingId)
    const series = meeting.seriesId ? await seriesContext(ctx, meeting.seriesId) : null
    return { meeting, segments, participants, series }
  })

  // A transcript records whoever was in the room, so a line spoken (or pasted in) by an
  // outside participant is untrusted external content. A segment that carries an
  // instruction is reported and is not allowed to originate a decision or a commitment —
  // it stays in the record, but it cannot put work on anybody's plate (§5.9.6).
  const flaggedSegmentIds = new Set<string>()
  const injectionWarnings: MeetingOutcome['injectionWarnings'] = []
  for (const segment of context.segments) {
    if (segment.speakerUserId) continue
    const findings = detectInjection(segment.text)
    if (findings.length === 0) continue
    flaggedSegmentIds.add(segment.id)
    injectionWarnings.push({
      anchor: segment.anchor,
      speaker: segment.speaker,
      patterns: findings.map((f) => f.pattern),
    })
  }
  const trustedSegments = context.segments.filter((segment) => !flaggedSegmentIds.has(segment.id))

  if (context.segments.length === 0) {
    await withTenant(session, (ctx) =>
      setRunStatus(ctx, runId, 'failed', {
        failureClass: 'not_found',
        failureDetail: 'This meeting has no transcript to summarize.',
      }),
    )
    throw new Error('This meeting has no transcript yet. Attach one first.')
  }

  const response = await completeWithFallback({
    taskClass: 'meeting.summarize',
    system:
      'Summarize this meeting. Record decisions, action items, open questions and risks, each anchored ' +
      'to the transcript segment it came from. Do not invent an owner or a date that was not said.',
    blocks: trustedSegments.slice(0, 200).map((segment) => ({
      zone: 'external' as const,
      trust: segment.speakerUserId ? ('org_data' as const) : ('untrusted_external' as const),
      label: `${segment.anchor} ${segment.speaker}`,
      text: segment.text,
      sourceId: segment.id,
    })),
    userMessage: `Summarize "${context.meeting.title}".`,
    grounding: {
      meeting: {
        title: context.meeting.title,
        segments: trustedSegments.map((s) => ({
          ordinal: s.ordinal,
          speaker: s.speaker,
          startsAtSeconds: s.startsAtSeconds,
          text: s.text,
          anchor: s.anchor,
        })),
        participants: context.participants.map((p) => p.displayName),
        internalParticipants: context.participants.filter((p) => p.userId).map((p) => p.displayName),
        seriesContext: context.series
          ? { occurrences: context.series.occurrences, deferrals: context.series.deferrals }
          : null,
      },
    },
  })

  const summary = response.json as MeetingSummary
  const segmentByOrdinal = new Map(context.segments.map((s) => [s.ordinal, s]))

  const outcome = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)

    // The summary itself is a note on the meeting, so it appears in the timeline.
    await ctx.sql`
      INSERT INTO notes (organization_id, entity_type, entity_id, body, actor_type, agent_run_id, created_by)
      VALUES (${ctx.organizationId}, 'meeting', ${meetingId}, ${summary.summary}, 'agent', ${runId}, ${session.userId})`

    let decisionsRecorded = 0
    for (const decision of summary.decisions) {
      const segment = segmentByOrdinal.get(decision.segmentOrdinal)
      await recordDecision(ctx, actor, {
        summary: decision.summary,
        rationale: decision.rationale,
        meetingId,
        projectId: context.meeting.projectId,
        status: decision.status,
        sourceSegmentId: segment?.id ?? null,
        confidence: decision.confidence,
        agentRunId: runId,
      })
      decisionsRecorded += 1
    }

    let commitmentsProposed = 0
    for (const item of summary.actionItems) {
      const segment = segmentByOrdinal.get(item.segmentOrdinal)
      const owner = context.participants.find((p) => p.displayName === item.ownerHint && p.userId)
      await proposeCommitment(ctx, actor, {
        obligation: item.title,
        // An external participant undertaking something is *their* commitment to us.
        direction: item.speakerIsInternal ? 'we_owe' : 'they_owe',
        ownerUserId: owner?.userId ?? null,
        companyId: context.meeting.companyId,
        dueAt: resolveDueHint(item.dueHint, context.meeting.startsAt),
        confidence: item.confidence,
        sourceSegmentId: segment?.id ?? null,
        sourceExcerpt: segment?.text.slice(0, 300) ?? null,
        agentRunId: runId,
      })
      commitmentsProposed += 1
    }

    if (context.meeting.companyId) {
      await logInteraction(ctx, actor, {
        companyId: context.meeting.companyId,
        kind: 'meeting',
        summary: `${context.meeting.title}: ${summary.summary.slice(0, 200)}`,
        occurredAt: context.meeting.startsAt,
        sourceType: 'meeting',
        sourceId: meetingId,
        agentRunId: runId,
      })
    }

    if (response.usage) {
      await recordMessage(ctx, runId, {
        taskClass: 'meeting.summarize',
        content: summary.summary,
        simulated: response.simulated,
        usage: response.usage,
      })
    }

    await recordStep(ctx, runId, {
      ordinal: 0,
      phase: 'act',
      label:
        injectionWarnings.length > 0
          ? `Read ${trustedSegments.length} transcript segments and set aside ${injectionWarnings.length} that carried instructions`
          : `Read ${context.segments.length} transcript segments`,
      status: 'succeeded',
    })
    if (injectionWarnings.length > 0) {
      await markUntrusted(
        ctx,
        runId,
        injectionWarnings.map((warning) => ({
          sourceId: warning.anchor,
          label: `${warning.speaker} at ${warning.anchor}`,
          patterns: warning.patterns,
        })),
        true,
      )
    }
    await recordStep(ctx, runId, {
      ordinal: 1,
      phase: 'report',
      label: `Recorded ${decisionsRecorded} decisions and proposed ${commitmentsProposed} action items`,
      status: 'succeeded',
    })
    await saveReport(ctx, runId, {
      narrative: summary.summary,
      outcome: { created: decisionsRecorded, updated: 0, drafted: 0, sent: 0, skipped: [], failed: [] },
      citations: [],
      needsAttention: [],
      undoable: false,
      degraded: response.degraded,
      simulated: response.simulated,
      injectionWarnings: injectionWarnings.map((warning) => ({
        sourceId: warning.anchor,
        label: `${warning.speaker} at ${warning.anchor}`,
        patterns: warning.patterns,
      })),
    })
    await setRunStatus(ctx, runId, 'succeeded')

    await writeActivity(ctx, {
      actorType: 'agent',
      actorUserId: session.userId,
      actorLabel: 'Superwork',
      verb: 'summarized',
      entityType: 'meeting',
      entityId: meetingId,
      entityLabel: context.meeting.title,
      summary: `Summarized "${context.meeting.title}". ${decisionsRecorded} decisions recorded, ${commitmentsProposed} action items proposed for confirmation. No tasks were created.`,
      agentRunId: runId,
    })

    return { decisionsRecorded, commitmentsProposed }
  })

  return {
    runId,
    summary: summary.summary,
    decisionsRecorded: outcome.decisionsRecorded,
    actionItemsProposed: summary.actionItems.length,
    commitmentsProposed: outcome.commitmentsProposed,
    sentiment: summary.sentiment,
    openQuestions: summary.openQuestions.map((q) => ({
      question: q.question,
      anchor: segmentByOrdinal.get(q.segmentOrdinal)?.anchor ?? '',
    })),
    risks: summary.risks.map((r) => ({
      risk: r.risk,
      anchor: segmentByOrdinal.get(r.segmentOrdinal)?.anchor ?? '',
    })),
    actionItems: summary.actionItems.map((item) => {
      const segment = segmentByOrdinal.get(item.segmentOrdinal)
      return {
        title: item.title,
        ownerName: item.ownerHint,
        mentionedOwner: item.mentionedOwner,
        direction: item.speakerIsInternal ? ('we_owe' as const) : ('they_owe' as const),
        dueHint: item.dueHint,
        anchor: segment?.anchor ?? '',
        segmentId: segment?.id ?? '',
      }
    }),
    injectionWarnings,
    costCents: response.usage?.costCents ?? 0,
  }
}

// ---------------------------------------------------------------------------
// CRM 360° narration
// ---------------------------------------------------------------------------

export interface AccountSummary {
  runId: string
  narrative: string
  nextBestAction: string | null
  facts: { claim: string; sourceType: string; sourceId: string | null }[]
  risks: string[]
  costCents: number
  simulated: boolean
}

export async function narrateAccount(session: RunSession, companyId: string): Promise<AccountSummary> {
  const runId = await openRun(session, { request: 'Summarize the account', route: `/companies/${companyId}` })

  const view = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    return relationship360(ctx, actor, companyId)
  })

  const nextBestAction =
    view.openThreads.some((t) => t.pastSla)
      ? `Reply to the ${view.openThreads.filter((t) => t.pastSla).length} thread(s) past SLA.`
      : view.commitmentsWeOwe.some((c) => c.dueAt && c.dueAt.getTime() < Date.now())
        ? 'Close out the commitment we are late on.'
        : view.risks.length > 0
          ? view.risks[0]!
          : null

  const response = await completeWithFallback({
    taskClass: 'crm.summary',
    system:
      'Narrate this account from the supplied facts only. Every sentence must correspond to a supplied ' +
      'fact. Do not add commercial judgement the facts do not support.',
    blocks: [
      {
        zone: 'task_context',
        trust: 'org_data',
        label: `Facts about ${view.company.name}`,
        data: view.facts,
      },
    ],
    userMessage: `Summarize the relationship with ${view.company.name}.`,
    grounding: {
      account: {
        companyName: view.company.name,
        facts: view.facts.map((f) => ({ claim: f.claim })),
        risks: view.risks,
        openThreads: view.openThreads.length,
        weOwe: view.commitmentsWeOwe.length,
        theyOwe: view.commitmentsTheyOwe.length,
        nextBestAction,
      },
    },
  })

  const narrated = response.json as { text: string; nextBestAction: string | null }

  await withTenant(session, async (ctx) => {
    if (response.usage) {
      await recordMessage(ctx, runId, {
        taskClass: 'crm.summary',
        content: narrated.text,
        simulated: response.simulated,
        usage: response.usage,
      })
    }
    // Each claim is cited back to the row it came from.
    let ordinal = 0
    for (const fact of view.facts) {
      await ctx.sql`
        INSERT INTO citations (organization_id, run_id, claim, source_type, source_id, anchor, ordinal, created_by)
        VALUES (${ctx.organizationId}, ${runId}, ${fact.claim}, ${fact.sourceType},
                ${isUuid(fact.sourceId) ? fact.sourceId : null}, ${fact.sourceType}, ${ordinal}, ${session.userId})`
      ordinal += 1
    }
    await recordStep(ctx, runId, {
      ordinal: 0,
      phase: 'report',
      label: `Assembled ${view.facts.length} cited facts about ${view.company.name}`,
      status: 'succeeded',
    })
    await saveReport(ctx, runId, {
      narrative: narrated.text,
      outcome: { created: 0, updated: 0, drafted: 0, sent: 0, skipped: [], failed: [] },
      citations: view.facts.map((f) => ({ claim: f.claim, sourceType: f.sourceType, sourceId: f.sourceId })),
      needsAttention: [],
      undoable: false,
      degraded: response.degraded,
      simulated: response.simulated,
      injectionWarnings: [],
    })
    await setRunStatus(ctx, runId, 'succeeded')
  })

  return {
    runId,
    narrative: narrated.text,
    nextBestAction: narrated.nextBestAction ?? nextBestAction,
    facts: view.facts.map((f) => ({ claim: f.claim, sourceType: f.sourceType, sourceId: f.sourceId })),
    risks: view.risks,
    costCents: response.usage?.costCents ?? 0,
    simulated: response.simulated,
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

export type { Actor, TenantContext }
