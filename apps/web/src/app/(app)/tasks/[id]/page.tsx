import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireSession, withActor } from '@/lib/session'
import { getTask, listTasks, NotFoundError, PermissionError, taskDependencies } from '@superwork/core'
import { TaskDependencies } from '@/components/TaskDependencies'

export const dynamic = 'force-dynamic'

/**
 * One task, and what stands between it and being finished (§12.1). This is where the
 * "you can start this now" notification lands.
 */
export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params

  try {
    const { task, dependencies, candidates } = await withActor(session, async (ctx, actor) => {
      const loaded = await getTask(ctx, actor, id)
      const deps = await taskDependencies(ctx, actor, id)
      const open = await listTasks(ctx, actor, {
        status: ['backlog', 'todo', 'in_progress', 'waiting', 'blocked', 'review'],
        limit: 100,
      })
      const already = new Set(deps.blockedBy.map((edge) => edge.taskId))
      return {
        task: loaded,
        dependencies: deps,
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
            {dependencies.blocking.length > 0 ? (
              <span className="chip chip-critical" data-testid="task-blocking-chip">
                blocking {dependencies.blocking.length}
              </span>
            ) : null}
          </div>
          {task.description ? <p className="prose secondary">{task.description}</p> : null}
        </header>

        <TaskDependencies taskId={task.id} dependencies={dependencies} candidates={candidates} />
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
