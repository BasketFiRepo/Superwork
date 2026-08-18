'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Which milestone this work is part of (§17, ADR 0048).
 *
 * `tasks.milestone_id` has existed since migration 0002 and nothing ever wrote it, so a
 * milestone was a date with a name on it and nothing underneath — "what is this waiting on"
 * had no answer, and neither did "is it going to make it".
 *
 * The choices are the open milestones of this task's own project, because a milestone is a
 * promise one project makes. A task on no project has none to choose from, and the panel says
 * that rather than offering an empty list.
 */
export function TaskMilestone({
  taskId,
  projectName,
  milestoneId,
  milestones,
  dueAt,
}: {
  taskId: string
  projectName: string | null
  milestoneId: string | null
  /** The open milestones of the task's project, plus the one it is already on. */
  milestones: { id: string; name: string; dueOn: string | null; status: string }[]
  /** This task's own due date, for saying plainly when it lands after the milestone. */
  dueAt: string | null
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function choose(next: string) {
    setBusy(true)
    setError(null)
    const response = await fetch(`/api/tasks/${taskId}/milestone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ milestoneId: next || null }),
    })
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(payload.error)
      return
    }
    router.refresh()
  }

  const current = milestones.find((milestone) => milestone.id === milestoneId) ?? null
  // Stated rather than scored: the task is due after the date the project is judged against.
  const lands = current?.dueOn && dueAt ? dueAt.slice(0, 10) > current.dueOn : false

  return (
    <section className="panel" data-testid="task-milestone">
      <div className="panel-header">
        <h2>Part of</h2>
        <span className="small muted">{current ? current.name : 'No milestone'}</span>
      </div>

      <div className="panel-body stack stack-4">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        {projectName === null ? (
          <p className="small secondary" style={{ margin: 0 }} data-testid="milestone-no-project">
            A milestone belongs to a project, and this task is not on one. Put it on a project and
            its milestones will be offered here.
          </p>
        ) : (
          <>
            <label className="stack stack-2" htmlFor="task-milestone-select">
              <span className="micro">Milestone of {projectName}</span>
              <select
                id="task-milestone-select"
                className="select"
                value={milestoneId ?? ''}
                disabled={busy}
                onChange={(event) => choose(event.target.value)}
              >
                <option value="">Not part of a milestone</option>
                {milestones.map((milestone) => (
                  <option key={milestone.id} value={milestone.id}>
                    {milestone.name}
                    {milestone.dueOn ? ` — due ${milestone.dueOn.slice(0, 10)}` : ''}
                    {milestone.status !== 'open' ? ` (${milestone.status})` : ''}
                  </option>
                ))}
              </select>
            </label>

            {lands ? (
              <div className="banner banner-attention" data-testid="milestone-lands-after">
                This task is due after “{current!.name}” is. That is the milestone saying it will
                slip, in advance — move one of the two dates, or take the task off it.
              </div>
            ) : null}

            <p className="small muted" style={{ margin: 0 }}>
              A milestone cannot be marked reached while work on it is still open, so what is
              filed here is what somebody will be held to.
            </p>
          </>
        )}
      </div>
    </section>
  )
}
