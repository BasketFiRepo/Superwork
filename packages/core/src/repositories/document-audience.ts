import type { Role, Sensitivity, TenantContext } from '@superwork/db'
import { can, ROLE_MAX_SENSITIVITY, SENSITIVITY_RANK, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'

/**
 * Who can find a document (§4.6, §17).
 *
 * `document_permissions` was created in migration 0004 and never written to, while being
 * read on every retrieval — both arms of `hybridSearch` and, since 0019, memory recall. Its
 * branch has been evaluated millions of times and has never matched anything.
 *
 * It is a different shape from the sharing that did get built, and the difference is the
 * point. A relation tuple is **additive**: it grants one person one relation on one object
 * and never takes anything away. A circulation list is **restrictive**: while it exists,
 * only the subjects on it may retrieve the document at all. An HR file or a signed contract
 * needs the second, and there was no way to express it.
 *
 * Three rules, and the first two are the ones that make it safe:
 *
 *   A list never widens anything. The sensitivity ceiling is applied separately and ANDed,
 *   so putting a member on the list for a restricted document does not let them retrieve
 *   it. The screen says so rather than appearing to work.
 *
 *   A list is not a bypass for anybody, including the owner. An owner who is not on the
 *   list cannot retrieve the document and will not see it cited in an answer. That is
 *   surprising, and it is what somebody restricting an HR file to three people means.
 *   They can still open the document's own page, which `can()` governs — those are two
 *   different questions and this table only answers the retrieval one.
 *
 *   Sharing and restricting must not disagree. `share()` on a document that has a list now
 *   adds the recipient to it, because otherwise "I shared it with you" and "the assistant
 *   cannot find it" are both true.
 */

export type AudienceSubject = 'user' | 'department' | 'role'
export type AudienceRelation = 'viewer' | 'editor' | 'owner'

export interface AudienceEntry {
  id: string
  subjectType: AudienceSubject
  subjectId: string | null
  subjectRole: Role | null
  subjectName: string
  relation: AudienceRelation
  reason: string | null
  grantedByName: string | null
  createdAt: Date
}

export interface DocumentAudience {
  documentId: string
  title: string
  sensitivity: Sensitivity
  /** True while a list exists. An open document has no rows here at all. */
  restricted: boolean
  entries: AudienceEntry[]
  /**
   * Roles that cannot reach this document however it is shared, because its classification
   * is above their ceiling. Named so the screen can say it instead of silently doing
   * nothing when somebody adds them.
   */
  blockedByClassification: Role[]
}

interface Row {
  id: string
  subject_type: AudienceSubject
  subject_id: string | null
  subject_role: Role | null
  subject_name: string | null
  relation: AudienceRelation
  reason: string | null
  granted_by_name: string | null
  created_at: Date
}

const ALL_ROLES: Role[] = ['owner', 'admin', 'manager', 'member', 'viewer', 'guest']

async function loadDocument(
  ctx: TenantContext,
  documentId: string,
): Promise<{ id: string; title: string; sensitivity: Sensitivity; owner_id: string | null }> {
  const [document] = await ctx.sql<{ id: string; title: string; sensitivity: Sensitivity; owner_id: string | null }[]>`
    SELECT id, title, sensitivity, owner_id FROM documents
    WHERE organization_id = ${ctx.organizationId} AND id = ${documentId} AND deleted_at IS NULL`
  if (!document) throw new NotFoundError()
  return document
}

/** The same check `deleteDocument` uses: changing who can find something is a high-risk act. */
function guard(
  ctx: TenantContext,
  actor: Actor,
  document: { id: string; sensitivity: Sensitivity; owner_id: string | null },
): void {
  const decision = can(actor, 'document:update', {
    type: 'document',
    id: document.id,
    organizationId: ctx.organizationId,
    ownerId: document.owner_id,
    sensitivity: document.sensitivity,
    riskTier: 'high',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
}

export async function documentAudience(
  ctx: TenantContext,
  actor: Actor,
  documentId: string,
): Promise<DocumentAudience> {
  const document = await loadDocument(ctx, documentId)
  // Classification and team are passed rather than left absent: an unclassified resource
  // now skips the clearance check, so a document that omitted them would skip it too.
  const decision = can(actor, 'document:read', {
    type: 'document',
    id: documentId,
    organizationId: ctx.organizationId,
    ownerId: document.owner_id,
    sensitivity: document.sensitivity,
    riskTier: 'read',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  const rows = await ctx.sql<Row[]>`
    SELECT p.id, p.subject_type, p.subject_id, p.subject_role, p.relation, p.reason,
           g.name AS granted_by_name, p.created_at,
           CASE p.subject_type
             WHEN 'user' THEN (SELECT u.name FROM users u WHERE u.id = p.subject_id)
             WHEN 'department' THEN (SELECT d.name FROM departments d WHERE d.id = p.subject_id)
             WHEN 'team' THEN (SELECT t.name FROM teams t WHERE t.id = p.subject_id)
             ELSE NULL
           END AS subject_name
    FROM document_permissions p
    LEFT JOIN users g ON g.id = p.granted_by
    WHERE p.organization_id = ${ctx.organizationId} AND p.document_id = ${documentId}
      AND p.deleted_at IS NULL
    ORDER BY p.subject_type, p.created_at`

  const rank = SENSITIVITY_RANK[document.sensitivity]
  return {
    documentId,
    title: document.title,
    sensitivity: document.sensitivity,
    restricted: rows.length > 0,
    entries: rows.map((row) => ({
      id: row.id,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      subjectRole: row.subject_role,
      subjectName: row.subject_name ?? (row.subject_role ? `Everyone with the ${row.subject_role} role` : 'unknown'),
      relation: row.relation,
      reason: row.reason,
      grantedByName: row.granted_by_name,
      createdAt: row.created_at,
    })),
    // Adding one of these to the list would do nothing, so the screen says it rather than
    // appearing to work.
    blockedByClassification: ALL_ROLES.filter((role) => SENSITIVITY_RANK[ROLE_MAX_SENSITIVITY[role]] < rank),
  }
}

export interface GrantInput {
  documentId: string
  subjectType: AudienceSubject
  subjectId?: string | null
  subjectRole?: Role | null
  relation?: AudienceRelation
  reason: string
}

/**
 * Adds a subject to the document's circulation list, creating the list if there is none.
 *
 * Creating one is the consequential half: the moment the first row exists, everybody not
 * named loses the ability to retrieve the document. So the caller is told which it did, and
 * the interface warns before the first grant rather than after.
 */
export async function grantDocumentAccess(
  ctx: TenantContext,
  actor: Actor,
  input: GrantInput,
): Promise<DocumentAudience> {
  const document = await loadDocument(ctx, input.documentId)
  guard(ctx, actor, document)

  if (input.reason.trim().length < 4) {
    throw new ValidationError('Say why they need it. A list nobody can explain is one nobody will ever prune.')
  }

  if (input.subjectType === 'role') {
    if (!input.subjectRole) throw new ValidationError('Say which role.')
    if (!ALL_ROLES.includes(input.subjectRole)) throw new ValidationError('That is not a role.')
    const rank = SENSITIVITY_RANK[document.sensitivity]
    if (SENSITIVITY_RANK[ROLE_MAX_SENSITIVITY[input.subjectRole]] < rank) {
      throw new ValidationError(
        `“${document.title}” is classified ${document.sensitivity}, which is above what the ` +
          `${input.subjectRole} role may read. Adding them here would change nothing — the classification ` +
          'is the thing to change, deliberately, if that is what is meant.',
      )
    }
  } else {
    if (!input.subjectId) throw new ValidationError(`Say which ${input.subjectType}.`)
    const table = input.subjectType === 'user' ? 'memberships' : 'departments'
    const [exists] =
      input.subjectType === 'user'
        ? await ctx.sql<{ ok: boolean }[]>`
            SELECT true AS ok FROM memberships
            WHERE organization_id = ${ctx.organizationId} AND user_id = ${input.subjectId}
              AND deleted_at IS NULL`
        : await ctx.sql<{ ok: boolean }[]>`
            SELECT true AS ok FROM departments
            WHERE organization_id = ${ctx.organizationId} AND id = ${input.subjectId} AND deleted_at IS NULL`
    if (!exists) throw new ValidationError(`No such ${table === 'memberships' ? 'person' : 'department'} here.`)
  }

  const before = await documentAudience(ctx, actor, input.documentId)

  await ctx.sql`
    INSERT INTO document_permissions (
      organization_id, document_id, subject_type, subject_id, subject_role, relation,
      reason, granted_by, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.documentId}, ${input.subjectType},
      ${input.subjectType === 'role' ? null : input.subjectId!},
      ${input.subjectType === 'role' ? input.subjectRole! : null},
      ${input.relation ?? 'viewer'}, ${input.reason.trim()}, ${actor.userId}, ${ctx.userId}
    )
    ON CONFLICT DO NOTHING`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: before.restricted ? 'document.audience_added' : 'document.restricted',
    entityType: 'document',
    entityId: input.documentId,
    before: { restricted: before.restricted, audience: before.entries.length },
    after: {
      subject: input.subjectType === 'role' ? `role:${input.subjectRole}` : `${input.subjectType}:${input.subjectId}`,
      reason: input.reason.trim(),
    },
  })

  if (!before.restricted) {
    // The first grant is the one that changes the world: everybody else just lost it.
    await writeActivity(ctx, {
      actorType: actor.type,
      actorUserId: actor.userId,
      actorLabel: actor.displayName,
      verb: 'restricted',
      entityType: 'document',
      entityId: input.documentId,
      entityLabel: document.title,
      summary:
        `${actor.displayName} restricted “${document.title}”. Only the people on its circulation list can ` +
        'retrieve it or see it cited in an answer.',
    })
  }

  return documentAudience(ctx, actor, input.documentId)
}

/**
 * Takes one subject off the list. Removing the last one would silently reopen the document
 * to everybody, so it is refused and the caller is pointed at the control that says so out
 * loud.
 */
export async function revokeDocumentAccess(
  ctx: TenantContext,
  actor: Actor,
  input: { documentId: string; entryId: string; reason: string },
): Promise<DocumentAudience> {
  const document = await loadDocument(ctx, input.documentId)
  guard(ctx, actor, document)
  if (input.reason.trim().length < 4) {
    throw new ValidationError('Say why they no longer need it.')
  }

  const audience = await documentAudience(ctx, actor, input.documentId)
  const entry = audience.entries.find((candidate) => candidate.id === input.entryId)
  if (!entry) throw new NotFoundError()
  if (audience.entries.length === 1) {
    throw new ValidationError(
      'That is the last person on the list, and removing it would reopen the document to everybody who ' +
        'can already read its classification. Open it deliberately instead.',
    )
  }

  await ctx.sql`
    UPDATE document_permissions SET deleted_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.entryId} AND deleted_at IS NULL`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'document.audience_removed',
    entityType: 'document',
    entityId: input.documentId,
    before: { subject: entry.subjectName },
    after: { reason: input.reason.trim(), remaining: audience.entries.length - 1 },
  })
  return documentAudience(ctx, actor, input.documentId)
}

/**
 * Clears the list, which returns the document to being findable by anybody whose
 * classification ceiling allows it. Separate from revoking the last entry so that reopening
 * a document is always something somebody chose, never a side effect of tidying up.
 */
export async function openDocumentToEveryone(
  ctx: TenantContext,
  actor: Actor,
  input: { documentId: string; reason: string },
): Promise<DocumentAudience> {
  const document = await loadDocument(ctx, input.documentId)
  guard(ctx, actor, document)
  if (input.reason.trim().length < 4) {
    throw new ValidationError('Say why it no longer needs restricting.')
  }

  const audience = await documentAudience(ctx, actor, input.documentId)
  if (!audience.restricted) throw new ValidationError('That document is not restricted.')

  await ctx.sql`
    UPDATE document_permissions SET deleted_at = now()
    WHERE organization_id = ${ctx.organizationId} AND document_id = ${input.documentId} AND deleted_at IS NULL`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'document.opened',
    entityType: 'document',
    entityId: input.documentId,
    before: { restricted: true, audience: audience.entries.length },
    after: { restricted: false, reason: input.reason.trim() },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'opened',
    entityType: 'document',
    entityId: input.documentId,
    entityLabel: document.title,
    summary:
      `${actor.displayName} removed the circulation list from “${document.title}”. Anybody whose ` +
      'classification allows it can find it again.',
  })
  return documentAudience(ctx, actor, input.documentId)
}

/**
 * Keeps sharing and restricting from disagreeing.
 *
 * Called by `share()` when the object is a document. If the document has no circulation
 * list this does nothing — an additive grant on an open document is exactly what a relation
 * tuple already means. If it has one, the recipient goes on it, because a share that leaves
 * somebody unable to find the thing they were given is not a share.
 */
export async function syncShareToAudience(
  ctx: TenantContext,
  actor: Actor,
  input: { documentId: string; subjectType: 'user' | 'team' | 'department'; subjectId: string; reason?: string },
): Promise<boolean> {
  const [restricted] = await ctx.sql<{ ok: boolean }[]>`
    SELECT true AS ok FROM document_permissions
    WHERE organization_id = ${ctx.organizationId} AND document_id = ${input.documentId}
      AND deleted_at IS NULL LIMIT 1`
  if (!restricted) return false

  await ctx.sql`
    INSERT INTO document_permissions (
      organization_id, document_id, subject_type, subject_id, relation, reason, granted_by, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.documentId}, ${input.subjectType}, ${input.subjectId}, 'viewer',
      ${input.reason?.trim() || 'Added by sharing, so the share actually works.'},
      ${actor.userId}, ${ctx.userId}
    )
    ON CONFLICT DO NOTHING`
  return true
}
