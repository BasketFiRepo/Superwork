import { Link } from '@/components/Link'
import { requireSession, withActor } from '@/lib/session'
import { Sidebar } from '@/components/Sidebar'
import { AgentRail } from '@/components/AgentRail'
import { CommandBar } from '@/components/CommandBar'
import { env } from '@superwork/config'
import { reminderCount } from '@superwork/core'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession()

  const counts = await withActor(session, async (ctx, actor) => {
    const [row] = await ctx.sql<
      { approvals: number; insights: number; inbox: number; pastSla: number; commitments: number }[]
    >`
      SELECT
        (SELECT count(*)::int FROM approvals
          WHERE organization_id = ${ctx.organizationId} AND status = 'pending' AND deleted_at IS NULL) AS approvals,
        (SELECT count(*)::int FROM insights
          WHERE organization_id = ${ctx.organizationId} AND status = 'new' AND deleted_at IS NULL) AS insights,
        (SELECT count(*)::int FROM conversations
          WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL AND archived_at IS NULL
            AND (snoozed_until IS NULL OR snoozed_until <= now())) AS inbox,
        (SELECT count(*)::int FROM conversations conv
          LEFT JOIN companies c ON c.id = conv.company_id
          WHERE conv.organization_id = ${ctx.organizationId} AND conv.deleted_at IS NULL
            AND conv.archived_at IS NULL AND conv.last_direction = 'inbound'
            AND conv.last_message_at < now() - make_interval(days => coalesce(c.reply_sla_days, 4))) AS "pastSla",
        (SELECT count(*)::int FROM commitments
          WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL AND status = 'proposed') AS commitments`
    // Your own, and only ever your own: the badge counts what is waiting for *you* to
    // answer, which is a different question from what the organization has outstanding.
    const reminders = await reminderCount(ctx, actor)
    return { ...(row ?? { approvals: 0, insights: 0, inbox: 0, pastSla: 0, commitments: 0 }), reminders }
  })

  // Density is a per-person flag, resolved with the session. The root layout stamps the
  // default on <html>; this overrides it for the signed-in shell only.
  return (
    <div className="shell" data-density={session.flags.compact_density ? 'compact' : 'comfortable'}>
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

      <Sidebar
        approvals={counts.approvals}
        insights={counts.insights}
        inbox={counts.inbox}
        pastSla={counts.pastSla}
        commitments={counts.commitments}
        reminders={counts.reminders}
        flags={session.flags}
      />

      <main className="main">
        <div className="main-inner">{children}</div>
      </main>

      <aside className="rail">
        <AgentRail timezone={session.timezone} />
      </aside>
    </div>
  )
}
