'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Authoring a custom tool (§22).
 *
 * The order on this screen is the order the rules apply in: review the host first, define
 * the tool second, activate third. Activate stays disabled until a named person has
 * reviewed the host, because that decision is what the whole feature rests on.
 */

interface ToolRow {
  id: string
  name: string
  description: string
  method: string
  urlTemplate: string
  host: string
  riskTier: string
  requiredPermissions: string[]
  status: string
  approvedByName: string | null
  approvedAt: string | null
  hostReviewed: boolean
  lastCalledAt: string | null
}

interface HostRow {
  id: string
  host: string
  reason: string
  reviewedByName: string | null
  reviewedAt: string | null
}

const PERMISSIONS = ['integration:read:org', 'integration:update:org', 'company:read:org', 'task:read:org']

export function CustomToolsAdmin({ tools, hosts }: { tools: ToolRow[]; hosts: HostRow[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [host, setHost] = useState('')
  const [hostReason, setHostReason] = useState('')

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [method, setMethod] = useState('GET')
  const [urlTemplate, setUrlTemplate] = useState('')
  const [riskTier, setRiskTier] = useState('read')
  const [permission, setPermission] = useState(PERMISSIONS[0]!)
  const [parameters, setParameters] = useState('')

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/tools', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(payload.error)
      return false
    }
    router.refresh()
    return true
  }

  function parseParameters() {
    // "id:string:path:required — the order number" per line. A form that made this a table
    // would be nicer; a form that silently accepted an undeclared parameter would not.
    return parameters
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [spec, ...rest] = line.split('—')
        const [pname, type = 'string', place = 'query', required = ''] = (spec ?? '').trim().split(':')
        return {
          name: (pname ?? '').trim(),
          type: (['string', 'number', 'boolean'].includes(type.trim()) ? type.trim() : 'string') as
            | 'string'
            | 'number'
            | 'boolean',
          in: (['path', 'query', 'body'].includes(place.trim()) ? place.trim() : 'query') as 'path' | 'query' | 'body',
          required: required.trim() === 'required',
          description: rest.join('—').trim() || 'No description given.',
        }
      })
  }

  return (
    <div className="stack stack-8">
      {error ? (
        <div className="banner banner-critical" role="alert">
          {error}
        </div>
      ) : null}

      <section className="panel" data-testid="reviewed-hosts">
        <div className="panel-header">
          <h2>Reviewed hosts</h2>
          <span className="small muted">Which systems tools may call, and who said so</span>
        </div>
        <div className="panel-body stack stack-5">
          {hosts.length === 0 ? (
            <p className="small secondary" style={{ margin: 0 }}>
              None yet. A tool cannot be activated until its host is on this list.
            </p>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Host</th>
                    <th>Why</th>
                    <th style={{ width: 180 }}>Reviewed by</th>
                    <th style={{ width: 100 }} />
                  </tr>
                </thead>
                <tbody>
                  {hosts.map((entry) => (
                    <tr key={entry.id}>
                      <td>{entry.host}</td>
                      <td className="small secondary">{entry.reason}</td>
                      <td className="small secondary">
                        {entry.reviewedByName ?? 'nobody'}
                        {entry.reviewedAt ? ` · ${entry.reviewedAt.slice(0, 10)}` : ''}
                      </td>
                      <td>
                        <button
                          className="btn btn-ghost small"
                          disabled={busy}
                          onClick={() => post({ action: 'revoke_host', host: entry.host })}
                          title="Revoking disables every tool that used this host, in the same breath."
                        >
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="row wrap" style={{ alignItems: 'flex-end' }}>
            <label className="stack stack-2" style={{ flex: '1 1 200px' }}>
              <span className="micro">Hostname</span>
              <input className="input" value={host} onChange={(event) => setHost(event.target.value)} placeholder="erp.example.com" />
            </label>
            <label className="stack stack-2" style={{ flex: '2 1 300px' }}>
              <span className="micro">What is it, and why may Superwork call it?</span>
              <input
                className="input"
                value={hostReason}
                onChange={(event) => setHostReason(event.target.value)}
                placeholder="Our order system. Read-only lookups for support."
              />
            </label>
            <button
              className="btn"
              disabled={busy || !host.trim() || !hostReason.trim()}
              onClick={async () => {
                if (await post({ action: 'review_host', host, reason: hostReason })) {
                  setHost('')
                  setHostReason('')
                }
              }}
            >
              Review this host
            </button>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Tools</h2>
          <span className="small muted">
            {tools.filter((tool) => tool.status === 'active').length} active of {tools.length}
          </span>
        </div>
        {tools.length === 0 ? (
          <div className="empty small secondary">No custom tools yet.</div>
        ) : (
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Tool</th>
                  <th style={{ width: 200 }}>Calls</th>
                  <th style={{ width: 90 }}>Risk</th>
                  <th style={{ width: 150 }}>Status</th>
                  <th style={{ width: 110 }} />
                </tr>
              </thead>
              <tbody>
                {tools.map((tool) => (
                  <tr key={tool.id} data-testid="custom-tool-row">
                    <td>
                      <div>{tool.name}</div>
                      <div className="small muted">{tool.description}</div>
                    </td>
                    <td className="small secondary">
                      {tool.method} {tool.host}
                    </td>
                    <td className="small secondary">{tool.riskTier}</td>
                    <td className="small secondary">
                      {tool.status}
                      {tool.approvedByName ? ` · ${tool.approvedByName}` : ''}
                      {!tool.hostReviewed ? <div className="chip chip-attention">host not reviewed</div> : null}
                    </td>
                    <td>
                      {tool.status === 'active' ? (
                        <button className="btn btn-ghost small" disabled={busy} onClick={() => post({ action: 'disable', id: tool.id })}>
                          Disable
                        </button>
                      ) : (
                        <button
                          className="btn small"
                          disabled={busy || !tool.hostReviewed}
                          title={
                            tool.hostReviewed
                              ? 'Activating records you as the person who approved it.'
                              : `Nobody has reviewed ${tool.host} yet.`
                          }
                          onClick={() => post({ action: 'activate', id: tool.id })}
                        >
                          Activate
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Define a tool</h2>
          <span className="small muted">Saved as a draft — activation is a separate decision</span>
        </div>
        <div className="panel-body stack stack-5">
          <div className="row wrap" style={{ alignItems: 'flex-end' }}>
            <label className="stack stack-2" style={{ flex: '1 1 220px' }}>
              <span className="micro">Name</span>
              <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="lookup_order@v1" />
            </label>
            <label className="stack stack-2" style={{ flex: '0 0 110px' }}>
              <span className="micro">Method</span>
              <select className="select" value={method} onChange={(event) => setMethod(event.target.value)}>
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </label>
            <label className="stack stack-2" style={{ flex: '0 0 130px' }}>
              <span className="micro">Risk</span>
              <select className="select" value={riskTier} onChange={(event) => setRiskTier(event.target.value)}>
                <option value="read">read</option>
                <option value="low">low</option>
                <option value="high">high</option>
              </select>
            </label>
            <label className="stack stack-2" style={{ flex: '1 1 220px' }}>
              <span className="micro">A caller must be allowed to</span>
              <select className="select" value={permission} onChange={(event) => setPermission(event.target.value)}>
                {PERMISSIONS.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </label>
          </div>

          <label className="stack stack-2">
            <span className="micro">What it does — this is what the model reads</span>
            <input
              className="input"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Look up an order in the ERP by its order number."
            />
          </label>

          <label className="stack stack-2">
            <span className="micro">URL — https only, {'{placeholders}'} must be declared below</span>
            <input
              className="input"
              value={urlTemplate}
              onChange={(event) => setUrlTemplate(event.target.value)}
              placeholder="https://erp.example.com/api/orders/{orderNumber}"
            />
          </label>

          <label className="stack stack-2">
            <span className="micro">Parameters — one per line: name:type:where:required — description</span>
            <textarea
              className="textarea"
              rows={3}
              value={parameters}
              onChange={(event) => setParameters(event.target.value)}
              placeholder="orderNumber:string:path:required — the order number, as printed on the invoice"
            />
          </label>

          <p className="small muted" style={{ margin: 0 }}>
            Credentials go in a secret, referenced as <code>{'${NAME}'}</code>. A value typed here would be a
            credential in the database, the audit log and somebody’s screenshot — so it is refused.
          </p>

          <div className="row">
            <button
              className="btn btn-primary"
              disabled={busy || !name.trim() || !urlTemplate.trim() || description.trim().length < 10}
              onClick={async () => {
                const saved = await post({
                  action: 'save',
                  name,
                  description,
                  method,
                  urlTemplate,
                  parameters: parseParameters(),
                  headers: {},
                  riskTier,
                  requiredPermissions: [permission],
                })
                if (saved) {
                  setName('')
                  setDescription('')
                  setUrlTemplate('')
                  setParameters('')
                }
              }}
            >
              Save as draft
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
