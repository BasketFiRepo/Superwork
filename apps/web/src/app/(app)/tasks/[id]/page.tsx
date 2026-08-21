import { Link } from '@/components/Link'
import { notFound } from 'next/navigation'
import { requireSession, withActor } from '@/lib/session'
import {
  commitmentsForTask,
  getTask,
  projectMilestones,
  listShares,
  listTasks,
  listTeams,
  NotFoundError,
  PermissionError,
  shareableRelations,
  taskComments,
  taskDependencies,
  taskRecurrence,
  taskWatchers,
  teamScope,
} from '@superwork/core'
import { TaskComments } from '@/components/TaskComments'
import { TaskDependencies } from '@/components/TaskDependencies'
import { TeamScope } from '@/components/TeamScope'
import { TaskMilestone } from '@/components/TaskMilestone'
import { TaskWatchers } from '@/components/TaskWatchers'
import { TaskRecurrence } from '@/components/TaskRecurrence'
import { ShareObject } from '@/components/ShareObject'

export const dynamic = 'force-dynamic'

/**
 * One task, and what stands between it and being finished (§12.1). This is where the
 * "you can start this now" notification lands.
 */
export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params

  try {
    const { task, dependencies, candidates, scope, promises, teams, shares, people, relations, comments, watchers, recurrence, milestones } = await withActor(session, async (ctx, actor) => {
      const loaded = await getTask(ctx, actor, id)
      const deps = await taskDependencies(ctx, actor, id)
      const open = await listTasks(ctx, actor, {
        status: ['backlog', 'todo', 'in_progress', 'waiting', 'blocked', 'review'],
        limit: 100,
      })
      const already = new Set(deps.blockedBy.map((edge) => edge.taskId))
      // Sharing a task with a whole team needs the roster, which is admin-visible; a member
      // simply gets no team option in the share control rather than an error.
      const visibleTeams = await listTeams(ctx, actor).catch(() => [])
      return {
        task: loaded,
        dependencies: deps,
        shares: await listShares(ctx, actor, 'task', id),
        comments: await taskComments(ctx, actor, id),
        watchers: await taskWatchers(ctx, actor, id),
        recurrence: await taskRecurrence(ctx, actor, id),
        // The dates its own project is judged against. Only the project's own, because that
        // is the only kind of milestone a task may be filed against (ADR 0048).
        milestones: loaded.projectId ? await projectMilestones(ctx, loaded.projectId) : [],
        relations: shareableRelations(actor, 'task', id, ctx.organizationId),
        people: await ctx.sql<{ id: string; name: string }[]>`
          SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = ${ctx.organizationId} AND m.deleted_at IS NULL AND m.status = 'active'
            AND m.user_id <> ${actor.userId}
          ORDER BY u.name`,
        // Where it sits, where it could go, and whether this person may move it — the last
        // decided by the same `can()` the write goes through (ADR 0064).
        scope: await teamScope(ctx, actor, 'task', id),
        // What this work is for, read from the link rather than from the description the
        // create wrote — a description is text somebody can edit (ADR 0066).
        promises: await commitmentsForTask(ctx, actor, id),
        teams: visibleTeams.map((team) => ({ id: team.id, name: team.name })),
        // Anything already a prerequisite, and the task itself, would only be refused.
        candidates: open.tasks
          .filter((candidate) => candidate.id !== id && !already.has(candidate.id))
          .map((candidate) => ({ id: candidate.id, title: candidate.title })),
      }
    })

    return (
      <div className="stack stack-8">
        <header className="stack stack-3">
          <Link className="small secondary" href="/tasks">
            ← Tasks
          </Link>
          <h1>{task.title}</h1>
          <div className="row wrap">
            <span className="chip">{task.status.replace(/_/g, ' ')}</span>
            <span className="chip">{task.priority}</span>
            {task.assigneeName ? <span className="chip">{task.assigneeName}</span> : null}
            {task.projectName ? <span className="chip">{task.projectName}</span> : null}
            {dependencies.isBlocked ? (
              <span className="chip chip-attention" data-testid="task-blocked-chip">
                waiting on {dependencies.blockedBy.filter((e) => !['completed', 'cancelled'].includes(e.taskStatus)).length}
              </span>
            ) : null}
            {task.recurrenceRule ? (
              <span className="chip" data-testid="task-repeats-chip">
                repeats
              </span>
            ) : null}
            {dependencies.blocking.length > 0 ? (
              <span className="chip chip-critical" data-testid="task-blocking-chip">
                blocking {dependencies.blocking.length}
              </span>
            ) : null}
          </div>
          {task.description ? <p className="prose secondary">{task.description}</p> : null}
          {promises.map((promise) => (
            <p className="small secondary prose" style={{ margin: 0 }} key={promise.id} data-testid="task-promise">
              This is how we keep a promise{promise.companyName ? ` to ${promise.companyName}` : ''}:{' '}
              <strong>&ldquo;{promise.obligation}&rdquo;</strong>
              {promise.status === 'kept'
                ? ' — kept, because this was finished.'
                : ' Finishing this marks it kept in the ledger.'}
            </p>
          ))}
        </header>

        <ShareObject
          objectType="task"
          objectId={task.id}
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
          teams={teams}
        />

        <TaskMilestone
          taskId={task.id}
          projectName={task.projectName}
          milestoneId={task.milestoneId}
          dueAt={task.dueAt ? task.dueAt.toISOString() : null}
          milestones={milestones
            .filter((milestone) => milestone.status === 'open' || milestone.id === task.milestoneId)
            .map((milestone) => ({
              id: milestone.id,
              name: milestone.name,
              dueOn: milestone.dueOn ? milestone.dueOn.toISOString() : null,
              status: milestone.status,
            }))}
        />

        <TeamScope
          entity="task"
          id={task.id}
          sensitivity={scope.sensitivity}
          teamId={scope.teamId}
          teamName={scope.teamName}
          options={scope.options}
          canScope={scope.canScope}
          refusal={scope.refusal}
        />

        <TaskDependencies taskId={task.id} dependencies={dependencies} candidates={candidates} />

        <TaskRecurrence
          taskId={task.id}
          hasDueDate={task.dueAt !== null}
          recurrence={
            recurrence
              ? {
                  rule: recurrence.rule,
                  description: recurrence.description,
                  nextDueAt: recurrence.nextDueAt ? recurrence.nextDueAt.toISOString() : null,
                  nextIsNonWorking: recurrence.nextIsNonWorking,
                  timezone: recurrence.timezone,
                  history: recurrence.history.map((row) => ({
                    id: row.id,
                    title: row.title,
                    status: row.status,
                    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
                  })),
                }
              : null
          }
        />

        <TaskWatchers
          taskId={task.id}
          watchers={watchers.map((row) => ({ userId: row.userId, name: row.name, isYou: row.isYou }))}
        />

        <TaskComments
          taskId={task.id}
          people={people}
          comments={comments.map((comment) => ({
            id: comment.id,
            body: comment.body,
            authorName: comment.authorName,
            byAgent: comment.byAgent,
            mentions: comment.mentions,
            canDelete: comment.canDelete,
            createdAt: comment.createdAt.toISOString(),
          }))}
        />
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
