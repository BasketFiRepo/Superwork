import { listCustomTools, listHosts, PermissionError } from '@superwork/core'
import { httpTransport } from '@superwork/integrations'
import { requireSession, withActor } from '@/lib/session'
import { CustomToolsAdmin } from '@/components/CustomToolsAdmin'

export const dynamic = 'force-dynamic'

/**
 * Custom tools (§22). An organization can teach Superwork to call one of its own systems.
 * What makes that safe is that a custom tool is a tool: same registry, same policy engine,
 * same approval flow, same audit trail. No exceptions.
 */
export default async function CustomToolsPage() {
  const session = await requireSession()

  let data: { tools: Awaited<ReturnType<typeof listCustomTools>>; hosts: Awaited<ReturnType<typeof listHosts>> } | null =
    null
  let denied: string | null = null
  try {
    data = await withActor(session, async (ctx, actor) => ({
      tools: await listCustomTools(ctx, actor),
      hosts: await listHosts(ctx, actor),
    }))
  } catch (error) {
    if (error instanceof PermissionError) denied = error.message
    else throw error
  }

  const transport = httpTransport()

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Admin</span>
        <h1>Custom tools</h1>
        <p className="prose secondary">
          Teach Superwork to call one of your own systems. A custom tool is a tool like any other:
          the same permission check, the same approval card with the same preview, the same line in
          the audit trail. It is never a way around any of them.
        </p>
        {transport.mode === 'mock' ? (
          <div className="banner">
            <span>
              Outbound HTTP is simulated in this deployment, so tools return a deterministic
              locally-generated response marked <strong>Simulated</strong>. Everything else — review,
              permissions, previews, approvals, audit — is real.
            </span>
          </div>
        ) : null}
      </header>

      {denied ? (
        <div className="panel">
          <div className="empty small secondary">{denied}</div>
        </div>
      ) : (
        <CustomToolsAdmin
          tools={(data?.tools ?? []).map((tool) => ({
            ...tool,
            approvedAt: tool.approvedAt ? tool.approvedAt.toISOString() : null,
            lastCalledAt: tool.lastCalledAt ? tool.lastCalledAt.toISOString() : null,
            limitsSetAt: tool.limitsSetAt ? tool.limitsSetAt.toISOString() : null,
          }))}
          hosts={(data?.hosts ?? []).map((host) => ({
            ...host,
            reviewedAt: host.reviewedAt ? host.reviewedAt.toISOString() : null,
          }))}
        />
      )}
    </div>
  )
}
