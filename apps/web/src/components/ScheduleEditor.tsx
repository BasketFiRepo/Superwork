'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * When an automation runs (§10.2).
 *
 * Nothing is committed to a clock without showing the first firings. A cron string — or
 * `@daily` — is not something a person should have to trust; the preview turns it into
 * three dates and a sentence, and the same server rules decide whether it is acceptable.
 */

interface Preview {
  cron: string
  description: string
  next: string[]
}

const ALIASES = ['@hourly', '@daily', '@weekly', '@monthly', '@yearly']

const POLICIES: { value: string; label: string; help: string }[] = [
  { value: 'run_once', label: 'Catch up once', help: 'A lost night fires once, not twelve times.' },
  { value: 'skip_missed', label: 'Skip what was missed', help: 'A firing more than ten minutes late is dropped.' },
  { value: 'run_all', label: 'Catch up to five', help: 'Fires each missed run, up to five in one sweep.' },
]

export function ScheduleEditor({
  workflowId,
  cron,
  timezone,
  catchUpPolicy,
  enabled,
}: {
  workflowId: string
  cron: string | null
  timezone: string
  catchUpPolicy: string
  enabled: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [spec, setSpec] = useState(cron ?? '@daily')
  const [policy, setPolicy] = useState(catchUpPolicy)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function call(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const response = await fetch(`/api/workflows/${workflowId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(payload.error)
      return null
    }
    return payload
  }

  if (!open) {
    return (
      <div className="row wrap">
        <button className="btn" data-testid="change-schedule" onClick={() => setOpen(true)}>
          Change when it runs
        </button>
        <button
          className="btn btn-ghost"
          disabled={busy}
          onClick={async () => {
            if (await call({ action: 'schedule', cron: cron ?? '@daily', enabled: !enabled })) router.refresh()
          }}
        >
          {enabled ? 'Stop the clock' : 'Start the clock'}
        </button>
      </div>
    )
  }

  return (
    <div className="stack stack-4" data-testid="schedule-editor">
      <label className="stack stack-2" htmlFor="schedule-cron">
        <span className="micro">When</span>
        <input
          id="schedule-cron"
          className="input"
          value={spec}
          onChange={(event) => {
            setSpec(event.target.value)
            setPreview(null)
          }}
          placeholder="@daily, or 0 9 * * 1-5"
        />
        <span className="small muted">
          An alias, or five cron fields — minute, hour, day of month, month, day of week. Times are read in{' '}
          {timezone}.
        </span>
      </label>

      <div className="row wrap">
        {ALIASES.map((alias) => (
          <button
            key={alias}
            type="button"
            className="btn btn-ghost small"
            onClick={() => {
              setSpec(alias)
              setPreview(null)
            }}
          >
            {alias}
          </button>
        ))}
      </div>

      <label className="stack stack-2" htmlFor="schedule-policy">
        <span className="micro">If a firing is missed</span>
        <select
          id="schedule-policy"
          className="select"
          value={policy}
          onChange={(event) => setPolicy(event.target.value)}
        >
          {POLICIES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="small muted">{POLICIES.find((option) => option.value === policy)?.help}</span>
      </label>

      {error ? (
        <div className="banner banner-critical" role="alert">
          {error}
        </div>
      ) : null}

      {preview ? (
        <div className="stack stack-2" data-testid="schedule-preview">
          <div className="banner">
            <span>Runs {preview.description}.</span>
          </div>
          <ul className="stack stack-2 small secondary" style={{ margin: 0, paddingLeft: 'var(--s-7)' }}>
            {preview.next.map((instant) => (
              <li key={instant}>{new Date(instant).toISOString().slice(0, 16).replace('T', ' ')} UTC</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="row wrap">
        <button
          className="btn"
          disabled={busy || !spec.trim()}
          onClick={async () => {
            const payload = await call({ action: 'preview_schedule', cron: spec })
            if (payload) setPreview(payload.preview)
          }}
        >
          {busy ? 'Working…' : 'Show me the next three'}
        </button>
        <button
          className="btn btn-primary"
          data-testid="save-schedule"
          disabled={busy || !preview}
          title={preview ? 'Saves this schedule.' : 'See the next three firings first.'}
          onClick={async () => {
            if (await call({ action: 'schedule', cron: spec, catchUpPolicy: policy })) {
              setOpen(false)
              setPreview(null)
              router.refresh()
            }
          }}
        >
          Save this schedule
        </button>
        <button
          className="btn btn-ghost"
          disabled={busy}
          onClick={() => {
            setSpec(cron ?? '@daily')
            setPolicy(catchUpPolicy)
            setPreview(null)
            setError(null)
            setOpen(false)
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
