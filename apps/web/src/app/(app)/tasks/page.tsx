import { Link } from '@/components/Link'
import { requireSession, withActor } from '@/lib/session'
import { listSavedViews, listTasks, asOfLabel, startOfDay } from '@superwork/core'
import { requestNow } from '@/lib/request-now'
import type { TaskStatus } from '@superwork/db'
import { SavedViews } from '@/components/SavedViews'

export const dynamic = 'force-dynamic'

const FILTERS = [
  { id: 'all', label: 'All open' },
  { id: 'mine', label: 'My work' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'today', label: 'Due today' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'watching', label: 'Following' },
] as const

const OPEN_STATUSES: TaskStatus[] = ['backlog', 'todo', 'in_progress', 'waiting', 'blocked', 'review']

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ filter?: string; q?: string }> }) {
  const session = await requireSession()
  const params = await searchParams
  const filter = params.filter ?? 'all'

  const { tasks, hasMore, views } = await withActor(session, async (ctx, actor) => {
    const result = await listTasks(ctx, actor, {
      status: filter === 'blocked' ? ['blocked'] : OPEN_STATUSES,
      ...(filter === 'mine' ? { assigneeId: 'me' as const } : {}),
      ...(filter === 'overdue' ? { overdueOnly: true } : {}),
      ...(filter === 'today' ? { dueBefore: new Date(startOfDay(new Date(), ctx.timezone).getTime() + 86_400_000) } : {}),
      ...(filter === 'watching' ? { watching: true } : {}),
      ...(params.q ? { search: params.q } : {}),
      limit: 100,
    })
    return {
      tasks: result.tasks,
      hasMore: result.nextCursor !== null,
      views: await listSavedViews(ctx, actor, 'task'),
    }
  })

  // What "Save this view" would save, and what marks a saved view as the one you are in.
  const current = { ...(filter === 'all' && !params.q ? {} : { filter }), ...(params.q ? { q: params.q } : {}) }
  const active =
    views.find(
      (view) => (view.query.filter ?? 'all') === filter && (view.query.q ?? '') === (params.q ?? ''),
    ) ?? null

  const today = startOfDay(new Date(), session.timezone).getTime()

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Work</span>
        <h1>Tasks</h1>
        <p className="prose secondary">
          {tasks.length} open {tasks.length === 1 ? 'task' : 'tasks'} shown ({asOfLabel(session.timezone, requestNow())}).
          Overdue is computed in your timezone, not the server's.
        </p>
      </header>

      <SavedViews entity="task" views={views} current={current} activeId={active?.id ?? null} />

      <div className="row wrap">
        {FILTERS.map((option) => (
          <Link
            key={option.id}
            href={`/tasks?filter=${option.id}`}
            className={`btn btn-sm${filter === option.id ? ' btn-primary' : ''}`}
          >
            {option.label}
          </Link>
        ))}
      </div>

      <div className="panel">
        {tasks.length === 0 ? (
          <div className="empty stack stack-3">
            <p className="secondary">Nothing matches this filter.</p>
            <p className="small muted">
              Ask the agent in the rail to create work, or switch filters. Everything the agent
              creates appears here with a link back to where it came from.
            </p>
          </div>
        ) : (
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th style={{ width: 120 }}>Status</th>
                  <th style={{ width: 90 }}>Priority</th>
                  <th style={{ width: 150 }}>Assignee</th>
                  <th style={{ width: 130 }}>Due</th>
                  <th style={{ width: 120 }}>Source</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => {
                  const overdue = task.dueAt ? task.dueAt.getTime() < today : false
                  return (
                    <tr key={task.id} data-testid="task-row">
                      <td>
                        <div className="stack stack-1">
                          <Link href={`/tasks/${task.id}`}>{task.title}</Link>
                          {task.recurrenceRule ? (
                            <span className="row-tight small">
                              <span className="chip" data-testid="task-repeats-chip">
                                repeats
                              </span>
                            </span>
                          ) : null}
                          {task.blockedByCount > 0 || task.blockingCount > 0 ? (
                            <span className="row-tight small">
                              {task.blockedByCount > 0 ? (
                                <span className="chip chip-attention" data-testid="task-waiting-chip">
                                  waiting on {task.blockedByCount}
                                </span>
                              ) : null}
                              {task.blockingCount > 0 ? (
                                <span className="chip chip-critical" data-testid="task-blocking-chip">
                                  blocking {task.blockingCount}
                                </span>
                              ) : null}
                            </span>
                          ) : null}
                          {task.blockedReason ? (
                            <span className="small" style={{ color: 'var(--critical)' }}>
                              Blocked: {task.blockedReason}
                            </span>
                          ) : null}
                          {task.waitingOn ? (
                            <span className="small muted">Waiting on {task.waitingOn}</span>
                          ) : null}
                        </div>
                      </td>
                      <td className="small secondary">{task.status.replace(/_/g, ' ')}</td>
                      <td>
                        <span className="row-tight small">
                          <span
                            className="dot"
                            style={{ background: `var(--p-${task.priority === 'medium' ? 'med' : task.priority})` }}
                          />
                          {task.priority}
                        </span>
                      </td>
                      <td className="small secondary">{task.assigneeName ?? 'Unassigned'}</td>
                      <td className="num small" style={overdue ? { color: 'var(--critical)' } : undefined}>
                        {task.dueAt
                          ? new Intl.DateTimeFormat('en-GB', { timeZone: session.timezone, day: '2-digit', month: 'short' }).format(task.dueAt)
                          : '—'}
                      </td>
                      <td>
                        {task.createdByActorType === 'agent' ? (
                          <a className="chip chip-accent" href={`/activity?run=${task.createdByAgentRunId}`}>
                            agent
                          </a>
                        ) : (
                          <span className="small muted">person</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {hasMore ? (
          <div className="panel-body hairline-top small muted">
            More rows exist. This list is keyset-paginated, never OFFSET.
          </div>
        ) : null}
      </div>
    </div>
  )
}
