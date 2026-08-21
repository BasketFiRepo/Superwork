import type { TenantContext } from '@superwork/db'
import { can, grantedScope, readCeiling, type Actor } from '@superwork/auth'
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

/**
 * What happens next with this person (ADR 0071).
 *
 * Derived, never stored. `contacts.next_step` and `contacts.next_step_at` existed from 0010 and
 * nothing ever wrote them; making them writable would have been a fourth place meaning "something
 * is owed", beside commitments, follow-ups and tasks, and reconciled with none of them. The
 * product already knows the answer — this is the query nobody had written.
 */
export interface ContactNextStep {
  /** Which already-true thing this is: a promise on the ledger, or a meeting in the diary. */
  source: 'commitment' | 'meeting'
  id: string
  what: string
  at: Date
  /** Who owes it, for a commitment. Null for a meeting, which nobody owes anybody. */
  direction: 'we_owe' | 'they_owe' | null
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
  nextStep: ContactNextStep | null
  mergedIntoContactId: string | null
}

/** The flat shape the query returns; `withNextStep` folds the five columns into one field. */
interface ContactRow extends Omit<ContactView, 'nextStep'> {
  nextSource: ContactNextStep['source'] | null
  nextId: string | null
  nextWhat: string | null
  nextAt: Date | null
  nextDirection: ContactNextStep['direction']
}

function withNextStep(row: ContactRow): ContactView {
  const { nextSource, nextId, nextWhat, nextAt, nextDirection, ...rest } = row
  return {
    ...rest,
    nextStep:
      nextSource && nextId && nextWhat && nextAt
        ? { source: nextSource, id: nextId, what: nextWhat, at: nextAt, direction: nextDirection }
        : null,
  }
}

/**
 * The soonest of the two things that are already true about this person.
 *
 * An **outstanding promise** they are the counterparty to — `confirmed` is what this codebase
 * means by outstanding everywhere else (`commitmentHealth` counts exactly these), so a proposal
 * nobody has accepted is not a next step, and a kept or cancelled one is not next.
 *
 * A **meeting they are coming to**, which has to be in the future to be a next step at all.
 *
 * A commitment does not: a date that has passed on a promise is still what is next with the
 * person — it is what is next *and late* — whereas a meeting that has happened is history.
 * That asymmetry is the point, so the overdue promise sorts first.
 */
const SELECT_CONTACT = (ctx: TenantContext) => ctx.sql`
  SELECT ct.id, ct.name, ct.emails, ct.phones, ct.title, ct.seniority,
         ct.company_id AS "companyId", co.name AS "companyName",
         ct.owner_id AS "ownerId", u.name AS "ownerName",
         ct.preferred_channel AS "preferredChannel", ct.timezone,
         ct.last_interaction_at AS "lastInteractionAt",
         ns.next_source AS "nextSource", ns.next_id AS "nextId", ns.next_what AS "nextWhat",
         ns.next_at AS "nextAt", ns.next_direction AS "nextDirection",
         ct.merged_into_contact_id AS "mergedIntoContactId"
  FROM contacts ct
  LEFT JOIN companies co ON co.id = ct.company_id
  LEFT JOIN users u ON u.id = ct.owner_id
  LEFT JOIN LATERAL (
    SELECT step.next_source, step.next_id, step.next_what, step.next_at, step.next_direction
    FROM (
      SELECT 'commitment'::text AS next_source, cm.id AS next_id, cm.obligation AS next_what,
             cm.due_at AS next_at, cm.direction::text AS next_direction
        FROM commitments cm
       WHERE cm.organization_id = ct.organization_id
         AND cm.counterparty_contact_id = ct.id
         AND cm.deleted_at IS NULL
         AND cm.status = 'confirmed'
         AND cm.due_at IS NOT NULL
      UNION ALL
      SELECT 'meeting'::text AS next_source, m.id AS next_id, m.title AS next_what,
             m.starts_at AS next_at, NULL::text AS next_direction
        FROM meeting_participants mp
        JOIN meetings m ON m.id = mp.meeting_id AND m.organization_id = mp.organization_id
       WHERE mp.organization_id = ct.organization_id
         AND mp.contact_id = ct.id
         AND mp.deleted_at IS NULL
         AND m.deleted_at IS NULL
         AND m.status = 'scheduled'
         AND m.starts_at >= now()
    ) step
    ORDER BY step.next_at
    LIMIT 1
  ) ns ON true`

export async function listContacts(
  ctx: TenantContext,
  actor: Actor,
  filter: { companyId?: string; search?: string; includeMerged?: boolean; limit?: number } = {},
): Promise<ContactView[]> {
  const decision = can(actor, 'contact:read', { type: 'contact', organizationId: ctx.organizationId })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const sql = ctx.sql
  const rows = await sql<ContactRow[]>`
    ${SELECT_CONTACT(ctx)}
    WHERE ct.organization_id = ${ctx.organizationId} AND ct.deleted_at IS NULL
      ${filter.includeMerged ? sql`` : sql`AND ct.merged_into_contact_id IS NULL`}
      ${filter.companyId ? sql`AND ct.company_id = ${filter.companyId}` : sql``}
      ${filter.search ? sql`AND ct.name ILIKE ${'%' + filter.search + '%'}` : sql``}
    ORDER BY ct.name
    LIMIT ${Math.min(filter.limit ?? 100, 200)}`
  return rows.map(withNextStep)
}

export async function getContact(ctx: TenantContext, actor: Actor, id: string): Promise<ContactView> {
  const [row] = await ctx.sql<ContactRow[]>`
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
  return withNextStep(row)
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

  // Gated once at the top and then trusted, this aggregate handed over every task and
  // document filed under the company — including ones the reader could not open from their
  // own screens. One check on the company is not a check on six kinds of record, and a
  // company share (ADR 0025) would have made that an easy way in.
  const taskScope = grantedScope(actor, 'task:read', 'task')
  const openTasks = taskScope === null
    ? []
    : await sql<{ id: string; title: string; dueAt: Date | null; assigneeName: string | null }[]>`
        SELECT t.id, t.title, t.due_at AS "dueAt", u.name AS "assigneeName"
        FROM tasks t
        JOIN projects p ON p.id = t.project_id
        LEFT JOIN users u ON u.id = t.assignee_id
        WHERE t.organization_id = ${ctx.organizationId} AND p.company_id = ${companyId}
          AND t.deleted_at IS NULL AND t.status NOT IN ('completed', 'cancelled')
          ${
            taskScope === 'org'
              ? sql``
              : taskScope === 'department'
                ? sql`AND t.department_id = ANY(${actor.departmentIds}::uuid[])`
                : taskScope === 'team'
                  ? sql`AND t.team_id = ANY(${actor.teamIds}::uuid[])`
                  : sql`AND (t.assignee_id = ${actor.userId} OR t.created_by = ${actor.userId})`
          }
        ORDER BY t.due_at NULLS LAST LIMIT 20`

  const recentMeetings = await sql<{ id: string; title: string; startsAt: Date }[]>`
    SELECT id, title, starts_at AS "startsAt" FROM meetings
    WHERE organization_id = ${ctx.organizationId} AND company_id = ${companyId} AND deleted_at IS NULL
    ORDER BY starts_at DESC LIMIT 5`

  // A title is content. A `restricted` contract listed here by name told a reader who
  // could not open it that it exists and what it is called.
  const documents = await sql<{ id: string; title: string; docType: string }[]>`
    SELECT id, title, doc_type AS "docType" FROM documents
    WHERE organization_id = ${ctx.organizationId} AND company_id = ${companyId}
      AND deleted_at IS NULL AND index_status = 'indexed'
      AND sensitivity <= ${readCeiling(actor)}::sw_sensitivity
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

/**
 * What was said, and when (ADR 0057).
 *
 * The relationship timeline, and the thing `last_interaction_at` is derived from — so this is
 * also what the quiet-account watcher acts on. It was reachable through `log_interaction@v1` and
 * from nowhere else, which meant a person who rang a customer this morning could watch the
 * product decide the account had gone quiet.
 *
 * It had **no permission check at all**. That was survivable while the only caller was a tool
 * with `requiredPermissions` of its own; it stops being survivable the moment a person-facing
 * route calls it. The gate here is the same one the tool declares — `note:create` — so the two
 * layers cannot disagree about who may write to the timeline (§4.2).
 */
export const INTERACTION_KINDS = ['email', 'call', 'meeting', 'note', 'task'] as const
export type InteractionKind = (typeof INTERACTION_KINDS)[number]

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
  const decision = can(actor, 'note:create', {
    type: 'note',
    organizationId: ctx.organizationId,
    ownerId: actor.userId,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const summary = input.summary.trim()
  if (summary.length < 3) {
    throw new ValidationError('Say what happened, in a sentence somebody else could act on.')
  }
  if (summary.length > 2000) throw new ValidationError('That is longer than a note needs to be.')

  if (!INTERACTION_KINDS.includes(input.kind as InteractionKind)) {
    throw new ValidationError(`An interaction is one of: ${INTERACTION_KINDS.join(', ')}.`)
  }

  if (!input.companyId && !input.contactId) {
    throw new ValidationError(
      'An interaction has to be about a company or a person. One attached to neither is a note ' +
        'nothing would ever show.',
    )
  }

  // Not a CHECK: a constraint cannot call `now()`, and a row that was legitimate when written
  // must not become invalid as the clock passes it.
  const occurredAt = input.occurredAt ?? new Date()
  if (occurredAt.getTime() > Date.now() + 60_000) {
    throw new ValidationError('That is in the future. Log it after it happens.')
  }

  if (input.companyId) {
    const [company] = await ctx.sql<{ id: string }[]>`
      SELECT id FROM companies
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.companyId} AND deleted_at IS NULL`
    if (!company) throw new NotFoundError()
  }
  if (input.contactId) {
    const [contact] = await ctx.sql<{ id: string }[]>`
      SELECT id FROM contacts
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.contactId} AND deleted_at IS NULL`
    if (!contact) throw new NotFoundError()
  }

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO interactions (
      organization_id, company_id, contact_id, user_id, kind, direction, summary,
      occurred_at, source_type, source_id, agent_run_id, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.companyId ?? null}, ${input.contactId ?? null}, ${actor.userId},
      ${input.kind}, ${input.direction ?? null}, ${summary},
      ${occurredAt}, ${input.sourceType ?? null}, ${input.sourceId ?? null},
      ${input.agentRunId ?? null}, ${ctx.userId}
    ) RETURNING id`

  if (input.companyId) {
    await ctx.sql`
      UPDATE companies SET last_interaction_at = GREATEST(
        coalesce(last_interaction_at, 'epoch'::timestamptz), ${occurredAt})
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.companyId}`
  }
  if (input.contactId) {
    await ctx.sql`
      UPDATE contacts SET last_interaction_at = GREATEST(
        coalesce(last_interaction_at, 'epoch'::timestamptz), ${occurredAt})
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.contactId}`
  }

  // On the feed, so a colleague about to ring the same customer knows somebody already has.
  // Deliberately no audit record: the interaction *is* the record, and it already carries who
  // logged it and when. A second row saying the same thing would be ceremony.
  if (input.companyId) {
    const [company] = await ctx.sql<{ name: string }[]>`
      SELECT name FROM companies
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.companyId}`
    await writeActivity(ctx, {
      actorType: actor.type,
      actorUserId: actor.userId,
      actorLabel: actor.displayName,
      verb: 'logged',
      entityType: 'company',
      entityId: input.companyId,
      entityLabel: company?.name ?? 'a company',
      summary: `${input.kind} with ${company?.name ?? 'a company'}: ${summary.slice(0, 160)}`,
      ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
    })
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

// ---------------------------------------------------------------------------
// Adding a customer, and keeping the record true (ADR 0056)
// ---------------------------------------------------------------------------

/**
 * The health of an account, as the screen shows it. Kept here and in a CHECK: the column had no
 * vocabulary at all, so it could have held anything the day something started writing it.
 */
export const HEALTH_STATUSES = ['unknown', 'healthy', 'at_risk', 'critical'] as const
export type HealthStatus = (typeof HEALTH_STATUSES)[number]

export const COMPANY_TYPES = ['customer', 'vendor', 'partner', 'prospect', 'other'] as const

/** What a domain has to look like to match an address. The database holds the same rule. */
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const EMAIL = /^[^@\s]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

function normalizeDomains(raw: string[] | undefined): string[] {
  return [...new Set((raw ?? []).map((entry) => entry.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))]
}

function normalizeEmails(raw: string[] | undefined): string[] {
  return [...new Set((raw ?? []).map((entry) => entry.trim().toLowerCase()).filter(Boolean))]
}

/**
 * Adds a company.
 *
 * The interesting rule is the domain list. `companyForAddress` splits an inbound address at the
 * `@` and looks the remainder up here, so a second company claiming a domain makes the answer to
 * "whose customer is this?" arbitrary — and nothing would ever say so. It is refused, naming the
 * company that already has it, rather than left to whichever row the planner returns first.
 */
export async function createCompany(
  ctx: TenantContext,
  actor: Actor,
  input: {
    name: string
    type?: string
    legalName?: string | null
    industry?: string | null
    sizeBand?: string | null
    domains?: string[]
    ownerId?: string | null
    sensitivity?: string
  },
): Promise<CompanyView> {
  const sensitivity = input.sensitivity ?? 'internal'
  const decision = can(actor, 'company:create', {
    type: 'company',
    organizationId: ctx.organizationId,
    // The row this will become, so an `own`-scoped grant is judged against the right owner
    // (ADR 0045): a create check that does not say who will own it is checking nothing.
    ownerId: input.ownerId ?? actor.userId,
    sensitivity: sensitivity as never,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const name = input.name.trim()
  if (name.length < 2) throw new ValidationError('A company needs a name somebody would recognise.')
  if (name.length > 200) throw new ValidationError('That is longer than a name needs to be.')

  const type = input.type ?? 'customer'
  if (!COMPANY_TYPES.includes(type as (typeof COMPANY_TYPES)[number])) {
    throw new ValidationError(`A company is one of: ${COMPANY_TYPES.join(', ')}.`)
  }

  // Nobody may file a record they could not then read. That rule is not repeated here: the
  // classification is handed to `can()` above, and the policy engine already refuses it against
  // the actor's ceiling — with a better sentence than a second copy would produce. Documents
  // need their own check (ADR 0045) because there the level comes from a classifier reading the
  // content rather than from the caller.
  const domains = normalizeDomains(input.domains)
  for (const domain of domains) {
    if (!DOMAIN.test(domain)) {
      throw new ValidationError(
        `“${domain}” is not a domain mail can be matched on. It looks like northwind.example — ` +
          'no @, and at least one dot.',
      )
    }
  }

  const [existing] = await ctx.sql<{ name: string }[]>`
    SELECT name FROM companies
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
      AND lower(btrim(name)) = lower(${name})`
  if (existing) {
    throw new ConflictError(`There is already a company called “${existing.name}”.`)
  }

  if (domains.length > 0) {
    const [clash] = await ctx.sql<{ name: string; domains: string[] }[]>`
      SELECT name, domains FROM companies
      WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
        AND domains && ${domains}`
    if (clash) {
      const shared = clash.domains.filter((domain) => domains.includes(domain))
      throw new ConflictError(
        `“${clash.name}” already receives mail from ${shared.join(', ')}. Two companies on one ` +
          'domain would make it a coin toss which of them a message belongs to.',
      )
    }
  }

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO companies (
      organization_id, name, legal_name, type, industry, size_band, domains, owner_id,
      sensitivity, created_by
    ) VALUES (
      ${ctx.organizationId}, ${name}, ${input.legalName?.trim() || null}, ${type}::sw_company_type,
      ${input.industry?.trim() || null}, ${input.sizeBand?.trim() || null}, ${domains},
      ${input.ownerId ?? actor.userId}, ${sensitivity}::sw_sensitivity, ${actor.userId}
    ) RETURNING id`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'company.created',
    entityType: 'company',
    entityId: row!.id,
    before: null,
    after: { name, type, domains, sensitivity },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'added',
    entityType: 'company',
    entityId: row!.id,
    entityLabel: name,
    summary:
      `${name} was added as a ${type}.` +
      (domains.length ? ` Mail from ${domains.join(', ')} will be attributed to them.` : ''),
  })

  return getCompany(ctx, actor, row!.id)
}

/**
 * Changes one.
 *
 * The three numbers here are what watchers act on — how long a thread may go unanswered, how long
 * the account may go quiet, and how it is doing — and they have run on the column defaults for
 * every company in every organization since Phase 0.
 */
export async function updateCompany(
  ctx: TenantContext,
  actor: Actor,
  input: {
    id: string
    name?: string
    legalName?: string | null
    type?: string
    industry?: string | null
    sizeBand?: string | null
    domains?: string[]
    ownerId?: string | null
    healthStatus?: string
    replySlaDays?: number
    checkInDays?: number
    contractRenewsOn?: string | null
  },
): Promise<CompanyView> {
  const before = await getCompany(ctx, actor, input.id)

  const decision = can(actor, 'company:update', {
    type: 'company',
    organizationId: ctx.organizationId,
    id: input.id,
    ownerId: before.ownerId,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const name = input.name === undefined ? before.name : input.name.trim()
  if (name.length < 2) throw new ValidationError('A company needs a name somebody would recognise.')

  const type = input.type ?? before.type
  if (!COMPANY_TYPES.includes(type as (typeof COMPANY_TYPES)[number])) {
    throw new ValidationError(`A company is one of: ${COMPANY_TYPES.join(', ')}.`)
  }

  const healthStatus = input.healthStatus ?? before.healthStatus
  if (!HEALTH_STATUSES.includes(healthStatus as HealthStatus)) {
    throw new ValidationError(`An account is one of: ${HEALTH_STATUSES.join(', ')}.`)
  }

  const replySlaDays = input.replySlaDays ?? before.replySlaDays
  if (!Number.isInteger(replySlaDays) || replySlaDays < 1 || replySlaDays > 90) {
    throw new ValidationError(
      'A reply promise is between 1 and 90 days. Zero would mean chasing the moment a message ' +
        'arrives, for ever.',
    )
  }
  const checkInDays = input.checkInDays ?? before.checkInDays
  if (!Number.isInteger(checkInDays) || checkInDays < 1 || checkInDays > 365) {
    throw new ValidationError('A check-in window is between 1 and 365 days.')
  }

  const domains = input.domains === undefined ? before.domains : normalizeDomains(input.domains)
  for (const domain of domains) {
    if (!DOMAIN.test(domain)) {
      throw new ValidationError(
        `“${domain}” is not a domain mail can be matched on. It looks like northwind.example — ` +
          'no @, and at least one dot.',
      )
    }
  }
  if (domains.length > 0) {
    const [clash] = await ctx.sql<{ name: string; domains: string[] }[]>`
      SELECT name, domains FROM companies
      WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL AND id <> ${input.id}
        AND domains && ${domains}`
    if (clash) {
      const shared = clash.domains.filter((domain) => domains.includes(domain))
      throw new ConflictError(
        `“${clash.name}” already receives mail from ${shared.join(', ')}. Two companies on one ` +
          'domain would make it a coin toss which of them a message belongs to.',
      )
    }
  }

  if (input.name !== undefined && name.toLowerCase() !== before.name.toLowerCase()) {
    const [existing] = await ctx.sql<{ name: string }[]>`
      SELECT name FROM companies
      WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL AND id <> ${input.id}
        AND lower(btrim(name)) = lower(${name})`
    if (existing) throw new ConflictError(`There is already a company called “${existing.name}”.`)
  }

  const sql = ctx.sql
  await sql`
    UPDATE companies
    SET name = ${name},
        legal_name = ${input.legalName === undefined ? sql`legal_name` : input.legalName?.trim() || null},
        type = ${type}::sw_company_type,
        industry = ${input.industry === undefined ? sql`industry` : input.industry?.trim() || null},
        size_band = ${input.sizeBand === undefined ? sql`size_band` : input.sizeBand?.trim() || null},
        domains = ${domains},
        owner_id = ${input.ownerId === undefined ? sql`owner_id` : input.ownerId},
        health_status = ${healthStatus},
        reply_sla_days = ${replySlaDays},
        check_in_days = ${checkInDays},
        contract_renews_on = ${
          input.contractRenewsOn === undefined
            ? sql`contract_renews_on`
            : input.contractRenewsOn
              ? sql`${input.contractRenewsOn}::date`
              : null
        },
        updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.id}`

  const after = await getCompany(ctx, actor, input.id)
  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'company.updated',
    entityType: 'company',
    entityId: input.id,
    before: {
      name: before.name,
      type: before.type,
      domains: before.domains,
      healthStatus: before.healthStatus,
      replySlaDays: before.replySlaDays,
      checkInDays: before.checkInDays,
      ownerId: before.ownerId,
    },
    after: {
      name,
      type,
      domains,
      healthStatus,
      replySlaDays,
      checkInDays,
      ownerId: after.ownerId,
    },
  })

  // The health of an account is the one thing here other people act on, so it goes on the feed
  // rather than only into the audit log.
  if (before.healthStatus !== healthStatus) {
    await writeActivity(ctx, {
      actorType: actor.type,
      actorUserId: actor.userId,
      actorLabel: actor.displayName,
      verb: 'marked',
      entityType: 'company',
      entityId: input.id,
      entityLabel: name,
      summary: `${name} is now ${healthStatus.replace('_', ' ')}, was ${before.healthStatus.replace('_', ' ')}.`,
    })
  }

  return after
}

/**
 * Adds a contact.
 *
 * A duplicate address is *not* refused. Two records for the same person is what the merge queue
 * exists to notice (§8.4), and refusing the row would remove the thing that queue works on. So
 * the queue is asked to look immediately after the row lands: the duplicate surfaces as something
 * a person resolves, with both records in front of them, rather than as a refusal at the moment
 * they were trying to write something down.
 */
export async function createContact(
  ctx: TenantContext,
  actor: Actor,
  input: {
    name: string
    companyId?: string | null
    emails?: string[]
    title?: string | null
    seniority?: string | null
    ownerId?: string | null
    sensitivity?: string
  },
): Promise<ContactView> {
  const sensitivity = input.sensitivity ?? 'internal'
  const decision = can(actor, 'contact:create', {
    type: 'contact',
    organizationId: ctx.organizationId,
    ownerId: input.ownerId ?? actor.userId,
    sensitivity: sensitivity as never,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const name = input.name.trim()
  if (name.length < 2) throw new ValidationError('A contact needs a name somebody would recognise.')

  // The ceiling is the engine's, as above.
  const emails = normalizeEmails(input.emails)
  for (const address of emails) {
    if (!EMAIL.test(address)) {
      throw new ValidationError(`“${address}” is not an email address.`)
    }
  }

  if (input.companyId) {
    const [company] = await ctx.sql<{ id: string }[]>`
      SELECT id FROM companies
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.companyId} AND deleted_at IS NULL`
    if (!company) throw new NotFoundError()
  }

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO contacts (
      organization_id, company_id, name, emails, title, seniority, owner_id, sensitivity, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.companyId ?? null}, ${name}, ${emails},
      ${input.title?.trim() || null}, ${input.seniority?.trim() || null},
      ${input.ownerId ?? actor.userId}, ${sensitivity}::sw_sensitivity, ${actor.userId}
    ) RETURNING id`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'contact.created',
    entityType: 'contact',
    entityId: row!.id,
    before: null,
    after: { name, emails, companyId: input.companyId ?? null },
  })

  // The same sweep the nervous system runs, asked now rather than on its own cadence: a person
  // who has just typed an address that already exists should see that while they remember why.
  if (emails.length > 0) await detectDuplicateContacts(ctx, actor)

  return getContact(ctx, actor, row!.id)
}
