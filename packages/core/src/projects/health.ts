import type { TenantContext } from '@superwork/db'
import { startOfDay } from '../time.js'

/**
 * Project health (§12.2).
 *
 * The score is computed deterministically here. The model is only ever asked to
 * *explain* it in prose — it never invents the number. Every component is exposed so
 * the explanation can cite the arithmetic rather than gesture at it.
 */

export interface HealthComponent {
  name: string
  value: number
  weight: number
  contribution: number
  detail: string
}

export interface ProjectHealth {
  projectId: string
  projectName: string
  score: number
  band: 'healthy' | 'watch' | 'at_risk' | 'critical'
  components: HealthComponent[]
  computedAt: Date
}

interface HealthInputs {
  project_id: string
  project_name: string
  total_tasks: number
  overdue_tasks: number
  blocked_tasks: number
  open_tasks: number
  completed_tasks: number
  milestones_total: number
  milestones_late: number
  days_since_activity: number | null
}

export async function computeProjectHealth(ctx: TenantContext, projectId: string): Promise<ProjectHealth> {
  const today = startOfDay(new Date(), ctx.timezone)
  const [row] = await ctx.sql<HealthInputs[]>`
    SELECT p.id AS project_id, p.name AS project_name,
           count(t.id) FILTER (WHERE t.deleted_at IS NULL)::int AS total_tasks,
           count(t.id) FILTER (WHERE t.deleted_at IS NULL AND t.due_at < ${today}
                                 AND t.status NOT IN ('completed','cancelled'))::int AS overdue_tasks,
           count(t.id) FILTER (WHERE t.deleted_at IS NULL AND t.status = 'blocked')::int AS blocked_tasks,
           count(t.id) FILTER (WHERE t.deleted_at IS NULL
                                 AND t.status NOT IN ('completed','cancelled'))::int AS open_tasks,
           count(t.id) FILTER (WHERE t.status = 'completed')::int AS completed_tasks,
           (SELECT count(*)::int FROM milestones m
             WHERE m.project_id = p.id AND m.deleted_at IS NULL) AS milestones_total,
           (SELECT count(*)::int FROM milestones m
             WHERE m.project_id = p.id AND m.deleted_at IS NULL
               AND m.status <> 'done' AND m.due_on < ${today}::date) AS milestones_late,
           (SELECT EXTRACT(DAY FROM (now() - max(a.occurred_at)))::int FROM activities a
             WHERE a.entity_type = 'task' AND a.organization_id = p.organization_id
               AND a.entity_id IN (SELECT id FROM tasks WHERE project_id = p.id)) AS days_since_activity
    FROM projects p
    LEFT JOIN tasks t ON t.project_id = p.id
    WHERE p.organization_id = ${ctx.organizationId} AND p.id = ${projectId} AND p.deleted_at IS NULL
    GROUP BY p.id, p.name`

  if (!row) throw new Error('Not found.')

  const overdueRatio = row.open_tasks ? row.overdue_tasks / row.open_tasks : 0
  const blockedRatio = row.open_tasks ? row.blocked_tasks / row.open_tasks : 0
  const milestoneSlip = row.milestones_total ? row.milestones_late / row.milestones_total : 0
  const staleness = Math.min((row.days_since_activity ?? 0) / 14, 1)

  const components: HealthComponent[] = [
    {
      name: 'Overdue work',
      value: overdueRatio,
      weight: 35,
      contribution: -Math.round(overdueRatio * 35),
      detail: `${row.overdue_tasks} of ${row.open_tasks} open tasks are past their due date.`,
    },
    {
      name: 'Blocked work',
      value: blockedRatio,
      weight: 25,
      contribution: -Math.round(blockedRatio * 25),
      detail: `${row.blocked_tasks} tasks are blocked.`,
    },
    {
      name: 'Milestone slack',
      value: milestoneSlip,
      weight: 25,
      contribution: -Math.round(milestoneSlip * 25),
      detail: `${row.milestones_late} of ${row.milestones_total} milestones are past due.`,
    },
    {
      name: 'Activity velocity',
      value: staleness,
      weight: 15,
      contribution: -Math.round(staleness * 15),
      detail:
        row.days_since_activity === null
          ? 'No task activity recorded yet.'
          : `Last task activity was ${row.days_since_activity} days ago.`,
    },
  ]

  const score = Math.max(0, Math.min(100, 100 + components.reduce((sum, c) => sum + c.contribution, 0)))
  const band: ProjectHealth['band'] = score >= 80 ? 'healthy' : score >= 60 ? 'watch' : score >= 40 ? 'at_risk' : 'critical'
  const computedAt = new Date()

  await ctx.sql`
    UPDATE projects SET health_score = ${score}, health_computed_at = ${computedAt}
    WHERE organization_id = ${ctx.organizationId} AND id = ${projectId}`

  return { projectId: row.project_id, projectName: row.project_name, score, band, components, computedAt }
}
