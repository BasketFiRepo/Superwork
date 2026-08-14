import type { Fragment, Sql, TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { PermissionError, ValidationError } from './errors.js'
import { writeActivity, writeAudit } from './audit.js'
import { assertSteppedUp } from './step-up.js'
import { recordDisclosure } from './transparency.js'

/**
 * Legal holds (§21).
 *
 * Retention gave the organization a way to delete on a schedule. This is the other half of
 * the same obligation. An organization that cannot suspend its own retention when a matter
 * arises destroys evidence on a timer, and destroying evidence is a worse failure than
 * keeping too much of it — the first is spoliation, the second is a privacy cost the hold
 * itself is the justification for.
 *
 * A hold is a row the purge consults, not a flag stamped on the records it protects. A flag
 * could only ever cover what existed the moment it was placed; a matter covers what arrives
 * afterwards too, which is most of the reason anybody places one.
 *
 * Two asymmetries are deliberate:
 *
 *   Placing a hold needs no step-up. Preserving in a hurry is the point, and friction on
 *   this side buys nothing — the same reasoning as engaging the kill switch.
 *
 *   Releasing one does. It re-exposes everything the matter covered to the next sweep, and
 *   the sweep will not ask again.
 *
 * And one refusal is structural: a hold is never covert. Every named custodian gets a
 * disclosure they can see, at the moment it is placed. A hold that a person is not told
 * about is indefinite retention of one individual's records on somebody's private say-so,
 * which is precisely what §29.5 makes unconfigurable everywhere else in this product.
 */

export interface LegalHoldView {
  id: string
  matter: string
  basis: string
  custodianIds: string[]
  custodianNames: string[]
  coversFrom: Date
  coversTo: Date | null
  placedByName: string | null
  placedAt: Date
  releasedByName: string | null
  releasedAt: Date | null
  releaseReason: string | null
  /** True while the hold is suspending deletion. */
  live: boolean
}

interface HoldRow {
  id: string
  matter: string
  basis: string
  custodian_ids: string[]
  custodian_names: string[] | null
  covers_from: Date
  covers_to: Date | null
  placed_by_name: string | null
  placed_at: Date
  released_by_name: string | null
  released_at: Date | null
  release_reason: string | null
}

const toView = (row: HoldRow): LegalHoldView => ({
  id: row.id,
  matter: row.matter,
  basis: row.basis,
  custodianIds: row.custodian_ids,
  custodianNames: row.custodian_names ?? [],
  coversFrom: row.covers_from,
  coversTo: row.covers_to,
  placedByName: row.placed_by_name,
  placedAt: row.placed_at,
  releasedByName: row.released_by_name,
  releasedAt: row.released_at,
  releaseReason: row.release_reason,
  live: row.released_at === null,
})

export async function listHolds(ctx: TenantContext, actor: Actor): Promise<LegalHoldView[]> {
  const decision = can(actor, 'settings:read', { type: 'settings', organizationId: ctx.organizationId })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const rows = await ctx.sql<HoldRow[]>`
    SELECT h.id, h.matter, h.basis, h.custodian_ids, h.covers_from, h.covers_to,
           p.name AS placed_by_name, h.placed_at,
           r.name AS released_by_name, h.released_at, h.release_reason,
           ARRAY(SELECT u.name FROM users u WHERE u.id = ANY(h.custodian_ids) ORDER BY u.name)
             AS custodian_names
    FROM legal_holds h
    LEFT JOIN users p ON p.id = h.placed_by
    LEFT JOIN users r ON r.id = h.released_by
    WHERE h.organization_id = ${ctx.organizationId} AND h.deleted_at IS NULL
    ORDER BY h.released_at IS NOT NULL, h.placed_at DESC
    LIMIT 200`
  return rows.map(toView)
}

/**
 * The correlated subquery every purge consults. It is one fragment rather than seven
 * hand-written clauses so that a class cannot quietly acquire a different idea of what
 * "held" means from the class next to it.
 *
 * `when` must be the same column the purge compares against its cutoff. If they disagreed,
 * a row could be old enough to delete by one column and outside the hold by another, and
 * the hold would leak on exactly the boundary it exists to guard.
 *
 * `who` is a predicate, not a column, because attribution differs by class — a transcript
 * belongs to whoever spoke in it, an API request to whoever the key acts as. Passing null
 * means the class has no person to attribute a row to, and a hold covering the period
 * therefore covers all of it: over-preserving is the safe direction here, and it is stated
 * on the screen rather than left to be discovered.
 */
export function heldBy(
  sql: Sql,
  organizationId: string,
  when: Fragment,
  who: Fragment | null,
): Fragment {
  return sql`EXISTS (
    SELECT 1 FROM legal_holds h
    WHERE h.organization_id = ${organizationId}
      AND h.released_at IS NULL AND h.deleted_at IS NULL
      AND ${when} >= h.covers_from
      AND (h.covers_to IS NULL OR ${when} < h.covers_to)
      AND (cardinality(h.custodian_ids) = 0${who ? sql` OR (${who})` : sql``})
  )`
}

export interface PlaceHoldInput {
  matter: string
  basis: string
  /** Empty means every person in the organization. */
  custodianIds: string[]
  coversFrom: Date
  coversTo?: Date | null
}

/**
 * Places a hold, and tells every custodian. Deliberately no step-up: the reason to place a
 * hold is usually that somebody has just been told to, and an extra password prompt buys
 * nothing that the audit row does not already record.
 */
export async function placeHold(
  ctx: TenantContext,
  actor: Actor,
  input: PlaceHoldInput,
): Promise<LegalHoldView> {
  const decision = can(actor, 'settings:update', {
    type: 'settings',
    organizationId: ctx.organizationId,
    riskTier: 'high',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  if (input.matter.trim().length < 3) {
    throw new ValidationError('Name the matter. A hold nobody can name is one nobody can release.')
  }
  if (input.basis.trim().length < 12) {
    throw new ValidationError(
      'Say what the hold is for — the notice, the claim, the regulator and the date. ' +
        'Without it, preserving one person’s records indefinitely is indistinguishable from watching them.',
    )
  }
  if (input.coversTo && input.coversTo <= input.coversFrom) {
    throw new ValidationError('The period has to end after it starts.')
  }

  const custodians = [...new Set(input.custodianIds)]
  if (custodians.length > 0) {
    const known = await ctx.sql<{ user_id: string }[]>`
      SELECT user_id FROM memberships
      WHERE organization_id = ${ctx.organizationId} AND user_id = ANY(${custodians}::uuid[])
        AND deleted_at IS NULL`
    if (known.length !== custodians.length) {
      throw new ValidationError('One of those people is not a member of this organization.')
    }
  }

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO legal_holds (
      organization_id, matter, basis, custodian_ids, covers_from, covers_to, placed_by, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.matter.trim()}, ${input.basis.trim()}, ${custodians}::uuid[],
      ${input.coversFrom}, ${input.coversTo ?? null}, ${actor.userId}, ${ctx.userId}
    ) RETURNING id`

  // Every named custodian is told, at the moment it is placed and by the same mechanism
  // that tells them anything else about themselves. A hold nobody is told about is covert
  // retention of one person's records, whatever it is called internally.
  for (const custodianId of custodians) {
    await recordDisclosure(ctx, {
      subjectUserId: custodianId,
      recipientUserId: null,
      recipientLabel: `Preserved for “${input.matter.trim()}”`,
      kind: 'legal_hold',
      summary:
        `Records concerning you from ${input.coversFrom.toISOString().slice(0, 10)} ` +
        `${input.coversTo ? `to ${input.coversTo.toISOString().slice(0, 10)}` : 'onwards'} are preserved ` +
        `for “${input.matter.trim()}” and will not be deleted on the usual schedule. ${input.basis.trim()}`,
      fields: ['agent runs', 'meetings', 'notifications', 'audit trail'],
      sourceType: 'legal_hold',
      sourceId: row!.id,
    })
  }

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'legal_hold.placed',
    entityType: 'legal_hold',
    entityId: row!.id,
    after: {
      matter: input.matter.trim(),
      custodians: custodians.length === 0 ? 'everybody' : custodians.length,
      coversFrom: input.coversFrom.toISOString(),
      coversTo: input.coversTo?.toISOString() ?? null,
    },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'placed',
    entityType: 'legal_hold',
    entityId: row!.id,
    entityLabel: input.matter.trim(),
    summary:
      `${actor.displayName} placed a hold for “${input.matter.trim()}”, covering ` +
      `${custodians.length === 0 ? 'everybody' : `${custodians.length} ${custodians.length === 1 ? 'person' : 'people'}`}. ` +
      'Nothing it covers will be deleted until it is released.',
  })

  return (await listHolds(ctx, actor)).find((hold) => hold.id === row!.id)!
}

/**
 * Releases a hold. Requires step-up, because the next sweep will delete what this was
 * keeping and will not ask first (§4.1).
 */
export async function releaseHold(
  ctx: TenantContext,
  actor: Actor,
  input: { holdId: string; reason: string },
): Promise<LegalHoldView> {
  const decision = can(actor, 'settings:update', {
    type: 'settings',
    organizationId: ctx.organizationId,
    riskTier: 'high',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  assertSteppedUp(actor, 'legal_hold.release')

  if (input.reason.trim().length < 8) {
    throw new ValidationError(
      'Say why the matter is closed. Releasing a hold is a decision to let the records go.',
    )
  }

  const [existing] = await ctx.sql<{ matter: string; released_at: Date | null }[]>`
    SELECT matter, released_at FROM legal_holds
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.holdId} AND deleted_at IS NULL`
  if (!existing) throw new ValidationError('That hold does not exist.')
  if (existing.released_at) throw new ValidationError('That hold was already released.')

  await ctx.sql`
    UPDATE legal_holds
    SET released_at = now(), released_by = ${actor.userId}, release_reason = ${input.reason.trim()}
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.holdId}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'legal_hold.released',
    entityType: 'legal_hold',
    entityId: input.holdId,
    before: { matter: existing.matter, live: true },
    after: { matter: existing.matter, live: false, reason: input.reason.trim() },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'released',
    entityType: 'legal_hold',
    entityId: input.holdId,
    entityLabel: existing.matter,
    summary:
      `${actor.displayName} released the hold for “${existing.matter}”. What it covered is subject to the ` +
      'ordinary retention windows again, from the next sweep.',
  })

  return (await listHolds(ctx, actor)).find((hold) => hold.id === input.holdId)!
}

/**
 * The live holds covering one person, for the callers that must refuse rather than purge —
 * erasure and document deletion. A released hold is not returned: it has stopped being a
 * promise.
 */
export async function holdsCovering(
  ctx: TenantContext,
  userId: string,
  at = new Date(),
): Promise<{ id: string; matter: string }[]> {
  return ctx.sql<{ id: string; matter: string }[]>`
    SELECT id, matter FROM legal_holds
    WHERE organization_id = ${ctx.organizationId}
      AND released_at IS NULL AND deleted_at IS NULL
      AND covers_from <= ${at}
      AND (cardinality(custodian_ids) = 0 OR ${userId}::uuid = ANY(custodian_ids))
    ORDER BY placed_at`
}

/**
 * Whether a document is inside a live hold. A document is attributed to whoever added it,
 * on the day they added it — the only attribution the table actually carries, and saying so
 * is better than inferring one from its contents.
 */
export async function holdsCoveringDocument(
  ctx: TenantContext,
  documentId: string,
): Promise<{ id: string; matter: string }[]> {
  return ctx.sql<{ id: string; matter: string }[]>`
    SELECT h.id, h.matter
    FROM legal_holds h
    JOIN documents d ON d.id = ${documentId} AND d.organization_id = ${ctx.organizationId}
    WHERE h.organization_id = ${ctx.organizationId}
      AND h.released_at IS NULL AND h.deleted_at IS NULL
      AND d.created_at >= h.covers_from
      AND (h.covers_to IS NULL OR d.created_at < h.covers_to)
      AND (cardinality(h.custodian_ids) = 0 OR d.created_by = ANY(h.custodian_ids))
    ORDER BY h.placed_at`
}
