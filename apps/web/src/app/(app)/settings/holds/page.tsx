import { Link } from '@/components/Link'
import { listHolds, PermissionError, retentionPolicies } from '@superwork/core'
import { requireSession, withActor } from '@/lib/session'
import { LegalHolds } from '@/components/LegalHolds'

export const dynamic = 'force-dynamic'

/**
 * Legal holds (§21). The other half of retention: what is not being deleted, for what
 * matter, on whose say-so, and how much the last sweep left alone because of it.
 */
export default async function HoldsPage() {
  const session = await requireSession()

  let data: {
    holds: Awaited<ReturnType<typeof listHolds>>
    members: { id: string; name: string; role: string }[]
    heldRows: number
  } | null = null
  let denied: string | null = null

  try {
    data = await withActor(session, async (ctx, actor) => {
      const policies = await retentionPolicies(ctx, actor)
      return {
        holds: await listHolds(ctx, actor),
        members: await ctx.sql<{ id: string; name: string; role: string }[]>`
          SELECT u.id, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = ${ctx.organizationId} AND m.deleted_at IS NULL AND m.status = 'active'
          ORDER BY u.name`,
        heldRows: policies.reduce((sum, policy) => sum + policy.lastHeld, 0),
      }
    })
  } catch (error) {
    if (error instanceof PermissionError) denied = error.message
    else throw error
  }

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Admin</span>
        <h1>Legal holds</h1>
        <p className="prose secondary">
          A hold suspends deletion for one matter. While it stands, nothing it covers is purged
          by a <Link href="/settings/retention">retention window</Link>, erased on request, or
          deleted from the library — the refusals name the matter rather than failing quietly.
          Everyone named in a hold is told.
        </p>
      </header>

      {denied ? (
        <div className="panel">
          <div className="empty small secondary">{denied}</div>
        </div>
      ) : (
        <LegalHolds
          holds={(data?.holds ?? []).map((hold) => ({
            ...hold,
            coversFrom: hold.coversFrom.toISOString(),
            coversTo: hold.coversTo ? hold.coversTo.toISOString() : null,
            placedAt: hold.placedAt.toISOString(),
            releasedAt: hold.releasedAt ? hold.releasedAt.toISOString() : null,
          }))}
          members={data?.members ?? []}
          heldRows={data?.heldRows ?? 0}
        />
      )}
    </div>
  )
}
