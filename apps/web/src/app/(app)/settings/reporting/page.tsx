import { requireSession, withActor } from '@/lib/session'
import { orgChart, PermissionError } from '@superwork/core'
import { OrgChart } from '@/components/OrgChart'

export const dynamic = 'force-dynamic'

/**
 * Settings → Reporting lines (§26.1).
 *
 * `reporting_relationships` was seeded with a real org chart in migration 0001 and read by
 * nothing, while three controls sat on top of it claiming to work: the ladder's escalation
 * rung, the profiles' no-surprises window, and the compliance review's evidence about
 * manager escalation.
 */
export default async function ReportingPage() {
  const session = await requireSession()

  let lines: Awaited<ReturnType<typeof orgChart>> = []
  let people: { id: string; name: string; role: string }[] = []
  let denied: string | null = null
  try {
    const loaded = await withActor(session, async (ctx, actor) => ({
      lines: await orgChart(ctx, actor),
      people: await ctx.sql<{ id: string; name: string; role: string }[]>`
        SELECT u.id, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ${ctx.organizationId} AND m.deleted_at IS NULL AND m.status = 'active'
        ORDER BY u.name`,
    }))
    lines = loaded.lines
    people = loaded.people
  } catch (error) {
    if (!(error instanceof PermissionError)) throw error
    denied = error.message
  }

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Settings</span>
        <h1>Reporting lines</h1>
        <p className="prose secondary">
          Who is answerable for whom. This routes escalations and approvals to a person
          instead of to a role — and nothing else.
        </p>
      </header>

      {denied ? (
        <div className="panel">
          <div className="empty small secondary">{denied}</div>
        </div>
      ) : (
        <OrgChart
          lines={lines.map((line) => ({
            id: line.id,
            personId: line.personId,
            personName: line.personName,
            managerId: line.managerId,
            managerName: line.managerName,
            type: line.type,
            reason: line.reason,
            setByName: line.setByName,
          }))}
          people={people}
        />
      )}
    </div>
  )
}
