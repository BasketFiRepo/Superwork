import type { Sql, TenantContext } from '@superwork/db'
import { can, ROLE_MAX_SENSITIVITY, SENSITIVITY_RANK, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from './errors.js'
import { writeAudit } from './audit.js'

/**
 * Agent memory (§9.3).
 *
 * `memory_facts` has existed since migration 0006 with a complete design and no writer.
 * Two live paths read it — `deleteDocument` counts the memories a deletion forgets, and
 * `purgeDocument` forgets them — so both have been reporting zero about an empty table,
 * and the README's promise that deleting a document takes "any memories the assistant
 * formed from it" has been true only in the way an empty set makes anything true.
 *
 * The design here is shaped by what makes a remembered fact safe rather than by what
 * makes it easy:
 *
 *   Nothing is remembered without a source. Every fact carries the document passage it
 *   came from, checked to resolve at the moment it is proposed. A memory whose citation
 *   does not resolve is refused, not stored with a warning.
 *
 *   Nothing is remembered without a person. A candidate is what the assistant noticed; a
 *   confirmed fact is what somebody agreed with. Only confirmed facts are recalled. The
 *   assistant is never permitted to promote its own observation into company knowledge,
 *   because the failure mode — one wrong inference quietly becoming the thing every later
 *   answer is built on — is the whole reason people distrust systems that "learn".
 *
 *   Recall is bound by the same ACL as retrieval. A memory is a compressed quotation of
 *   its source, so recalling one to somebody who may not read that source would make this
 *   table a hole straight through the document permissions the retrieval layer applies in
 *   both of its arms.
 *
 *   Contradiction is impossible rather than flagged. The database holds at most one
 *   confirmed answer per subject and predicate in a scope, so changing what is known is
 *   necessarily a supersession — leaving the old answer, the new one, and who changed
 *   their mind, all on the record.
 */

/** A fact about something that moves. Recalled with its date, and re-asked for eventually. */
export const VOLATILE_MAX_AGE_DAYS = 90

export type MemoryState = 'candidate' | 'confirmed' | 'superseded' | 'forgotten'
export type MemoryScope = 'organization' | 'department' | 'project' | 'company' | 'user'

export interface MemoryCitation {
  documentId: string
  anchor: string
  documentTitle?: string
  snippet?: string
}

export interface MemoryFact {
  id: string
  scope: MemoryScope
  scopeId: string | null
  scopeLabel: string
  subject: string
  predicate: string
  object: string
  confidence: number
  state: MemoryState
  volatile: boolean
  /** True when this fact is confirmed but old enough that it should be asked about again. */
  stale: boolean
  citation: MemoryCitation | null
  sourceRunId: string | null
  supersedesId: string | null
  confirmedByName: string | null
  validFrom: Date
  validTo: Date | null
  createdAt: Date
}

interface MemoryRow {
  id: string
  scope: MemoryScope
  scope_id: string | null
  scope_label: string | null
  subject: string
  predicate: string
  object: string
  confidence: string
  state: MemoryState
  volatile: boolean
  source_citation: MemoryCitation | null
  source_run_id: string | null
  supersedes_id: string | null
  confirmed_by_name: string | null
  valid_from: Date
  valid_to: Date | null
  created_at: Date
}

function toFact(row: MemoryRow, now: Date): MemoryFact {
  const ageDays = (now.getTime() - row.valid_from.getTime()) / 86_400_000
  return {
    id: row.id,
    scope: row.scope,
    scopeId: row.scope_id,
    scopeLabel: row.scope_label ?? 'the whole organization',
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    confidence: Number(row.confidence),
    state: row.state,
    volatile: row.volatile,
    stale: row.state === 'confirmed' && row.volatile && ageDays > VOLATILE_MAX_AGE_DAYS,
    citation: row.source_citation,
    sourceRunId: row.source_run_id,
    supersedesId: row.supersedes_id,
    confirmedByName: row.confirmed_by_name,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    createdAt: row.created_at,
  }
}

function guard(ctx: TenantContext, actor: Actor, action: 'read' | 'update'): void {
  const decision = can(actor, `knowledge:${action}`, {
    type: 'knowledge',
    organizationId: ctx.organizationId,
    riskTier: action === 'read' ? 'read' : 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
}

/**
 * The predicate that keeps a memory inside the permissions of the document it came from.
 *
 * A memory is a compressed quotation. Recalling one is disclosing its source in shorter
 * words, so it is gated by the source: the document must still exist, still be indexed,
 * be within the actor's sensitivity ceiling, and — if it carries explicit grants — name
 * this actor among them. This is deliberately the same shape as the ACL in `hybridSearch`,
 * and it is applied to the document the citation points at rather than to the memory row,
 * because the memory row has no sensitivity of its own to be wrong about.
 */
function readableSource(sql: Sql, ctx: TenantContext, actor: Actor) {
  const ceiling = actor.agent
    ? (SENSITIVITY_RANK[ROLE_MAX_SENSITIVITY[actor.role]] <= SENSITIVITY_RANK[actor.agent.maxSensitivity]
        ? ROLE_MAX_SENSITIVITY[actor.role]
        : actor.agent.maxSensitivity)
    : ROLE_MAX_SENSITIVITY[actor.role]

  return sql`EXISTS (
    SELECT 1 FROM documents d
    WHERE d.organization_id = ${ctx.organizationId}
      AND d.id = (m.source_citation->>'documentId')::uuid
      AND d.deleted_at IS NULL
      AND d.index_status = 'indexed'
      AND d.quarantine_reason IS NULL
      AND CASE d.sensitivity
            WHEN 'public' THEN 0 WHEN 'internal' THEN 1
            WHEN 'confidential' THEN 2 ELSE 3 END <= ${SENSITIVITY_RANK[ceiling]}
      AND (
        NOT EXISTS (SELECT 1 FROM document_permissions dp WHERE dp.document_id = d.id AND dp.deleted_at IS NULL)
        OR EXISTS (
          SELECT 1 FROM document_permissions dp
          WHERE dp.document_id = d.id AND dp.deleted_at IS NULL
            AND (
              (dp.subject_type = 'user' AND dp.subject_id = ${actor.userId})
              OR (dp.subject_type = 'department' AND dp.subject_id = ANY(${actor.departmentIds}::uuid[]))
              OR (dp.subject_type = 'team' AND dp.subject_id = ANY(${actor.teamIds}::uuid[]))
              OR (dp.subject_type = 'role' AND dp.subject_role = ${actor.role}::sw_role)
            )
        )
      )
  )`
}

const SCOPE_LABEL = (sql: Sql) => sql`
  CASE m.scope
    WHEN 'organization' THEN NULL
    WHEN 'company'      THEN (SELECT c.name FROM companies c WHERE c.id = m.scope_id)
    WHEN 'project'      THEN (SELECT p.name FROM projects p WHERE p.id = m.scope_id)
    WHEN 'department'   THEN (SELECT dep.name FROM departments dep WHERE dep.id = m.scope_id)
    WHEN 'user'         THEN (SELECT u2.name FROM users u2 WHERE u2.id = m.scope_id)
  END`

/**
 * What the assistant may treat as known, for this actor, right now.
 *
 * Only confirmed facts, only where the source is still readable by this actor, and never
 * one whose validity has run out. Volatile facts are returned with their age so the answer
 * can say when it was last agreed rather than stating a moving number flatly.
 */
export async function recallMemories(
  ctx: TenantContext,
  actor: Actor,
  options: { scopeIds?: string[]; limit?: number; now?: Date } = {},
): Promise<MemoryFact[]> {
  guard(ctx, actor, 'read')
  const sql = ctx.sql
  const now = options.now ?? new Date()
  const scopeIds = options.scopeIds ?? []

  const rows = await sql<MemoryRow[]>`
    SELECT m.id, m.scope, m.scope_id, ${SCOPE_LABEL(sql)} AS scope_label,
           m.subject, m.predicate, m.object, m.confidence, m.state, m.volatile,
           m.source_citation, m.source_run_id, m.supersedes_id,
           (SELECT u.name FROM users u WHERE u.id = m.confirmed_by) AS confirmed_by_name,
           m.valid_from, m.valid_to, m.created_at
    FROM memory_facts m
    WHERE m.organization_id = ${ctx.organizationId}
      AND m.deleted_at IS NULL
      AND m.state = 'confirmed'
      AND m.valid_from <= ${now}
      AND (m.valid_to IS NULL OR m.valid_to > ${now})
      AND (m.scope = 'organization'${scopeIds.length ? sql` OR m.scope_id = ANY(${scopeIds}::uuid[])` : sql``})
      AND ${readableSource(sql, ctx, actor)}
    ORDER BY m.scope = 'organization', m.confidence DESC, m.valid_from DESC
    LIMIT ${Math.min(options.limit ?? 24, 100)}`

  return rows.map((row) => toFact(row, now))
}

export interface MemoryCandidate {
  scope: MemoryScope
  scopeId?: string | null
  subject: string
  predicate: string
  object: string
  confidence?: number
  volatile?: boolean
  /** Index into the run's grounded knowledge. The citation is resolved from it, never taken. */
  knowledgeIndex: number
}

export interface ProposeResult {
  stored: number
  /** Candidates that were not stored, and the reason in the words a person would use. */
  refused: { subject: string; predicate: string; reason: string }[]
}

/**
 * Records what a run noticed, as candidates for somebody to agree with.
 *
 * Nothing here trusts the model with a fact. The triple is text the model produced, but
 * the *source* is resolved from the run's own grounding by index — so a model that invents
 * a document id cannot store one, and a model that cites a passage the run never retrieved
 * cannot either. Anything that fails to resolve is refused with a reason rather than
 * stored at lower confidence, because a memory nobody can trace is worse than no memory.
 */
export async function proposeMemories(
  ctx: TenantContext,
  input: {
    runId: string
    knowledge: { documentId: string; documentTitle: string; anchor: string; content: string }[]
    candidates: MemoryCandidate[]
  },
): Promise<ProposeResult> {
  const sql = ctx.sql
  const refused: ProposeResult['refused'] = []
  let stored = 0

  for (const candidate of input.candidates.slice(0, 8)) {
    const subject = candidate.subject?.trim() ?? ''
    const predicate = candidate.predicate?.trim() ?? ''
    const object = candidate.object?.trim() ?? ''
    const label = { subject, predicate }

    if (!subject || !predicate || !object) {
      refused.push({ ...label, reason: 'It was not a complete statement about anything.' })
      continue
    }
    if (object.length > 500) {
      refused.push({ ...label, reason: 'A remembered fact is a sentence, not a passage. Cite the document instead.' })
      continue
    }

    const chunk = input.knowledge[candidate.knowledgeIndex]
    if (!chunk) {
      // The one refusal that matters: a source the run did not actually read.
      refused.push({ ...label, reason: 'It cited a passage this run never retrieved.' })
      continue
    }
    if (candidate.scope !== 'organization' && !candidate.scopeId) {
      refused.push({ ...label, reason: `A ${candidate.scope} fact has to say which ${candidate.scope}.` })
      continue
    }

    const citation: MemoryCitation = {
      documentId: chunk.documentId,
      anchor: chunk.anchor,
      documentTitle: chunk.documentTitle,
      snippet: chunk.content.slice(0, 400),
    }

    // Does this contradict something already agreed? Not stored differently — stored the
    // same way and marked, so the review screen can put the two side by side and ask.
    const [existing] = await sql<{ id: string; object: string }[]>`
      SELECT id, object FROM memory_facts
      WHERE organization_id = ${ctx.organizationId} AND state = 'confirmed' AND deleted_at IS NULL
        AND scope = ${candidate.scope}
        AND coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = coalesce(${candidate.scopeId ?? null}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        AND lower(btrim(subject)) = lower(${subject}) AND lower(btrim(predicate)) = lower(${predicate})`

    if (existing && existing.object.trim().toLowerCase() === object.toLowerCase()) {
      // Already known and already agreed. Noticing it again is not new knowledge.
      refused.push({ ...label, reason: 'Already remembered, and unchanged.' })
      continue
    }

    // An identical candidate already waiting for somebody is not a second candidate.
    const [pending] = await sql<{ id: string }[]>`
      SELECT id FROM memory_facts
      WHERE organization_id = ${ctx.organizationId} AND state = 'candidate' AND deleted_at IS NULL
        AND scope = ${candidate.scope}
        AND coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = coalesce(${candidate.scopeId ?? null}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        AND lower(btrim(subject)) = lower(${subject}) AND lower(btrim(predicate)) = lower(${predicate})
        AND lower(btrim(object)) = lower(${object})`
    if (pending) {
      refused.push({ ...label, reason: 'Already waiting for somebody to agree with it.' })
      continue
    }

    await sql`
      INSERT INTO memory_facts (
        organization_id, scope, scope_id, subject, predicate, object, confidence, state,
        volatile, source_run_id, source_citation, conflict_flagged, created_by
      ) VALUES (
        ${ctx.organizationId}, ${candidate.scope}, ${candidate.scopeId ?? null},
        ${subject}, ${predicate}, ${object},
        ${Math.min(Math.max(candidate.confidence ?? 0.5, 0), 1)}, 'candidate',
        ${candidate.volatile ?? false}, ${input.runId}, ${sql.json(citation as never)},
        ${Boolean(existing)}, ${ctx.userId}
      )`
    stored += 1
  }

  return { stored, refused }
}

export interface MemoryListing {
  candidates: MemoryFact[]
  confirmed: MemoryFact[]
  /** Confirmed facts a candidate now contradicts, paired with the candidate contradicting them. */
  conflicts: { candidate: MemoryFact; confirmed: MemoryFact }[]
  stale: MemoryFact[]
}

export async function listMemories(ctx: TenantContext, actor: Actor, now = new Date()): Promise<MemoryListing> {
  guard(ctx, actor, 'read')
  const sql = ctx.sql

  const rows = await sql<(MemoryRow & { conflict_flagged: boolean })[]>`
    SELECT m.id, m.scope, m.scope_id, ${SCOPE_LABEL(sql)} AS scope_label,
           m.subject, m.predicate, m.object, m.confidence, m.state, m.volatile,
           m.source_citation, m.source_run_id, m.supersedes_id, m.conflict_flagged,
           (SELECT u.name FROM users u WHERE u.id = m.confirmed_by) AS confirmed_by_name,
           m.valid_from, m.valid_to, m.created_at
    FROM memory_facts m
    WHERE m.organization_id = ${ctx.organizationId} AND m.deleted_at IS NULL
      AND m.state IN ('candidate', 'confirmed')
      AND ${readableSource(sql, ctx, actor)}
    ORDER BY m.created_at DESC
    LIMIT 400`

  const facts = rows.map((row) => ({ ...toFact(row, now), conflictFlagged: row.conflict_flagged }))
  const candidates = facts.filter((fact) => fact.state === 'candidate')
  const confirmed = facts.filter((fact) => fact.state === 'confirmed')

  const conflicts: MemoryListing['conflicts'] = []
  for (const candidate of candidates.filter((fact) => fact.conflictFlagged)) {
    const against = confirmed.find(
      (fact) =>
        fact.scope === candidate.scope &&
        fact.scopeId === candidate.scopeId &&
        fact.subject.trim().toLowerCase() === candidate.subject.trim().toLowerCase() &&
        fact.predicate.trim().toLowerCase() === candidate.predicate.trim().toLowerCase(),
    )
    if (against) conflicts.push({ candidate, confirmed: against })
  }

  return {
    candidates,
    confirmed,
    conflicts,
    stale: confirmed.filter((fact) => fact.stale),
  }
}

async function loadOne(ctx: TenantContext, id: string): Promise<MemoryRow & { conflict_flagged: boolean }> {
  const sql = ctx.sql
  const [row] = await sql<(MemoryRow & { conflict_flagged: boolean })[]>`
    SELECT m.id, m.scope, m.scope_id, ${SCOPE_LABEL(sql)} AS scope_label,
           m.subject, m.predicate, m.object, m.confidence, m.state, m.volatile,
           m.source_citation, m.source_run_id, m.supersedes_id, m.conflict_flagged,
           (SELECT u.name FROM users u WHERE u.id = m.confirmed_by) AS confirmed_by_name,
           m.valid_from, m.valid_to, m.created_at
    FROM memory_facts m
    WHERE m.organization_id = ${ctx.organizationId} AND m.id = ${id} AND m.deleted_at IS NULL`
  if (!row) throw new NotFoundError()
  return row
}

/**
 * Agrees with a candidate. This is the only way anything enters recall, and it is always a
 * person: `confirmed_by` is NOT NULL by constraint, and an agent actor is refused here
 * because an assistant confirming its own observation is how a wrong inference becomes the
 * foundation of every later answer.
 */
export async function confirmMemory(ctx: TenantContext, actor: Actor, id: string): Promise<MemoryFact> {
  guard(ctx, actor, 'update')
  if (actor.type !== 'user') {
    throw new PermissionError(
      'Only a person can agree that something is true. The assistant proposes; it does not decide.',
    )
  }

  const row = await loadOne(ctx, id)
  if (row.state !== 'candidate') {
    throw new ValidationError(`That is already ${row.state}, so there is nothing to agree with.`)
  }
  if (row.conflict_flagged) {
    throw new ValidationError(
      'Something else is already agreed for this. Correcting the existing fact is how it changes — ' +
        'that keeps the old answer and who changed their mind on the record.',
    )
  }

  await ctx.sql`
    UPDATE memory_facts SET state = 'confirmed', confirmed_by = ${actor.userId}, valid_from = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${id}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'memory.confirmed',
    entityType: 'memory_fact',
    entityId: id,
    before: { state: 'candidate' },
    after: { state: 'confirmed', fact: `${row.subject} — ${row.predicate} — ${row.object}` },
  })
  return toFact(await loadOne(ctx, id), new Date())
}

/**
 * Changes what is known, by superseding rather than editing. The old row stays, marked
 * superseded and closed off at the moment it stopped being true; the new one points back
 * at it. "What did we think last quarter, and who changed it" stays answerable.
 */
export async function correctMemory(
  ctx: TenantContext,
  actor: Actor,
  input: { id: string; object: string; reason: string },
): Promise<MemoryFact> {
  guard(ctx, actor, 'update')
  if (actor.type !== 'user') {
    throw new PermissionError('Only a person can change what the organization takes to be true.')
  }
  const object = input.object.trim()
  if (!object) throw new ValidationError('Say what it should be instead.')
  if (input.reason.trim().length < 4) {
    throw new ValidationError('Say why it changed. It goes in the audit trail beside the old answer.')
  }

  const row = await loadOne(ctx, input.id)
  if (row.state === 'forgotten') throw new ValidationError('That has been forgotten. There is nothing to correct.')

  const sql = ctx.sql
  // Close the old one first: the unique index permits one confirmed answer per question,
  // so the order here is what makes the correction possible rather than a violation.
  await sql`
    UPDATE memory_facts SET state = 'superseded', valid_to = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.id}`

  const [created] = await sql<{ id: string }[]>`
    INSERT INTO memory_facts (
      organization_id, scope, scope_id, subject, predicate, object, confidence, state,
      volatile, source_run_id, source_citation, supersedes_id, confirmed_by, created_by
    ) VALUES (
      ${ctx.organizationId}, ${row.scope}, ${row.scope_id}, ${row.subject}, ${row.predicate}, ${object},
      1.0, 'confirmed', ${row.volatile}, ${row.source_run_id}, ${sql.json(row.source_citation as never)},
      ${input.id}, ${actor.userId}, ${ctx.userId}
    ) RETURNING id`

  // Any other candidate asking the same question is answered now.
  await sql`
    UPDATE memory_facts SET state = 'forgotten', conflict_flagged = false, valid_to = now()
    WHERE organization_id = ${ctx.organizationId} AND state = 'candidate' AND deleted_at IS NULL
      AND scope = ${row.scope}
      AND coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = coalesce(${row.scope_id}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
      AND lower(btrim(subject)) = lower(${row.subject}) AND lower(btrim(predicate)) = lower(${row.predicate})`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'memory.corrected',
    entityType: 'memory_fact',
    entityId: created!.id,
    before: { object: row.object },
    after: { object, reason: input.reason.trim(), supersedes: input.id },
  })
  return toFact(await loadOne(ctx, created!.id), new Date())
}

/**
 * Forgets a fact. Not a delete: the row stays until retention takes it, because "we used
 * to believe this and stopped" is a question somebody will ask about an answer the
 * assistant gave last month.
 */
export async function forgetMemory(
  ctx: TenantContext,
  actor: Actor,
  input: { id: string; reason: string },
): Promise<void> {
  guard(ctx, actor, 'update')
  if (input.reason.trim().length < 4) {
    throw new ValidationError('Say why it is being forgotten. It goes in the audit trail.')
  }
  const row = await loadOne(ctx, input.id)

  await ctx.sql`
    UPDATE memory_facts SET state = 'forgotten', conflict_flagged = false, valid_to = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.id}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'memory.forgotten',
    entityType: 'memory_fact',
    entityId: input.id,
    before: { state: row.state, fact: `${row.subject} — ${row.predicate} — ${row.object}` },
    after: { state: 'forgotten', reason: input.reason.trim() },
  })
}
