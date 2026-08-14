'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Row {
  departmentId: string | null
  departmentName: string
  weight: number
  maxConcurrent: number
  runsPerHour: number
  deficit: number
  queued: number
  running: number
  ranLastHour: number
  oldestWaitMs: number
}

/** Weights, caps and what each department is actually getting (§26.6). */
export function QuotaEditor({ rows }: { rows: Row[] }) {
  const router = useRouter()
  const [draft, setDraft] = useState(rows)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function save(row: Row) {
    setBusy(row.departmentId ?? 'default')
    setError(null)
    const response = await fetch('/api/queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        departmentId: row.departmentId,
        weight: row.weight,
        maxConcurrent: row.maxConcurrent,
        runsPerHour: row.runsPerHour,
      }),
    })
    setBusy(null)
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: 'That could not be saved.' }))
      setError(body.error)
      return
    }
    router.refresh()
  }

  const update = (index: number, patch: Partial<Row>) =>
    setDraft(draft.map((row, position) => (position === index ? { ...row, ...patch } : row)))

  return (
    <section className="panel" data-testid="quotas">
      <div className="panel-header">
        <h2>Shares</h2>
        <span className="small muted">Weight decides the split when everybody is busy</span>
      </div>
      {error ? <div className="panel-body"><div className="banner banner-critical">{error}</div></div> : null}
      <div className="panel-body-flush table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Department</th>
              <th style={{ width: 90 }}>Weight</th>
              <th style={{ width: 110 }}>Concurrent</th>
              <th style={{ width: 110 }}>Per hour</th>
              <th style={{ width: 90 }}>Queued</th>
              <th style={{ width: 90 }}>Running</th>
              <th style={{ width: 120 }}>Waiting</th>
              <th style={{ width: 80 }}></th>
            </tr>
          </thead>
          <tbody>
            {draft.map((row, index) => (
              <tr key={row.departmentId ?? 'default'} data-testid="quota-row">
                <td className="small">{row.departmentName}</td>
                <td>
                  <input
                    className="input num"
                    type="number"
                    min={1}
                    value={row.weight}
                    onChange={(event) => update(index, { weight: Number(event.target.value) })}
                  />
                </td>
                <td>
                  <input
                    className="input num"
                    type="number"
                    min={1}
                    value={row.maxConcurrent}
                    onChange={(event) => update(index, { maxConcurrent: Number(event.target.value) })}
                  />
                </td>
                <td>
                  <input
                    className="input num"
                    type="number"
                    min={1}
                    value={row.runsPerHour}
                    onChange={(event) => update(index, { runsPerHour: Number(event.target.value) })}
                  />
                </td>
                <td className="num">{row.queued}</td>
                <td className="num">{row.running}</td>
                <td className="num small">{row.oldestWaitMs > 0 ? `${Math.round(row.oldestWaitMs / 1000)}s` : '—'}</td>
                <td>
                  <button className="btn btn-ghost btn-sm" onClick={() => save(row)} disabled={busy !== null}>
                    Save
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel-body hairline-top">
        <span className="small muted">
          A department with nothing queued gives its share to the others; it takes it back the
          moment it has work. Nothing here can set a share to zero — pause the department&rsquo;s
          agents instead, where it is visible.
        </span>
      </div>
    </section>
  )
}
