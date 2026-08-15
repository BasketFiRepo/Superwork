import Link from 'next/link'
import { requireSession, withActor } from '@/lib/session'
import {
  ledgerReport,
  parseMonthKey,
  shiftMonth,
  spendSnapshot,
  subscription,
  PermissionError,
} from '@superwork/core'
import { PlanCaps } from '@/components/PlanCaps'

export const dynamic = 'force-dynamic'

/**
 * Billing and metering (§19).
 *
 * Usage is recorded in the same transaction as the work, so this screen cannot disagree
 * with what actually happened. Every figure names the rows it came from.
 */
export default async function BillingPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const session = await requireSession()
  const params = await searchParams
  const period = parseMonthKey(params.month, session.timezone)
  const previous = shiftMonth(period, -1, session.timezone)

  let data:
    | {
        spend: Awaited<ReturnType<typeof spendSnapshot>>
        report: Awaited<ReturnType<typeof ledgerReport>>
        units: { unit: string; quantity: number; costCents: number }[]
        byTaskClass: { taskClass: string; runs: number; costCents: number }[]
        api: { calls: number; keys: number; errors: number }
        tier: string
        plan: Awaited<ReturnType<typeof subscription>>
      }
    | null = null
  let denied: string | null = null

  try {
    data = await withActor(session, async (ctx, actor) => {
      const [org] = await ctx.sql<{ plan_tier: 'free' | 'team' | 'business' | 'enterprise' }[]>`
        SELECT plan_tier FROM organizations WHERE id = ${ctx.organizationId}`
      const tier = org?.plan_tier ?? 'free'
      const [units, byTaskClass, api] = await Promise.all([
        ctx.sql<{ unit: string; quantity: string; cost: string }[]>`
          SELECT unit, sum(quantity)::text AS quantity, sum(cost_cents)::text AS cost
          FROM usage_records
          WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
            AND occurred_at >= ${period.from} AND occurred_at < ${period.to}
          GROUP BY unit ORDER BY sum(cost_cents) DESC`,
        ctx.sql<{ task_class: string | null; runs: string; cost: string }[]>`
          SELECT task_class, count(*)::text AS runs, sum(cost_cents)::text AS cost
          FROM usage_records
          WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
            AND occurred_at >= ${period.from} AND occurred_at < ${period.to}
          GROUP BY task_class ORDER BY sum(cost_cents) DESC LIMIT 12`,
        ctx.sql<{ calls: string; keys: string; errors: string }[]>`
          SELECT count(*)::text AS calls,
                 count(DISTINCT api_key_id)::text AS keys,
                 count(*) FILTER (WHERE status >= 400)::text AS errors
          FROM api_requests
          WHERE organization_id = ${ctx.organizationId}
            AND occurred_at >= ${period.from} AND occurred_at < ${period.to}`,
      ])

      return {
        spend: await spendSnapshot(ctx, tier),
        report: await ledgerReport(ctx, actor, period),
        units: units.map((row) => ({ unit: row.unit, quantity: Number(row.quantity), costCents: Number(row.cost) })),
        byTaskClass: byTaskClass.map((row) => ({
          taskClass: row.task_class ?? 'unattributed',
          runs: Number(row.runs),
          costCents: Number(row.cost),
        })),
        api: {
          calls: Number(api[0]?.calls ?? 0),
          keys: Number(api[0]?.keys ?? 0),
          errors: Number(api[0]?.errors ?? 0),
        },
        tier,
        plan: await subscription(ctx, actor),
      }
    })
  } catch (error) {
    if (error instanceof PermissionError) denied = error.message
    else throw error
  }

  const money = (cents: number) => `£${(cents / 100).toFixed(2)}`

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Admin</span>
        <h1>Usage and cost</h1>
        <p className="prose secondary">
          What the assistant cost, by unit, by task class and by department. Recorded beside
          the work itself, so this screen and the audit trail can never disagree.
        </p>
      </header>

      {denied ? (
        <div className="panel">
          <div className="empty small secondary">{denied}</div>
        </div>
      ) : data ? (
        <>
          <div className="row-tight">
            <Link className="btn btn-sm" href={`/settings/billing?month=${previous.key}`}>
              ← {previous.label}
            </Link>
            <span className="chip chip-accent">{period.label}</span>
            <span className="chip">plan: {data.tier}</span>
          </div>

          <PlanCaps
            plan={{
              tier: data.plan.tier,
              status: data.plan.status,
              seatsPurchased: data.plan.seatsPurchased,
              seatsUsed: data.plan.seatsUsed,
              seatsRemaining: data.plan.seatsRemaining,
              capsReason: data.plan.capsReason,
              capsSetByName: data.plan.capsSetByName,
              limits: {
                aiSpendCapCents: data.plan.limits.aiSpendCapCents,
                perUserDailySpendCapCents: data.plan.limits.perUserDailySpendCapCents,
                seats: data.plan.limits.seats,
                agentRunsPerMonth: data.plan.limits.agentRunsPerMonth,
                autopilotAllowed: data.plan.limits.autopilotAllowed,
                tightened: data.plan.limits.tightened,
                source: data.plan.limits.source,
              },
              // Resolved the same way as the limits, not read from the config constant —
              // that constant is exactly what this work stopped trusting.
              planCaps: data.plan.planCaps,
            }}
          />

          <section className="panel">
            <div className="panel-header">
              <h2>This month</h2>
              <span className="small muted">
                {data.spend.capCents === null
                  ? 'No cap set'
                  : `${Math.round(data.spend.utilization * 100)}% of ${money(data.spend.capCents)}`}
              </span>
            </div>
            <div className="panel-body">
              <div className="row wrap" style={{ gap: 'var(--s-8)' }}>
                <Figure label="Spent" value={money(data.spend.monthToDateCents)} />
                <Figure label="Runs" value={data.report.organization.runs} />
                <Figure label="Actions" value={data.report.organization.actionsExecuted} />
                <Figure label="API calls" value={data.api.calls} sub={`${data.api.keys} keys · ${data.api.errors} errors`} />
                <Figure
                  label="Your spend today"
                  value={money(data.spend.userTodayCents)}
                  sub={data.spend.userDailyCapCents ? `cap ${money(data.spend.userDailyCapCents)}` : 'no personal cap'}
                />
              </div>
            </div>
            {data.spend.utilization >= 0.8 && data.spend.capCents !== null ? (
              <div className="panel-body hairline-top">
                <div className="banner banner-attention">
                  Past 80% of the monthly cap. Above it, agent runs stop rather than costing more than you agreed.
                </div>
              </div>
            ) : null}
          </section>

          <section className="panel">
            <div className="panel-header">
              <h2>By unit</h2>
            </div>
            {data.units.length === 0 ? (
              <div className="empty small secondary">Nothing metered this month.</div>
            ) : (
              <div className="panel-body-flush table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Unit</th>
                      <th style={{ width: 140 }}>Quantity</th>
                      <th style={{ width: 140 }}>Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.units.map((row) => (
                      <tr key={row.unit}>
                        <td className="small mono">{row.unit}</td>
                        <td className="num">{row.quantity.toLocaleString('en-GB')}</td>
                        <td className="num">{money(row.costCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-header">
              <h2>By task class</h2>
              <span className="small muted">Which kind of work is expensive</span>
            </div>
            {data.byTaskClass.length === 0 ? (
              <div className="empty small secondary">Nothing metered this month.</div>
            ) : (
              <div className="panel-body-flush table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Task class</th>
                      <th style={{ width: 120 }}>Records</th>
                      <th style={{ width: 140 }}>Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byTaskClass.map((row) => (
                      <tr key={row.taskClass}>
                        <td className="small mono">{row.taskClass}</td>
                        <td className="num">{row.runs}</td>
                        <td className="num">{money(row.costCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-header">
              <h2>By department</h2>
              <Link className="small" href={`/analytics?month=${period.key}`}>
                Open the full ledger
              </Link>
            </div>
            <div className="panel-body-flush table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Department</th>
                    <th style={{ width: 120 }}>Runs</th>
                    <th style={{ width: 140 }}>Actions</th>
                    <th style={{ width: 140 }}>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.report.departments.map((department) => (
                    <tr key={department.departmentId ?? 'none'}>
                      <td className="small">{department.departmentName}</td>
                      <td className="num">{department.runs}</td>
                      <td className="num">{department.actionsExecuted}</td>
                      <td className="num">{money(department.costCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="panel-body hairline-top">
              <span className="small muted">{data.report.basis}</span>
            </div>
          </section>
        </>
      ) : null}
    </div>
  )
}

function Figure({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="stack stack-1">
      <span className="micro">{label}</span>
      <span className="num" style={{ fontSize: 22 }}>
        {value}
      </span>
      {sub ? <span className="small muted">{sub}</span> : null}
    </div>
  )
}
