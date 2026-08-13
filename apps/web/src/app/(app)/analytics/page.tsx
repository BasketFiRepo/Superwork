import Link from 'next/link'
import { requireSession, withActor } from '@/lib/session'
import { ledgerReport, ledgerRuns, parseMonthKey, shiftMonth } from '@superwork/core'
import { PermissionError } from '@superwork/core'

export const dynamic = 'force-dynamic'

/**
 * The AI ledger (§24, Phase 3 acceptance): what the assistant read, proposed, executed
 * and cost, per department, for a month you can choose.
 *
 * There is no per-person column here and there is no way to add one — the query does not
 * group by user (§29.5).
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; department?: string }>
}) {
  const session = await requireSession()
  const params = await searchParams

  const period = parseMonthKey(params.month, session.timezone)
  const previous = shiftMonth(period, -1, session.timezone)
  const next = shiftMonth(period, 1, session.timezone)
  const thisMonth = parseMonthKey(null, session.timezone)

  let report
  let runsByDepartment: Record<string, Awaited<ReturnType<typeof ledgerRuns>>> = {}
  let denied: string | null = null
  try {
    const loaded = await withActor(session, async (ctx, actor) => {
      const built = await ledgerReport(ctx, actor, period)
      // Every figure has to be openable, so the runs behind each department come back
      // with it rather than behind a link to a screen that cannot filter (§16.9).
      const runs: Record<string, Awaited<ReturnType<typeof ledgerRuns>>> = {}
      for (const department of built.departments) {
        if (department.runs === 0) continue
        runs[department.departmentId ?? 'none'] = await ledgerRuns(ctx, actor, {
          departmentId: department.departmentId,
          period,
          limit: 25,
        })
      }
      return { built, runs }
    })
    report = loaded.built
    runsByDepartment = loaded.runs
  } catch (error) {
    if (error instanceof PermissionError) denied = error.message
    else throw error
  }

  const money = (cents: number) => `£${(cents / 100).toFixed(2)}`

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Operate</span>
        <h1>AI ledger</h1>
        <p className="prose secondary">
          What the assistant read, proposed, executed and cost — by department, for one month.
          Every figure is a count of rows you can open, and none of them is a measure of a person.
        </p>
      </header>

      {denied ? (
        <div className="panel">
          <div className="empty small secondary">{denied}</div>
        </div>
      ) : null}

      {report ? (
        <>
          <div className="spread">
            <div className="row-tight">
              <Link className="btn btn-sm" href={`/analytics?month=${previous.key}`}>
                ← {previous.label}
              </Link>
              <span className="chip chip-accent">{report.period.label}</span>
              {next.key <= thisMonth.key ? (
                <Link className="btn btn-sm" href={`/analytics?month=${next.key}`}>
                  {next.label} →
                </Link>
              ) : (
                <span className="chip" style={{ color: 'var(--ink-disabled)' }}>
                  {next.label}
                </span>
              )}
            </div>
            {report.restrictedTo ? (
              <span className="small muted">Showing {report.restrictedTo.join(', ')}</span>
            ) : (
              <span className="small muted">Whole organization</span>
            )}
          </div>

          <section className="panel" data-testid="ledger-totals">
            <div className="panel-body">
              <div className="row wrap" style={{ gap: 'var(--s-8)' }}>
                <Figure label="Runs" value={report.organization.runs} />
                <Figure label="Passages read" value={report.organization.passagesRead} />
                <Figure label="Actions executed" value={report.organization.actionsExecuted} />
                <Figure label="Approvals asked for" value={report.organization.approvalsRequested} />
                <Figure label="Runs undone" value={report.organization.runsUndone} />
                <Figure label="Cost" value={money(report.organization.costCents)} />
              </div>
            </div>
            <div className="panel-body hairline-top">
              <span className="small muted">{report.basis}</span>
            </div>
          </section>

          {report.departments.map((department) => (
            <section className="panel" key={department.departmentId ?? 'none'} data-testid="ledger-department">
              <div className="panel-header">
                <h2>{department.departmentName}</h2>
                <div className="row-tight">
                  <span className="small muted">
                    {department.runs} {department.runs === 1 ? 'run' : 'runs'}
                  </span>
                  <span className="chip">{money(department.costCents)}</span>
                </div>
              </div>

              {department.runs === 0 ? (
                <div className="empty small secondary">
                  The assistant did nothing for this department in {report.period.label}.
                </div>
              ) : (
                <div className="panel-body stack stack-6">
                  <div className="row wrap" style={{ gap: 'var(--s-7)' }}>
                    <Figure label="Read" value={`${department.passagesRead} passages`} sub={`${department.distinctDocumentsRead} documents`} />
                    <Figure label="Proposed" value={`${department.stepsProposed} steps`} />
                    <Figure label="Executed" value={`${department.actionsExecuted} actions`} />
                    <Figure
                      label="Approvals"
                      value={`${department.approvalsApproved}/${department.approvalsRequested}`}
                      sub={department.approvalsRejected ? `${department.approvalsRejected} rejected` : 'none rejected'}
                    />
                    <Figure label="Undone" value={department.runsUndone} />
                    <Figure
                      label="Read untrusted content"
                      value={department.runsWithUntrustedContent}
                      sub={department.runsCapabilityDowngraded ? `${department.runsCapabilityDowngraded} downgraded` : 'none downgraded'}
                    />
                  </div>

                  {department.toolsProposed.length > 0 ? (
                    <div className="stack stack-3">
                      <span className="micro">Proposed against executed</span>
                      <div className="table-scroll">
                        <table className="table">
                          <thead>
                            <tr>
                              <th>Tool</th>
                              <th style={{ width: 110 }}>Risk</th>
                              <th style={{ width: 110 }}>Proposed</th>
                              <th style={{ width: 110 }}>Executed</th>
                              <th style={{ width: 110 }}>Failed</th>
                            </tr>
                          </thead>
                          <tbody>
                            {department.toolsProposed.map((tool) => (
                              <tr key={tool.tool}>
                                <td className="mono small">{tool.tool}</td>
                                <td>
                                  <span className={`chip${tool.riskTier === 'high' ? ' chip-attention' : ''}`}>
                                    {tool.riskTier}
                                  </span>
                                </td>
                                <td className="num">{tool.proposed}</td>
                                <td className="num">{tool.executed}</td>
                                <td className="num">{tool.failed || ''}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : null}

                  {department.topSources.length > 0 ? (
                    <div className="stack stack-2">
                      <span className="micro">What it read most</span>
                      <div className="row wrap">
                        {department.topSources.map((source, index) => (
                          <span className="chip" key={`${source.label}-${index}`}>
                            {source.documentId ? (
                              <Link href={`/knowledge/${source.documentId}`}>{source.label}</Link>
                            ) : (
                              source.label
                            )}
                            {' · '}
                            {source.times}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <details data-testid="ledger-drilldown">
                    <summary className="small" style={{ cursor: 'pointer', color: 'var(--ink-secondary)' }}>
                      The runs behind these numbers
                    </summary>
                    <div className="table-scroll" style={{ marginTop: 'var(--s-4)' }}>
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Request</th>
                            <th style={{ width: 110 }}>Mode</th>
                            <th style={{ width: 130 }}>Status</th>
                            <th style={{ width: 100 }}>Actions</th>
                            <th style={{ width: 100 }}>Cost</th>
                            <th style={{ width: 120 }}>Trace</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(runsByDepartment[department.departmentId ?? 'none'] ?? []).map((run) => (
                            <tr key={run.id}>
                              <td className="small">{run.request}</td>
                              <td className="small secondary">{run.mode}</td>
                              <td>
                                <span className={`chip${run.undoneAt ? ' chip-attention' : ''}`}>
                                  {run.undoneAt ? 'undone' : run.status}
                                </span>
                              </td>
                              <td className="num">{run.actions}</td>
                              <td className="num">{money(run.costCents)}</td>
                              <td className="small">
                                <Link href={`/activity?run=${run.id}`}>open</Link>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </div>
              )}
            </section>
          ))}

          <section className="panel">
            <div className="panel-header">
              <h2>By agent</h2>
              <span className="small muted">Which persona did the work</span>
            </div>
            <div className="panel-body-flush table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th style={{ width: 120 }}>Runs</th>
                    <th style={{ width: 140 }}>Actions</th>
                    <th style={{ width: 120 }}>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {report.agents.map((agent) => (
                    <tr key={agent.agentId ?? 'adhoc'}>
                      <td>
                        {agent.agentId ? (
                          <Link href={`/settings/agents/${agent.agentId}`}>{agent.agentName}</Link>
                        ) : (
                          agent.agentName
                        )}
                      </td>
                      <td className="num">{agent.runs}</td>
                      <td className="num">{agent.actionsExecuted}</td>
                      <td className="num">{money(agent.costCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <p className="small muted">
            There is no ranking of individuals here, and no setting that adds one. Superwork
            reports what the assistant did, by department and by agent — never how much a
            named colleague used it.
          </p>
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
