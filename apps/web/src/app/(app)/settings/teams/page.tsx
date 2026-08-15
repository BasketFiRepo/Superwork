import { listTeams, PermissionError } from '@superwork/core'
import { requireSession, withActor } from '@/lib/session'
import { TeamsAdmin } from '@/components/TeamsAdmin'

export const dynamic = 'force-dynamic'

/**
 * Teams (§4.3). The dimension the policy engine has always had a scope for and never had
 * any data behind — including for the `guest` role, every one of whose permissions is
 * team-scoped.
 */
export default async function TeamsPage() {
  const session = await requireSession()

  let data: {
    teams: Awaited<ReturnType<typeof listTeams>>
    people: { id: string; name: string; role: string }[]
  } | null = null
  let denied: string | null = null

  try {
    data = await withActor(session, async (ctx, actor) => ({
      teams: await listTeams(ctx, actor),
      people: await ctx.sql<{ id: string; name: string; role: string }[]>`
        SELECT u.id, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ${ctx.organizationId} AND m.deleted_at IS NULL AND m.status = 'active'
        ORDER BY u.name`,
    }))
  } catch (error) {
    if (error instanceof PermissionError) denied = error.message
    else throw error
  }

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Admin</span>
        <h1>Teams</h1>
        <p className="prose secondary">
          A department is where somebody sits; a team is what they are working on, and there can
          be several. Work scoped to a team is reachable by the people on it — which is the whole
          of what the <strong>guest</strong> role can reach, since every permission it holds is
          team-scoped.
        </p>
      </header>

      {denied ? (
        <div className="panel">
          <div className="empty small secondary">{denied}</div>
        </div>
      ) : (
        <TeamsAdmin
          teams={(data?.teams ?? []).map((team) => ({
            id: team.id,
            name: team.name,
            purpose: team.purpose,
            departmentName: team.departmentName,
            members: team.members.map((member) => ({
              userId: member.userId,
              name: member.name,
              role: member.role,
              reason: member.reason,
            })),
            counts: team.counts,
          }))}
          people={data?.people ?? []}
        />
      )}
    </div>
  )
}
