'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useStepUp } from './StepUp'

interface Settings {
  ssoEnabled: boolean
  ssoProvider: string | null
  ssoMetadataUrl: string | null
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

interface Region {
  region: string
  allowed: string[]
  provisioned: string[]
  setByName: string | null
  setAt: string | null
  reason: string | null
}

export function IdentitySettingsForm({
  settings,
  region,
  regions,
}: {
  settings: Settings
  region: Region
  regions: { id: string; label: string; note: string }[]
}) {
  const router = useRouter()
  const stepUp = useStepUp()
  const [form, setForm] = useState(settings)
  const [domains, setDomains] = useState(settings.verifiedDomains.join(', '))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scimToken, setScimToken] = useState<string | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [regionEdit, setRegionEdit] = useState<{ id: string; allow: boolean } | null>(null)
  const [regionWhy, setRegionWhy] = useState('')

  /**
   * Saying where this company's data may be kept (ADR 0074).
   *
   * Widening asks for a password because it widens, and the client decides that from the same
   * fact the repository does — whether the region is being added. The repository is still the
   * authority: this only saves the round trip of being refused.
   */
  async function saveRegions(next: string[], widening: boolean) {
    setBusy('regions')
    setError(null)
    const send = () =>
      fetch('/api/data-regions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ regions: next, reason: regionWhy.trim() }),
      })
    const response = widening ? await stepUp.run(send) : await send()
    setBusy(null)
    if (!response) return
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    if (!response.ok) {
      setError(payload.error)
      return
    }
    setRegionEdit(null)
    setRegionWhy('')
    router.refresh()
  }

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
      {error ? (
        <div className="banner banner-critical" role="alert" data-testid="identity-error">
          {error}
        </div>
      ) : null}
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
          {/*
            The two fields that make that switch mean something (ADR 0087). Until this, `sso_enabled`
            was a switch with no sign-in to allow and `sso_metadata_url` had no writer at all —
            because nothing in the product had ever called `verifyAssertion`.
          */}
          <div className="row wrap" style={{ gap: 'var(--s-6)' }}>
            <label className="stack stack-1" style={{ flex: '0 0 180px' }}>
              <span className="micro">Directory</span>
              <input
                className="input"
                data-testid="sso-provider"
                value={form.ssoProvider ?? ''}
                placeholder="Okta"
                onChange={(event) => setForm({ ...form, ssoProvider: event.target.value || null })}
              />
            </label>
            <label className="stack stack-1" style={{ flex: '1 1 280px' }}>
              <span className="micro">Metadata URL</span>
              <input
                className="input"
                data-testid="sso-metadata-url"
                value={form.ssoMetadataUrl ?? ''}
                placeholder="https://example.okta.com/app/exk1/sso/saml/metadata"
                onChange={(event) => setForm({ ...form, ssoMetadataUrl: event.target.value || null })}
              />
              <span className="small muted">
                Where the directory publishes the key that signs an assertion. Single sign-on cannot
                be turned on without one: Superwork would be trusting whatever arrived.
              </span>
            </label>
          </div>
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
        {/* Asked for beside the thing it protects, not at the top of the page. */}
        {stepUp.prompt}

        <div className="panel-header">
          <h2>Data residency</h2>
          <span className="chip">{region.region.toUpperCase()}</span>
        </div>

        {/* `allowed_regions` was read by four things and written by nothing, so every organization
            sat at the column's default and this panel refused two of the three regions it offered
            — with a message naming a provisioning act nobody could perform (ADR 0074). */}
        <p className="small muted" style={{ margin: 0, padding: '0 var(--s-5)' }} data-testid="residency-explainer">
          Where your data <em>is</em>, and where you have said it <em>may</em> go. Ruling a region out is a
          promise this company makes about itself and Superwork will keep it. Allowing one again asks for
          your password, because it widens.
        </p>

        <div className="panel-body stack stack-3">
          {regions.map((entry) => {
            const allowed = region.allowed.includes(entry.id)
            const provisioned = region.provisioned.includes(entry.id)
            const current = region.region === entry.id
            const editing = regionEdit?.id === entry.id
            const next = regionEdit?.allow
              ? [...region.allowed, entry.id]
              : region.allowed.filter((id) => id !== entry.id)
            return (
              <div className="stack stack-2" key={entry.id} data-testid="residency-region">
                <div className="spread">
                  <div className="stack stack-1">
                    <strong className="small">{entry.label}</strong>
                    <span className="small muted">{entry.note}</span>
                  </div>
                  <div className="row-tight">
                    {current ? <span className="chip chip-positive">current</span> : null}
                    {!provisioned ? (
                      /* Was a `title` tooltip, which no keyboard reaches. It is also the one
                         case a button would be a lie, so it says what would work instead. */
                      <span className="small muted" data-testid="region-unprovisioned">
                        No database here — ask us to provision it
                      </span>
                    ) : allowed ? (
                      <>
                        {!current ? (
                          <button
                            className="btn btn-sm"
                            onClick={() => moveRegion(entry.id)}
                            disabled={busy !== null}
                          >
                            Switch
                          </button>
                        ) : null}
                        <button
                          className="btn btn-ghost btn-sm"
                          data-testid="region-restrict"
                          disabled={busy !== null || current}
                          title={current ? 'Your data is here. Move it before ruling this region out.' : undefined}
                          onClick={() => {
                            setRegionEdit({ id: entry.id, allow: false })
                            setRegionWhy('')
                          }}
                        >
                          Rule out
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn btn-sm"
                        data-testid="region-allow"
                        disabled={busy !== null}
                        onClick={() => {
                          setRegionEdit({ id: entry.id, allow: true })
                          setRegionWhy('')
                        }}
                      >
                        Allow
                      </button>
                    )}
                  </div>
                </div>

                {editing ? (
                  <div className="stack stack-2" data-testid="region-editor">
                    <label className="stack stack-2">
                      <span className="micro">
                        {regionEdit!.allow
                          ? `Why ${entry.label} may hold this company’s data`
                          : `Why this company’s data may not be kept in ${entry.label}`}
                      </span>
                      <input
                        className="input"
                        id="region-reason"
                        value={regionWhy}
                        onChange={(event) => setRegionWhy(event.target.value)}
                        placeholder={
                          regionEdit!.allow
                            ? 'Opening a Manchester office; our UK entity signs its own contracts.'
                            : 'Customer contracts commit us to EU-only processing.'
                        }
                      />
                    </label>
                    <div className="row-tight">
                      <button
                        className="btn btn-primary btn-sm"
                        data-testid="region-confirm"
                        disabled={busy !== null || regionWhy.trim().length < 4}
                        onClick={() => saveRegions(next, regionEdit!.allow)}
                      >
                        {busy === 'regions' ? 'Saving…' : regionEdit!.allow ? 'Allow it' : 'Rule it out'}
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        data-testid="region-cancel"
                        disabled={busy !== null}
                        onClick={() => setRegionEdit(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            )
          })}

          <p className="small muted" style={{ margin: 0 }} data-testid="residency-attribution">
            {region.setByName && region.setAt ? (
              <>
                Set by {region.setByName} on {region.setAt.slice(0, 10)} — &ldquo;{region.reason}&rdquo;
              </>
            ) : (
              /* Not blank. "Nobody has narrowed this" is the fact, and for every organization
                 that existed before this was buildable it is the true one. */
              <>Nobody has ruled a region out. Your data may be kept anywhere you are provisioned for.</>
            )}
          </p>
        </div>
      </section>
    </div>
  )
}
