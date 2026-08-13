import { requireSession, withActor } from '@/lib/session'
import { listConnections, PermissionError } from '@superwork/core'
import { capabilityCatalogue } from '@superwork/integrations'
import { ConnectionRow } from '@/components/ConnectionRow'

export const dynamic = 'force-dynamic'

/**
 * Integrations (§13.3). Every row is a capability the product actually uses, with what
 * degrades when it is missing. There is no button here for a vendor Superwork cannot talk
 * to, and connecting a simulated provider says so on the row.
 */
export default async function IntegrationsPage() {
  const session = await requireSession()

  let connections: Awaited<ReturnType<typeof listConnections>> = []
  let denied: string | null = null
  try {
    connections = await withActor(session, (ctx, actor) => listConnections(ctx, actor))
  } catch (error) {
    if (error instanceof PermissionError) denied = error.message
    else throw error
  }

  const catalogue = capabilityCatalogue()
  const byCapability = new Map(connections.map((connection) => [connection.capability, connection]))

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Admin</span>
        <h1>Integrations</h1>
        <p className="prose secondary">
          Superwork asks for capabilities, not vendors: a feature needs <em>chat</em>, not Slack.
          A capability that is not connected degrades the feature that uses it — it never
          breaks the product, and it is never hidden.
        </p>
      </header>

      {denied ? (
        <div className="panel">
          <div className="empty small secondary">{denied}</div>
        </div>
      ) : (
        <section className="panel">
          <div className="panel-header">
            <h2>Capabilities</h2>
            <span className="small muted">{connections.filter((c) => c.status === 'connected').length} connected</span>
          </div>
          <div className="panel-body-flush">
            {catalogue.map((capability) => (
              <ConnectionRow
                key={capability.capability}
                capability={capability.capability}
                label={capability.label}
                degradesTo={capability.degradesTo}
                vendorHint={capability.vendorHint}
                mode={capability.mode}
                connection={(() => {
                  const found = byCapability.get(capability.capability)
                  if (!found) return null
                  return {
                    status: found.status,
                    vendor: found.vendor,
                    mode: found.mode,
                    connectedByName: found.connectedByName,
                    lastSyncAt: found.lastSyncAt ? found.lastSyncAt.toISOString() : null,
                    lastError: found.lastError,
                    health: found.health,
                    scopes: found.scopes,
                  }
                })()}
              />
            ))}
          </div>
        </section>
      )}

      <p className="small muted">
        Everything in this build ships with a simulated provider. They fail, rate-limit and
        expire on request, which is how the failure handling is tested rather than assumed —
        and it is why the whole product runs with no credentials at all.
      </p>
    </div>
  )
}
