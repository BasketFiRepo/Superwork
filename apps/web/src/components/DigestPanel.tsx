'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * What the agent reported to its owner (§27.6). Every figure in the narrative comes from
 * the facts stored beside it, and everyone named in it can see that it was reported.
 *
 * And whether the owner read it (ADR 0070). `read_at` was on the view and never on the screen,
 * while the digest itself was written to a table nobody was told about — so "every agent has a
 * named accountable human" rested on somebody happening to navigate three levels into Settings.
 * The mark is the recipient's own and nobody else's: what an administrator reads here is the
 * same thing the owner reads, which is the only version of this that is not surveillance.
 */
export function DigestPanel({
  agentId,
  agentName,
  ownerName,
  viewerIsOwner,
  digests,
}: {
  agentId: string
  agentName: string
  ownerName: string | null
  /** Only the person a report was written for may say they have read it. */
  viewerIsOwner: boolean
  digests: {
    id: string
    periodFrom: string
    periodTo: string
    narrative: string
    readAt: string | null
    facts: { peopleAffected?: { name: string; items: number }[]; costCents?: number }
  }[]
}) {
  const router = useRouter()
  const unread = digests.filter((digest) => digest.readAt === null).length
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function markRead(digestId: string) {
    setBusy(true)
    setError(null)
    const response = await fetch(`/api/agents/${agentId}/digest/${digestId}/read`, { method: 'POST' })
    setBusy(false)
    if (!response.ok) {
      setError('That could not be recorded.')
      return
    }
    router.refresh()
  }

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
          <span className="small muted" data-testid="digest-unread">
            {unread === 0
              ? `Read by ${ownerName ?? 'its owner'}`
              : `${unread} ${unread === 1 ? 'report' : 'reports'} ${ownerName ?? 'its owner'} has not read`}
          </span>
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
            Digests are written once a week by the worker and sent to whoever is accountable for
            the agent. Anyone whose work appears in one sees it on their own record at the same
            moment.
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
                {digest.readAt ? (
                  <span className="chip chip-positive" data-testid="digest-read">
                    read {digest.readAt.slice(0, 10)}
                  </span>
                ) : (
                  <span className="chip chip-attention">not read</span>
                )}
              </div>
              <p className="prose small">{digest.narrative}</p>
              {digest.readAt === null ? (
                viewerIsOwner ? (
                  <div className="row">
                    <button
                      className="btn btn-sm"
                      data-testid="digest-mark-read"
                      disabled={busy}
                      onClick={() => markRead(digest.id)}
                    >
                      I have read this
                    </button>
                  </div>
                ) : (
                  <span className="small muted">
                    Only {ownerName ?? 'the person it went to'} can say they have read it.
                  </span>
                )
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
