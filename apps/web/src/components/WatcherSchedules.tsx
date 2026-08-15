'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * What is watching, and when (§9.1, §9.2).
 *
 * Every watcher declares a cadence in its own source; this is that cadence, running. The
 * row says when it last looked, when it looks next, and — when a watcher has been muted for
 * being noise — that it is muted and why, because a watcher that has silently stopped is
 * indistinguishable from one that has nothing to say.
 *
 * The verdict comes from what people said when they dismissed an insight, which is a
 * question the card has asked since Phase 3 into a table nothing read. It is shown in full
 * rather than as a rate: "already handled" and "wrong" are opposite verdicts on a watcher
 * and a single dismissal percentage cannot tell them apart (ADR 0031).
 */

export interface WatcherRow {
  key: string
  title: string
  description: string
  cron: string
  declaredCron: string
  enabled: boolean
  muted: boolean
  lastRunAt: string | null
  nextRunAt: string | null
  quality: {
    verdict: 'good' | 'late' | 'misrouted' | 'muted' | 'quiet'
    reason: string
    shown: number
    rated: number
  } | null
}

/** What each verdict is called on the row, and how loudly. */
const VERDICT: Record<string, { label: string; chip: string }> = {
  muted: { label: 'muted', chip: 'chip-attention' },
  late: { label: 'right, but late', chip: 'chip-attention' },
  misrouted: { label: 'reaching the wrong people', chip: 'chip-attention' },
  quiet: { label: 'not enough ratings to judge', chip: '' },
  good: { label: 'worth having', chip: '' },
}

const PRESETS = ['@hourly', '0 8 * * 1-5', '@daily', '@weekly']

export function WatcherSchedules({ watchers, canEdit }: { watchers: WatcherRow[]; canEdit: boolean }) {
  const router = useRouter()
  const [editing, setEditing] = useState<string | null>(null)
  const [spec, setSpec] = useState('')
  const [preview, setPreview] = useState<{ description: string; next: string[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function call(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/watchers', {
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

  return (
    <section className="panel" data-testid="watcher-schedules">
      <div className="panel-header">
        <h2>What is watching</h2>
        <span className="small muted">Each on the cadence it declares, in your timezone</span>
      </div>

      {error ? (
        <div className="panel-body">
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        </div>
      ) : null}

      <div className="panel-body-flush table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Watcher</th>
              <th style={{ width: 240 }}>Runs</th>
              <th style={{ width: 150 }}>Last</th>
              <th style={{ width: 150 }}>Next</th>
              {canEdit ? <th style={{ width: 170 }} /> : null}
            </tr>
          </thead>
          <tbody>
            {watchers.map((watcher) => (
              <tr key={watcher.key} data-testid="watcher-row">
                <td>
                  <div>{watcher.title}</div>
                  {!watcher.enabled ? <span className="chip chip-attention">stopped</span> : null}
                  {watcher.quality && watcher.quality.shown > 0 ? (
                    <div className="stack stack-2" data-testid="watcher-verdict">
                      <span className={`chip ${VERDICT[watcher.quality.verdict]?.chip ?? ''}`}>
                        {VERDICT[watcher.quality.verdict]?.label ?? watcher.quality.verdict}
                      </span>
                      <span className="small muted">{watcher.quality.reason}</span>
                    </div>
                  ) : (
                    <span className="small muted">Nothing found yet — nothing to judge.</span>
                  )}
                </td>
                <td className="small secondary">
                  {watcher.description}
                  {watcher.cron !== watcher.declaredCron ? (
                    <div className="small muted">changed from its default of {watcher.declaredCron}</div>
                  ) : null}
                </td>
                <td className="small secondary">
                  {watcher.lastRunAt ? watcher.lastRunAt.slice(0, 16).replace('T', ' ') : 'never'}
                </td>
                <td className="small secondary">
                  {watcher.enabled && watcher.nextRunAt ? watcher.nextRunAt.slice(0, 16).replace('T', ' ') : '—'}
                </td>
                {canEdit ? (
                  <td>
                    <div className="row-tight">
                      <button
                        className="btn btn-ghost small"
                        disabled={busy}
                        onClick={() => {
                          setEditing(editing === watcher.key ? null : watcher.key)
                          setSpec(watcher.cron)
                          setPreview(null)
                          setError(null)
                        }}
                      >
                        Re-time
                      </button>
                      <button
                        className="btn btn-ghost small"
                        disabled={busy}
                        onClick={async () => {
                          if (await call({ action: watcher.enabled ? 'disable' : 'enable', key: watcher.key })) {
                            router.refresh()
                          }
                        }}
                      >
                        {watcher.enabled ? 'Stop' : 'Start'}
                      </button>
                    </div>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing ? (
        <div className="panel-body stack stack-4" data-testid="watcher-editor">
          <label className="stack stack-2" htmlFor="watcher-cron">
            <span className="micro">When should {watchers.find((w) => w.key === editing)?.title} look?</span>
            <input
              id="watcher-cron"
              className="input"
              value={spec}
              onChange={(event) => {
                setSpec(event.target.value)
                setPreview(null)
              }}
              placeholder="@daily, or 0 8 * * 1-5"
            />
          </label>
          <div className="row wrap">
            {PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className="btn btn-ghost small"
                onClick={() => {
                  setSpec(preset)
                  setPreview(null)
                }}
              >
                {preset}
              </button>
            ))}
          </div>

          {preview ? (
            <div className="stack stack-2" data-testid="watcher-preview">
              <div className="banner">
                <span>Looks {preview.description}.</span>
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
                const payload = await call({ action: 'preview_schedule', key: editing, cron: spec })
                if (payload) setPreview(payload.preview)
              }}
            >
              {busy ? 'Working…' : 'Show me the next three'}
            </button>
            <button
              className="btn btn-primary"
              disabled={busy || !preview}
              onClick={async () => {
                if (await call({ action: 'schedule', key: editing, cron: spec })) {
                  setEditing(null)
                  setPreview(null)
                  router.refresh()
                }
              }}
            >
              Save this cadence
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
