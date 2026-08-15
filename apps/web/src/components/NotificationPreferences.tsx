'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * When this person is written to.
 *
 * `notification_preferences` has been read by the briefing scheduler since Phase 2 and
 * written by nothing but the seed, so everybody got the default hour and had no way to say
 * otherwise. Only the three fields the scheduler actually reads are settable here; quiet
 * hours and per-type channels sit in the same table and are honoured by nothing, so they
 * are shown as not yet in force rather than offered as a control that would change a number
 * nobody consults (§25).
 */

export function NotificationPreferences({
  briefingHour,
  endOfDayHour,
  briefingEnabled,
  quietHours,
  timezone,
}: {
  briefingHour: number
  endOfDayHour: number
  briefingEnabled: boolean
  quietHours: { start: string; end: string }
  timezone: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [morning, setMorning] = useState(briefingHour)
  const [evening, setEvening] = useState(endOfDayHour)
  const [enabled, setEnabled] = useState(briefingEnabled)

  async function save() {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/reminders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'preferences',
        briefingHour: morning,
        endOfDayHour: evening,
        briefingEnabled: enabled,
      }),
    })
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(payload.error)
      return
    }
    setSaved(true)
    router.refresh()
  }

  const hours = Array.from({ length: 24 }, (_, hour) => hour)

  return (
    <section className="panel" data-testid="notification-preferences">
      <div className="panel-header">
        <h2>When you hear from Superwork</h2>
        <span className="small muted">in {timezone}</span>
      </div>
      <div className="panel-body stack stack-4">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}
        {saved ? <div className="banner banner-accent">Saved. The next briefing follows this.</div> : null}

        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <label className="stack stack-2" style={{ flex: '0 0 190px' }} htmlFor="briefing-hour">
            <span className="micro">Morning briefing at</span>
            <select
              id="briefing-hour"
              className="select"
              value={morning}
              disabled={!enabled}
              onChange={(event) => setMorning(Number(event.target.value))}
            >
              {hours.map((hour) => (
                <option key={hour} value={hour}>
                  {String(hour).padStart(2, '0')}:00
                </option>
              ))}
            </select>
          </label>
          <label className="stack stack-2" style={{ flex: '0 0 190px' }} htmlFor="end-of-day-hour">
            <span className="micro">End-of-day digest at</span>
            <select
              id="end-of-day-hour"
              className="select"
              value={evening}
              onChange={(event) => setEvening(Number(event.target.value))}
            >
              {hours.map((hour) => (
                <option key={hour} value={hour}>
                  {String(hour).padStart(2, '0')}:00
                </option>
              ))}
            </select>
          </label>
          <label className="row-tight" style={{ flex: '0 0 auto' }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              data-testid="briefing-enabled"
            />
            <span className="small">Send me a morning briefing</span>
          </label>
        </div>

        <div className="row wrap">
          <button className="btn btn-primary" data-testid="preferences-save" disabled={busy} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>

        <div className="hairline-top stack stack-2" style={{ paddingTop: 'var(--s-4)' }}>
          <label className="stack stack-2" htmlFor="quiet-hours">
            <span className="micro">Quiet hours</span>
            <div className="row-tight">
              <input
                id="quiet-hours"
                className="input"
                style={{ maxWidth: 200 }}
                value={`${quietHours.start} – ${quietHours.end}`}
                disabled
                readOnly
              />
              <span className="chip">Coming soon · phase 6</span>
            </div>
          </label>
          <p className="small muted" style={{ margin: 0 }}>
            Recorded against your account and honoured by nothing yet: reminders are rationed by a
            daily budget rather than held to a window. It is shown because it is stored, not
            because it works.
          </p>
        </div>
      </div>
    </section>
  )
}
