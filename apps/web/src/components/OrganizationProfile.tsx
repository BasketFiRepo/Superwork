'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * What the organization says about itself (§4.1, ADR 0052).
 *
 * `organizations` was written by the seed and by almost nothing else, so every organization was
 * Northwind Logistics, in Europe/London, that thinks a reefer is a temperature-controlled
 * trailer. Each field here is read by something, and the screen says by what — a settings field
 * whose effect nobody can name is one nobody will dare change.
 */

export interface OrganizationProfileRow {
  name: string
  slug: string
  industry: string | null
  timezone: string
  currency: string
  tone: string | null
  glossary: { term: string; meaning: string }[]
  peopleOnTheOrgClock: number
  departmentsOnTheOrgClock: number
}

export function OrganizationProfileAdmin({
  profile,
  canEdit,
}: {
  profile: OrganizationProfileRow
  canEdit: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  const [name, setName] = useState(profile.name)
  const [industry, setIndustry] = useState(profile.industry ?? '')
  const [timezone, setTimezone] = useState(profile.timezone)
  const [currency, setCurrency] = useState(profile.currency)
  const [tone, setTone] = useState(profile.tone ?? '')

  const [term, setTerm] = useState('')
  const [meaning, setMeaning] = useState('')

  const changed =
    name.trim() !== profile.name ||
    industry.trim() !== (profile.industry ?? '') ||
    timezone.trim() !== profile.timezone ||
    currency.trim().toUpperCase() !== profile.currency ||
    tone.trim() !== (profile.tone ?? '')

  async function post(body: Record<string, unknown>, note: string) {
    setBusy(true)
    setError(null)
    setSaved(null)
    const response = await fetch('/api/organization', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(payload.error)
      return
    }
    setSaved(note)
    setTerm('')
    setMeaning('')
    router.refresh()
  }

  return (
    <>
      <section className="panel" data-testid="organization-profile">
        <div className="panel-header">
          <h2>This organization</h2>
          <span className="small muted">{profile.slug}</span>
        </div>

        <div className="panel-body stack stack-4">
          {error ? (
            <div className="banner banner-critical" role="alert">
              {error}
            </div>
          ) : null}
          {saved ? (
            <div className="banner" role="status" data-testid="organization-saved">
              {saved}
            </div>
          ) : null}

          <p className="prose small secondary" style={{ margin: 0 }} data-testid="organization-explainer">
            Every one of these is read by something. The name and what the company does are the
            grounding the assistant is given, and the name is on the transparency report anybody
            can ask for about themselves. The clock decides what “today” and “overdue” mean for
            the {profile.peopleOnTheOrgClock}{' '}
            {profile.peopleOnTheOrgClock === 1 ? 'person' : 'people'} who have no timezone of
            their own and the {profile.departmentsOnTheOrgClock}{' '}
            {profile.departmentsOnTheOrgClock === 1 ? 'department' : 'departments'} that fall back
            to it. The currency is how money is written on every screen. The web address —{' '}
            <span className="mono">{profile.slug}</span> — is deliberately not changeable: it is
            an address, and changing it would break every link anybody kept.
          </p>

          <div className="row wrap" style={{ alignItems: 'flex-end' }}>
            <label className="stack stack-2" style={{ flex: '1 1 260px' }} htmlFor="organization-name">
              <span className="micro">Name</span>
              <input
                id="organization-name"
                className="input"
                data-testid="organization-name"
                disabled={!canEdit || busy}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="stack stack-2" style={{ flex: '1 1 260px' }} htmlFor="organization-industry">
              <span className="micro">What it does</span>
              <input
                id="organization-industry"
                className="input"
                data-testid="organization-industry"
                disabled={!canEdit || busy}
                value={industry}
                onChange={(event) => setIndustry(event.target.value)}
                placeholder="Freight forwarding and third-party logistics"
              />
            </label>
          </div>

          <div className="row wrap" style={{ alignItems: 'flex-end' }}>
            <label className="stack stack-2" style={{ flex: '1 1 220px' }} htmlFor="organization-timezone">
              <span className="micro">Company clock</span>
              <input
                id="organization-timezone"
                className="input"
                data-testid="organization-timezone"
                disabled={!canEdit || busy}
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                placeholder="Europe/London"
              />
              <span className="micro muted">
                An IANA name, the kind with a slash in. Changing it changes which work is late.
              </span>
            </label>
            <label className="stack stack-2" style={{ flex: '0 0 160px' }} htmlFor="organization-currency">
              <span className="micro">Money</span>
              <input
                id="organization-currency"
                className="input"
                data-testid="organization-currency"
                disabled={!canEdit || busy}
                value={currency}
                onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                placeholder="GBP"
                maxLength={3}
              />
              <span className="micro muted">Three-letter code.</span>
            </label>
          </div>

          <label className="stack stack-2" htmlFor="organization-tone">
            <span className="micro">How it asks to be written to</span>
            <textarea
              id="organization-tone"
              className="input"
              data-testid="organization-tone"
              rows={2}
              disabled={!canEdit || busy}
              value={tone}
              onChange={(event) => setTone(event.target.value)}
              placeholder="Direct, warm, never breezy. Short sentences. No exclamation marks."
            />
            <span className="micro muted">
              Given to the assistant with everything it writes. It adds to how this product
              already writes and cannot switch it off — hedging honestly, and every number
              carrying its basis, are not settings.
            </span>
          </label>

          {canEdit ? (
            <div className="row wrap">
              <button
                className="btn btn-primary"
                data-testid="organization-save"
                disabled={busy || !changed || name.trim().length < 2}
                onClick={() =>
                  post(
                    {
                      action: 'profile',
                      name: name.trim(),
                      industry: industry.trim() || null,
                      timezone: timezone.trim(),
                      currency: currency.trim().toUpperCase(),
                      tone: tone.trim() || null,
                    },
                    'Saved.',
                  )
                }
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
              {changed ? <span className="small muted">Unsaved changes.</span> : null}
            </div>
          ) : (
            <p className="small muted" style={{ margin: 0 }}>
              Changing what this organization says about itself needs administrator access.
            </p>
          )}
        </div>
      </section>

      <section className="panel" data-testid="organization-glossary">
        <div className="panel-header">
          <h2>Words this company uses</h2>
          <span className="small muted">{profile.glossary.length}</span>
        </div>

        <div className="panel-body stack stack-4">
          <p className="prose small secondary" style={{ margin: 0 }} data-testid="glossary-explainer">
            Every search is widened with these before it goes looking, so a person can type the
            acronym they say out loud and find the document that spells it out. A term is matched
            on whole words and never as a pattern, so nothing here can change what a search means
            beyond adding its meaning to it.
          </p>

          {profile.glossary.length === 0 ? (
            <div className="empty small secondary">
              Nothing yet. Add the acronyms and shorthand your people type into search.
            </div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 160 }}>Term</th>
                    <th>Means</th>
                    {canEdit ? <th style={{ width: 90 }} /> : null}
                  </tr>
                </thead>
                <tbody>
                  {profile.glossary.map((entry) => (
                    <tr key={entry.term} data-testid="glossary-row">
                      <td className="mono">{entry.term}</td>
                      <td className="small secondary">{entry.meaning}</td>
                      {canEdit ? (
                        <td>
                          <button
                            className="btn btn-ghost small"
                            data-testid="glossary-remove"
                            disabled={busy}
                            onClick={() =>
                              post(
                                { action: 'glossary.remove', term: entry.term },
                                `“${entry.term}” is no longer expanded in searches.`,
                              )
                            }
                          >
                            Remove
                          </button>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {canEdit ? (
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <label className="stack stack-2" style={{ flex: '0 0 160px' }} htmlFor="glossary-term">
                <span className="micro">Term</span>
                <input
                  id="glossary-term"
                  className="input"
                  data-testid="glossary-term"
                  disabled={busy}
                  value={term}
                  onChange={(event) => setTerm(event.target.value)}
                  placeholder="IMM"
                />
              </label>
              <label className="stack stack-2" style={{ flex: '1 1 260px' }} htmlFor="glossary-meaning">
                <span className="micro">Means</span>
                <input
                  id="glossary-meaning"
                  className="input"
                  data-testid="glossary-meaning"
                  disabled={busy}
                  value={meaning}
                  onChange={(event) => setMeaning(event.target.value)}
                  placeholder="Immingham port"
                />
              </label>
              <button
                className="btn"
                data-testid="glossary-add"
                disabled={busy || term.trim().length < 2 || meaning.trim().length < 2}
                onClick={() =>
                  post(
                    { action: 'glossary.set', term: term.trim(), meaning: meaning.trim() },
                    `Searches for “${term.trim()}” will also look for “${meaning.trim()}”.`,
                  )
                }
              >
                {busy ? 'Working…' : 'Add it'}
              </button>
            </div>
          ) : null}
        </div>
      </section>
    </>
  )
}
