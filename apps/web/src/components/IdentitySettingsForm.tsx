'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Settings {
  ssoEnabled: boolean
  ssoProvider: string | null
  verifiedDomains: string[]
  jitProvisioning: boolean
  defaultRole: string
  scimEnabled: boolean
  scimTokenPrefix: string | null
  lastSyncAt: string | null
  lastSyncSummary: { created?: number; updated?: number; deactivated?: number } | null
}

interface Plan {
  create: { email: string; displayName: string }[]
  reactivate: { email: string; displayName: string }[]
  deactivate: { email: string; displayName: string }[]
  unchanged: number
  skippedUnverifiedDomain: string[]
}

export function IdentitySettingsForm({
  settings,
  region,
  regions,
}: {
  settings: Settings
  region: { region: string; allowed: string[] }
  regions: { id: string; label: string; note: string }[]
}) {
  const router = useRouter()
  const [form, setForm] = useState(settings)
  const [domains, setDomains] = useState(settings.verifiedDomains.join(', '))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scimToken, setScimToken] = useState<string | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [note, setNote] = useState<string | null>(null)

  async function save() {
    setBusy('save')
    setError(null)
    const response = await fetch('/api/identity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...form,
        verifiedDomains: domains
          .split(',')
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean),
      }),
    })
    setBusy(null)
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: 'That could not be saved.' }))
      setError(body.error)
      return
    }
    const payload = await response.json()
    if (payload.scimToken) setScimToken(payload.scimToken)
    setNote('Saved.')
    router.refresh()
  }

  async function sync(apply: boolean) {
    setBusy(apply ? 'apply' : 'preview')
    setError(null)
    const response = await fetch('/api/identity/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apply }),
    })
    setBusy(null)
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: 'The directory could not be read.' }))
      setError(body.error)
      return
    }
    const payload = await response.json()
    setPlan(payload.plan)
    if (payload.applied) {
      setNote(
        `${payload.applied.created} added, ${payload.applied.reactivated} reactivated, ${payload.applied.deactivated} deactivated.`,
      )
      router.refresh()
    }
  }

  async function moveRegion(next: string) {
    setBusy('region')
    setError(null)
    const response = await fetch('/api/identity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ region: next }),
    })
    setBusy(null)
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: 'That could not be changed.' }))
      setError(body.error)
      return
    }
    router.refresh()
  }

  return (
    <div className="stack stack-8">
      {note ? <div className="banner banner-accent">{note}</div> : null}
      {error ? <div className="banner banner-critical">{error}</div> : null}
      {scimToken ? (
        <div className="banner banner-accent stack stack-2">
          <strong>SCIM token — copy it now, it is not shown again.</strong>
          <code className="mono small" style={{ wordBreak: 'break-all' }}>
            {scimToken}
          </code>
        </div>
      ) : null}

      <section className="panel" data-testid="sso-settings">
        <div className="panel-header">
          <h2>Single sign-on</h2>
          <span className="chip chip-accent">simulated provider</span>
        </div>
        <div className="panel-body stack stack-4">
          <label className="row-tight">
            <input
              type="checkbox"
              checked={form.ssoEnabled}
              onChange={(event) => setForm({ ...form, ssoEnabled: event.target.checked })}
            />
            <span className="small">Allow signing in with the directory</span>
          </label>
          <label className="stack stack-1">
            <span className="micro">Verified domains — comma separated</span>
            <input className="input" value={domains} onChange={(event) => setDomains(event.target.value)} />
            <span className="small muted">
              Only addresses on these domains may be provisioned. Without one, nobody is provisioned automatically.
            </span>
          </label>
          <div className="row wrap" style={{ gap: 'var(--s-6)' }}>
            <label className="row-tight">
              <input
                type="checkbox"
                checked={form.jitProvisioning}
                onChange={(event) => setForm({ ...form, jitProvisioning: event.target.checked })}
              />
              <span className="small">Create people on first sign-in</span>
            </label>
            <label className="stack stack-1">
              <span className="micro">They arrive as</span>
              <select
                className="select"
                value={form.defaultRole}
                onChange={(event) => setForm({ ...form, defaultRole: event.target.value })}
              >
                <option value="viewer">viewer</option>
                <option value="member">member</option>
                <option value="manager">manager</option>
              </select>
              <span className="small muted">Owners and admins are never granted automatically.</span>
            </label>
          </div>
          <label className="row-tight">
            <input
              type="checkbox"
              checked={form.scimEnabled}
              onChange={(event) => setForm({ ...form, scimEnabled: event.target.checked })}
            />
            <span className="small">
              Enable SCIM provisioning{form.scimTokenPrefix ? ` (token ${form.scimTokenPrefix}…)` : ''}
            </span>
          </label>
          <div className="row">
            <button className="btn btn-primary" onClick={save} disabled={busy !== null}>
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </section>

      <section className="panel" data-testid="directory-sync">
        <div className="panel-header">
          <h2>Directory sync</h2>
          <span className="small muted">
            {settings.lastSyncAt
              ? `Last synced ${settings.lastSyncAt.slice(0, 16).replace('T', ' ')}`
              : 'Never synced'}
          </span>
        </div>
        <div className="panel-body stack stack-4">
          <p className="small secondary">
            A sync is previewed before it is applied, and nobody is ever deleted — people who
            have left are deactivated, so what they did stays attributable.
          </p>
          {plan ? (
            <div className="stack stack-3">
              <div className="row wrap" style={{ gap: 'var(--s-6)' }}>
                <span className="chip chip-positive">{plan.create.length} to add</span>
                <span className="chip">{plan.reactivate.length} to reactivate</span>
                <span className={`chip${plan.deactivate.length ? ' chip-attention' : ''}`}>
                  {plan.deactivate.length} to deactivate
                </span>
                <span className="chip">{plan.unchanged} unchanged</span>
                {plan.skippedUnverifiedDomain.length > 0 ? (
                  <span className="chip chip-critical">
                    {plan.skippedUnverifiedDomain.length} skipped — unverified domain
                  </span>
                ) : null}
              </div>
              {[...plan.create, ...plan.reactivate, ...plan.deactivate].slice(0, 10).map((person) => (
                <span className="small secondary" key={person.email}>
                  {person.displayName} · {person.email}
                </span>
              ))}
            </div>
          ) : null}
          <div className="row">
            <button className="btn" onClick={() => sync(false)} disabled={busy !== null}>
              {busy === 'preview' ? 'Reading…' : 'Preview a sync'}
            </button>
            {plan ? (
              <button className="btn btn-primary" onClick={() => sync(true)} disabled={busy !== null}>
                {busy === 'apply' ? 'Applying…' : 'Apply this plan'}
              </button>
            ) : null}
          </div>
        </div>
      </section>

      <section className="panel" data-testid="residency">
        <div className="panel-header">
          <h2>Data residency</h2>
          <span className="chip">{region.region.toUpperCase()}</span>
        </div>
        <div className="panel-body stack stack-3">
          {regions.map((entry) => {
            const allowed = region.allowed.includes(entry.id)
            const current = region.region === entry.id
            return (
              <div className="spread" key={entry.id}>
                <div className="stack stack-1">
                  <strong className="small">{entry.label}</strong>
                  <span className="small muted">{entry.note}</span>
                </div>
                {current ? (
                  <span className="chip chip-positive">current</span>
                ) : allowed ? (
                  <button className="btn btn-sm" onClick={() => moveRegion(entry.id)} disabled={busy !== null}>
                    Switch
                  </button>
                ) : (
                  <span className="chip" title="Moving region means moving the data. It is a migration, not a setting.">
                    not provisioned
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
