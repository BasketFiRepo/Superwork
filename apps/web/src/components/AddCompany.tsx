'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Adding a customer, and the people at it (§12.6, ADR 0056).
 *
 * `companies` and `contacts` are read by the companies screen, the relationship view, the inbox's
 * routing and the watchers that ask whether an account has gone quiet — and both were written by
 * the seed and by nothing else. There was no way to add a customer to this product.
 *
 * The domain field is the one that needs explaining, so it explains itself: it is what decides
 * whose customer an inbound message is, and no two companies may claim the same one.
 */

export interface AddCompanyProps {
  canAddCompany: boolean
  canAddContact: boolean
  companies: { id: string; name: string }[]
}

export function AddCompany({ canAddCompany, canAddContact, companies }: AddCompanyProps) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<'company' | 'contact' | null>(null)

  const [name, setName] = useState('')
  const [type, setType] = useState('customer')
  const [domains, setDomains] = useState('')
  const [industry, setIndustry] = useState('')

  const [contactName, setContactName] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [contactTitle, setContactTitle] = useState('')
  const [contactCompany, setContactCompany] = useState('')

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/companies', {
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
    setOpen(null)
    setName('')
    setDomains('')
    setIndustry('')
    setContactName('')
    setContactEmail('')
    setContactTitle('')
    setContactCompany('')
    router.refresh()
  }

  if (!canAddCompany && !canAddContact) return null

  return (
    <section className="panel" data-testid="add-company">
      <div className="panel-header">
        <h2>Add</h2>
        <span className="small muted">A company, or somebody at one</span>
      </div>

      <div className="panel-body stack stack-4">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        {open === null ? (
          <div className="row wrap">
            {canAddCompany ? (
              <button className="btn" data-testid="add-company-open" disabled={busy} onClick={() => setOpen('company')}>
                Add a company
              </button>
            ) : null}
            {canAddContact ? (
              <button className="btn" data-testid="add-contact-open" disabled={busy} onClick={() => setOpen('contact')}>
                Add a contact
              </button>
            ) : null}
            {!canAddCompany ? (
              <span className="small muted">Adding a company needs administrator access.</span>
            ) : null}
          </div>
        ) : null}

        {open === 'company' ? (
          <div className="stack stack-3" data-testid="company-editor">
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <label className="stack stack-2" style={{ flex: '1 1 240px' }} htmlFor="company-name">
                <span className="micro">Name</span>
                <input
                  id="company-name"
                  className="input"
                  data-testid="company-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Meridian Foods"
                />
              </label>
              <label className="stack stack-2" style={{ flex: '0 0 160px' }} htmlFor="company-type">
                <span className="micro">They are a</span>
                <select
                  id="company-type"
                  className="select"
                  data-testid="company-type"
                  value={type}
                  onChange={(event) => setType(event.target.value)}
                >
                  {['customer', 'vendor', 'partner', 'prospect', 'other'].map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label className="stack stack-2" style={{ flex: '1 1 200px' }} htmlFor="company-industry">
                <span className="micro">What they do</span>
                <input
                  id="company-industry"
                  className="input"
                  data-testid="company-industry"
                  value={industry}
                  onChange={(event) => setIndustry(event.target.value)}
                  placeholder="Chilled food distribution"
                />
              </label>
            </div>
            <label className="stack stack-2" htmlFor="company-domains">
              <span className="micro">Mail from</span>
              <input
                id="company-domains"
                className="input mono"
                data-testid="company-domains"
                value={domains}
                onChange={(event) => setDomains(event.target.value)}
                placeholder="meridianfoods.example, meridian.example"
              />
              <span className="micro muted">
                What decides whose customer an incoming message is. No two companies may claim the
                same domain — a message would otherwise belong to whichever the database returned
                first. Separate several with commas.
              </span>
            </label>
            <div className="row wrap">
              <button
                className="btn btn-primary"
                data-testid="company-confirm"
                disabled={busy || name.trim().length < 2}
                onClick={() =>
                  post({
                    action: 'create',
                    name: name.trim(),
                    type,
                    industry: industry.trim() || null,
                    domains: domains
                      .split(',')
                      .map((entry) => entry.trim())
                      .filter(Boolean),
                  })
                }
              >
                {busy ? 'Adding…' : 'Add it'}
              </button>
              <button
                className="btn btn-ghost"
                data-testid="company-cancel"
                disabled={busy}
                onClick={() => setOpen(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {open === 'contact' ? (
          <div className="stack stack-3" data-testid="contact-editor">
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <label className="stack stack-2" style={{ flex: '1 1 200px' }} htmlFor="contact-name">
                <span className="micro">Name</span>
                <input
                  id="contact-name"
                  className="input"
                  data-testid="contact-name"
                  value={contactName}
                  onChange={(event) => setContactName(event.target.value)}
                  placeholder="Dana Whitfield"
                />
              </label>
              <label className="stack stack-2" style={{ flex: '1 1 220px' }} htmlFor="contact-email">
                <span className="micro">Email</span>
                <input
                  id="contact-email"
                  className="input mono"
                  data-testid="contact-email"
                  value={contactEmail}
                  onChange={(event) => setContactEmail(event.target.value)}
                  placeholder="dana@meridianfoods.example"
                />
              </label>
              <label className="stack stack-2" style={{ flex: '0 0 200px' }} htmlFor="contact-company">
                <span className="micro">At</span>
                <select
                  id="contact-company"
                  className="select"
                  data-testid="contact-company"
                  value={contactCompany}
                  onChange={(event) => setContactCompany(event.target.value)}
                >
                  <option value="">Nobody in particular</option>
                  {companies.map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="stack stack-2" style={{ flex: '1 1 180px' }} htmlFor="contact-title">
                <span className="micro">Their job</span>
                <input
                  id="contact-title"
                  className="input"
                  data-testid="contact-title"
                  value={contactTitle}
                  onChange={(event) => setContactTitle(event.target.value)}
                  placeholder="Head of logistics"
                />
              </label>
            </div>
            <div className="row wrap">
              <button
                className="btn btn-primary"
                data-testid="contact-confirm"
                disabled={busy || contactName.trim().length < 2}
                onClick={() =>
                  post({
                    action: 'contact',
                    name: contactName.trim(),
                    companyId: contactCompany || null,
                    emails: contactEmail.trim() ? [contactEmail.trim()] : [],
                    title: contactTitle.trim() || null,
                  })
                }
              >
                {busy ? 'Adding…' : 'Add them'}
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setOpen(null)}>
                Cancel
              </button>
              <span className="small muted">
                If that address is already on somebody, both records go to the merge queue rather
                than one of them being refused.
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}
