'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * What the agent reported to its owner (§27.6). Every figure in the narrative comes from
 * the facts stored beside it, and everyone named in it can see that it was reported.
 */
export function DigestPanel({
  agentId,
  agentName,
  ownerName,
  digests,
}: {
  agentId: string
  agentName: string
  ownerName: string | null
  digests: {
    id: string
    periodFrom: string
    periodTo: string
    narrative: string
    facts: { peopleAffected?: { name: string; items: number }[]; costCents?: number }
  }[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function generate() {
    setBusy(true)
    setError(null)
    const response = await fetch(`/api/agents/${agentId}/digest`, { method: 'POST' })
    setBusy(false)
    if (!response.ok) {
      setError('That could not be written.')
      return
    }
    router.refresh()
  }

  return (
    <section className="panel" data-testid="digests">
      <div className="panel-header">
        <h2>Weekly digest</h2>
        <div className="row-tight">
          <span className="small muted">Goes to {ownerName ?? 'its owner'}</span>
          <button className="btn btn-sm" onClick={generate} disabled={busy}>
            {busy ? 'Writing…' : 'Write last week’s now'}
          </button>
        </div>
      </div>
      {error ? <div className="panel-body"><div className="banner banner-critical">{error}</div></div> : null}
      {digests.length === 0 ? (
        <div className="empty stack stack-2">
          <p className="secondary">{agentName} has not reported yet.</p>
          <p className="small muted">
            Digests are written once a week by the worker. Anyone whose work appears in one
            sees it on their own record at the same moment.
          </p>
        </div>
      ) : (
        <div className="panel-body-flush">
          {digests.map((digest) => (
            <div className="panel-body hairline-top stack stack-2" key={digest.id}>
              <div className="row-tight">
                <span className="chip mono">
                  {digest.periodFrom.slice(0, 10)} → {digest.periodTo.slice(0, 10)}
                </span>
                {digest.facts.peopleAffected?.length ? (
                  <span className="chip">{digest.facts.peopleAffected.length} people named</span>
                ) : null}
              </div>
              <p className="prose small">{digest.narrative}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
