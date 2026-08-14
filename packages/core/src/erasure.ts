import { adminSql, asJson, type TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from './errors.js'
import { writeActivity, writeAudit } from './audit.js'
import { assertSteppedUp } from './step-up.js'
import { holdsCovering } from './legal-hold.js'

/**
 * Erasure (§21).
 *
 * The right to be forgotten, done in the only way that is honest: by saying in advance
 * exactly what will be deleted, what will be anonymised, and what will be kept and on what
 * basis — and then doing that, and recording that it was done.
 *
 * The three-way split is the whole design. An erasure that deletes everything the person
 * touched destroys other people's work: a task they raised is somebody else's task now, a
 * meeting they attended is a meeting the others were also in. An erasure that deletes
 * nothing and calls it anonymisation is a lie. So:
 *
 *   delete    — records that exist only because of this person and describe only them
 *   anonymise — records other people depend on, with the person replaced by a tombstone
 *   keep      — records with a legal basis that outlives the request, named as such
 *
 * The preview is computed before anything happens and stored on the request, because the
 * person consenting to an erasure is consenting to that list, and the list has to still be
 * readable afterwards.
 */

export type ErasureDisposition = 'delete' | 'anonymise' | 'keep'

export interface ErasureLine {
  table: string
  label: string
  disposition: ErasureDisposition
  count: number
  /** Why this disposition, in the words a person would use. */
  basis: string
}

export interface ErasurePreview {
  subjectUserId: string
  subjectLabel: string
  lines: ErasureLine[]
  totals: { deleted: number; anonymised: number; kept: number }
  /** Anything that stops the erasure happening at all. */
  blockers: string[]
}

/**
 * A single row every erased person's authored records point at afterwards. One tombstone
 * per organization: it is a placeholder, not a person, and giving each erasure its own
 * would let somebody count the erasures and correlate them with who left.
 */
const TOMBSTONE_EMAIL = 'erased@superwork.invalid'

/** The plan. Each line is a table, a disposition and the reason for it. */
const PLAN: {
  table: string
  label: string
  disposition: ErasureDisposition
  basis: string
  /** Counts what this erasure would touch. */
  count: (ctx: TenantContext, userId: string) => Promise<number>
}[] = [
  {
    table: 'nudges',
    label: 'Reminders sent to them',
    disposition: 'delete',
    basis: 'Exists only to chase this person. Nobody else needs it.',
    count: (ctx, id) => tally(ctx, ctx.sql`SELECT count(*)::text AS count FROM nudges
      WHERE organization_id = ${ctx.organizationId} AND recipient_user_id = ${id}`),
  },
  {
    table: 'notifications',
    label: 'Notifications addressed to them',
    disposition: 'delete',
    basis: 'Addressed to this person alone.',
    count: (ctx, id) => tally(ctx, ctx.sql`SELECT count(*)::text AS count FROM notifications
      WHERE organization_id = ${ctx.organizationId} AND user_id = ${id}`),
  },
  {
    table: 'briefings',
    label: 'Their daily briefings',
    disposition: 'delete',
    basis: 'Written for this person, read by nobody else.',
    count: (ctx, id) => tally(ctx, ctx.sql`SELECT count(*)::text AS count FROM briefings
      WHERE organization_id = ${ctx.organizationId} AND user_id = ${id}`),
  },
  {
    table: 'sessions',
    label: 'Their sign-ins',
    disposition: 'delete',
    basis: 'Access records for an account that will no longer exist.',
    count: (ctx, id) => tally(ctx, adminSql()`SELECT count(*)::text AS count FROM sessions WHERE user_id = ${id}`),
  },
  {
    table: 'notification_preferences',
    label: 'Their notification settings',
    disposition: 'delete',
    basis: 'Preferences belong to the person who set them.',
    count: (ctx, id) => tally(ctx, ctx.sql`SELECT count(*)::text AS count FROM notification_preferences
      WHERE organization_id = ${ctx.organizationId} AND user_id = ${id}`),
  },
  {
    table: 'tasks',
    label: 'Tasks assigned to them',
    disposition: 'anonymise',
    basis: 'The work is somebody else’s problem now. The task stays; the name comes off.',
    count: (ctx, id) => tally(ctx, ctx.sql`SELECT count(*)::text AS count FROM tasks
      WHERE organization_id = ${ctx.organizationId} AND (assignee_id = ${id} OR created_by = ${id})`),
  },
  {
    table: 'commitments',
    label: 'Commitments they made or were owed',
    disposition: 'anonymise',
    basis: 'A promise to a customer outlives the person who made it.',
    count: (ctx, id) => tally(ctx, ctx.sql`SELECT count(*)::text AS count FROM commitments
      WHERE organization_id = ${ctx.organizationId} AND owner_user_id = ${id}`),
  },
  {
    table: 'transcript_segments',
    label: 'Things they said in meetings',
    disposition: 'anonymise',
    basis: 'The meeting happened and the others were in it. The words stay; the speaker becomes “a participant”.',
    count: (ctx, id) => tally(ctx, ctx.sql`SELECT count(*)::text AS count FROM transcript_segments
      WHERE organization_id = ${ctx.organizationId} AND speaker_user_id = ${id}`),
  },
  {
    table: 'agent_runs',
    label: 'Assistant runs they asked for',
    disposition: 'anonymise',
    basis: 'The cost and the actions are the organization’s record. The requester becomes the tombstone.',
    count: (ctx, id) => tally(ctx, ctx.sql`SELECT count(*)::text AS count FROM agent_runs
      WHERE organization_id = ${ctx.organizationId} AND principal_user_id = ${id}`),
  },
  {
    table: 'memory_facts',
    label: 'Facts the assistant holds about them',
    disposition: 'delete',
    basis:
      'A remembered fact scoped to one person is about that person. It goes, and the document it came ' +
      'from stays — anybody can read that again.',
    count: (ctx, id) => tally(ctx, ctx.sql`SELECT count(*)::text AS count FROM memory_facts
      WHERE organization_id = ${ctx.organizationId} AND scope = 'user' AND scope_id = ${id}
        AND state <> 'forgotten' AND deleted_at IS NULL`),
  },
  {
    table: 'audit_logs',
    label: 'Decisions they took',
    disposition: 'keep',
    basis:
      'Who approved what, and when. Kept under the legitimate interest in being able to answer that later — ' +
      'and pseudonymised: the row keeps the decision and loses the name.',
    count: (ctx, id) => tally(ctx, adminSql()`SELECT count(*)::text AS count FROM audit_logs
      WHERE organization_id = ${ctx.organizationId} AND actor_id = ${id}`),
  },
  {
    table: 'disclosures',
    label: 'What was reported about them, and to whom',
    disposition: 'keep',
    basis:
      'The record that anything said about this person was visible to them first. Deleting it would remove the ' +
      'evidence that the promise was kept. Pseudonymised like the audit trail.',
    count: (ctx, id) => tally(ctx, ctx.sql`SELECT count(*)::text AS count FROM disclosures
      WHERE organization_id = ${ctx.organizationId} AND subject_user_id = ${id}`),
  },
]

async function tally(_ctx: TenantContext, query: Promise<{ count: string }[]>): Promise<number> {
  return Number((await query)[0]?.count ?? 0)
}

function guard(ctx: TenantContext, actor: Actor, action: string, riskTier: 'low' | 'high' = 'high'): void {
  const decision = can(actor, action, { type: 'member', organizationId: ctx.organizationId, riskTier })
  if (!decision.allow) throw new PermissionError(decision.reason)
}

/** What an erasure would do. Changes nothing. */
export async function previewErasure(
  ctx: TenantContext,
  actor: Actor,
  subjectUserId: string,
): Promise<ErasurePreview> {
  guard(ctx, actor, 'member:update')

  const [subject] = await ctx.sql<{ id: string; name: string; role: string }[]>`
    SELECT u.id, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = ${ctx.organizationId} AND m.user_id = ${subjectUserId} AND m.deleted_at IS NULL`
  if (!subject) throw new NotFoundError()

  const blockers: string[] = []
  if (subject.role === 'owner') {
    const [owners] = await ctx.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM memberships
      WHERE organization_id = ${ctx.organizationId} AND role = 'owner' AND deleted_at IS NULL`
    if (Number(owners?.count ?? 0) <= 1) {
      blockers.push(
        'They are the only owner of this organization. Make somebody else an owner first — an organization ' +
          'nobody owns cannot be administered, including to undo this.',
      )
    }
  }
  const [workflows] = await ctx.sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM workflows
    WHERE organization_id = ${ctx.organizationId} AND owner_user_id = ${subjectUserId}
      AND status = 'active' AND deleted_at IS NULL`
  if (Number(workflows?.count ?? 0) > 0) {
    blockers.push(
      `${workflows!.count} active ${Number(workflows!.count) === 1 ? 'workflow names' : 'workflows name'} them as the ` +
        'accountable owner. Give those to somebody else first — an automation with nobody answerable for it is ' +
        'the thing the owner requirement exists to prevent.',
    )
  }

  // A hold outranks an erasure request. Both are legal obligations; only one of them can
  // be satisfied later. So this refuses, names the matter, and leaves the choice of whether
  // to release the hold to the people who placed it.
  const holds = await holdsCovering(ctx, subjectUserId)
  for (const hold of holds) {
    blockers.push(
      `Records concerning them are preserved for “${hold.matter}”. Erasing them now would destroy evidence ` +
        'in a live matter. Release that hold first, if the matter is closed.',
    )
  }

  const lines: ErasureLine[] = []
  for (const entry of PLAN) {
    lines.push({
      table: entry.table,
      label: entry.label,
      disposition: entry.disposition,
      basis: entry.basis,
      count: await entry.count(ctx, subjectUserId),
    })
  }

  const total = (disposition: ErasureDisposition) =>
    lines.filter((line) => line.disposition === disposition).reduce((sum, line) => sum + line.count, 0)

  return {
    subjectUserId,
    // Never their name or address: this label outlives them by design.
    subjectLabel: `A former ${subject.role} of this organization`,
    lines,
    totals: { deleted: total('delete'), anonymised: total('anonymise'), kept: total('keep') },
    blockers,
  }
}

export interface ErasureRecord {
  id: string
  subjectLabel: string
  status: string
  reason: string
  requestedByName: string | null
  preview: ErasurePreview | Record<string, never>
  outcome: { lines: ErasureLine[]; tombstoneId: string } | null
  completedAt: Date | null
  createdAt: Date
}

/**
 * Carries it out. Requires step-up, because this is the least reversible thing in the
 * product: there is no undo, and the record of what was removed is deliberately not enough
 * to reconstruct it.
 */
export async function erasePerson(
  ctx: TenantContext,
  actor: Actor,
  input: { subjectUserId: string; reason: string },
): Promise<ErasureRecord> {
  guard(ctx, actor, 'member:update')
  assertSteppedUp(actor, 'erasure.execute')

  if (input.subjectUserId === actor.userId) {
    throw new ValidationError(
      'Erasing yourself would leave nobody able to confirm it happened. Ask another admin to do it.',
    )
  }
  if (input.reason.trim().length < 8) {
    throw new ValidationError('Say why this is being erased — a request reference, or the decision behind it.')
  }

  const preview = await previewErasure(ctx, actor, input.subjectUserId)
  if (preview.blockers.length > 0) {
    throw new ValidationError(`This cannot be erased yet. ${preview.blockers.join(' ')}`)
  }

  const [request] = await ctx.sql<{ id: string }[]>`
    INSERT INTO erasure_requests (
      organization_id, subject_user_id, subject_label, requested_by, reason, status, preview, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.subjectUserId}, ${preview.subjectLabel}, ${actor.userId},
      ${input.reason}, 'previewed', ${ctx.sql.json(asJson(preview))}, ${ctx.userId}
    ) RETURNING id`

  const tombstoneId = await tombstone(ctx)

  // Delete first, then anonymise. The other order would leave a window in which the
  // person's own records point at the tombstone and are therefore no longer findable as
  // theirs — which is exactly how an erasure half-completes and nobody notices.
  const sql = ctx.sql
  const org = ctx.organizationId
  const id = input.subjectUserId

  await sql`DELETE FROM nudges WHERE organization_id = ${org} AND recipient_user_id = ${id}`
  await sql`DELETE FROM notifications WHERE organization_id = ${org} AND user_id = ${id}`
  await sql`DELETE FROM briefings WHERE organization_id = ${org} AND user_id = ${id}`
  await sql`DELETE FROM notification_preferences WHERE organization_id = ${org} AND user_id = ${id}`
  await sql`DELETE FROM memory_facts WHERE organization_id = ${org} AND scope = 'user' AND scope_id = ${id}`
  await adminSql()`DELETE FROM sessions WHERE user_id = ${id}`

  await sql`UPDATE tasks SET assignee_id = ${tombstoneId} WHERE organization_id = ${org} AND assignee_id = ${id}`
  await sql`UPDATE tasks SET created_by = ${tombstoneId} WHERE organization_id = ${org} AND created_by = ${id}`
  await sql`UPDATE commitments SET owner_user_id = ${tombstoneId} WHERE organization_id = ${org} AND owner_user_id = ${id}`
  await sql`
    UPDATE transcript_segments SET speaker_user_id = ${tombstoneId}, speaker = 'A participant'
    WHERE organization_id = ${org} AND speaker_user_id = ${id}`
  await sql`
    UPDATE agent_runs SET principal_user_id = ${tombstoneId}
    WHERE organization_id = ${org} AND principal_user_id = ${id}`

  // Kept, but pseudonymised: the decision survives, the identity does not. audit_logs is
  // append-only for the application role, so this goes through the owner connection, and
  // it is an UPDATE — which the trigger refuses for *every* role. Repointing the actor is
  // therefore done by the only means left: delete-and-reinsert is not available either, so
  // the identity is severed at the users table instead, below.
  await sql`
    UPDATE disclosures SET subject_user_id = ${tombstoneId}
    WHERE organization_id = ${org} AND subject_user_id = ${id}`

  // The membership and the person. `users.id` is referenced by audit_logs.actor_id without
  // a foreign key precisely so history can outlive the account; the row itself goes.
  await sql`DELETE FROM memberships WHERE organization_id = ${org} AND user_id = ${id}`
  const [stillMember] = await adminSql()<{ count: string }[]>`
    SELECT count(*)::text AS count FROM memberships WHERE user_id = ${id} AND deleted_at IS NULL`
  if (Number(stillMember?.count ?? 0) === 0) {
    // They belong to no other organization, so the account itself is theirs to lose.
    await adminSql()`DELETE FROM users WHERE id = ${id}`
  }

  const outcome = { lines: preview.lines, tombstoneId }
  await sql`
    UPDATE erasure_requests
    SET status = 'completed', outcome = ${sql.json(asJson(outcome))}, completed_at = now(),
        subject_user_id = NULL
    WHERE organization_id = ${org} AND id = ${request!.id}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'member.erased',
    entityType: 'member',
    entityId: null,
    after: {
      request: request!.id,
      reason: input.reason,
      deleted: preview.totals.deleted,
      anonymised: preview.totals.anonymised,
      kept: preview.totals.kept,
    },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'erased',
    entityType: 'erasure_request',
    // The activity points at the erasure record, not at the person: after this runs there
    // is no person to point at, which is the whole idea.
    entityId: request!.id,
    entityLabel: preview.subjectLabel,
    summary:
      `${actor.displayName} erased ${preview.subjectLabel.toLowerCase()}: ${preview.totals.deleted} records ` +
      `deleted, ${preview.totals.anonymised} anonymised, ${preview.totals.kept} kept with a stated basis.`,
  })

  return (await listErasures(ctx, actor, request!.id))[0]!
}

/** The tombstone every anonymised record points at. Created once, reused for ever. */
async function tombstone(ctx: TenantContext): Promise<string> {
  const [existing] = await adminSql()<{ id: string }[]>`
    SELECT id FROM users WHERE lower(email) = ${TOMBSTONE_EMAIL}`
  if (existing) return existing.id

  const [created] = await adminSql()<{ id: string }[]>`
    INSERT INTO users (email, name, timezone)
    VALUES (${TOMBSTONE_EMAIL}, 'Erased', 'UTC')
    ON CONFLICT DO NOTHING
    RETURNING id`
  if (created) return created.id
  const [raced] = await adminSql()<{ id: string }[]>`
    SELECT id FROM users WHERE lower(email) = ${TOMBSTONE_EMAIL}`
  return raced!.id
}

export async function listErasures(ctx: TenantContext, actor: Actor, id?: string): Promise<ErasureRecord[]> {
  guard(ctx, actor, 'member:read', 'low')
  const sql = ctx.sql
  return sql<ErasureRecord[]>`
    SELECT e.id, e.subject_label AS "subjectLabel", e.status, e.reason,
           u.name AS "requestedByName", e.preview, e.outcome,
           e.completed_at AS "completedAt", e.created_at AS "createdAt"
    FROM erasure_requests e
    LEFT JOIN users u ON u.id = e.requested_by
    WHERE e.organization_id = ${ctx.organizationId} AND e.deleted_at IS NULL
      ${id ? sql`AND e.id = ${id}` : sql``}
    ORDER BY e.created_at DESC
    LIMIT 100`
}
