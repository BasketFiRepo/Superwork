'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * The conversation about a task (§12.1).
 *
 * The agent's `comment_on_task@v1` tool has been writing here since Phase 0 under a
 * description promising the comment is "attributed to the agent by name. Never post as if a
 * person wrote it." Nothing read the table, so those notes were invisible — and no person
 * could add one, because the only writer was a tool.
 *
 * An agent's comment is marked as one on the row. Mentioning somebody puts a notification on
 * their reminders screen; it does not email them, because nothing leaves the company because
 * a colleague typed a name.
 */

export interface CommentRow {
  id: string
  body: string
  authorName: string | null
  byAgent: boolean
  mentions: { userId: string; name: string }[]
  canDelete: boolean
  createdAt: string
}

export interface Candidate {
  id: string
  name: string
}

export function TaskComments({
  taskId,
  comments,
  people,
}: {
  taskId: string
  comments: CommentRow[]
  people: Candidate[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [body, setBody] = useState('')
  const [mentions, setMentions] = useState<string[]>([])

  async function post(payload: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const response = await fetch(`/api/tasks/${taskId}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const result = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(result.error)
      return
    }
    setBody('')
    setMentions([])
    router.refresh()
  }

  return (
    <section className="panel" data-testid="task-comments">
      <div className="panel-header">
        <h2>Comments</h2>
        <span className="small muted">
          {comments.length === 0 ? 'Nothing said yet' : `${comments.length}`}
        </span>
      </div>

      <div className="panel-body stack stack-5">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        {comments.length === 0 ? (
          <div className="empty small secondary">
            Nothing has been said about this task. The assistant leaves its notes here too, marked
            as its own.
          </div>
        ) : (
          <div className="stack stack-4">
            {comments.map((comment) => (
              <div key={comment.id} className="stack stack-2" data-testid="comment-row">
                <div className="row-tight wrap">
                  <span className={comment.byAgent ? 'chip chip-accent' : 'chip'}>
                    {comment.byAgent ? 'the assistant' : (comment.authorName ?? 'somebody since removed')}
                  </span>
                  <span className="small muted">{comment.createdAt.slice(0, 16).replace('T', ' ')}</span>
                  {comment.mentions.length > 0 ? (
                    <span className="small muted">
                      told {comment.mentions.map((person) => person.name).join(', ')}
                    </span>
                  ) : null}
                  {comment.canDelete ? (
                    <button
                      className="btn btn-ghost small"
                      data-testid="comment-remove"
                      disabled={busy}
                      onClick={() => post({ action: 'remove', commentId: comment.id })}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
                <p className="prose" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                  {comment.body}
                </p>
              </div>
            ))}
          </div>
        )}

        <div className="stack stack-3" data-testid="comment-editor">
          <label className="stack stack-2" htmlFor="comment-body">
            <span className="micro">Say something</span>
            <textarea
              id="comment-body"
              className="input"
              rows={3}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="What is holding this up?"
            />
          </label>
          <label className="stack stack-2" htmlFor="comment-mentions">
            <span className="micro">Tell somebody (optional) — it lands on their reminders, not their email</span>
            <select
              id="comment-mentions"
              className="select"
              multiple
              size={3}
              value={mentions}
              onChange={(event) =>
                setMentions(Array.from(event.target.selectedOptions).map((option) => option.value))
              }
            >
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <button
              className="btn btn-primary"
              data-testid="comment-send"
              disabled={busy || body.trim().length === 0}
              onClick={() => post({ action: 'add', body: body.trim(), mentions })}
            >
              {busy ? 'Saving…' : 'Comment'}
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
