import { can } from '@superwork/auth'
import { organizationProfile, PermissionError } from '@superwork/core'
import { requireSession, withActor } from '@/lib/session'
import { OrganizationProfileAdmin } from '@/components/OrganizationProfile'

export const dynamic = 'force-dynamic'

/**
 * What the organization says about itself (§4.1, ADR 0052).
 *
 * `organizations` was written by the seed and by almost nothing else since Phase 0, so every
 * organization was Northwind Logistics, in Europe/London, with a freight glossary. Each field
 * on this screen is read by live code, and the screen says by what.
 */
export default async function OrganizationSettingsPage() {
  const session = await requireSession()

  let data: {
    profile: Awaited<ReturnType<typeof organizationProfile>>
    canEdit: boolean
  } | null = null
  let denied: string | null = null

  try {
    data = await withActor(session, async (ctx, actor) => ({
      profile: await organizationProfile(ctx, actor),
      canEdit: can(actor, 'settings:update', {
        type: 'settings',
        organizationId: ctx.organizationId,
        riskTier: 'high',
      }).allow,
    }))
  } catch (error) {
    if (error instanceof PermissionError) denied = error.message
    else throw error
  }

  return (
    <div className="stack stack-6">
      <header className="stack stack-2">
        <h1>Organization</h1>
        <p className="prose secondary" style={{ margin: 0 }}>
          The name, the clock, the money and the words this company uses. Everything here is read
          by something else in the product, which is what makes it worth getting right.
        </p>
      </header>

      {denied || !data ? (
        <div className="panel">
          <div className="empty small secondary">{denied ?? 'Not permitted.'}</div>
        </div>
      ) : (
        <OrganizationProfileAdmin profile={data.profile} canEdit={data.canEdit} />
      )}
    </div>
  )
}
