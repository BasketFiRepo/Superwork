import { z } from 'zod'
import {
  archiveConversation,
  getConversation,
  listCommitments,
  listConversations,
  listDecisions,
  listMeetings,
  listSegments,
  logInteraction,
  proposeCommitment,
  relationship360,
  snoozeConversation,
  markWaitingFor,
  type PreviewLine,
} from '@superwork/core'
import { register, type ToolContext } from '../registry.js'

/** Inbox, meetings and CRM tools (§6.3). */

export const listThreads = register({
  name: 'list_threads@v1',
  description:
    'List conversations from the inbox queue with their triage classification and how long each has been waiting. Use it before proposing follow-ups.',
  inputSchema: z.object({
    view: z.enum(['queue', 'mine', 'waiting', 'snoozed', 'archived', 'all']).default('queue'),
    category: z.enum(['needs_reply', 'needs_action', 'waiting_on_others', 'fyi', 'urgent', 'spam']).optional(),
    companyId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  outputSchema: z.object({
    threads: z.array(
      z.object({
        id: z.string(),
        subject: z.string(),
        companyName: z.string().nullable(),
        category: z.string().nullable(),
        priority: z.string().nullable(),
        daysWaiting: z.number(),
        pastSla: z.boolean(),
        hasFlaggedContent: z.boolean(),
      }),
    ),
  }),
  riskTier: 'read' as const,
  requiredPermissions: ['conversation:read:org'],
  reversible: true,
  rateLimit: { perRun: 10, perOrgPerHour: 2000 },
  timeoutMs: 8000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    const threads = await listConversations(ctx.tenantDb, ctx.policy, {
      view: input.view,
      ...(input.category ? { category: input.category } : {}),
      ...(input.companyId ? { companyId: input.companyId } : {}),
      limit: input.limit,
    })
    return {
      ok: true as const,
      value: {
        threads: threads.map((t) => ({
          id: t.id,
          subject: t.subject,
          companyName: t.companyName,
          category: t.category,
          priority: t.priority,
          daysWaiting: t.daysWaiting,
          pastSla: t.pastSla,
          hasFlaggedContent: t.hasFlaggedContent,
        })),
      },
    }
  },
})

export const snoozeThread = register({
  name: 'snooze_thread@v1',
  description: 'Snooze a conversation so it leaves the queue and returns later. Reversible.',
  inputSchema: z.object({ conversationId: z.string().uuid(), hours: z.number().int().min(1).max(24 * 30).default(24) }),
  outputSchema: z.object({ id: z.string(), until: z.string() }),
  riskTier: 'low' as const,
  requiredPermissions: ['conversation:update:org'],
  reversible: true,
  inverse: 'unsnooze_thread@v1',
  rateLimit: { perRun: 25, perOrgPerHour: 1000 },
  timeoutMs: 5000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    const until = new Date(Date.now() + input.hours * 3600_000)
    await snoozeConversation(ctx.tenantDb, ctx.policy, input.conversationId, until, ctx.agentRunId)
    return { ok: true as const, value: { id: input.conversationId, until: until.toISOString() } }
  },
  buildUndo(input) {
    return {
      tool: 'unsnooze_thread@v1',
      input: { conversationId: input.conversationId },
      entityType: 'conversation',
      entityId: input.conversationId,
      description: 'Return the thread to the queue',
    }
  },
})

export const unsnoozeThread = register({
  name: 'unsnooze_thread@v1',
  description: 'Return a snoozed conversation to the queue. Inverse of snooze_thread.',
  inputSchema: z.object({ conversationId: z.string().uuid() }),
  outputSchema: z.object({ id: z.string() }),
  riskTier: 'low' as const,
  requiredPermissions: ['conversation:update:org'],
  reversible: false,
  rateLimit: { perRun: 25, perOrgPerHour: 1000 },
  timeoutMs: 5000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    await ctx.tenantDb.sql`
      UPDATE conversations SET snoozed_until = NULL
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.conversationId}`
    return { ok: true as const, value: { id: input.conversationId } }
  },
})

export const archiveThread = register({
  name: 'archive_thread@v1',
  description: 'Archive a conversation once it needs nothing further. Reversible.',
  inputSchema: z.object({ conversationId: z.string().uuid() }),
  outputSchema: z.object({ id: z.string(), subject: z.string() }),
  riskTier: 'low' as const,
  requiredPermissions: ['conversation:update:org'],
  reversible: true,
  inverse: 'unarchive_thread@v1',
  rateLimit: { perRun: 30, perOrgPerHour: 1000 },
  timeoutMs: 5000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    const conversation = await getConversation(ctx.tenantDb, ctx.policy, input.conversationId)
    await archiveConversation(ctx.tenantDb, ctx.policy, input.conversationId, ctx.agentRunId)
    return { ok: true as const, value: { id: input.conversationId, subject: conversation.subject } }
  },
  async preview(input, ctx: ToolContext): Promise<PreviewLine[]> {
    const conversation = await getConversation(ctx.tenantDb, ctx.policy, input.conversationId)
    return [
      {
        operation: 'Archive thread',
        entityType: 'conversation',
        entityLabel: conversation.subject,
        changes: [{ field: 'Leaves the queue', to: 'yes' }],
        riskTier: 'low',
        reversible: true,
      },
    ]
  },
  buildUndo(input, output) {
    return {
      tool: 'unarchive_thread@v1',
      input: { conversationId: input.conversationId },
      entityType: 'conversation',
      entityId: input.conversationId,
      description: `Return "${output.subject}" to the queue`,
    }
  },
})

export const unarchiveThread = register({
  name: 'unarchive_thread@v1',
  description: 'Return an archived conversation to the queue. Inverse of archive_thread.',
  inputSchema: z.object({ conversationId: z.string().uuid() }),
  outputSchema: z.object({ id: z.string() }),
  riskTier: 'low' as const,
  requiredPermissions: ['conversation:update:org'],
  reversible: false,
  rateLimit: { perRun: 30, perOrgPerHour: 1000 },
  timeoutMs: 5000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    await ctx.tenantDb.sql`
      UPDATE conversations SET archived_at = NULL, status = 'open'
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.conversationId}`
    return { ok: true as const, value: { id: input.conversationId } }
  },
})

export const trackWaitingFor = register({
  name: 'track_waiting_for@v1',
  description: 'Record what we are waiting on from a counterparty. The wait clears itself when they reply.',
  inputSchema: z.object({ conversationId: z.string().uuid(), waitingFor: z.string().max(300) }),
  outputSchema: z.object({ id: z.string(), waitingFor: z.string() }),
  riskTier: 'low' as const,
  requiredPermissions: ['conversation:update:org'],
  reversible: true,
  inverse: 'clear_waiting_for@v1',
  rateLimit: { perRun: 25, perOrgPerHour: 1000 },
  timeoutMs: 5000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    await markWaitingFor(ctx.tenantDb, ctx.policy, input.conversationId, input.waitingFor)
    return { ok: true as const, value: { id: input.conversationId, waitingFor: input.waitingFor } }
  },
  buildUndo(input) {
    return {
      tool: 'clear_waiting_for@v1',
      input: { conversationId: input.conversationId },
      entityType: 'conversation',
      entityId: input.conversationId,
      description: 'Stop tracking that wait',
    }
  },
})

export const clearWaitingFor = register({
  name: 'clear_waiting_for@v1',
  description: 'Stop tracking a wait on a conversation. Inverse of track_waiting_for.',
  inputSchema: z.object({ conversationId: z.string().uuid() }),
  outputSchema: z.object({ id: z.string() }),
  riskTier: 'low' as const,
  requiredPermissions: ['conversation:update:org'],
  reversible: false,
  rateLimit: { perRun: 25, perOrgPerHour: 1000 },
  timeoutMs: 5000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    await markWaitingFor(ctx.tenantDb, ctx.policy, input.conversationId, null)
    return { ok: true as const, value: { id: input.conversationId } }
  },
})

export const getTranscript = register({
  name: 'get_transcript@v1',
  description: 'Read a meeting transcript with speaker turns and timestamps. Timestamps are the citation anchors for anything derived from it.',
  inputSchema: z.object({ meetingId: z.string().uuid(), limit: z.number().int().min(1).max(400).default(200) }),
  outputSchema: z.object({
    segments: z.array(
      z.object({ anchor: z.string(), speaker: z.string(), text: z.string(), external: z.boolean() }),
    ),
  }),
  riskTier: 'read' as const,
  requiredPermissions: ['project:read:org'],
  reversible: true,
  rateLimit: { perRun: 8, perOrgPerHour: 1000 },
  timeoutMs: 10_000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    const segments = await listSegments(ctx.tenantDb, input.meetingId)
    return {
      ok: true as const,
      value: {
        segments: segments.slice(0, input.limit).map((s) => ({
          anchor: s.anchor,
          speaker: s.speaker,
          text: s.text,
          external: !s.speakerUserId,
        })),
      },
    }
  },
})

export const listMeetingsTool = register({
  name: 'list_meetings@v1',
  description: 'List meetings with their transcript and decision status.',
  inputSchema: z.object({
    projectId: z.string().uuid().optional(),
    companyId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  outputSchema: z.object({
    meetings: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        startsAt: z.string(),
        companyName: z.string().nullable(),
        hasTranscript: z.boolean(),
        decisionCount: z.number(),
      }),
    ),
  }),
  riskTier: 'read' as const,
  requiredPermissions: ['project:read:org'],
  reversible: true,
  rateLimit: { perRun: 8, perOrgPerHour: 1000 },
  timeoutMs: 8000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    const meetings = await listMeetings(ctx.tenantDb, ctx.policy, {
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.companyId ? { companyId: input.companyId } : {}),
      limit: input.limit,
    })
    return {
      ok: true as const,
      value: {
        meetings: meetings.map((m) => ({
          id: m.id,
          title: m.title,
          startsAt: m.startsAt.toISOString(),
          companyName: m.companyName,
          hasTranscript: m.hasTranscript,
          decisionCount: m.decisionCount,
        })),
      },
    }
  },
})

export const listDecisionsTool = register({
  name: 'list_decisions@v1',
  description: 'Read the decision log: what was decided, deferred or reversed, and where it was said.',
  inputSchema: z.object({
    projectId: z.string().uuid().optional(),
    meetingId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  outputSchema: z.object({
    decisions: z.array(
      z.object({ id: z.string(), summary: z.string(), status: z.string(), meetingTitle: z.string().nullable() }),
    ),
  }),
  riskTier: 'read' as const,
  requiredPermissions: ['project:read:org'],
  reversible: true,
  rateLimit: { perRun: 8, perOrgPerHour: 1000 },
  timeoutMs: 8000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    const decisions = await listDecisions(ctx.tenantDb, {
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.meetingId ? { meetingId: input.meetingId } : {}),
      limit: input.limit,
    })
    return {
      ok: true as const,
      value: {
        decisions: decisions.map((d) => ({
          id: d.id,
          summary: d.summary,
          status: d.status,
          meetingTitle: d.meetingTitle,
        })),
      },
    }
  },
})

export const summarizeRelationship = register({
  name: 'summarize_relationship@v1',
  description: 'Assemble the state of an account: open threads, commitments both ways, tasks, meetings and risks. Every item is a database row, not an inference.',
  inputSchema: z.object({ companyId: z.string().uuid() }),
  outputSchema: z.object({
    companyName: z.string(),
    facts: z.array(z.object({ claim: z.string(), sourceType: z.string() })),
    risks: z.array(z.string()),
    openThreads: z.number(),
    weOwe: z.number(),
    theyOwe: z.number(),
  }),
  riskTier: 'read' as const,
  requiredPermissions: ['company:read:org'],
  reversible: true,
  rateLimit: { perRun: 8, perOrgPerHour: 1000 },
  timeoutMs: 10_000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    const view = await relationship360(ctx.tenantDb, ctx.policy, input.companyId)
    return {
      ok: true as const,
      value: {
        companyName: view.company.name,
        facts: view.facts.map((f) => ({ claim: f.claim, sourceType: f.sourceType })),
        risks: view.risks,
        openThreads: view.openThreads.length,
        weOwe: view.commitmentsWeOwe.length,
        theyOwe: view.commitmentsTheyOwe.length,
      },
    }
  },
})

export const listCommitmentsTool = register({
  name: 'list_commitments@v1',
  description: 'Read the commitment ledger. Only confirmed commitments count; proposed ones are awaiting their owner.',
  inputSchema: z.object({
    ownerUserId: z.string().optional(),
    companyId: z.string().uuid().optional(),
    status: z.array(z.enum(['proposed', 'confirmed', 'kept', 'renegotiated', 'slipped', 'cancelled', 'disputed'])).optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  outputSchema: z.object({
    commitments: z.array(
      z.object({
        id: z.string(),
        obligation: z.string(),
        direction: z.string(),
        status: z.string(),
        ownerName: z.string().nullable(),
        dueAt: z.string().nullable(),
      }),
    ),
  }),
  riskTier: 'read' as const,
  requiredPermissions: ['conversation:read:org'],
  reversible: true,
  rateLimit: { perRun: 10, perOrgPerHour: 2000 },
  timeoutMs: 8000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    const commitments = await listCommitments(ctx.tenantDb, ctx.policy, {
      ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
      ...(input.companyId ? { companyId: input.companyId } : {}),
      ...(input.status ? { status: input.status } : {}),
      limit: input.limit,
    })
    return {
      ok: true as const,
      value: {
        commitments: commitments.map((c) => ({
          id: c.id,
          obligation: c.obligation,
          direction: c.direction,
          status: c.status,
          ownerName: c.ownerName,
          dueAt: c.dueAt ? c.dueAt.toISOString() : null,
        })),
      },
    }
  },
})

export const proposeCommitmentTool = register({
  name: 'propose_commitment@v1',
  description:
    'Record a detected promise as a proposal. It never counts, appears in a rollup or triggers a chase until the named owner confirms it.',
  inputSchema: z.object({
    obligation: z.string().min(5).max(500),
    direction: z.enum(['we_owe', 'they_owe']),
    ownerUserId: z.string().uuid().nullish(),
    companyId: z.string().uuid().nullish(),
    dueAt: z.string().nullish(),
    confidence: z.number().min(0).max(1).default(0.6),
    sourceMessageId: z.string().uuid().nullish(),
    sourceExcerpt: z.string().max(500).nullish(),
  }),
  outputSchema: z.object({ id: z.string(), status: z.string() }),
  riskTier: 'low' as const,
  requiredPermissions: ['conversation:read:org'],
  reversible: true,
  inverse: 'cancel_commitment@v1',
  rateLimit: { perRun: 25, perOrgPerHour: 1000 },
  timeoutMs: 8000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    const commitment = await proposeCommitment(ctx.tenantDb, ctx.policy, {
      obligation: input.obligation,
      direction: input.direction,
      ownerUserId: input.ownerUserId ?? null,
      companyId: input.companyId ?? null,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      confidence: input.confidence,
      sourceMessageId: input.sourceMessageId ?? null,
      sourceExcerpt: input.sourceExcerpt ?? null,
      agentRunId: ctx.agentRunId,
    })
    return { ok: true as const, value: { id: commitment.id, status: commitment.status } }
  },
  async preview(input): Promise<PreviewLine[]> {
    return [
      {
        operation: 'Propose commitment',
        entityType: 'commitment',
        entityLabel: input.obligation.slice(0, 80),
        changes: [
          { field: 'Direction', to: input.direction === 'we_owe' ? 'we owe them' : 'they owe us' },
          { field: 'Counts as a promise', to: 'no — only once the owner confirms' },
        ],
        riskTier: 'low',
        reversible: true,
      },
    ]
  },
  buildUndo(_input, output) {
    return {
      tool: 'cancel_commitment@v1',
      input: { id: output.id },
      entityType: 'commitment',
      entityId: output.id,
      description: 'Withdraw the proposed commitment',
    }
  },
})

export const cancelCommitment = register({
  name: 'cancel_commitment@v1',
  description: 'Withdraw a commitment. Inverse of propose_commitment.',
  inputSchema: z.object({ id: z.string().uuid() }),
  outputSchema: z.object({ id: z.string(), cancelled: z.boolean() }),
  riskTier: 'low' as const,
  requiredPermissions: ['conversation:read:org'],
  reversible: false,
  rateLimit: { perRun: 25, perOrgPerHour: 1000 },
  timeoutMs: 5000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    await ctx.tenantDb.sql`
      UPDATE commitments SET status = 'cancelled', deleted_at = now()
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.id}`
    return { ok: true as const, value: { id: input.id, cancelled: true } }
  },
})

export const logInteractionTool = register({
  name: 'log_interaction@v1',
  description: 'Record a touch on an account so the relationship timeline and quiet-account detection stay accurate.',
  inputSchema: z.object({
    companyId: z.string().uuid(),
    contactId: z.string().uuid().nullish(),
    kind: z.enum(['email', 'call', 'meeting', 'note', 'task']),
    summary: z.string().min(3).max(500),
    occurredAt: z.string().nullish(),
  }),
  outputSchema: z.object({ id: z.string() }),
  riskTier: 'low' as const,
  requiredPermissions: ['note:create:org'],
  reversible: true,
  inverse: 'delete_interaction@v1',
  rateLimit: { perRun: 25, perOrgPerHour: 2000 },
  timeoutMs: 5000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    const id = await logInteraction(ctx.tenantDb, ctx.policy, {
      companyId: input.companyId,
      contactId: input.contactId ?? null,
      kind: input.kind,
      summary: input.summary,
      ...(input.occurredAt ? { occurredAt: new Date(input.occurredAt) } : {}),
      agentRunId: ctx.agentRunId,
    })
    return { ok: true as const, value: { id } }
  },
  buildUndo(_input, output) {
    return {
      tool: 'delete_interaction@v1',
      input: { id: output.id },
      entityType: 'interaction',
      entityId: output.id,
      description: 'Remove the logged interaction',
    }
  },
})

export const deleteInteraction = register({
  name: 'delete_interaction@v1',
  description: 'Remove a logged interaction. Inverse of log_interaction.',
  inputSchema: z.object({ id: z.string().uuid() }),
  outputSchema: z.object({ id: z.string(), deleted: z.boolean() }),
  riskTier: 'low' as const,
  requiredPermissions: ['note:create:org'],
  reversible: false,
  rateLimit: { perRun: 25, perOrgPerHour: 2000 },
  timeoutMs: 5000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    await ctx.tenantDb.sql`
      UPDATE interactions SET deleted_at = now()
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.id}`
    return { ok: true as const, value: { id: input.id, deleted: true } }
  },
})
