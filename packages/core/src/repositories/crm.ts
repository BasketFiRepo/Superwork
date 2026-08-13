import type { TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { ConflictError, NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'

/**
 * CRM (§12.6).
 *
 * Two rules shape this module. Inbound mail associates to a company by domain, but a new
 * *contact* is proposed for confirmation rather than silently created. And the 360° view
 * is assembled from cited facts — every claim on it points at the row it came from.
 */

export interface CompanyView {
  id: string
  name: string
  legalName: string | null
  type: string
  industry: string | null
  domains: string[]
  sizeBand: string | null
  ownerId: string | null
  ownerName: string | null
  healthStatus: string
  replySlaDays: number
  checkInDays: number
  contractRenewsOn: Date | null
  lastInteractionAt: Date | null
  daysSinceInteraction: number | null
  contactCount: number
  openConversations: number
  openTasks: number
  createdAt: Date
}

const SELECT_COMPANY = (ctx: TenantContext) => ctx.sql`
  SELECT c.id, c.name, c.legal_name AS "legalName", c.type, c.industry, c.domains,
         c.size_band AS "sizeBand", c.owner_id AS "ownerId", u.name AS "ownerName",
         c.health_status AS "healthStatus", c.reply_sla_days AS "replySlaDays",
         c.check_in_days AS "checkInDays", c.contract_renews_on AS "contractRenewsOn",
         c.last_interaction_at AS "lastInteractionAt",
         CASE WHEN c.last_interaction_at IS NULL THEN NULL
              ELSE EXTRACT(DAY FROM (now() - c.last_interaction_at))::int END AS "daysSinceInteraction",
         (SELECT count(*)::int FROM contacts ct
           WHERE ct.company_id = c.id AND ct.deleted_at IS NULL AND ct.merged_into_contact_id IS NULL) AS "contactCount",
         (SELECT count(*)::int FROM conversations cv
           WHERE cv.company_id = c.id AND cv.deleted_at IS NULL AND cv.archived_at IS NULL) AS "openConversations",
         (SELECT count(*)::int FROM tasks t
           JOIN projects p ON p.id = t.project_id
           WHERE p.company_id = c.id AND t.deleted_at IS NULL
             AND t.status NOT IN ('completed', 'cancelled')) AS "openTasks",
         c.created_at AS "createdAt"
  FROM companies c
  LEFT JOIN users u ON u.id = c.owner_id`

export async function listCompanies(
  ctx: TenantContext,
  actor: Actor,
  filter: { type?: string; search?: string; limit?: number } = {},
): Promise<CompanyView[]> {
  const decision = can(actor, 'company:read', { type: 'company', organizationId: ctx.organizationId })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const sql = ctx.sql
  return sql<CompanyView[]>`
    ${SELECT_COMPANY(ctx)}
    WHERE c.organization_id = ${ctx.organizationId} AND c.deleted_at IS NULL
      ${filter.type ? sql`AND c.type = ${filter.type}::sw_company_type` : sql``}
      ${filter.search ? sql`AND c.name ILIKE ${'%' + filter.search + '%'}` : sql``}
    ORDER BY c.name
    LIMIT ${Math.min(filter.limit ?? 100, 200)}`
}

export async function getCompany(ctx: TenantContext, actor: Actor, id: string): Promise<CompanyView> {
  const [row] = await ctx.sql<CompanyView[]>`
    ${SELECT_COMPANY(ctx)}
    WHERE c.organization_id = ${ctx.organizationId} AND c.id = ${id} AND c.deleted_at IS NULL`
  if (!row) throw new NotFoundError()

  const decision = can(actor, 'company:read', {
    type: 'company',
    id: row.id,
    organizationId: ctx.organizationId,
    ownerId: row.ownerId,
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  return row
}

export interface ContactView {
  id: string
  name: string
  emails: string[]
  phones: string[]
  title: string | null
  seniority: string | null
  companyId: string | null
  companyName: string | null
  ownerId: string | null
  ownerName: string | null
  preferredChannel: string | null
  timezone: string | null
  lastInteractionAt: Date | null
  nextStep: string | null
  nextStepAt: Date | null
  mergedIntoContactId: string | null
}

const SELECT_CONTACT = (ctx: TenantContext) => ctx.sql`
  SELECT ct.id, ct.name, ct.emails, ct.phones, ct.title, ct.seniority,
         ct.company_id AS "companyId", co.name AS "companyName",
         ct.owner_id AS "ownerId", u.name AS "ownerName",
         ct.preferred_channel AS "preferredChannel", ct.timezone,
         ct.last_interaction_at AS "lastInteractionAt",
         ct.next_step AS "nextStep", ct.next_step_at AS "nextStepAt",
         ct.merged_into_contact_id AS "mergedIntoContactId"
  FROM contacts ct
  LEFT JOIN companies co ON co.id = ct.company_id
  LEFT JOIN users u ON u.id = ct.owner_id`

export async function listContacts(
  ctx: TenantContext,
  actor: Actor,
  filter: { companyId?: string; search?: string; includeMerged?: boolean; limit?: number } = {},
): Promise<ContactView[]> {
  const decision = can(actor, 'contact:read', { type: 'contact', organizationId: ctx.organizationId })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const sql = ctx.sql
  return sql<ContactView[]>`
    ${SELECT_CONTACT(ctx)}
    WHERE ct.organization_id = ${ctx.organizationId} AND ct.deleted_at IS NULL
      ${filter.includeMerged ? sql`` : sql`AND ct.merged_into_contact_id IS NULL`}
      ${filter.companyId ? sql`AND ct.company_id = ${filter.companyId}` : sql``}
      ${filter.search ? sql`AND ct.name ILIKE ${'%' + filter.search + '%'}` : sql``}
    ORDER BY ct.name
    LIMIT ${Math.min(filter.limit ?? 100, 200)}`
}

export async function getContact(ctx: TenantContext, actor: Actor, id: string): Promise<ContactView> {
  const [row] = await ctx.sql<ContactView[]>`
    ${SELECT_CONTACT(ctx)}
    WHERE ct.organization_id = ${ctx.organizationId} AND ct.id = ${id} AND ct.deleted_at IS NULL`
  if (!row) throw new NotFoundError()
  const decision = can(actor, 'contact:read', {
    type: 'contact',
    id: row.id,
    organizationId: ctx.organizationId,
    ownerId: row.ownerId,
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  return row
}

/** Inbound mail associates to a company by domain — a deterministic lookup, not a guess. */
export async function companyForAddress(ctx: TenantContext, address: string): Promise<CompanyView | null> {
  const domain = address.split('@')[1]?.toLowerCase()
  if (!domain) return null
  const [row] = await ctx.sql<{ id: string }[]>`
    SELECT id FROM companies
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
      AND ${domain} = ANY(domains)
    LIMIT 1`
  if (!row) return null
  const [company] = await ctx.sql<CompanyView[]>`
    ${SELECT_COMPANY(ctx)} WHERE c.id = ${row.id} AND c.organization_id = ${ctx.organizationId}`
  return company ?? null
}

// ---------------------------------------------------------------------------
// The 360° view
// ---------------------------------------------------------------------------

export interface RelationshipFact {
  claim: string
  sourceType: 'conversation' | 'commitment' | 'task' | 'meeting' | 'company' | 'document' | 'interaction'
  sourceId: string | null
  occurredAt: Date | null
}

export interface Relationship360 {
  company: CompanyView
  /** Every claim carries the row it came from; nothing here is inferred prose (§12.6). */
  facts: RelationshipFact[
  ]
  openThreads: { id: string; subject: string; daysWaiting: number; pastSla: boolean }[]
  commitmentsWeOwe: { id: string; obligation: string; dueAt: Date | null; status: string }[]
  commitmentsTheyOwe: { id: string; obligation: string; dueAt: Date | null; status: string }[]
  openTasks: { id: string; title: string; dueAt: Date | null; assigneeName: string | null }[]
  recentMeetings: { id: string; title: string; startsAt: Date }[]
  documents: { id: string; title: string; docType: string }[]
  risks: string[]
  computedAt: Date
}

/**
 * Assembles the 360° view from the database. The model is only ever asked to narrate
 * this structure — it never supplies a fact that is not already here.
 */
export async function relationship360(ctx: TenantContext, actor: Actor, companyId: string): Promise<Relationship360> {
  const company = await getCompany(ctx, actor, companyId)
  const sql = ctx.sql

  const openThreads = await sql<{ id: string; subject: string; daysWaiting: number; pastSla: boolean }[]>`
    SELECT conv.id, conv.subject,
           GREATEST(0, EXTRACT(DAY FROM (now() - conv.last_message_at))::int) AS "daysWaiting",
           (conv.last_direction = 'inbound'
             AND conv.last_message_at < now() - make_interval(days => ${company.replySlaDays})) AS "pastSla"
    FROM conversations conv
    WHERE conv.organization_id = ${ctx.organizationId} AND conv.company_id = ${companyId}
      AND conv.deleted_at IS NULL AND conv.archived_at IS NULL
    ORDER BY conv.last_message_at ASC`

  const commitments = await sql<{ id: string; obligation: string; dueAt: Date | null; status: string; direction: string }[]>`
    SELECT id, obligation, due_at AS "dueAt", status, direction FROM commitments
    WHERE organization_id = ${ctx.organizationId} AND company_id = ${companyId}
      AND deleted_at IS NULL AND status NOT IN ('cancelled')
    ORDER BY due_at NULLS LAST`

  const openTasks = await sql<{ id: string; title: string; dueAt: Date | null; assigneeName: string | null }[]>`
    SELECT t.id, t.title, t.due_at AS "dueAt", u.name AS "assigneeName"
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.organization_id = ${ctx.organizationId} AND p.company_id = ${companyId}
      AND t.deleted_at IS NULL AND t.status NOT IN ('completed', 'cancelled')
    ORDER BY t.due_at NULLS LAST LIMIT 20`

  const recentMeetings = await sql<{ id: string; title: string; startsAt: Date }[]>`
    SELECT id, title, starts_at AS "startsAt" FROM meetings
    WHERE organization_id = ${ctx.organizationId} AND company_id = ${companyId} AND deleted_at IS NULL
    ORDER BY starts_at DESC LIMIT 5`

  const documents = await sql<{ id: string; title: string; docType: string }[]>`
    SELECT id, title, doc_type AS "docType" FROM documents
    WHERE organization_id = ${ctx.organizationId} AND company_id = ${companyId}
      AND deleted_at IS NULL AND index_status = 'indexed'
    ORDER BY created_at DESC LIMIT 10`

  const facts: RelationshipFact[] = []
  const risks: string[] = []

  const stale = openThreads.filter((t) => t.pastSla)
  if (stale.length > 0) {
    facts.push({
      claim: `${stale.length} open ${stale.length === 1 ? 'thread is' : 'threads are'} past the ${company.replySlaDays}-day reply SLA.`,
      sourceType: 'conversation',
      sourceId: stale[0]!.id,
      occurredAt: null,
    })
    risks.push(`Awaiting a reply from us for ${Math.max(...stale.map((t) => t.daysWaiting))} days.`)
  }

  const weOwe = commitments.filter((c) => c.direction === 'we_owe')
  const theyOwe = commitments.filter((c) => c.direction === 'they_owe')
  const overdueOurs = weOwe.filter((c) => c.dueAt && c.dueAt.getTime() < Date.now() && c.status === 'confirmed')
  if (overdueOurs.length > 0) {
    facts.push({
      claim: `${overdueOurs.length} confirmed ${overdueOurs.length === 1 ? 'commitment we made is' : 'commitments we made are'} past their date.`,
      sourceType: 'commitment',
      sourceId: overdueOurs[0]!.id,
      occurredAt: overdueOurs[0]!.dueAt,
    })
    risks.push('We are late on something we promised.')
  }

  if (company.contractRenewsOn) {
    const days = Math.round((company.contractRenewsOn.getTime() - Date.now()) / 86_400_000)
    facts.push({
      claim: `The contract renews on ${company.contractRenewsOn.toISOString().slice(0, 10)} — ${days} days away.`,
      sourceType: 'company',
      sourceId: company.id,
      occurredAt: company.contractRenewsOn,
    })
    if (days <= 90 && days >= 0) risks.push(`Renewal in ${days} days.`)
  }

  if (company.daysSinceInteraction !== null && company.daysSinceInteraction > company.checkInDays) {
    facts.push({
      claim: `No recorded interaction for ${company.daysSinceInteraction} days, against a ${company.checkInDays}-day check-in cadence.`,
      sourceType: 'company',
      sourceId: company.id,
      occurredAt: company.lastInteractionAt,
    })
    risks.push('The account has gone quiet.')
  }

  if (openTasks.length > 0) {
    facts.push({
      claim: `${openTasks.length} open ${openTasks.length === 1 ? 'task' : 'tasks'} on this account.`,
      sourceType: 'task',
      sourceId: openTasks[0]!.id,
      occurredAt: null,
    })
  }

  if (recentMeetings[0]) {
    facts.push({
      claim: `Last meeting: "${recentMeetings[0].title}" on ${recentMeetings[0].startsAt.toISOString().slice(0, 10)}.`,
      sourceType: 'meeting',
      sourceId: recentMeetings[0].id,
      occurredAt: recentMeetings[0].startsAt,
    })
  }

  return {
    company,
    facts,
    openThreads,
    commitmentsWeOwe: weOwe.map(({ direction, ...rest }) => rest),
    commitmentsTheyOwe: theyOwe.map(({ direction, ...rest }) => rest),
    openTasks,
    recentMeetings,
    documents,
    risks,
    computedAt: new Date(),
  }
}

// ---------------------------------------------------------------------------
// Duplicate detection and guided merge
// ---------------------------------------------------------------------------

export interface MergeCandidateView {
  id: string
  primary: ContactView
  duplicate: ContactView
  similarity: number
  reasons: string[]
  status: string
}

/**
 * Duplicate detection: shared email is decisive, otherwise name similarity within the
 * same company. Candidates are queued for a person; nothing merges automatically.
 */
export async function detectDuplicateContacts(ctx: TenantContext, actor: Actor): Promise<number> {
  const decision = can(actor, 'contact:read', { type: 'contact', organizationId: ctx.organizationId })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const pairs = await ctx.sql<
    { a: string; b: string; similarity: number; shared_email: boolean; same_company: boolean }[]
  >`
    SELECT c1.id AS a, c2.id AS b,
           similarity(c1.name, c2.name)::numeric(4,3) AS similarity,
           (c1.emails && c2.emails) AS shared_email,
           (c1.company_id IS NOT DISTINCT FROM c2.company_id) AS same_company
    FROM contacts c1
    JOIN contacts c2 ON c2.organization_id = c1.organization_id AND c2.id > c1.id
    WHERE c1.organization_id = ${ctx.organizationId}
      AND c1.deleted_at IS NULL AND c2.deleted_at IS NULL
      AND c1.merged_into_contact_id IS NULL AND c2.merged_into_contact_id IS NULL
      AND ((c1.emails && c2.emails)
           OR (similarity(c1.name, c2.name) > 0.55
               AND c1.company_id IS NOT DISTINCT FROM c2.company_id))
    LIMIT 100`

  let created = 0
  for (const pair of pairs) {
    const reasons: string[] = []
    if (pair.shared_email) reasons.push('They share an email address.')
    if (pair.same_company) reasons.push('They sit at the same company.')
    if (pair.similarity > 0.55) reasons.push(`Their names are ${(pair.similarity * 100).toFixed(0)}% similar.`)

    const rows = await ctx.sql<{ id: string }[]>`
      INSERT INTO contact_merge_candidates (
        organization_id, primary_contact_id, duplicate_contact_id, similarity, reasons, created_by
      ) VALUES (
        ${ctx.organizationId}, ${pair.a}, ${pair.b},
        ${pair.shared_email ? 1 : Number(pair.similarity)}, ${reasons}, ${ctx.userId}
      )
      ON CONFLICT (organization_id, primary_contact_id, duplicate_contact_id) WHERE deleted_at IS NULL
      DO NOTHING
      RETURNING id`
    if (rows.length) created += 1
  }
  return created
}

export async function listMergeCandidates(ctx: TenantContext, actor: Actor): Promise<MergeCandidateView[]> {
  const rows = await ctx.sql<
    { id: string; primary_contact_id: string; duplicate_contact_id: string; similarity: string; reasons: string[]; status: string }[]
  >`
    SELECT id, primary_contact_id, duplicate_contact_id, similarity, reasons, status
    FROM contact_merge_candidates
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL AND status = 'pending'
    ORDER BY similarity DESC LIMIT 50`

  const result: MergeCandidateView[] = []
  for (const row of rows) {
    result.push({
      id: row.id,
      primary: await getContact(ctx, actor, row.primary_contact_id),
      duplicate: await getContact(ctx, actor, row.duplicate_contact_id),
      similarity: Number(row.similarity),
      reasons: row.reasons,
      status: row.status,
    })
  }
  return result
}

export interface MergeResolution {
  candidateId: string
  /** Field-level resolution: which record wins for each field. */
  keep: Record<string, 'primary' | 'duplicate'>
}

/** Guided merge with field-level resolution. The loser is tombstoned, never deleted. */
export async function mergeContacts(ctx: TenantContext, actor: Actor, input: MergeResolution): Promise<ContactView> {
  const decision = can(actor, 'contact:update', {
    type: 'contact',
    organizationId: ctx.organizationId,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const [candidate] = await ctx.sql<{ primary_contact_id: string; duplicate_contact_id: string; status: string }[]>`
    SELECT primary_contact_id, duplicate_contact_id, status FROM contact_merge_candidates
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.candidateId} AND deleted_at IS NULL`
  if (!candidate) throw new NotFoundError()
  if (candidate.status !== 'pending') throw new ConflictError('That merge was already resolved.')

  const primary = await getContact(ctx, actor, candidate.primary_contact_id)
  const duplicate = await getContact(ctx, actor, candidate.duplicate_contact_id)

  const pick = <K extends keyof ContactView>(field: K): ContactView[K] =>
    input.keep[field as string] === 'duplicate' ? duplicate[field] : primary[field]

  await ctx.sql`
    UPDATE contacts SET
      name = ${pick('name')},
      title = ${pick('title')},
      seniority = ${pick('seniority')},
      preferred_channel = ${pick('preferredChannel')},
      timezone = ${pick('timezone')},
      -- Email and phone lists are unioned: losing a way to reach someone is worse than
      -- carrying an extra address.
      emails = (SELECT array_agg(DISTINCT e) FROM unnest(${[...primary.emails, ...duplicate.emails]}::text[]) e),
      phones = (SELECT array_agg(DISTINCT p) FROM unnest(${[...primary.phones, ...duplicate.phones]}::text[]) p),
      last_interaction_at = GREATEST(
        coalesce(${primary.lastInteractionAt}, 'epoch'::timestamptz),
        coalesce(${duplicate.lastInteractionAt}, 'epoch'::timestamptz))
    WHERE organization_id = ${ctx.organizationId} AND id = ${primary.id}`

  // Re-point everything that referenced the duplicate.
  await ctx.sql`
    UPDATE commitments SET counterparty_contact_id = ${primary.id}
    WHERE organization_id = ${ctx.organizationId} AND counterparty_contact_id = ${duplicate.id}`
  await ctx.sql`
    UPDATE meeting_participants SET contact_id = ${primary.id}
    WHERE organization_id = ${ctx.organizationId} AND contact_id = ${duplicate.id}`
  await ctx.sql`
    UPDATE interactions SET contact_id = ${primary.id}
    WHERE organization_id = ${ctx.organizationId} AND contact_id = ${duplicate.id}`

  await ctx.sql`
    UPDATE contacts SET merged_into_contact_id = ${primary.id}, deleted_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${duplicate.id}`

  await ctx.sql`
    UPDATE contact_merge_candidates
    SET status = 'merged', resolved_at = now(), resolved_by = ${actor.userId},
        field_resolution = ${ctx.sql.json(input.keep as never)}
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.candidateId}`

  await writeActivity(ctx, {
    actorType: 'user',
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'merged',
    entityType: 'contact',
    entityId: primary.id,
    entityLabel: primary.name,
    summary: `Merged "${duplicate.name}" into "${primary.name}".`,
  })
  await writeAudit(ctx, {
    actorType: 'user',
    actorId: actor.userId,
    action: 'contact.merge',
    entityType: 'contact',
    entityId: primary.id,
    before: { duplicateId: duplicate.id, duplicateName: duplicate.name },
    after: { keep: input.keep },
  })

  return getContact(ctx, actor, primary.id)
}

export async function rejectMergeCandidate(ctx: TenantContext, actor: Actor, candidateId: string): Promise<void> {
  await ctx.sql`
    UPDATE contact_merge_candidates
    SET status = 'rejected', resolved_at = now(), resolved_by = ${actor.userId}
    WHERE organization_id = ${ctx.organizationId} AND id = ${candidateId}`
}

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

export async function logInteraction(
  ctx: TenantContext,
  actor: Actor,
  input: {
    companyId?: string | null
    contactId?: string | null
    kind: string
    direction?: 'inbound' | 'outbound' | 'internal'
    summary: string
    occurredAt?: Date
    sourceType?: string
    sourceId?: string
    agentRunId?: string | null
  },
): Promise<string> {
  if (!input.summary.trim()) throw new ValidationError('An interaction needs a summary.')

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO interactions (
      organization_id, company_id, contact_id, user_id, kind, direction, summary,
      occurred_at, source_type, source_id, agent_run_id, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.companyId ?? null}, ${input.contactId ?? null}, ${actor.userId},
      ${input.kind}, ${input.direction ?? null}, ${input.summary.trim()},
      ${input.occurredAt ?? new Date()}, ${input.sourceType ?? null}, ${input.sourceId ?? null},
      ${input.agentRunId ?? null}, ${ctx.userId}
    ) RETURNING id`

  if (input.companyId) {
    await ctx.sql`
      UPDATE companies SET last_interaction_at = GREATEST(
        coalesce(last_interaction_at, 'epoch'::timestamptz), ${input.occurredAt ?? new Date()})
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.companyId}`
  }
  if (input.contactId) {
    await ctx.sql`
      UPDATE contacts SET last_interaction_at = GREATEST(
        coalesce(last_interaction_at, 'epoch'::timestamptz), ${input.occurredAt ?? new Date()})
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.contactId}`
  }

  return row!.id
}

export async function listInteractions(
  ctx: TenantContext,
  companyId: string,
  limit = 25,
): Promise<{ id: string; kind: string; summary: string; occurredAt: Date; userName: string | null }[]> {
  return ctx.sql`
    SELECT i.id, i.kind, i.summary, i.occurred_at AS "occurredAt", u.name AS "userName"
    FROM interactions i LEFT JOIN users u ON u.id = i.user_id
    WHERE i.organization_id = ${ctx.organizationId} AND i.company_id = ${companyId} AND i.deleted_at IS NULL
    ORDER BY i.occurred_at DESC LIMIT ${limit}`
}

/** Recomputes `last_interaction_at` from actual messages, so the field is never stale. */
export async function refreshCompanyInteractionTimes(ctx: TenantContext): Promise<void> {
  await ctx.sql`
    UPDATE companies c SET last_interaction_at = sub.last_at
    FROM (
      SELECT conv.company_id, max(m.sent_at) AS last_at
      FROM messages m JOIN conversations conv ON conv.id = m.conversation_id
      WHERE m.organization_id = ${ctx.organizationId} AND conv.company_id IS NOT NULL
      GROUP BY conv.company_id
    ) sub
    WHERE c.organization_id = ${ctx.organizationId} AND c.id = sub.company_id
      AND (c.last_interaction_at IS NULL OR c.last_interaction_at < sub.last_at)`
}
