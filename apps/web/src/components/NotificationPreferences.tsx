'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * When this person is written to.
 *
 * `quiet_hours`, `channel_defaults` and `per_type` sat in this table since migration 0010 and
 * were honoured by nothing — this screen showed the window read-only under a "Coming soon"
 * chip, which was at least honest. They are now what the one notification writer routes by
 * (ADR 0047): quiet hours hold an interruption until the window opens, never dropping it, and
 * each kind can be immediate, saved for the briefing, or nothing at all.
 */

const DELIVERIES = [
  { value: 'immediate', label: 'Straight away' },
  { value: 'digest', label: 'In my briefing' },
  { value: 'none', label: 'Nothing' },
] as const

export function NotificationPreferences({
  briefingHour,
  endOfDayHour,
  briefingEnabled,
  quietHours,
  timezone,
  perType,
  types,
  unmuteable,
}: {
  briefingHour: number
  endOfDayHour: number
  briefingEnabled: boolean
  quietHours: { start: string; end: string }
  timezone: string
  perType: Record<string, string>
  /** The kinds this product actually writes, with a sentence each. */
  types: { type: string; label: string }[]
  unmuteable: string[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [morning, setMorning] = useState(briefingHour)
  const [evening, setEvening] = useState(endOfDayHour)
  const [enabled, setEnabled] = useState(briefingEnabled)
  const [start, setStart] = useState(quietHours.start)
  const [end, setEnd] = useState(quietHours.end)
  const [routes, setRoutes] = useState<Record<string, string>>(perType)

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
        quietHours: { start, end },
        perType: routes,
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

        <div className="hairline-top stack stack-3" style={{ paddingTop: 'var(--s-4)' }} data-testid="quiet-hours">
          <div className="row wrap" style={{ alignItems: 'flex-end' }}>
            <label className="stack stack-2" style={{ flex: '0 0 150px' }} htmlFor="quiet-start">
              <span className="micro">Quiet from</span>
              <input
                id="quiet-start"
                className="input"
                type="time"
                value={start}
                onChange={(event) => setStart(event.target.value)}
              />
            </label>
            <label className="stack stack-2" style={{ flex: '0 0 150px' }} htmlFor="quiet-end">
              <span className="micro">Until</span>
              <input
                id="quiet-end"
                className="input"
                type="time"
                value={end}
                onChange={(event) => setEnd(event.target.value)}
              />
            </label>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            Inside that window nothing interrupts you — in {timezone}, your own timezone, not the
            company's. Nothing is dropped: what happens while you are quiet is written down when it
            happens and appears the moment the window opens, and reminders wait too, the same way
            they already wait for a weekend or a public holiday.
          </p>
        </div>

        <div className="hairline-top stack stack-3" style={{ paddingTop: 'var(--s-4)' }} data-testid="per-type">
          <span className="micro">And for each kind of thing</span>
          <table className="table">
            <tbody>
              {types.map(({ type, label }) => {
                const locked = unmuteable.includes(type)
                return (
                  <tr key={type}>
                    <td>
                      <span className="small">{label}</span>
                    </td>
                    <td style={{ width: 200 }}>
                      <select
                        className="select"
                        id={`route-${type}`}
                        aria-label={label}
                        value={locked ? 'immediate' : (routes[type] ?? 'immediate')}
                        disabled={locked}
                        title={locked ? 'This one cannot be turned down.' : undefined}
                        onChange={(event) => setRoutes({ ...routes, [type]: event.target.value })}
                      >
                        {DELIVERIES.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="small muted" style={{ margin: 0 }}>
            “Nothing” still records it — you can find it later, and turning a kind back on does not
            rewrite what happened while it was off. Two kinds cannot be turned down at all: being
            told that something about you reached somebody else, and the assistant stopping to ask
            you a question. A guarantee you can switch off is not one.
          </p>
        </div>
      </div>
    </section>
  )
}
