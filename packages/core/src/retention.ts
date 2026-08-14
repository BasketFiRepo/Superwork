import { adminSql, type TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { PermissionError, ValidationError } from './errors.js'
import { writeAudit } from './audit.js'
import { assertSteppedUp } from './step-up.js'
import { jurisdiction } from './compliance.js'

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
    }[]
  >`
    SELECT p.data_class, p.keep_days, p.reason, u.name AS set_by_name, p.set_at,
           p.last_applied_at, p.last_purged
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
    const purged = await purgeClass(ctx, entry, cutoff, batch)
    outcomes.push({ dataClass: entry.key, keepDays, purged })

    if (purged > 0 || configured.has(entry.key)) {
      await ctx.sql`
        UPDATE retention_policies SET last_applied_at = ${now}, last_purged = ${purged}
        WHERE organization_id = ${ctx.organizationId} AND data_class = ${entry.key} AND deleted_at IS NULL`
    }
  }
  return outcomes
}

async function purgeClass(
  ctx: TenantContext,
  entry: RetentionClass,
  cutoff: Date,
  batch: number,
): Promise<number> {
  const sql = ctx.sql
  const org = ctx.organizationId

  switch (entry.key) {
    case 'agent_runs': {
      // Only finished runs. A run still waiting for somebody's approval is not old, it is
      // outstanding, however long it has been there.
      const rows = await sql<{ id: string }[]>`
        DELETE FROM agent_runs WHERE id IN (
          SELECT id FROM agent_runs
          WHERE organization_id = ${org} AND finished_at IS NOT NULL AND finished_at < ${cutoff}
          LIMIT ${batch}
        ) RETURNING id`
      return rows.length
    }
    case 'tool_calls': {
      const rows = await sql<{ id: string }[]>`
        DELETE FROM tool_calls WHERE id IN (
          SELECT id FROM tool_calls WHERE organization_id = ${org} AND created_at < ${cutoff} LIMIT ${batch}
        ) RETURNING id`
      return rows.length
    }
    case 'transcripts': {
      // Segments go with their transcript by cascade; deleting the parent is the whole act.
      const rows = await sql<{ id: string }[]>`
        DELETE FROM transcripts WHERE id IN (
          SELECT t.id FROM transcripts t
          JOIN meetings m ON m.id = t.meeting_id
          WHERE t.organization_id = ${org} AND m.starts_at < ${cutoff}
          LIMIT ${batch}
        ) RETURNING id`
      return rows.length
    }
    case 'notifications': {
      const notifications = await sql<{ id: string }[]>`
        DELETE FROM notifications WHERE id IN (
          SELECT id FROM notifications WHERE organization_id = ${org} AND created_at < ${cutoff} LIMIT ${batch}
        ) RETURNING id`
      const nudges = await sql<{ id: string }[]>`
        DELETE FROM nudges WHERE id IN (
          SELECT id FROM nudges WHERE organization_id = ${org} AND created_at < ${cutoff} LIMIT ${batch}
        ) RETURNING id`
      return notifications.length + nudges.length
    }
    case 'insights': {
      // Open insights are never purged: an unanswered observation is not stale, it is
      // unanswered, and deleting it would hide work rather than tidy it.
      const rows = await sql<{ id: string }[]>`
        DELETE FROM insights WHERE id IN (
          SELECT id FROM insights
          WHERE organization_id = ${org} AND created_at < ${cutoff}
            AND status NOT IN ('new', 'acknowledged', 'in_progress')
          LIMIT ${batch}
        ) RETURNING id`
      return rows.length
    }
    case 'api_requests': {
      const rows = await sql<{ id: string }[]>`
        DELETE FROM api_requests WHERE id IN (
          SELECT id FROM api_requests WHERE organization_id = ${org} AND created_at < ${cutoff} LIMIT ${batch}
        ) RETURNING id`
      return rows.length
    }
    case 'audit_logs': {
      // The application role is refused by the trigger from 0009. This is the one path
      // history may leave by, and it is explicitly scoped to this organization because the
      // owner connection has no RLS to fall back on.
      const rows = await adminSql()<{ id: string }[]>`
        DELETE FROM audit_logs WHERE id IN (
          SELECT id FROM audit_logs WHERE organization_id = ${org} AND occurred_at < ${cutoff} LIMIT ${batch}
        ) RETURNING id`
      return rows.length
    }
    default:
      return 0
  }
}
