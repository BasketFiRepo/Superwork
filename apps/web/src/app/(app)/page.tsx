import Link from 'next/link'
import { requireSession, withActor } from '@/lib/session'
import { runAggregate, asOfLabel, formatCents } from '@superwork/core'
import { requestNow } from '@/lib/request-now'
import { InsightCard } from '@/components/InsightCard'
import { RunWatchersButton } from '@/components/RunWatchersButton'

export const dynamic = 'force-dynamic'

/**
 * Home / Today (§17). Primary action: act on the top priority.
 *
 * Every figure on this page is computed in SQL in the viewing user's timezone. The
 * model writes connective prose only, and never invents a number.
 */
export default async function TodayPage() {
  const session = await requireSession()

  const data = await withActor(session, async (ctx, actor) => {
    const [overdue, dueToday, stale, approvals, spend] = await Promise.all([
      runAggregate(ctx, actor, 'tasks_overdue', { assigneeId: 'me', limit: 10 }),
      runAggregate(ctx, actor, 'tasks_due_today', { assigneeId: 'me', limit: 10 }),
      runAggregate(ctx, actor, 'stale_customer_threads', { limit: 10 }),
      runAggregate(ctx, actor, 'approvals_pending', { limit: 10 }),
      runAggregate(ctx, actor, 'agent_cost_month_to_date', { limit: 10 }),
    ])
    const insights = await ctx.sql<
      {
        id: string
        title: string
        body: string
        severity: string
        watcher: string
        status: string
        evidence: { claim: string }[]
        recommendedActions: { label: string; tool: string; args: Record<string, unknown> }[]
        createdAt: Date
      }[]
    >`
      SELECT id, title, body, severity, watcher, status, evidence,
             recommended_actions AS "recommendedActions", created_at AS "createdAt"
      FROM insights
      WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
        AND status IN ('new', 'acknowledged', 'in_progress')
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
               created_at DESC
      LIMIT 3`
    return { overdue, dueToday, stale, approvals, spend, insights }
  })

  const actionable = data.stale.rows.filter((r) => r['ambiguous'] !== true)
  const spendTotal = data.spend.rows.reduce((sum, row) => sum + Number(row['cost_cents'] ?? 0), 0)
  const basis = asOfLabel(session.timezone, requestNow())

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Today</span>
        <h1 className="display">Good day, {session.name.split(' ')[0]}.</h1>
        <p className="prose secondary">
          {actionable.length > 0
            ? `${actionable.length} ${actionable.length === 1 ? 'customer is' : 'customers are'} past their reply SLA and ${data.overdue.total} of your tasks are overdue (${basis}).`
            : `Nothing is past its reply SLA. ${data.overdue.total} of your tasks are overdue (${basis}).`}
        </p>
      </header>

      <section className="grid-3">
        <Metric label="Overdue (you)" value={data.overdue.total} href="/tasks?filter=overdue" tone={data.overdue.total > 0 ? 'critical' : 'neutral'} />
        <Metric label="Due today (you)" value={data.dueToday.total} href="/tasks?filter=today" />
        <Metric label="Customers waiting" value={actionable.length} href="/insights" tone={actionable.length > 0 ? 'attention' : 'neutral'} />
        <Metric label="Approvals for you" value={data.approvals.total} href="/approvals" tone={data.approvals.total > 0 ? 'attention' : 'neutral'} />
        <Metric label="AI spend this month" value={formatCents(spendTotal, session.currency)} href="/settings/ai-governance" />
      </section>

      <section className="stack stack-5">
        <div className="spread">
          <h2>What needs you</h2>
          <RunWatchersButton />
        </div>
        {data.insights.length === 0 ? (
          <div className="panel">
            <div className="empty stack stack-4">
              <p className="secondary">No open insights.</p>
              <p className="small muted">
                Watchers look for stale threads, slipping work and approvals past their SLA. Run
                them now to see what they find in the demo data.
              </p>
              <div className="row" style={{ justifyContent: 'center' }}>
                <RunWatchersButton label="Run watchers" />
              </div>
            </div>
          </div>
        ) : (
          <div className="stack stack-5">
            {data.insights.map((insight) => (
              <InsightCard key={insight.id} insight={{ ...insight, createdAt: insight.createdAt.toISOString() }} />
            ))}
          </div>
        )}
      </section>

      <section className="grid-2">
        <div className="panel">
          <div className="panel-header">
            <h2>Your overdue work</h2>
            <Link className="btn btn-ghost btn-sm" href="/tasks?filter=overdue">
              Open
            </Link>
          </div>
          {data.overdue.rows.length === 0 ? (
            <div className="empty small secondary">Nothing of yours is overdue.</div>
          ) : (
            <div className="panel-body-flush table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Task</th>
                    <th style={{ width: 100 }}>Late</th>
                    <th style={{ width: 90 }}>Priority</th>
                  </tr>
                </thead>
                <tbody>
                  {data.overdue.rows.slice(0, 6).map((row) => (
                    <tr key={String(row['id'])}>
                      <td>{String(row['title'])}</td>
                      <td className="num" style={{ color: 'var(--critical)' }}>
                        {Number(row['days_overdue'])}d
                      </td>
                      <td className="small secondary">{String(row['priority'])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="panel-body hairline-top small muted">{data.overdue.basis}</div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2>Customers past SLA</h2>
            <Link className="btn btn-ghost btn-sm" href="/insights">
              Open
            </Link>
          </div>
          {data.stale.rows.length === 0 ? (
            <div className="empty small secondary">Every thread is inside its SLA.</div>
          ) : (
            <div className="panel-body-flush table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th style={{ width: 90 }}>Waiting</th>
                    <th style={{ width: 130 }}>Owner</th>
                  </tr>
                </thead>
                <tbody>
                  {data.stale.rows.map((row) => (
                    <tr key={String(row['conversation_id'])}>
                      <td>
                        <div className="row-tight">
                          {String(row['company_name'])}
                          {row['ambiguous'] === true ? (
                            <span className="chip chip-attention" title="We sent the last message — chasing may be wrong.">
                              ambiguous
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="num">{Number(row['days_waiting'])}d</td>
                      <td className="small secondary">{String(row['owner_name'] ?? '—')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="panel-body hairline-top small muted">{data.stale.basis}</div>
        </div>
      </section>
    </div>
  )
}

function Metric({
  label,
  value,
  href,
  tone = 'neutral',
}: {
  label: string
  value: number | string
  href: string
  tone?: 'neutral' | 'attention' | 'critical'
}) {
  const color = tone === 'critical' ? 'var(--critical)' : tone === 'attention' ? 'var(--attention)' : 'var(--ink)'
  return (
    <Link href={href} className="panel" style={{ display: 'block' }}>
      <div className="panel-body stack stack-2">
        <span className="micro">{label}</span>
        <span className="metric" style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', color }}>
          {value}
        </span>
      </div>
    </Link>
  )
}
