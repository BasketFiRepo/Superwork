import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireSession, withActor } from '@/lib/session'
import { can } from '@superwork/auth'
import {
  computeProjectHealth,
  getProject,
  listShares,
  listTasks,
  listTeams,
  NotFoundError,
  PermissionError,
  projectMilestones,
  projectRoster,
  shareableRelations,
} from '@superwork/core'
import { Milestones } from '@/components/Milestones'
import { ProjectStatus } from '@/components/ProjectStatus'
import { ProjectRoster } from '@/components/ProjectRoster'
import { ShareObject } from '@/components/ShareObject'

export const dynamic = 'force-dynamic'

/**
 * One project (§17). Health, its milestones, its open work, and who it is shared with.
 *
 * The page exists because the share panel needed somewhere to live, but a project you can
 * open and learn nothing from is not worth sharing — so it carries the work as well. The
 * task list here is `listTasks`, the same scope-aware read as the tasks screen, which is
 * what makes a project share reach the work inside it rather than just this page.
 */
export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params

  try {
    const { project, health, milestones, tasks, shares, people, teams, relations, roster, canStaff, everybody } = await withActor(
      session,
      async (ctx, actor) => {
        const loaded = await getProject(ctx, actor, id)
        return {
          project: loaded,
          health: await computeProjectHealth(ctx, id),
          milestones: await projectMilestones(ctx, id),
          tasks: (await listTasks(ctx, actor, { projectId: id, limit: 50 })).tasks,
          shares: await listShares(ctx, actor, 'project', id),
          roster: await projectRoster(ctx, actor, id),
          // The same question the repository asks, so the panel offers what it will accept.
          canStaff: can(actor, 'project:update', {
            type: 'project',
            id: loaded.id,
            organizationId: ctx.organizationId,
            ownerId: loaded.ownerId,
            createdBy: loaded.createdBy,
            departmentId: loaded.departmentId,
            teamIds: loaded.teamId ? [loaded.teamId] : [],
            riskTier: 'low',
          }),
          relations: shareableRelations(actor, 'project', id, ctx.organizationId),
          teams: await listTeams(ctx, actor).catch(() => []),
          // Two lists, because they answer different questions. Sharing with yourself is
          // meaningless; putting yourself on a project you are running is not.
          people: await ctx.sql<{ id: string; name: string }[]>`
          SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = ${ctx.organizationId} AND m.deleted_at IS NULL AND m.status = 'active'
            AND m.user_id <> ${actor.userId}
          ORDER BY u.name`,
          everybody: await ctx.sql<{ id: string; name: string }[]>`
          SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = ${ctx.organizationId} AND m.deleted_at IS NULL AND m.status = 'active'
          ORDER BY u.name`,
        }
      },
    )

    const open = tasks.filter((task) => !['completed', 'cancelled'].includes(task.status))

    return (
      <div className="stack stack-8">
        <header className="stack stack-3">
          <Link className="small secondary" href="/projects">
            ← Projects
          </Link>
          <h1>{project.name}</h1>
          <div className="row wrap">
            <span className="chip">{project.status.replace(/_/g, ' ')}</span>
            <span
              className={
                health.band === 'healthy'
                  ? 'chip chip-positive'
                  : health.band === 'watch'
                    ? 'chip'
                    : 'chip chip-critical'
              }
              data-testid="project-health-band"
            >
              {health.band.replace(/_/g, ' ')} · {health.score}
            </span>
            <span className="chip">{project.companyName ?? 'Internal'}</span>
            <span className="chip">owner {project.ownerName ?? 'unassigned'}</span>
            <span className="chip">{project.sensitivity}</span>
          </div>
          {project.description ? <p className="prose secondary">{project.description}</p> : null}
        </header>

        <ProjectRoster
          projectId={project.id}
          canEdit={canStaff.allow}
          people={everybody}
          members={roster.map((member) => ({
            userId: member.userId,
            name: member.name,
            role: member.role,
            reason: member.reason,
            derived: member.derived,
            addedByName: member.addedByName,
            joinedAt: member.joinedAt.toISOString(),
          }))}
        />

        <ShareObject
          objectType="project"
          objectId={project.id}
          relations={relations}
          shares={shares.map((entry) => ({
            id: entry.id,
            subjectType: entry.subjectType,
            subjectName: entry.subjectName,
            relation: entry.relation,
            reason: entry.reason,
            grantedByName: entry.grantedByName,
            expiresAt: entry.expiresAt ? entry.expiresAt.toISOString() : null,
            expired: entry.expired,
            canRevoke: entry.canRevoke,
          }))}
          people={people}
          teams={teams.map((team) => ({ id: team.id, name: team.name }))}
        />

        <section className="panel">
          <div className="panel-header">
            <h2>Why the score is what it is</h2>
            <span className="small muted">computed in SQL, explained in prose — never invented</span>
          </div>
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Component</th>
                  <th style={{ width: 110 }}>Contribution</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {health.components.map((component) => (
                  <tr key={component.name}>
                    <td>{component.name}</td>
                    <td className="num" style={{ color: component.contribution < 0 ? 'var(--critical)' : 'var(--ink)' }}>
                      {component.contribution}
                    </td>
                    <td className="small secondary">{component.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <ProjectStatus
          projectId={project.id}
          status={project.status}
          canEdit={canStaff.allow}
          denialReason={canStaff.reason}
        />

        <Milestones
          projectId={project.id}
          canEdit={canStaff.allow}
          milestones={milestones.map((milestone) => ({
            id: milestone.id,
            name: milestone.name,
            dueOn: milestone.dueOn ? new Date(milestone.dueOn).toISOString() : null,
            status: milestone.status,
            late: milestone.late,
            taskCount: milestone.taskCount,
            openCount: milestone.openCount,
            overdueCount: milestone.overdueCount,
            dueAfterCount: milestone.dueAfterCount,
          }))}
        />

        <section className="panel" data-testid="project-tasks">
          <div className="panel-header">
            <h2>Its work</h2>
            <span className="small muted">
              {open.length === 0 ? 'Nothing open' : `${open.length} open of ${tasks.length}`}
            </span>
          </div>
          {tasks.length === 0 ? (
            <div className="panel-body">
              <div className="empty small secondary">
                No tasks here that you can see. Work you have no access to is not counted or hinted at.
              </div>
            </div>
          ) : (
            <div className="panel-body-flush table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Task</th>
                    <th style={{ width: 130 }}>Status</th>
                    <th style={{ width: 160 }}>Assignee</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((task) => (
                    <tr key={task.id}>
                      <td>
                        <Link href={`/tasks/${task.id}`}>{task.title}</Link>
                      </td>
                      <td>
                        <span className="chip">{task.status.replace(/_/g, ' ')}</span>
                      </td>
                      <td className="small secondary">{task.assigneeName ?? 'unassigned'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="panel-body hairline-top">
            <Link className="btn btn-sm" href={`/tasks?filter=all&project=${project.id}`}>
              Open these in the task list
            </Link>
          </div>
        </section>
      </div>
    )
  } catch (error) {
    if (error instanceof NotFoundError) notFound()
    if (error instanceof PermissionError) {
      return (
        <div className="panel">
          <div className="empty small secondary">{error.message}</div>
        </div>
      )
    }
    throw error
  }
}
