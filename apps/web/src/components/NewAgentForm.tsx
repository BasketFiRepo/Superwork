'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Creating an agent is deliberately small: a key, a name and a purpose. Everything that
 * grants it reach is a separate, reviewed change (§27.4).
 */
export function NewAgentForm() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({ key: '', name: '', purpose: '' })

  async function create() {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(form),
    })
    setBusy(false)
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: 'That could not be created.' }))
      setError(body.error)
      return
    }
    const created = await response.json()
    router.push(`/settings/agents/${created.agentId}`)
  }

  if (!open) {
    return (
      <div>
        <button className="btn" onClick={() => setOpen(true)} data-testid="new-agent">
          Create an agent
        </button>
      </div>
    )
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>New agent</h2>
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <div className="panel-body stack stack-4">
        <label className="stack stack-1">
          <span className="micro">Key</span>
          <input
            className="input mono"
            value={form.key}
            placeholder="sla_watch"
            onChange={(e) => setForm({ ...form, key: e.target.value })}
          />
          <span className="small muted">Lower-case, stable, appears in the audit trail.</span>
        </label>
        <label className="stack stack-1">
          <span className="micro">Name</span>
          <input
            className="input"
            value={form.name}
            placeholder="SLA Watch"
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label className="stack stack-1">
          <span className="micro">Purpose</span>
          <textarea
            className="input"
            rows={3}
            value={form.purpose}
            placeholder="Chase the customers who have gone quiet and draft replies for approval."
            onChange={(e) => setForm({ ...form, purpose: e.target.value })}
          />
          <span className="small muted">
            This is the instruction the agent runs on, and the first thing a reviewer reads.
          </span>
        </label>
        {error ? <div className="banner banner-critical">{error}</div> : null}
        <div className="row">
          <button className="btn btn-primary" onClick={create} disabled={busy || !form.key || !form.name || !form.purpose}>
            {busy ? 'Creating…' : 'Create as draft'}
          </button>
          <span className="small muted">
            It starts in ask mode with no tools, and cannot run until a change is approved.
          </span>
        </div>
      </div>
    </section>
  )
}
