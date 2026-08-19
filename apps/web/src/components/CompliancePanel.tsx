'use client'

import { useState } from 'react'
import { Link } from '@/components/Link'
import { useRouter } from 'next/navigation'

interface Finding {
  id: string
  question: string
  why: string
  status: 'pass' | 'fail' | 'attention'
  evidence: string
  route: string | null
}

interface Entity {
  id: string
  name: string
  country: string
  jurisdictionProfile: string
  consultationStatus: string
  consultationReference: string | null
  consultationRecordedByName: string | null
  people: number
}

interface Profile {
  profile: string
  label: string
  summary: string
  maxNudgesPerPersonPerDay: number
  allowsManagerEscalation: boolean
  requiresConsultation: boolean
}

export function CompliancePanel({
  review,
  entities,
  profiles,
}: {
  review: {
    profile: string
    rules: Profile
    passed: number
    failed: number
    findings: Finding[]
    generatedAt: string
  }
  entities: Entity[]
  profiles: Profile[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newEntity, setNewEntity] = useState({ name: '', country: 'DE' })

  async function post(body: Record<string, unknown>, label: string) {
    setBusy(label)
    setError(null)
    const response = await fetch('/api/compliance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    setBusy(null)
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: 'That did not work.' }))
      setError(payload.error)
      return false
    }
    router.refresh()
    return true
  }

  return (
    <div className="stack stack-8">
      {error ? <div className="banner banner-critical">{error}</div> : null}

      <section className="panel" data-testid="review">
        <div className="panel-header">
          <h2>Review against {review.rules.label}</h2>
          <div className="row-tight">
            <span className={`chip${review.failed === 0 ? ' chip-positive' : ' chip-critical'}`}>
              {review.passed}/{review.passed + review.failed} answered
            </span>
          </div>
        </div>
        <div className="panel-body stack stack-5">
          <p className="prose secondary">{review.rules.summary}</p>
          {review.findings.map((finding) => (
            <div className="stack stack-2" key={finding.id} data-testid="finding">
              <div className="row-tight">
                <span className={`chip${finding.status === 'pass' ? ' chip-positive' : ' chip-critical'}`}>
                  {finding.status}
                </span>
                <strong className="small">{finding.question}</strong>
              </div>
              <span className="small muted">{finding.why}</span>
              <span className="small secondary">{finding.evidence}</span>
              {finding.route ? (
                <Link className="small" href={finding.route}>
                  See it
                </Link>
              ) : null}
            </div>
          ))}
        </div>
        <div className="panel-body hairline-top">
          <span className="small muted">
            Generated {new Date(review.generatedAt).toISOString().slice(0, 16).replace('T', ' ')} from live queries
            against this organization. Re-run it any time by reloading this page.
          </span>
        </div>
      </section>

      <section className="panel" data-testid="legal-entities">
        <div className="panel-header">
          <h2>Legal entities</h2>
          <span className="small muted">{entities.length} defined</span>
        </div>
        {entities.length === 0 ? (
          <div className="empty stack stack-2">
            <p className="secondary">No legal entity recorded yet.</p>
            <p className="small muted">
              Until one exists, the review runs against the strictest profile — which is the
              safe assumption, not a configured decision.
            </p>
          </div>
        ) : (
          <div className="panel-body-flush">
            {entities.map((entity) => (
              <div className="panel-body hairline-top stack stack-3" key={entity.id} data-testid="entity-row">
                <div className="spread">
                  <div className="stack stack-1">
                    <strong className="small">
                      {entity.name} · {entity.country}
                    </strong>
                    <span className="small muted">
                      {entity.people} {entity.people === 1 ? 'person' : 'people'} ·{' '}
                      {profiles.find((profile) => profile.profile === entity.jurisdictionProfile)?.label ??
                        entity.jurisdictionProfile}
                    </span>
                  </div>
                  <span
                    className={`chip${
                      entity.consultationStatus === 'agreed'
                        ? ' chip-positive'
                        : entity.consultationStatus === 'refused'
                          ? ' chip-critical'
                          : ' chip-attention'
                    }`}
                  >
                    consultation: {entity.consultationStatus.replace(/_/g, ' ')}
                  </span>
                </div>

                {entity.consultationReference ? (
                  <span className="small secondary">
                    Agreement {entity.consultationReference}
                    {entity.consultationRecordedByName ? `, recorded by ${entity.consultationRecordedByName}` : ''}
                  </span>
                ) : null}

                <div className="row wrap">
                  {entity.consultationStatus !== 'agreed' ? (
                    <button
                      className="btn btn-sm"
                      disabled={busy !== null}
                      onClick={async () => {
                        const reference = window.prompt(
                          'Works council agreement reference — the minute or agreement number they issued:',
                        )
                        if (!reference) return
                        await post(
                          {
                            action: 'record_consultation',
                            legalEntityId: entity.id,
                            status: 'agreed',
                            reference,
                          },
                          'consult',
                        )
                      }}
                    >
                      Record an agreement
                    </button>
                  ) : null}

                  {profiles
                    .filter((profile) => profile.profile !== entity.jurisdictionProfile)
                    .map((profile) => (
                      <button
                        key={profile.profile}
                        className="btn btn-ghost btn-sm"
                        disabled={busy !== null}
                        onClick={async () => {
                          const justification = window.prompt(
                            `Why is ${entity.name} moving to "${profile.label}"? This is recorded.`,
                          )
                          if (!justification) return
                          await post(
                            {
                              action: 'set_profile',
                              legalEntityId: entity.id,
                              profile: profile.profile,
                              justification,
                              // Loosening needs a named approver; the API refuses without one.
                              approvedBy: null,
                            },
                            'profile',
                          )
                        }}
                      >
                        Move to {profile.label}
                      </button>
                    ))}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="panel-body hairline-top row wrap">
          <input
            className="input"
            style={{ maxWidth: 240 }}
            placeholder="Northwind Logistics GmbH"
            value={newEntity.name}
            onChange={(event) => setNewEntity({ ...newEntity, name: event.target.value })}
          />
          <input
            className="input mono"
            style={{ maxWidth: 90 }}
            placeholder="DE"
            value={newEntity.country}
            onChange={(event) => setNewEntity({ ...newEntity, country: event.target.value })}
          />
          <button
            className="btn btn-sm"
            disabled={busy !== null || !newEntity.name.trim()}
            onClick={async () => {
              if (await post({ action: 'create_entity', ...newEntity }, 'create')) {
                setNewEntity({ name: '', country: 'DE' })
              }
            }}
          >
            Add entity
          </button>
          <span className="small muted">New entities start on the strictest profile.</span>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Profiles</h2>
        </div>
        <div className="panel-body-flush table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Profile</th>
                <th style={{ width: 150 }}>Contact per day</th>
                <th style={{ width: 170 }}>Manager escalation</th>
                <th style={{ width: 170 }}>Consultation</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((profile) => (
                <tr key={profile.profile}>
                  <td>
                    <div className="stack stack-1">
                      <strong className="small">{profile.label}</strong>
                      <span className="small muted">{profile.summary}</span>
                    </div>
                  </td>
                  <td className="num">{profile.maxNudgesPerPersonPerDay}</td>
                  <td className="small secondary">{profile.allowsManagerEscalation ? 'permitted' : 'not permitted'}</td>
                  <td className="small secondary">{profile.requiresConsultation ? 'required first' : 'not required'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel-body hairline-top">
          <span className="small muted">
            The §29.5 prohibitions — individual scoring, covert monitoring, automated employment
            decisions, reading private messages — are not on this table. They are properties of the
            product in every jurisdiction, enforced by a database constraint.
          </span>
        </div>
      </section>
    </div>
  )
}
