import { withTenant, asJson, type TenantContext } from '@superwork/db'
import { env } from '@superwork/config'
import { loadActor, type Actor } from '@superwork/auth'
import {
  composeBriefingFacts,
  pickRecommendation,
  startOfDay,
  formatInZone,
  type BriefingFacts,
  type BriefingKind,
  type Recommendation,
} from '@superwork/core'
import { completeWithFallback, type BriefingGrounding } from '@superwork/ai'
import { insertRun, saveReport, setRunStatus, recordStep, recordMessage } from './persistence.js'
import type { RunSession } from './runtime.js'

/**
 * Daily briefing and end-of-day summary (§9.4).
 *
 * The scaffold is deterministic and the numbers come from SQL; the model writes only the
 * connective prose. The computed `facts` are stored alongside the narrative, so any
 * briefing can be re-checked against the database that produced it — which is exactly
 * what the accuracy test does.
 */

export interface BriefingView {
  id: string
  kind: BriefingKind
  localDate: string
  timezone: string
  narrative: string
  facts: BriefingFacts
  recommendation: Recommendation | null
  citations: { label: string; route: string; count: number }[]
  generatedAt: Date
  readAt: Date | null
  costCents: number
  simulated: boolean
}

export interface GenerateOptions {
  kind?: BriefingKind
  /** Regenerate even if one already exists for this local date. */
  force?: boolean
  now?: Date
}

export async function generateBriefing(
  session: RunSession,
  targetUserId: string,
  options: GenerateOptions = {},
): Promise<BriefingView> {
  const kind = options.kind ?? 'daily'
  const now = options.now ?? new Date()

  const prepared = await withTenant({ ...session, userId: targetUserId }, async (ctx) => {
    const actor = await loadActor(ctx, targetUserId)
    const existing = await findExisting(ctx, targetUserId, kind, now)
    if (existing && !options.force) return { existing, actor, facts: null, runId: null }

    const facts = await composeBriefingFacts(ctx, actor, kind, now)
    const runId = await insertRun(ctx, {
      principalUserId: targetUserId,
      agentId: null,
      mode: 'ask',
      request: kind === 'daily' ? 'Daily briefing' : 'End-of-day summary',
      uiContext: { route: '/briefing', kind },
      trigger: 'schedule',
      budget: { maxSteps: 4, maxToolCalls: 0, maxCostCents: 5, maxWallClockMs: 30_000 },
      aiMode: env().AI_MODE,
      isDemo: await isDemoOrg(ctx),
    })
    await setRunStatus(ctx, runId, 'running')
    await recordStep(ctx, runId, {
      ordinal: 0,
      phase: 'ground',
      label: describeFacts(facts),
      status: 'succeeded',
      detail: { counts: facts.counts },
    })
    return { existing: null, actor, facts, runId }
  })

  if (prepared.existing) return prepared.existing

  const facts = prepared.facts!
  const runId = prepared.runId!
  const recommendation = pickRecommendation(facts)

  const grounding: BriefingGrounding = {
    kind: facts.kind,
    userName: facts.userName,
    timezone: facts.timezone,
    basis: facts.basis,
    counts: facts.counts as unknown as Record<string, number>,
    meetings: facts.meetings.map((m) => ({ title: m.title, localTime: m.localTime, minutes: m.minutes })),
    overdue: facts.overdue.map((t) => ({ title: t.title, daysOverdue: t.daysOverdue })),
    approvals: facts.approvals.map((a) => ({ title: a.title, hoursWaiting: a.hoursWaiting })),
    commitments: facts.commitments.map((c) => ({ obligation: c.obligation, companyName: c.companyName })),
    blockingOthers: facts.blockingOthers.map((b) => ({ title: b.title, waitingCount: b.waitingCount })),
    staleThreads: facts.staleThreads.map((s) => ({ companyName: s.companyName, daysWaiting: s.daysWaiting })),
    completedToday: facts.completedToday.map((t) => ({ title: t.title })),
    slippedToday: facts.slippedToday.map((t) => ({ title: t.title, daysOverdue: t.daysOverdue })),
    agentActions: facts.agentActions.map((a) => ({ summary: a.summary, costCents: a.costCents })),
    recommendation: { headline: recommendation.headline, why: recommendation.why },
  }

  const response = await completeWithFallback({
    taskClass: 'briefing.narrative',
    system: BRIEFING_SYSTEM,
    blocks: [
      {
        zone: 'task_context',
        trust: 'org_data',
        label: 'Computed figures — the only numbers you may state',
        data: facts.counts,
      },
    ],
    userMessage:
      kind === 'daily'
        ? 'Write the morning briefing from these figures.'
        : 'Write the end-of-day summary from these figures.',
    grounding: { briefing: grounding as unknown as Record<string, unknown> },
  })

  const narrative = String((response.json as { text?: string })?.text ?? response.text).trim()

  return withTenant({ ...session, userId: targetUserId }, async (ctx) => {
    if (response.usage) {
      // `ctx.userId` is the briefing's subject here, so the metering row is attributed to
      // them exactly as it was when it was written by hand.
      await recordMessage(ctx, runId, {
        taskClass: 'briefing.narrative',
        content: narrative,
        simulated: response.simulated,
        usage: response.usage,
      })
    }

    const citations = buildCitations(facts)

    const [row] = await ctx.sql<{ id: string }[]>`
      INSERT INTO briefings (
        organization_id, user_id, kind, local_date, timezone, facts, narrative,
        recommendation, citations, agent_run_id, cost_cents, simulated, is_demo, created_by
      ) VALUES (
        ${ctx.organizationId}, ${targetUserId}, ${kind}, ${facts.localDate}, ${facts.timezone},
        ${ctx.sql.json(asJson(facts))}, ${narrative}, ${ctx.sql.json(asJson(recommendation))}, ${ctx.sql.json(asJson(citations))},
        ${runId}, ${response.usage?.costCents ?? 0}, ${response.simulated},
        ${await isDemoOrg(ctx)}, ${targetUserId}
      )
      ON CONFLICT (organization_id, user_id, kind, local_date) WHERE deleted_at IS NULL
      DO UPDATE SET facts = EXCLUDED.facts, narrative = EXCLUDED.narrative,
                    recommendation = EXCLUDED.recommendation, citations = EXCLUDED.citations,
                    agent_run_id = EXCLUDED.agent_run_id, generated_at = now(),
                    cost_cents = EXCLUDED.cost_cents, simulated = EXCLUDED.simulated
      RETURNING id`

    await recordStep(ctx, runId, {
      ordinal: 1,
      phase: 'report',
      label: 'Wrote the briefing from the computed figures',
      status: 'succeeded',
    })
    await saveReport(ctx, runId, {
      narrative,
      outcome: { created: 0, updated: 0, drafted: 0, sent: 0, skipped: [], failed: [] },
      citations: [],
      needsAttention: [],
      undoable: false,
      degraded: response.degraded,
      simulated: response.simulated,
      injectionWarnings: [],
    })
    await setRunStatus(ctx, runId, 'succeeded')

    return {
      id: row!.id,
      kind,
      localDate: facts.localDate,
      timezone: facts.timezone,
      narrative,
      facts,
      recommendation,
      citations,
      generatedAt: new Date(),
      readAt: null,
      costCents: response.usage?.costCents ?? 0,
      simulated: response.simulated,
    }
  })
}

const BRIEFING_SYSTEM = `You write a short operational briefing.

RULES
1. Every number you state must already appear in the supplied figures. Never add, total,
   estimate or infer a figure. If a count is zero, say so plainly rather than omitting it.
2. Do not invent an item that is not in the supplied lists.
3. Plain verbs, sentence case, no exclamation marks. Do not open with a greeting beyond
   the person's first name.
4. Close with the supplied recommendation, unchanged in meaning.`

async function findExisting(
  ctx: TenantContext,
  userId: string,
  kind: BriefingKind,
  now: Date,
): Promise<BriefingView | null> {
  const localDate = localDateFor(now, ctx.timezone)
  const [row] = await ctx.sql<
    {
      id: string
      kind: BriefingKind
      local_date: string
      timezone: string
      narrative: string
      facts: BriefingFacts
      recommendation: Recommendation | null
      citations: BriefingView['citations']
      generated_at: Date
      read_at: Date | null
      cost_cents: string
      simulated: boolean
    }[]
  >`
    SELECT id, kind, local_date::text, timezone, narrative, facts, recommendation, citations,
           generated_at, read_at, cost_cents::text, simulated
    FROM briefings
    WHERE organization_id = ${ctx.organizationId} AND user_id = ${userId}
      AND kind = ${kind} AND local_date = ${localDate} AND deleted_at IS NULL`
  if (!row) return null

  return {
    id: row.id,
    kind: row.kind,
    localDate: row.local_date,
    timezone: row.timezone,
    narrative: row.narrative,
    facts: row.facts,
    recommendation: row.recommendation,
    citations: row.citations,
    generatedAt: row.generated_at,
    readAt: row.read_at,
    costCents: Number(row.cost_cents),
    simulated: row.simulated,
  }
}

export async function latestBriefing(
  ctx: TenantContext,
  userId: string,
  kind: BriefingKind = 'daily',
  now = new Date(),
): Promise<BriefingView | null> {
  return findExisting(ctx, userId, kind, now)
}

export async function markBriefingRead(ctx: TenantContext, id: string): Promise<void> {
  await ctx.sql`
    UPDATE briefings SET read_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${id} AND read_at IS NULL`
}

/**
 * Generates briefings for everyone who wants one, spread rather than fired at once —
 * 100,000 briefings at 08:00 local is a thundering herd (§26.5).
 */
export async function generateDueBriefings(
  session: RunSession,
  now = new Date(),
): Promise<{ generated: number; skipped: number }> {
  const recipients = await withTenant(session, async (ctx) => {
    return ctx.sql<{ user_id: string; timezone: string; briefing_hour: number; end_of_day_hour: number }[]>`
      SELECT m.user_id, u.timezone,
             coalesce(np.briefing_hour, 8) AS briefing_hour,
             coalesce(np.end_of_day_hour, 17) AS end_of_day_hour
      FROM memberships m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN notification_preferences np
        ON np.user_id = m.user_id AND np.organization_id = m.organization_id AND np.deleted_at IS NULL
      WHERE m.organization_id = ${ctx.organizationId} AND m.deleted_at IS NULL AND m.status = 'active'
        AND coalesce(np.briefing_enabled, true)`
  })

  let generated = 0
  let skipped = 0

  for (const recipient of recipients) {
    const localHour = Number(formatInZone(now, recipient.timezone, { hour: '2-digit', hour12: false }))
    const kind: BriefingKind | null =
      localHour >= recipient.briefing_hour && localHour < recipient.end_of_day_hour
        ? 'daily'
        : localHour >= recipient.end_of_day_hour
          ? 'end_of_day'
          : null

    if (!kind) {
      skipped += 1
      continue
    }

    const before = await withTenant({ ...session, userId: recipient.user_id, timezone: recipient.timezone }, (ctx) =>
      findExisting(ctx, recipient.user_id, kind, now),
    )
    if (before) {
      skipped += 1
      continue
    }

    await generateBriefing({ ...session, timezone: recipient.timezone }, recipient.user_id, { kind, now })
    generated += 1
  }

  return { generated, skipped }
}

function localDateFor(now: Date, timezone: string): string {
  const start = startOfDay(now, timezone)
  return formatInZone(start, timezone, { year: 'numeric', month: '2-digit', day: '2-digit' })
    .split('/')
    .reverse()
    .join('-')
}

function describeFacts(facts: BriefingFacts): string {
  const parts: string[] = []
  if (facts.counts.meetings) parts.push(`${facts.counts.meetings} meetings`)
  if (facts.counts.dueToday) parts.push(`${facts.counts.dueToday} due today`)
  if (facts.counts.overdue) parts.push(`${facts.counts.overdue} overdue`)
  if (facts.counts.approvals) parts.push(`${facts.counts.approvals} approvals`)
  if (facts.counts.staleThreads) parts.push(`${facts.counts.staleThreads} stale threads`)
  return parts.length ? `Computed ${parts.join(', ')}` : 'Computed the day — nothing outstanding'
}

/** Each figure drills through to the rows behind it (§9.4). */
function buildCitations(facts: BriefingFacts): BriefingView['citations'] {
  const citations: BriefingView['citations'] = []
  if (facts.counts.meetings) citations.push({ label: 'Meetings today', route: '/meetings', count: facts.counts.meetings })
  if (facts.counts.dueToday) citations.push({ label: 'Due today', route: '/tasks?filter=today', count: facts.counts.dueToday })
  if (facts.counts.overdue) citations.push({ label: 'Overdue', route: '/tasks?filter=overdue', count: facts.counts.overdue })
  if (facts.counts.approvals) citations.push({ label: 'Approvals', route: '/approvals', count: facts.counts.approvals })
  if (facts.counts.commitmentsDue) citations.push({ label: 'Commitments', route: '/commitments', count: facts.counts.commitmentsDue })
  if (facts.counts.staleThreads) citations.push({ label: 'Inbox', route: '/inbox', count: facts.counts.staleThreads })
  if (facts.counts.insights) citations.push({ label: 'Insights', route: '/insights', count: facts.counts.insights })
  return citations
}

async function isDemoOrg(ctx: TenantContext): Promise<boolean> {
  const [row] = await ctx.sql<{ is_demo: boolean }[]>`
    SELECT is_demo FROM organizations WHERE id = ${ctx.organizationId}`
  return row?.is_demo ?? false
}

export type { BriefingFacts, BriefingKind, Recommendation }
export type LoadedActor = Actor
