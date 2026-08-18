'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Starting a project (§17, ADR 0049).
 *
 * `projects` was read on every screen and written by the seed alone, so this screen listed work
 * nobody in the company had ever begun. The button is offered to the people whose grant covers
 * it and explained to everybody else, in the policy engine's own words.
 */
export function StartProject({
  canStart,
  reason,
  ceiling,
  people,
  departments,
  companies,
}: {
  canStart: boolean
  reason: string
  /** The highest classification this account can read, and so the highest it can start. */
  ceiling: string
  people: { id: string; name: string }[]
  departments: { id: string; name: string }[]
  companies: { id: string; name: string }[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [ownerUserId, setOwnerUserId] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [companyId, setCompanyId] = useState('')
  const [sensitivity, setSensitivity] = useState('internal')
  const [startsOn, setStartsOn] = useState('')
  const [targetDate, setTargetDate] = useState('')

  const levels = ['public', 'internal', 'confidential', 'restricted']
  const rank = levels.indexOf(ceiling)

  async function submit() {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        description: description.trim() || undefined,
        ownerUserId: ownerUserId || undefined,
        departmentId: departmentId || undefined,
        companyId: companyId || undefined,
        sensitivity,
        startsOn: startsOn || undefined,
        targetDate: targetDate || undefined,
      }),
    })
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(payload.error)
      return
    }
    setOpen(false)
    setName('')
    setDescription('')
    router.push(`/projects/${payload.project.id}`)
    router.refresh()
  }

  if (!canStart) {
    return (
      <div className="row" data-testid="start-project-denied">
        <button className="btn btn-primary btn-sm" disabled title={reason}>
          Start a project
        </button>
        <span className="small muted">{reason}</span>
      </div>
    )
  }

  if (!open) {
    return (
      <div className="row">
        <button className="btn btn-primary btn-sm" data-testid="start-project" onClick={() => setOpen(true)}>
          Start a project
        </button>
        <span className="small muted">
          It begins in planning, with you on its roster and answerable for it.
        </span>
      </div>
    )
  }

  return (
    <section className="panel" data-testid="start-project-panel">
      <div className="panel-header">
        <h2>Start a project</h2>
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>

      <div className="panel-body stack stack-4">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        <label className="stack stack-2" htmlFor="project-name">
          <span className="micro">Name</span>
          <input
            id="project-name"
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Halden peak season readiness"
          />
        </label>

        <label className="stack stack-2" htmlFor="project-description">
          <span className="micro">What it is for</span>
          <textarea
            id="project-description"
            className="textarea"
            style={{ minHeight: 70 }}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What has to be true when this is finished."
          />
        </label>

        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <label className="stack stack-2" style={{ flex: '1 1 220px' }} htmlFor="project-owner">
            <span className="micro">Answerable for it</span>
            <select
              id="project-owner"
              className="select"
              value={ownerUserId}
              onChange={(event) => setOwnerUserId(event.target.value)}
            >
              <option value="">You</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </label>

          <label className="stack stack-2" style={{ flex: '1 1 200px' }} htmlFor="project-department">
            <span className="micro">Department</span>
            <select
              id="project-department"
              className="select"
              value={departmentId}
              onChange={(event) => setDepartmentId(event.target.value)}
            >
              <option value="">None</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
          </label>

          <label className="stack stack-2" style={{ flex: '1 1 200px' }} htmlFor="project-company">
            <span className="micro">Customer or supplier</span>
            <select
              id="project-company"
              className="select"
              value={companyId}
              onChange={(event) => setCompanyId(event.target.value)}
            >
              <option value="">None</option>
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <label className="stack stack-2" style={{ flex: '0 0 170px' }} htmlFor="project-sensitivity">
            <span className="micro">Classification</span>
            <select
              id="project-sensitivity"
              className="select"
              value={sensitivity}
              onChange={(event) => setSensitivity(event.target.value)}
            >
              {levels.map((level, index) => (
                <option key={level} value={level} disabled={index > rank}>
                  {level}
                  {index > rank ? ' — above your access' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="stack stack-2" style={{ flex: '0 0 160px' }} htmlFor="project-starts">
            <span className="micro">Starts</span>
            <input
              id="project-starts"
              className="input"
              type="date"
              value={startsOn}
              onChange={(event) => setStartsOn(event.target.value)}
            />
          </label>
          <label className="stack stack-2" style={{ flex: '0 0 160px' }} htmlFor="project-target">
            <span className="micro">Target</span>
            <input
              id="project-target"
              className="input"
              type="date"
              value={targetDate}
              onChange={(event) => setTargetDate(event.target.value)}
            />
          </label>
        </div>

        <div className="row wrap">
          <button
            className="btn btn-primary"
            data-testid="start-project-confirm"
            disabled={busy || name.trim().length < 2}
            onClick={submit}
          >
            {busy ? 'Starting…' : 'Start it'}
          </button>
          <span className="small muted">
            The target has to be on or after the start, and two open projects cannot share a name —
            people refer to a project by its name in a sentence. Your access covers up to{' '}
            <strong>{ceiling}</strong>, and a project you could not open yourself is not on offer.
          </span>
        </div>
      </div>
    </section>
  )
}
