import { requireSession, withActor } from '@/lib/session'
import { listInvitations, PermissionError } from '@superwork/core'
import { Invitations } from '@/components/Invitations'

export const dynamic = 'force-dynamic'

/**
 * Settings → Members (§4.1, §23.2).
 *
 * `invitations` sat unread and unwritten since migration 0001, which meant there was no way
 * to add a person to an organization except by running the seed or connecting a directory
 * sync. This is where that stops being true.
 */
export default async function MembersPage() {
  const session = await requireSession()

  let data: {
    invitations: Awaited<ReturnType<typeof listInvitations>>
    members: { id: string; name: string; email: string; role: string; status: string }[]
    departments: { id: string; name: string }[]
    role: string
  } | null = null
  let denied: string | null = null

  try {
    data = await withActor(session, async (ctx, actor) => ({
      invitations: await listInvitations(ctx, actor),
      members: await ctx.sql<{ id: string; name: string; email: string; role: string; status: string }[]>`
        SELECT u.id, u.name, u.email, m.role, m.status
        FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ${ctx.organizationId} AND m.deleted_at IS NULL
        ORDER BY m.status, u.name`,
      departments: await ctx.sql<{ id: string; name: string }[]>`
        SELECT id, path AS name FROM departments
        WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL ORDER BY path`,
      role: actor.role,
    }))
  } catch (error) {
    if (!(error instanceof PermissionError)) throw error
    denied = error.message
  }

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Admin</span>
        <h1>Members</h1>
        <p className="prose secondary">
          Who is in this organization, and who has been asked to join. An invitation is a
          credential: it is shown once, expires, works once, and can be withdrawn.
        </p>
      </header>

      {denied ? (
        <div className="panel">
          <div className="empty small secondary">{denied}</div>
        </div>
      ) : data ? (
        <>
          <Invitations
            invitations={data.invitations.map((row) => ({
              id: row.id,
              email: row.email,
              role: row.role,
              departmentName: row.departmentName,
              reason: row.reason,
              invitedByName: row.invitedByName,
              expiresAt: row.expiresAt.toISOString(),
              acceptedUserName: row.acceptedUserName,
              revokedByName: row.revokedByName,
              revokedReason: row.revokedReason,
              state: row.state,
            }))}
            departments={data.departments}
            maxRole={data.role}
          />

          <section className="panel" data-testid="members">
            <div className="panel-header">
              <h2>Members</h2>
              <span className="small muted">{data.members.length}</span>
            </div>
            <div className="panel-body-flush table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th style={{ width: 120 }}>Role</th>
                    <th style={{ width: 110 }}>State</th>
                  </tr>
                </thead>
                <tbody>
                  {data.members.map((member) => (
                    <tr key={member.id} data-testid="member-row">
                      <td>{member.name}</td>
                      <td className="mono small secondary">{member.email}</td>
                      <td className="small secondary">{member.role}</td>
                      <td>
                        <span className={member.status === 'active' ? 'chip chip-positive' : 'chip'}>
                          {member.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="panel-body hairline-top small muted">
              A member is deactivated, never deleted, so their work stays attributable. Removing
              somebody is done through Identity, where the directory sync also lands.
            </div>
          </section>
        </>
      ) : null}
    </div>
  )
}
