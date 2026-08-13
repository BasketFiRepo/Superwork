import { withApiKey } from '@/lib/api-auth'
import { createTask, listTasks } from '@superwork/core'
import type { TaskStatus } from '@superwork/db'

// Query strings are strings; the filter takes an enum. Anything unrecognised is ignored
// rather than passed through to the database.
const STATUSES: TaskStatus[] = [
  'backlog', 'todo', 'in_progress', 'waiting', 'blocked', 'review', 'completed', 'cancelled',
]

export const dynamic = 'force-dynamic'

/** GET /api/v1/tasks — the caller's permissions decide what comes back, not the key. */
export async function GET(request: Request) {
  const url = new URL(request.url)
  return withApiKey(request, 'tasks:read', async ({ ctx, actor }) => {
    const requested = url.searchParams.get('status')
    const status = STATUSES.find((value) => value === requested) ?? null
    const assignee = url.searchParams.get('assignee')
    const { tasks } = await listTasks(ctx, actor, {
      ...(status ? { status: [status] } : {}),
      ...(assignee ? { assigneeId: assignee } : {}),
      limit: Math.min(Number(url.searchParams.get('limit') ?? 50), 200),
    })
    return {
      data: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        assigneeId: task.assigneeId,
        dueAt: task.dueAt,
        createdAt: task.createdAt,
      })),
    }
  })
}

/** POST /api/v1/tasks — a write, so it needs the write scope and the human's permission. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}))
  return withApiKey(request, 'tasks:write', async ({ ctx, actor }) => {
    const task = await createTask(ctx, actor, {
      title: String(body.title ?? ''),
      description: body.description ?? null,
      assigneeId: body.assigneeId ?? null,
      priority: body.priority ?? 'medium',
      dueAt: body.dueAt ? new Date(body.dueAt) : null,
    })
    return { data: { id: task.id, title: task.title, status: task.status } }
  })
}
