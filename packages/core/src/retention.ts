import { adminSql, type Fragment, type Sql, type TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { PermissionError, ValidationError } from './errors.js'
import { writeAudit } from './audit.js'
import { assertSteppedUp } from './step-up.js'
import { jurisdiction } from './compliance.js'
import { heldBy } from './legal-hold.js'

/**
 * Retention (§21).
 *
 * Migration 0009 taught `audit_logs` to permit DELETE by the owner role and refuse it from
 * the application, "which is how the retention and erasure jobs can complete". This is the
 * job it was talking about. Until now Superwork kept everything for ever while its own
 * schema described a policy that did not exist.
 *
 * A retention window is a number somebody set, with their name and their reason on it. The
 * defaults come from the jurisdiction profile, because "how long may we keep this" is a
 * question the jurisdiction has already answered and an admin should have to disagree with
 * on purpose.
 */

export interface RetentionClass {
  key: string
  label: string
  /** What is actually removed, in the words a person would use. */
  description: string
  /** Below this the class stops being useful — an audit trail of one day audits nothing. */
  minimumDays: number
  defaultDays: Record<'works_council' | 'gdpr' | 'standard', number>
  /** True when purging needs the owner role, because the app role is refused by a trigger. */
  ownerRoleOnly?: boolean
}

/**
 * The classes, and the query that purges each one. A class without a purge is a promise
 * nothing keeps, so the two are declared in the same place and `applyRetention` iterates
 * this list rather than a hand-written sequence somebody can forget to extend.
 */
export const RETENTION_CLASSES: RetentionClass[] = [
  {
    key: 'agent_runs',
    label: 'Agent runs',
    description: 'What the assistant was asked, what it planned, and every step it took.',
    minimumDays: 30,
    defaultDays: { works_council: 180, gdpr: 365, standard: 730 },
  },
  {
    key: 'tool_calls',
    label: 'Tool calls',
    description: 'The individual actions inside a run, with their arguments and results.',
    minimumDays: 30,
    defaultDays: { works_council: 180, gdpr: 365, standard: 730 },
  },
  {
    key: 'transcripts',
    label: 'Meeting transcripts',
    description: 'What was said in a meeting, line by line, with who said it.',
    minimumDays: 30,
    defaultDays: { works_council: 90, gdpr: 180, standard: 365 },
  },
  {
    key: 'notifications',
    label: 'Notifications and nudges',
    description: 'What Superwork sent to people, and when.',
    minimumDays: 7,
    defaultDays: { works_council: 60, gdpr: 90, standard: 180 },
  },
  {
    key: 'insights',
    label: 'Resolved and dismissed insights',
    description: 'Observations that have been dealt with. Open ones are never purged.',
    minimumDays: 7,
    defaultDays: { works_council: 90, gdpr: 180, standard: 365 },
  },
  {
    key: 'api_requests',
    label: 'API request log',
    description: 'Which key called which endpoint, and when.',
    minimumDays: 7,
    defaultDays: { works_council: 90, gdpr: 90, standard: 180 },
  },
  {
    key: 'audit_logs',
    label: 'Audit trail',
    description:
      'Who did what, and when. Kept longest of everything here, because it is the record ' +
      'that answers questions about all the rest.',
    // Two years is the shortest window in which "what happened last year" is still a
    // question this can answer. A shorter audit trail is a shorter memory of decisions.
    minimumDays: 730,
    defaultDays: { works_council: 1095, gdpr: 1095, standard: 2555 },
    ownerRoleOnly: true,
  },
]

export interface RetentionPolicyView {
  dataClass: string
  label: string
  description: string
  keepDays: number
  minimumDays: number
  /** True when nobody has set this and the jurisdiction default is in force. */
  isDefault: boolean
  reason: string
  setByName: string | null
  setAt: Date | null
  lastAppliedAt: Date | null
  lastPurged: number
  /** What the last sweep left alone because a hold covered it. */
  lastHeld: number
}

export async function retentionPolicies(ctx: TenantContext, actor: Actor): Promise<RetentionPolicyView[]> {
  const decision = can(actor, 'settings:read', { type: 'settings', organizationId: ctx.organizationId })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const profile = (await jurisdiction(ctx)).profile
  const rows = await ctx.sql<
    {
      data_class: string
      keep_days: number
      reason: string
      set_by_name: string | null
      set_at: Date
      last_applied_at: Date | null
      last_purged: number
      last_held: number
    }[]
  >`
    SELECT p.data_class, p.keep_days, p.reason, u.name AS set_by_name, p.set_at,
           p.last_applied_at, p.last_purged, p.last_held
    FROM retention_policies p
    LEFT JOIN users u ON u.id = p.set_by
    WHERE p.organization_id = ${ctx.organizationId} AND p.deleted_at IS NULL`
  const byClass = new Map(rows.map((row) => [row.data_class, row]))

  return RETENTION_CLASSES.map((entry) => {
    const row = byClass.get(entry.key)
    return {
      dataClass: entry.key,
      label: entry.label,
      description: entry.description,
      keepDays: row?.keep_days ?? entry.defaultDays[profile],
      minimumDays: entry.minimumDays,
      isDefault: !row,
      reason: row?.reason ?? `The default for ${profile.replace(/_/g, ' ')}. Nobody has changed it.`,
      setByName: row?.set_by_name ?? null,
      setAt: row?.set_at ?? null,
      lastAppliedAt: row?.last_applied_at ?? null,
      lastPurged: row?.last_purged ?? 0,
      lastHeld: row?.last_held ?? 0,
    }
  })
}

/**
 * Sets a window. Requires step-up: shortening one destroys data on a schedule, and
 * lengthening one keeps personal data past what the jurisdiction assumed — both are
 * decisions somebody should be awake for (§4.1).
 */
export async function setRetention(
  ctx: TenantContext,
  actor: Actor,
  input: { dataClass: string; keepDays: number; reason: string },
): Promise<RetentionPolicyView[]> {
  const decision = can(actor, 'settings:update', {
    type: 'settings',
    organizationId: ctx.organizationId,
    riskTier: 'high',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  assertSteppedUp(actor, 'retention.set')

  const entry = RETENTION_CLASSES.find((candidate) => candidate.key === input.dataClass)
  if (!entry) {
    throw new ValidationError(
      `"${input.dataClass}" is not something Superwork keeps as a class of its own. ` +
        `The classes are: ${RETENTION_CLASSES.map((c) => c.key).join(', ')}.`,
    )
  }
  if (!Number.isInteger(input.keepDays) || input.keepDays < entry.minimumDays) {
    throw new ValidationError(
      `${entry.label} is kept for at least ${entry.minimumDays} days. ${entry.description} ` +
        'A shorter window would make it unable to answer the questions it exists for.',
    )
  }
  if (input.keepDays > 3650) {
    throw new ValidationError('Ten years is the longest window. Longer than that is "for ever", and should be said so.')
  }
  if (input.reason.trim().length < 8) {
    throw new ValidationError('Say why. A retention window without a reason is a number nobody can defend.')
  }

  const before = (await retentionPolicies(ctx, actor)).find((p) => p.dataClass === input.dataClass)
  await ctx.sql`
    INSERT INTO retention_policies (organization_id, data_class, keep_days, reason, set_by, created_by)
    VALUES (${ctx.organizationId}, ${input.dataClass}, ${input.keepDays}, ${input.reason}, ${actor.userId}, ${ctx.userId})
    ON CONFLICT (organization_id, data_class) WHERE deleted_at IS NULL
    DO UPDATE SET keep_days = EXCLUDED.keep_days, reason = EXCLUDED.reason,
                  set_by = EXCLUDED.set_by, set_at = now()`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'retention.set',
    entityType: 'settings',
    entityId: null,
    before: { dataClass: input.dataClass, keepDays: before?.keepDays ?? null },
    after: { dataClass: input.dataClass, keepDays: input.keepDays, reason: input.reason },
  })
  return retentionPolicies(ctx, actor)
}

export interface PurgeOutcome {
  dataClass: string
  keepDays: number
  purged: number
  /** Rows past their window that a live legal hold kept. Counted so the hold is visible. */
  held: number
}

/**
 * Deletes what is past its window, one class at a time, bounded.
 *
 * `audit_logs` is purged through the owner connection because a trigger refuses the
 * application role — deliberately, so that the only way history leaves is this job. Every
 * other class goes through the tenant connection with RLS in force, so a purge can never
 * reach across organizations.
 */
export async function applyRetention(
  ctx: TenantContext,
  options: { batch?: number; now?: Date } = {},
): Promise<PurgeOutcome[]> {
  const batch = Math.min(options.batch ?? 5_000, 50_000)
  const now = options.now ?? new Date()
  const profile = (await jurisdiction(ctx)).profile
  const rows = await ctx.sql<{ data_class: string; keep_days: number }[]>`
    SELECT data_class, keep_days FROM retention_policies
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL`
  const configured = new Map(rows.map((row) => [row.data_class, row.keep_days]))

  const outcomes: PurgeOutcome[] = []
  for (const entry of RETENTION_CLASSES) {
    const keepDays = configured.get(entry.key) ?? entry.defaultDays[profile]
    const cutoff = new Date(now.getTime() - keepDays * 86_400_000)
    // Counted before the delete, because after it the rows that were purged are gone and
    // the rows that were held look no different from rows that were never due.
    const held = await countHeld(ctx, entry, cutoff)
    const purged = await purgeClass(ctx, entry, cutoff, batch)
    outcomes.push({ dataClass: entry.key, keepDays, purged, held })

    if (purged > 0 || held > 0 || configured.has(entry.key)) {
      await ctx.sql`
        UPDATE retention_policies SET last_applied_at = ${now}, last_purged = ${purged}, last_held = ${held}
        WHERE organization_id = ${ctx.organizationId} AND data_class = ${entry.key} AND deleted_at IS NULL`
    }
  }
  return outcomes
}

/**
 * One class's worth of rows that are past their window, described once.
 *
 * The purge deletes `NOT held`; the sweep counts `held`. Writing the pair as one scope is
 * what stops the two from drifting into different ideas of which rows they are talking
 * about — the count is the only evidence a hold did anything, so a count that disagrees
 * with the delete is worse than no count.
 */
interface ClassScope {
  /** The connection to run on: `audit_logs` needs the owner, everything else must not have it. */
  exec: Sql
  table: string
  /** Alias-qualified primary key, as selected by `source`. */
  id: Fragment
  /** `FROM … WHERE …` selecting rows of this class that are past the cutoff. */
  source: Fragment
  /** True when a live hold covers the row. */
  hold: Fragment
}

function classScopes(ctx: TenantContext, entry: RetentionClass, cutoff: Date): ClassScope[] {
  const sql = ctx.sql
  const org = ctx.organizationId

  switch (entry.key) {
    case 'agent_runs':
      return [
        {
          exec: sql,
          table: 'agent_runs',
          id: sql`r.id`,
          // Only finished runs. A run still waiting for somebody's approval is not old, it
          // is outstanding, however long it has been there.
          source: sql`FROM agent_runs r
            WHERE r.organization_id = ${org} AND r.finished_at IS NOT NULL AND r.finished_at < ${cutoff}`,
          hold: heldBy(sql, org, sql`r.finished_at`, sql`r.principal_user_id = ANY(h.custodian_ids)`),
        },
      ]
    case 'tool_calls':
      return [
        {
          exec: sql,
          table: 'tool_calls',
          id: sql`c.id`,
          // A tool call belongs to whoever the run was acting for, which is on the run.
          source: sql`FROM tool_calls c JOIN agent_runs r ON r.id = c.run_id
            WHERE c.organization_id = ${org} AND c.created_at < ${cutoff}`,
          hold: heldBy(sql, org, sql`c.created_at`, sql`r.principal_user_id = ANY(h.custodian_ids)`),
        },
      ]
    case 'transcripts':
      return [
        {
          exec: sql,
          table: 'transcripts',
          id: sql`t.id`,
          // Segments go with their transcript by cascade; deleting the parent is the whole act.
          source: sql`FROM transcripts t JOIN meetings m ON m.id = t.meeting_id
            WHERE t.organization_id = ${org} AND m.starts_at < ${cutoff}`,
          // A transcript belongs to everybody who spoke in it, so one custodian's line is
          // enough to hold the whole record. Splitting it would leave a transcript with
          // gaps where the other participants were, which is not preservation.
          hold: heldBy(
            sql,
            org,
            sql`m.starts_at`,
            sql`EXISTS (SELECT 1 FROM transcript_segments s
                        WHERE s.transcript_id = t.id AND s.speaker_user_id = ANY(h.custodian_ids))`,
          ),
        },
      ]
    case 'notifications':
      return [
        {
          exec: sql,
          table: 'notifications',
          id: sql`n.id`,
          source: sql`FROM notifications n WHERE n.organization_id = ${org} AND n.created_at < ${cutoff}`,
          hold: heldBy(sql, org, sql`n.created_at`, sql`n.user_id = ANY(h.custodian_ids)`),
        },
        {
          exec: sql,
          table: 'nudges',
          id: sql`g.id`,
          source: sql`FROM nudges g WHERE g.organization_id = ${org} AND g.created_at < ${cutoff}`,
          hold: heldBy(sql, org, sql`g.created_at`, sql`g.recipient_user_id = ANY(h.custodian_ids)`),
        },
      ]
    case 'insights':
      return [
        {
          exec: sql,
          table: 'insights',
          id: sql`i.id`,
          // Open insights are never purged: an unanswered observation is not stale, it is
          // unanswered, and deleting it would hide work rather than tidy it.
          source: sql`FROM insights i
            WHERE i.organization_id = ${org} AND i.created_at < ${cutoff}
              AND i.status NOT IN ('new', 'acknowledged', 'in_progress')`,
          // No person to attribute an insight to — it is an observation about the
          // organization. A hold over the period therefore holds all of them. Preserving
          // too much is the safe direction, and the screen says so rather than leaving it
          // to be discovered.
          hold: heldBy(sql, org, sql`i.created_at`, null),
        },
      ]
    case 'api_requests':
      return [
        {
          exec: sql,
          table: 'api_requests',
          id: sql`q.id`,
          // Every key acts as a person (ADR 0009), so that person is who the request is
          // attributable to.
          source: sql`FROM api_requests q LEFT JOIN api_keys k ON k.id = q.api_key_id
            WHERE q.organization_id = ${org} AND q.occurred_at < ${cutoff}`,
          hold: heldBy(sql, org, sql`q.occurred_at`, sql`k.principal_user_id = ANY(h.custodian_ids)`),
        },
      ]
    case 'audit_logs': {
      // The application role is refused by the trigger from 0009. This is the one path
      // history may leave by, and it is explicitly scoped to this organization because the
      // owner connection has no RLS to fall back on.
      const owner = adminSql()
      return [
        {
          exec: owner,
          table: 'audit_logs',
          id: sql`a.id`,
          source: owner`FROM audit_logs a WHERE a.organization_id = ${org} AND a.occurred_at < ${cutoff}`,
          // Held by who did it or who it was done for: an audit row about a custodian is
          // as much part of a matter as one they wrote themselves.
          hold: heldBy(
            owner,
            org,
            owner`a.occurred_at`,
            owner`(a.actor_id = ANY(h.custodian_ids) OR a.principal_user_id = ANY(h.custodian_ids))`,
          ),
        },
      ]
    }
    default:
      return []
  }
}

async function purgeClass(
  ctx: TenantContext,
  entry: RetentionClass,
  cutoff: Date,
  batch: number,
): Promise<number> {
  let removed = 0
  for (const scope of classScopes(ctx, entry, cutoff)) {
    const rows = await scope.exec<{ id: string }[]>`
      DELETE FROM ${scope.exec(scope.table)} WHERE id IN (
        SELECT ${scope.id} ${scope.source} AND NOT ${scope.hold} LIMIT ${batch}
      ) RETURNING id`
    removed += rows.length
  }
  return removed
}

/**
 * How many rows of this class a live hold is keeping past their window. Counted before the
 * delete, and reported per class, because a hold that works silently is indistinguishable
 * from one that does not work at all.
 */
async function countHeld(ctx: TenantContext, entry: RetentionClass, cutoff: Date): Promise<number> {
  let held = 0
  for (const scope of classScopes(ctx, entry, cutoff)) {
    const [row] = await scope.exec<{ count: number }[]>`
      SELECT count(*)::int AS count ${scope.source} AND ${scope.hold}`
    held += row?.count ?? 0
  }
  return held
}
