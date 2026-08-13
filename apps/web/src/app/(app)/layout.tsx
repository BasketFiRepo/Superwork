import Link from 'next/link'
import { requireSession, withActor } from '@/lib/session'
import { Sidebar } from '@/components/Sidebar'
import { AgentRail } from '@/components/AgentRail'
import { CommandBar } from '@/components/CommandBar'
import { env } from '@superwork/config'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession()

  const counts = await withActor(session, async (ctx) => {
    const [row] = await ctx.sql<{ approvals: number; insights: number }[]>`
      SELECT
        (SELECT count(*)::int FROM approvals
          WHERE organization_id = ${ctx.organizationId} AND status = 'pending' AND deleted_at IS NULL) AS approvals,
        (SELECT count(*)::int FROM insights
          WHERE organization_id = ${ctx.organizationId} AND status = 'new' AND deleted_at IS NULL) AS insights`
    return row ?? { approvals: 0, insights: 0 }
  })

  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/" className="row-tight" style={{ fontWeight: 600 }}>
          <span className="dot" style={{ background: 'var(--accent)' }} />
          Superwork
        </Link>

        <CommandBar />

        <div className="row" style={{ marginLeft: 'auto' }}>
          {session.isDemo ? (
            <span className="chip" title="Every record here is seeded demo data and is reset nightly.">
              Demo data
            </span>
          ) : null}
          {env().AI_MODE !== 'live' ? (
            <span className="chip chip-accent" title="Responses are generated deterministically from your real data, with no model provider.">
              AI: simulated
            </span>
          ) : null}
          {session.killSwitch ? (
            <span className="chip chip-critical">Agent halted</span>
          ) : null}
          <span className="chip" title={session.email}>
            {session.name}
          </span>
          <form action="/api/auth/logout" method="post">
            <button className="btn btn-ghost btn-sm" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <Sidebar approvals={counts.approvals} insights={counts.insights} flags={session.flags} />

      <main className="main">
        <div className="main-inner">{children}</div>
      </main>

      <aside className="rail">
        <AgentRail timezone={session.timezone} />
      </aside>
    </div>
  )
}
