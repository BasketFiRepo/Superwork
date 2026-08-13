import Link from 'next/link'
import { requireSession, withActor } from '@/lib/session'
import { listTasks, asOfLabel, startOfDay } from '@superwork/core'
import type { TaskStatus } from '@superwork/db'

export const dynamic = 'force-dynamic'

const FILTERS = [
  { id: 'all', label: 'All open' },
  { id: 'mine', label: 'My work' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'today', label: 'Due today' },
  { id: 'blocked', label: 'Blocked' },
] as const

const OPEN_STATUSES: TaskStatus[] = ['backlog', 'todo', 'in_progress', 'waiting', 'blocked', 'review']

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ filter?: string; q?: string }> }) {
  const session = await requireSession()
  const params = await searchParams
  const filter = params.filter ?? 'all'

  const { tasks, hasMore } = await withActor(session, async (ctx, actor) => {
    const result = await listTasks(ctx, actor, {
      status: filter === 'blocked' ? ['blocked'] : OPEN_STATUSES,
      ...(filter === 'mine' ? { assigneeId: 'me' as const } : {}),
      ...(filter === 'overdue' ? { overdueOnly: true } : {}),
      ...(filter === 'today' ? { dueBefore: new Date(startOfDay(new Date(), ctx.timezone).getTime() + 86_400_000) } : {}),
      ...(params.q ? { search: params.q } : {}),
      limit: 100,
    })
    return { tasks: result.tasks, hasMore: result.nextCursor !== null }
  })

  const today = startOfDay(new Date(), session.timezone).getTime()

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Work</span>
        <h1>Tasks</h1>
        <p className="prose secondary">
          {tasks.length} open {tasks.length === 1 ? 'task' : 'tasks'} shown ({asOfLabel(session.timezone)}).
          Overdue is computed in your timezone, not the server's.
        </p>
      </header>

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
                    <tr key={task.id}>
                      <td>
                        <div className="stack stack-1">
                          <span>{task.title}</span>
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
