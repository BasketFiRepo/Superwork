'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * The mailboxes you have connected (ADR 0084).
 *
 * This lives on the personal record rather than in Settings, and that is the design rather than
 * the filing. A person connects their own mailbox and nobody else's — an administrator who could
 * connect a colleague's mail would be operating the surveillance switch §29.5 exists to make
 * unbuildable. Settings shows an administrator how many connections are healthy and no addresses.
 */

export interface MailboxRow {
  id: string
  address: string
  provider: string
  status: string
  lastSyncAt: string | null
  lastError: string | null
}

export function Mailboxes({ mailboxes, simulated }: { mailboxes: MailboxRow[]; simulated: boolean }) {
  const router = useRouter()
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/mailboxes', {
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
    setAddress('')
    router.refresh()
  }

  return (
    <section className="panel" data-testid="mailboxes">
      <div className="panel-header">
        <h2>Mailboxes you have connected</h2>
        <span className="small muted">{mailboxes.length} connected</span>
      </div>

      <div className="panel-body stack stack-4">
        {error ? (
          <div className="banner banner-critical" role="alert" data-testid="mailbox-error">
            {error}
          </div>
        ) : null}

        <p className="small secondary prose" style={{ margin: 0 }} data-testid="mailboxes-explainer">
          Business correspondence from a connected mailbox is filed onto the threads your colleagues
          work. <strong>Only you can connect or disconnect your own</strong> — nobody else can do it
          for you, and no administrator can point Superwork at somebody&rsquo;s mail. What arrives is
          treated as text from outside the company: it is never allowed to instruct the assistant.
          {simulated ? ' This deployment uses a simulated provider, so nothing leaves this machine.' : ''}
        </p>

        <div className="row wrap">
          <input
            className="input"
            style={{ maxWidth: 320 }}
            placeholder="you@northwind.example"
            aria-label="Mailbox address"
            data-testid="mailbox-address"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
          <button
            className="btn btn-primary"
            data-testid="mailbox-connect"
            disabled={busy || address.trim().length < 3}
            onClick={() => post({ action: 'connect', address: address.trim() })}
          >
            {busy ? 'Working…' : 'Connect it'}
          </button>
        </div>
      </div>

      {mailboxes.length > 0 ? (
        <div className="panel-body-flush table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Address</th>
                <th style={{ width: 110 }}>Provider</th>
                <th style={{ width: 220 }}>How it is</th>
                <th style={{ width: 200 }} />
              </tr>
            </thead>
            <tbody>
              {mailboxes.map((mailbox) => (
                <tr key={mailbox.id} data-testid="mailbox-row">
                  <td className="small mono">{mailbox.address}</td>
                  <td className="small muted">{mailbox.provider}</td>
                  <td className="small">
                    {mailbox.status === 'connected' ? (
                      <>
                        <span className="chip chip-positive">connected</span>
                        <span className="small muted">
                          {mailbox.lastSyncAt
                            ? ` · last collected ${mailbox.lastSyncAt.slice(0, 10)}`
                            : ' · nothing collected yet'}
                        </span>
                      </>
                    ) : (
                      /* A stopped mailbox says what stopped it. An inbox that quietly goes stale
                         is the one thing this whole surface exists to prevent. */
                      <span data-testid="mailbox-trouble">
                        <span className="chip chip-attention">{mailbox.status}</span>{' '}
                        <span className="small">{mailbox.lastError}</span>
                      </span>
                    )}
                  </td>
                  <td>
                    <div className="row-tight">
                      {mailbox.status !== 'connected' ? (
                        <button
                          className="btn btn-sm"
                          data-testid="mailbox-reconnect"
                          disabled={busy}
                          onClick={() => post({ action: 'reconnect', mailboxId: mailbox.id })}
                        >
                          Reconnect
                        </button>
                      ) : null}
                      <button
                        className="btn btn-ghost btn-sm"
                        data-testid="mailbox-disconnect"
                        disabled={busy}
                        onClick={() => post({ action: 'disconnect', mailboxId: mailbox.id })}
                        title="Stops collecting. What already arrived stays on the threads it is on."
                      >
                        Disconnect
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}
