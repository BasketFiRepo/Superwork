import type { TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from './errors.js'
import { writeAudit } from './audit.js'

/**
 * The reporting line (§26.1, §29.5).
 *
 * `reporting_relationships` was seeded with a real org chart in migration 0001 and read by
 * nothing, while three controls sat on top of it claiming to work:
 *
 *   • the nudge ladder's fifth rung declares `audience: 'manager'` and every rung was
 *     delivered to the *owner*, carrying a message written in the third person about them;
 *   • `noSurprisesReviewHours` was defined on every profile and enforced nowhere;
 *   • the compliance review counted stage-5 nudges as escalations that had reached a
 *     manager, which none of them had.
 *
 * **What a reporting line is for here, and what it is not.**
 *
 * It routes *decisions and accountability to a person*: this escalation goes to your
 * manager rather than to whoever happens to hold the role; this approval goes to the person
 * answerable for you. It is deliberately **not** a window onto anybody. There is no view of
 * a report's activity, no rollup of their work, no metric about them — those are the §29.5
 * prohibitions, and they are properties of the product rather than of a setting.
 *
 * The rule that follows from that: **every time the line carries something about a person,
 * that person can see that it did.** A manager escalation writes a disclosure to the
 * subject's own record. "Nothing reaches your manager that you have not already seen" is
 * only a claim if it is evidenced.
 */

export type ReportingType = 'functional' | 'dotted'

export interface ReportingLine {
  id: string
  personId: string
  personName: string
  managerId: string
  managerName: string
  type: ReportingType
  reason: string | null
  setByName: string | null
  validFrom: Date
}

/**
 * Who this person answers to, nearest first.
 *
 * Functional lines only: a dotted line is context, not an escalation path. Walking dotted
 * lines would send an escalation to two people and make "who is answerable" unanswerable,
 * which is the same failure as having two functional managers.
 */
export async function managersOf(ctx: TenantContext, personId: string, depth = 10): Promise<string[]> {
  const rows = await ctx.sql<{ managerId: string; depth: number }[]>`
    WITH RECURSIVE chain(person_id, manager_id, depth) AS (
      SELECT r.person_id, r.manager_id, 0
      FROM reporting_relationships r
      WHERE r.organization_id = ${ctx.organizationId} AND r.person_id = ${personId}
        AND r.deleted_at IS NULL AND r.valid_to IS NULL AND r.type = 'functional'
      UNION ALL
      SELECT r.person_id, r.manager_id, c.depth + 1
      FROM reporting_relationships r
      JOIN chain c ON r.person_id = c.manager_id
      WHERE r.organization_id = ${ctx.organizationId}
        AND r.deleted_at IS NULL AND r.valid_to IS NULL AND r.type = 'functional'
        AND c.depth < ${depth}
    )
    SELECT manager_id AS "managerId", depth FROM chain ORDER BY depth`
  return rows.map((row) => row.managerId)
}

/** The one person an escalation about this person goes to, or null. */
export async function managerOf(ctx: TenantContext, personId: string): Promise<string | null> {
  const chain = await managersOf(ctx, personId, 0)
  return chain[0] ?? null
}

/** Who reports to this person directly. Functional and dotted, because both are the truth. */
export async function directReports(ctx: TenantContext, managerId: string): Promise<ReportingLine[]> {
  return ctx.sql<ReportingLine[]>`
    ${SELECT_LINE(ctx)}
    WHERE r.organization_id = ${ctx.organizationId} AND r.manager_id = ${managerId}
      AND r.deleted_at IS NULL AND r.valid_to IS NULL
    ORDER BY r.type, u.name`
}

const SELECT_LINE = (ctx: TenantContext) => ctx.sql`
  SELECT r.id, r.person_id AS "personId", u.name AS "personName",
         r.manager_id AS "managerId", m.name AS "managerName",
         r.type, r.reason, s.name AS "setByName", r.valid_from AS "validFrom"
  FROM reporting_relationships r
  JOIN users u ON u.id = r.person_id
  JOIN users m ON m.id = r.manager_id
  LEFT JOIN users s ON s.id = r.set_by`

/**
 * Everything about one person's place in the chart — who they answer to, and who answers
 * to them. This is the shape the personal record renders: a person may always see their own.
 */
export async function reportingFor(
  ctx: TenantContext,
  actor: Actor,
  personId: string,
): Promise<{ managers: ReportingLine[]; reports: ReportingLine[] }> {
  // Your own line is yours to see. Somebody else's needs the permission that reading the
  // chart needs — and reading the chart is not reading anybody's work.
  if (personId !== actor.userId) {
    const decision = can(actor, 'member:read', { type: 'member', organizationId: ctx.organizationId })
    if (!decision.allow) throw new PermissionError(decision.reason)
  }

  const managers = await ctx.sql<ReportingLine[]>`
    ${SELECT_LINE(ctx)}
    WHERE r.organization_id = ${ctx.organizationId} AND r.person_id = ${personId}
      AND r.deleted_at IS NULL AND r.valid_to IS NULL
    ORDER BY r.type, m.name`
  return { managers, reports: await directReports(ctx, personId) }
}

/** The whole chart, for the admin screen. Names and lines — nothing about anybody's work. */
export async function orgChart(ctx: TenantContext, actor: Actor): Promise<ReportingLine[]> {
  const decision = can(actor, 'member:read', { type: 'member', organizationId: ctx.organizationId })
  if (!decision.allow) throw new PermissionError(decision.reason)
  return ctx.sql<ReportingLine[]>`
    ${SELECT_LINE(ctx)}
    WHERE r.organization_id = ${ctx.organizationId} AND r.deleted_at IS NULL AND r.valid_to IS NULL
    ORDER BY m.name, r.type, u.name`
}

export async function setReportingLine(
  ctx: TenantContext,
  actor: Actor,
  input: { personId: string; managerId: string; type: ReportingType; reason: string },
): Promise<ReportingLine> {
  const decision = can(actor, 'member:update', {
    type: 'member',
    organizationId: ctx.organizationId,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  if (input.personId === input.managerId) {
    throw new ValidationError('Nobody reports to themselves.')
  }
  if (!input.reason?.trim()) {
    throw new ValidationError(
      'Say why. A reporting line decides where an escalation about somebody goes, and a chart nobody can account for is one nobody will correct.',
    )
  }

  // A person has one functional manager, so setting a new one closes the old line rather
  // than adding a second. The line is closed, not deleted: "who did they report to in
  // March" is a question an audit asks.
  if (input.type === 'functional') {
    await ctx.sql`
      UPDATE reporting_relationships SET valid_to = now(), updated_at = now()
      WHERE organization_id = ${ctx.organizationId} AND person_id = ${input.personId}
        AND type = 'functional' AND valid_to IS NULL AND deleted_at IS NULL`
  }

  let created: { id: string }
  try {
    const [row] = await ctx.sql<{ id: string }[]>`
      INSERT INTO reporting_relationships (
        organization_id, person_id, manager_id, type, reason, set_by, is_demo, created_by
      ) VALUES (
        ${ctx.organizationId}, ${input.personId}, ${input.managerId}, ${input.type},
        ${input.reason.trim()}, ${actor.userId}, false, ${ctx.userId}
      ) RETURNING id`
    created = row!
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/loop/i.test(message)) {
      throw new ValidationError(
        'That line would create a loop in the chart, and an escalation would never reach anybody.',
      )
    }
    if (/same organization/i.test(message)) throw new NotFoundError()
    throw error
  }

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'reporting_line.set',
    entityType: 'user',
    entityId: input.personId,
    after: { managerId: input.managerId, type: input.type, reason: input.reason.trim() },
  })

  const [line] = await ctx.sql<ReportingLine[]>`${SELECT_LINE(ctx)} WHERE r.id = ${created.id}`
  return line!
}

export async function removeReportingLine(
  ctx: TenantContext,
  actor: Actor,
  input: { lineId: string; reason: string },
): Promise<void> {
  const decision = can(actor, 'member:update', {
    type: 'member',
    organizationId: ctx.organizationId,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  if (!input.reason?.trim()) throw new ValidationError('Say why this line is being removed.')

  const [before] = await ctx.sql<{ personId: string; managerId: string; type: string }[]>`
    SELECT person_id AS "personId", manager_id AS "managerId", type FROM reporting_relationships
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.lineId} AND deleted_at IS NULL`
  if (!before) throw new NotFoundError()

  // Closed rather than deleted, for the same reason as above.
  await ctx.sql`
    UPDATE reporting_relationships SET valid_to = now(), updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.lineId}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'reporting_line.removed',
    entityType: 'user',
    entityId: before.personId,
    before: { managerId: before.managerId, type: before.type },
    after: { reason: input.reason.trim() },
  })
}
