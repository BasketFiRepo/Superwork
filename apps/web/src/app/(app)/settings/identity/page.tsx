import { requireSession, withActor } from '@/lib/session'
import { identitySettings, residency, REGIONS, PermissionError } from '@superwork/core'
import { IdentitySettingsForm } from '@/components/IdentitySettingsForm'

export const dynamic = 'force-dynamic'

/** SSO, SCIM and data residency (§23). */
export default async function IdentityPage() {
  const session = await requireSession()

  let data: {
    settings: Awaited<ReturnType<typeof identitySettings>>
    region: Awaited<ReturnType<typeof residency>>
  } | null = null
  let denied: string | null = null
  try {
    data = await withActor(session, async (ctx, actor) => ({
      settings: await identitySettings(ctx, actor),
      region: await residency(ctx, actor),
    }))
  } catch (error) {
    if (error instanceof PermissionError) denied = error.message
    else throw error
  }

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Admin</span>
        <h1>Identity and residency</h1>
        <p className="prose secondary">
          The directory says who exists and who has left. Superwork still decides what each
          of them may do — a directory group never grants a permission on its own.
        </p>
      </header>

      {denied ? (
        <div className="panel">
          <div className="empty small secondary">{denied}</div>
        </div>
      ) : data ? (
        <IdentitySettingsForm
          settings={{
            ssoEnabled: data.settings.ssoEnabled,
            ssoProvider: data.settings.ssoProvider,
            verifiedDomains: data.settings.verifiedDomains,
            jitProvisioning: data.settings.jitProvisioning,
            defaultRole: data.settings.defaultRole,
            scimEnabled: data.settings.scimEnabled,
            scimTokenPrefix: data.settings.scimTokenPrefix,
            lastSyncAt: data.settings.lastSyncAt ? data.settings.lastSyncAt.toISOString() : null,
            lastSyncSummary: data.settings.lastSyncSummary,
          }}
          region={{ ...data.region, setAt: data.region.setAt ? data.region.setAt.toISOString() : null }}
          regions={REGIONS.map((entry) => ({ id: entry.id, label: entry.label, note: entry.note }))}
        />
      ) : null}
    </div>
  )
}
