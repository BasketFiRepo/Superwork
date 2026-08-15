import { can } from '@superwork/auth'
import { flagStates, PermissionError } from '@superwork/core'
import { requireSession, withActor } from '@/lib/session'
import { FeatureFlags } from '@/components/FeatureFlags'

export const dynamic = 'force-dynamic'

/**
 * Feature flags (§2.3). The override table the session has been resolving on every request
 * since Phase 0, which until now had never contained a row — so every organization had
 * identical features and nobody could change one.
 */
export default async function FeaturesPage() {
  const session = await requireSession()

  let data: { flags: Awaited<ReturnType<typeof flagStates>>; canAdmin: boolean } | null = null
  let denied: string | null = null

  try {
    data = await withActor(session, async (ctx, actor) => ({
      flags: await flagStates(ctx, actor),
      canAdmin: can(actor, 'settings:update', {
        type: 'settings',
        organizationId: ctx.organizationId,
        riskTier: 'low',
      }).allow,
    }))
  } catch (error) {
    if (error instanceof PermissionError) denied = error.message
    else throw error
  }

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Admin</span>
        <h1>Features</h1>
        <p className="prose secondary">
          Three layers, resolved on every request: the product default, then anything this
          organization has decided, then anything you have decided for yourself. A personal choice
          sits on top — which is right for a preference and wrong for a capability, so anything that
          governs what a tenant <em>may</em> do lives in permissions or plan limits, not here.
        </p>
      </header>

      {denied ? (
        <div className="panel">
          <div className="empty small secondary">{denied}</div>
        </div>
      ) : (
        <FeatureFlags flags={data?.flags ?? []} canAdmin={data?.canAdmin ?? false} />
      )}
    </div>
  )
}
