import type { Priority, TenantContext } from '@superwork/db'
import { asJson } from '@superwork/db'
import { can, readCeiling, SENSITIVITY_RANK, type Actor } from '@superwork/auth'
import type { Sensitivity } from '@superwork/db'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { assertSteppedUp } from '../step-up.js'
import { writeActivity, writeAudit } from '../audit.js'
import { detectInjection } from '../retrieval/classify.js'
import { sanitizeMessage, type SanitizedContent } from '../sanitize.js'

/**
 * The Smart Inbox (§12.3).
 *
 * Triage-first: a keyboard-driven queue, because operations people live here. Every
 * classification is stored with the run that produced it, so "why is this urgent?" is
 * answerable. Message bodies are external content and are sanitized on the way out.
 */

export type ConversationCategory =
  | 'needs_reply' | 'needs_action' | 'waiting_on_others' | 'fyi' | 'urgent' | 'spam'

export interface ConversationView {
  id: string
  subject: string
  channel: string
  companyId: string | null
  companyName: string | null
  ownerId: string | null
  ownerName: string | null
  category: ConversationCategory | null
  priority: Priority | null
  sentiment: string | null
  lastMessageAt: Date | null
  lastDirection: string | null
  daysWaiting: number
  messageCount: number
  snoozedUntil: Date | null
  archivedAt: Date | null
  waitingFor: string | null
  triagedAt: Date | null
  triagedByAgentRunId: string | null
  hasFlaggedContent: boolean
  slaDays: number
  pastSla: boolean
  /** §4.3. `unset` means the default, not a decision — see `classifyConversation`. */
  sensitivity: Sensitivity
  sensitivitySource: 'unset' | 'human'
  sensitivitySetByName: string | null
  sensitivitySetAt: Date | null
  sensitivityReason: string | null
}

const SELECT_CONVERSATION = (ctx: TenantContext) => ctx.sql`
  SELECT conv.id, conv.subject, conv.channel,
         conv.company_id AS "companyId", c.name AS "companyName",
         conv.owner_id AS "ownerId", u.name AS "ownerName",
         conv.category, conv.priority, conv.sentiment,
         conv.last_message_at AS "lastMessageAt", conv.last_direction AS "lastDirection",
         GREATEST(0, EXTRACT(DAY FROM (now() - conv.last_message_at))::int) AS "daysWaiting",
         (SELECT count(*)::int FROM messages m
           WHERE m.conversation_id = conv.id AND m.deleted_at IS NULL) AS "messageCount",
         conv.snoozed_until AS "snoozedUntil", conv.archived_at AS "archivedAt",
         conv.waiting_for AS "waitingFor", conv.triaged_at AS "triagedAt",
         conv.triaged_by_agent_run_id AS "triagedByAgentRunId",
         EXISTS (SELECT 1 FROM messages m
                  WHERE m.conversation_id = conv.id AND m.injection_flagged) AS "hasFlaggedContent",
         conv.sensitivity, conv.sensitivity_source AS "sensitivitySource",
         (SELECT name FROM users WHERE id = conv.sensitivity_set_by) AS "sensitivitySetByName",
         conv.sensitivity_set_at AS "sensitivitySetAt",
         conv.sensitivity_reason AS "sensitivityReason",
         coalesce(c.reply_sla_days, 4) AS "slaDays",
         (conv.last_direction = 'inbound'
           AND conv.last_message_at < now() - make_interval(days => coalesce(c.reply_sla_days, 4))) AS "pastSla"
  FROM conversations conv
  LEFT JOIN companies c ON c.id = conv.company_id
  LEFT JOIN users u ON u.id = conv.owner_id`

export interface InboxFilter {
  view?: 'queue' | 'mine' | 'waiting' | 'snoozed' | 'archived' | 'all'
  category?: ConversationCategory
  companyId?: string
  limit?: number
}

/**
 * The triage queue. Ordered the way a person works it: what is past SLA first, then by
 * priority, then oldest — not simply newest-first, which buries the things that matter.
 */
export async function listConversations(
  ctx: TenantContext,
  actor: Actor,
  filter: InboxFilter = {},
): Promise<ConversationView[]> {
  const decision = can(actor, 'conversation:read', { type: 'conversation', organizationId: ctx.organizationId })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const sql = ctx.sql
  const view = filter.view ?? 'queue'

  return sql<ConversationView[]>`
    ${SELECT_CONVERSATION(ctx)}
    WHERE conv.organization_id = ${ctx.organizationId} AND conv.deleted_at IS NULL
      -- A subject is content. A thread somebody classified above this reader is not listed at
      -- all, rather than listed and refused on open: the same argument the relationship view
      -- makes about a restricted contract's title.
      AND conv.sensitivity <= ${readCeiling(actor)}::sw_sensitivity
      ${view === 'archived' ? sql`AND conv.archived_at IS NOT NULL` : sql`AND conv.archived_at IS NULL`}
      ${
        view === 'queue'
          ? sql`AND (conv.snoozed_until IS NULL OR conv.snoozed_until <= now())`
          : view === 'snoozed'
            ? sql`AND conv.snoozed_until > now()`
            : view === 'waiting'
              ? sql`AND conv.waiting_for IS NOT NULL`
              : view === 'mine'
                ? sql`AND (conv.owner_id = ${actor.userId} OR conv.assigned_to = ${actor.userId})`
                : sql``
      }
      ${filter.category ? sql`AND conv.category = ${filter.category}::sw_conversation_category` : sql``}
      ${filter.companyId ? sql`AND conv.company_id = ${filter.companyId}` : sql``}
    ORDER BY
      (conv.last_direction = 'inbound'
        AND conv.last_message_at < now() - make_interval(days => coalesce(c.reply_sla_days, 4))) DESC,
      CASE conv.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      conv.last_message_at ASC
    LIMIT ${Math.min(filter.limit ?? 50, 200)}`
}

export async function getConversation(ctx: TenantContext, actor: Actor, id: string): Promise<ConversationView> {
  const [row] = await ctx.sql<ConversationView[]>`
    ${SELECT_CONVERSATION(ctx)}
    WHERE conv.organization_id = ${ctx.organizationId} AND conv.id = ${id} AND conv.deleted_at IS NULL`
  if (!row) throw new NotFoundError()

  // The classification goes into the resource, which is the only reason `checkClearance` ever
  // sees it. It had never been passed, so the column on this table decided nothing at all.
  const decision = can(actor, 'conversation:read', {
    type: 'conversation',
    id: row.id,
    organizationId: ctx.organizationId,
    ownerId: row.ownerId,
    sensitivity: row.sensitivity,
  })
  // A thread above the reader's clearance is not theirs to know about, so it answers the way a
  // thread in another organization does (§3.2).
  if (!decision.allow) {
    if (SENSITIVITY_RANK[row.sensitivity] > SENSITIVITY_RANK[readCeiling(actor)]) throw new NotFoundError()
    throw new PermissionError(decision.reason)
  }
  return row
}

export interface MessageView {
  id: string
  direction: string
  fromName: string | null
  fromAddress: string
  toAddresses: string[]
  sentAt: Date
  /** Already sanitized: safe to render as text, never as HTML. */
  body: string
  sanitization: SanitizedContent['removed']
  sanitizationNote: string | null
  links: SanitizedContent['links']
  trustLevel: string
  injectionFlagged: boolean
  injectionPatterns: string[]
}

export async function listMessages(
  ctx: TenantContext,
  actor: Actor,
  conversationId: string,
): Promise<MessageView[]> {
  const conversation = await getConversation(ctx, actor, conversationId)

  const domains = conversation.companyId
    ? (
        await ctx.sql<{ domains: string[] }[]>`
          SELECT domains FROM companies WHERE organization_id = ${ctx.organizationId} AND id = ${conversation.companyId}`
      )[0]?.domains ?? []
    : []

  const rows = await ctx.sql<
    {
      id: string
      direction: string
      from_name: string | null
      from_address: string
      to_addresses: string[]
      sent_at: Date
      body_text: string
      trust_level: string
      injection_flagged: boolean
    }[]
  >`
    SELECT id, direction, from_name, from_address, to_addresses, sent_at, body_text,
           trust_level, injection_flagged
    FROM messages
    WHERE organization_id = ${ctx.organizationId} AND conversation_id = ${conversationId}
      AND deleted_at IS NULL
    ORDER BY sent_at ASC`

  return rows.map((row) => {
    const sanitized = sanitizeMessage(row.body_text, { knownDomains: domains })
    const findings = row.trust_level === 'untrusted_external' ? detectInjection(row.body_text) : []
    return {
      id: row.id,
      direction: row.direction,
      fromName: row.from_name,
      fromAddress: row.from_address,
      toAddresses: row.to_addresses,
      sentAt: row.sent_at,
      body: sanitized.text,
      sanitization: sanitized.removed,
      sanitizationNote: sanitized.modified
        ? `${sanitized.removed.remoteImages} remote images blocked${sanitized.removed.scripts ? `, ${sanitized.removed.scripts} scripts removed` : ''}`
        : null,
      links: sanitized.links,
      trustLevel: row.trust_level,
      injectionFlagged: row.injection_flagged || findings.length > 0,
      injectionPatterns: findings.map((f) => f.pattern),
    }
  })
}

// ---------------------------------------------------------------------------
// Triage actions
// ---------------------------------------------------------------------------

export interface TriageInput {
  conversationId: string
  category?: ConversationCategory
  priority?: Priority
  sentiment?: string
  agentRunId?: string | null
}

export async function applyTriage(ctx: TenantContext, actor: Actor, input: TriageInput): Promise<ConversationView> {
  const before = await getConversation(ctx, actor, input.conversationId)
  const decision = can(actor, 'conversation:update', {
    type: 'conversation',
    id: before.id,
    organizationId: ctx.organizationId,
    ownerId: before.ownerId,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  await ctx.sql`
    UPDATE conversations SET
      category = ${input.category ?? before.category}::sw_conversation_category,
      priority = ${input.priority ?? before.priority}::sw_priority,
      sentiment = ${input.sentiment ?? before.sentiment},
      classification = ${ctx.sql.json(asJson({
        category: input.category ?? before.category,
        priority: input.priority ?? before.priority,
        sentiment: input.sentiment ?? before.sentiment,
        classifiedBy: actor.type,
        classifiedAt: new Date().toISOString(),
      }))},
      triaged_at = now(),
      triaged_by_agent_run_id = ${input.agentRunId ?? null}
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.conversationId}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.agent?.agentId ?? actor.userId,
    action: 'conversation.triage',
    entityType: 'conversation',
    entityId: input.conversationId,
    before: { category: before.category, priority: before.priority },
    after: { category: input.category ?? before.category, priority: input.priority ?? before.priority },
    agentRunId: input.agentRunId ?? null,
  })

  return getConversation(ctx, actor, input.conversationId)
}

export const SENSITIVITIES: Sensitivity[] = ['public', 'internal', 'confidential', 'restricted']

/**
 * Saying how far a thread may travel (ADR 0061).
 *
 * `conversations.sensitivity` has carried `internal` since Phase 0, written by nothing and — more
 * to the point — read by nothing: no repository put it in the `Resource` it checked, so
 * `checkClearance` never saw it. Every member holds `conversation:read:org`, so every member read
 * every thread in the organization, and there was no way to say otherwise.
 *
 * Three things this deliberately does:
 *
 * **The new level is checked, not the old one.** `can()` is asked about the row as it *will be*,
 * so the clearance test refuses a classification the person could not then read, in the policy
 * engine's own words rather than in a second copy of the rule here (ADR 0045, ADR 0056).
 *
 * **Lowering asks for the password again; raising never does.** Raising narrows who can read the
 * thread, and a narrowing has never needed a fresh proof here. Lowering widens it, and cascades
 * to every message already in the thread (ADRs 0044, 0046, 0050, 0054, 0055).
 *
 * **The reason is required by the database, not by this function.** The CHECK is what makes it
 * true of every writer.
 */
export async function classifyConversation(
  ctx: TenantContext,
  actor: Actor,
  input: { conversationId: string; sensitivity: Sensitivity; reason: string },
): Promise<ConversationView> {
  const before = await getConversation(ctx, actor, input.conversationId)

  if (!SENSITIVITIES.includes(input.sensitivity)) {
    throw new ValidationError(`“${String(input.sensitivity)}” is not a classification.`)
  }

  const decision = can(actor, 'conversation:update', {
    type: 'conversation',
    id: before.id,
    organizationId: ctx.organizationId,
    ownerId: before.ownerId,
    riskTier: 'low',
    // The row as it will be. Filing a thread above your own clearance would be filing it out of
    // your own reach, and the policy engine says that better than a second check here would.
    sensitivity: input.sensitivity,
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const reason = input.reason.trim()
  if (reason.length < 4) {
    throw new ValidationError('Say why. A classification nobody explained is one nobody can check.')
  }

  if (SENSITIVITY_RANK[input.sensitivity] < SENSITIVITY_RANK[before.sensitivity]) {
    assertSteppedUp(actor, 'conversation.declassify')
  }

  await ctx.sql`
    UPDATE conversations
    SET sensitivity = ${input.sensitivity}::sw_sensitivity, sensitivity_source = 'human',
        sensitivity_set_by = ${actor.userId}, sensitivity_set_at = now(),
        sensitivity_reason = ${reason}, updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.conversationId}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'conversation.classified',
    entityType: 'conversation',
    entityId: input.conversationId,
    before: { sensitivity: before.sensitivity, source: before.sensitivitySource },
    after: { sensitivity: input.sensitivity, source: 'human', reason },
  })

  // Deliberately not on the activity feed. Who can read a thread is not news to the people who
  // can no longer read it, and the feed is a place they would still see the subject (§29.3 is
  // about the other direction, and the same care applies here).
  return getConversation(ctx, actor, input.conversationId)
}

export async function archiveConversation(
  ctx: TenantContext,
  actor: Actor,
  id: string,
  agentRunId?: string | null,
): Promise<void> {
  const before = await getConversation(ctx, actor, id)
  const decision = can(actor, 'conversation:update', {
    type: 'conversation',
    id,
    organizationId: ctx.organizationId,
    ownerId: before.ownerId,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  await ctx.sql`
    UPDATE conversations SET archived_at = now(), status = 'closed'
    WHERE organization_id = ${ctx.organizationId} AND id = ${id}`

  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.agent?.agentName ?? actor.displayName,
    verb: 'archived',
    entityType: 'conversation',
    entityId: id,
    entityLabel: before.subject,
    summary: `Archived "${before.subject}"`,
    agentRunId: agentRunId ?? null,
  })
}

export async function unarchiveConversation(ctx: TenantContext, actor: Actor, id: string): Promise<void> {
  await getConversation(ctx, actor, id)
  await ctx.sql`
    UPDATE conversations SET archived_at = NULL, status = 'open'
    WHERE organization_id = ${ctx.organizationId} AND id = ${id}`
}

export async function snoozeConversation(
  ctx: TenantContext,
  actor: Actor,
  id: string,
  until: Date,
  agentRunId?: string | null,
): Promise<void> {
  const before = await getConversation(ctx, actor, id)
  if (until.getTime() <= Date.now()) throw new ValidationError('A snooze has to be in the future.')

  const decision = can(actor, 'conversation:update', {
    type: 'conversation',
    id,
    organizationId: ctx.organizationId,
    ownerId: before.ownerId,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  await ctx.sql`
    UPDATE conversations SET snoozed_until = ${until}
    WHERE organization_id = ${ctx.organizationId} AND id = ${id}`

  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.agent?.agentName ?? actor.displayName,
    verb: 'snoozed',
    entityType: 'conversation',
    entityId: id,
    entityLabel: before.subject,
    summary: `Snoozed "${before.subject}" until ${until.toISOString()}`,
    agentRunId: agentRunId ?? null,
  })
}

/**
 * "Waiting for" tracking. The nudge cancels itself the moment the reply arrives — nothing
 * erodes trust faster than being chased for something already answered (§28.4).
 */
export async function markWaitingFor(
  ctx: TenantContext,
  actor: Actor,
  id: string,
  waitingFor: string | null,
): Promise<void> {
  const before = await getConversation(ctx, actor, id)
  const decision = can(actor, 'conversation:update', {
    type: 'conversation',
    id,
    organizationId: ctx.organizationId,
    ownerId: before.ownerId,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  await ctx.sql`
    UPDATE conversations SET
      waiting_for = ${waitingFor},
      waiting_since = ${waitingFor ? new Date() : null},
      category = ${waitingFor ? 'waiting_on_others' : null}::sw_conversation_category
    WHERE organization_id = ${ctx.organizationId} AND id = ${id}`
}

/** Called when an inbound message lands: any pending wait on that thread is satisfied. */
export async function resolveWaitOnReply(ctx: TenantContext, conversationId: string): Promise<void> {
  await ctx.sql`
    UPDATE conversations
    SET waiting_for = NULL, waiting_since = NULL
    WHERE organization_id = ${ctx.organizationId} AND id = ${conversationId} AND waiting_for IS NOT NULL`
}

export interface InboxCounts {
  queue: number
  pastSla: number
  needsReply: number
  waiting: number
  snoozed: number
  untriaged: number
}

/**
 * The numbers on the navigation. They take an actor for the same reason the list does: a badge
 * that counts a thread somebody cannot open tells them it is there.
 */
export async function inboxCounts(ctx: TenantContext, actor: Actor): Promise<InboxCounts> {
  const [row] = await ctx.sql<InboxCounts[]>`
    SELECT
      count(*) FILTER (WHERE archived_at IS NULL
        AND (snoozed_until IS NULL OR snoozed_until <= now()))::int AS queue,
      count(*) FILTER (WHERE archived_at IS NULL AND conv.last_direction = 'inbound'
        AND conv.last_message_at < now() - make_interval(days => coalesce(c.reply_sla_days, 4)))::int AS "pastSla",
      count(*) FILTER (WHERE archived_at IS NULL AND category = 'needs_reply')::int AS "needsReply",
      count(*) FILTER (WHERE archived_at IS NULL AND waiting_for IS NOT NULL)::int AS waiting,
      count(*) FILTER (WHERE archived_at IS NULL AND snoozed_until > now())::int AS snoozed,
      count(*) FILTER (WHERE archived_at IS NULL AND triaged_at IS NULL)::int AS untriaged
    FROM conversations conv
    LEFT JOIN companies c ON c.id = conv.company_id
    WHERE conv.organization_id = ${ctx.organizationId} AND conv.deleted_at IS NULL
      AND conv.sensitivity <= ${readCeiling(actor)}::sw_sensitivity`
  return row ?? { queue: 0, pastSla: 0, needsReply: 0, waiting: 0, snoozed: 0, untriaged: 0 }
}
