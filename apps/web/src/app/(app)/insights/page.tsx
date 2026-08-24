import { can } from '@superwork/auth'
import { watcherSchedules } from '@superwork/agent'
import { requireSession, withActor } from '@/lib/session'
import { InsightCard } from '@/components/InsightCard'
import { BringBackInsight } from '@/components/BringBackInsight'
import { RunWatchersButton } from '@/components/RunWatchersButton'
import { WatcherSchedules } from '@/components/WatcherSchedules'

export const dynamic = 'force-dynamic'

/** Insights (§17). The entire screen is agent output. */
export default async function InsightsPage() {
  const session = await requireSession()
  const { open, deferred, closed, dismissalRate, watchers, canEdit } = await withActor(session, async (ctx, actor) => {
    const rows = await ctx.sql<
      {
        id: string
        title: string
        body: string
        severity: string
        watcher: string
        status: string
        snoozedUntil: Date | null
        snoozedByName: string | null
        evidence: { claim: string }[]
        recommendedActions: { label: string; tool: string; args: Record<string, unknown> }[]
        createdAt: Date
      }[]
    >`
      SELECT i.id, i.title, i.body, i.severity, i.watcher, i.status, i.evidence,
             i.recommended_actions AS "recommendedActions", i.created_at AS "createdAt",
             i.snoozed_until AS "snoozedUntil", u.name AS "snoozedByName"
      FROM insights i
      LEFT JOIN users u ON u.id = i.snoozed_by
      WHERE i.organization_id = ${ctx.organizationId} AND i.deleted_at IS NULL
      ORDER BY CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
               i.created_at DESC
      LIMIT 50`
    const [stats] = await ctx.sql<{ total: number; dismissed: number }[]>`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'dismissed')::int AS dismissed
      FROM insights WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL`
    return {
      open: rows.filter((r) => ['new', 'acknowledged', 'in_progress'].includes(r.status)),
      // Deferred is neither. A snoozed insight filed under "closed" is one somebody thinks was
      // dealt with, and it is going to come back (ADR 0083).
      deferred: rows.filter((r) => r.status === 'snoozed'),
      closed: rows.filter((r) => !['new', 'acknowledged', 'in_progress', 'snoozed'].includes(r.status)),
      dismissalRate: stats && stats.total > 0 ? stats.dismissed / stats.total : 0,
      watchers: await watcherSchedules(ctx),
      canEdit: can(actor, 'settings:update', {
        type: 'settings',
        organizationId: ctx.organizationId,
        riskTier: 'low',
      }).allow,
    }
  })

  return (
    <div className="stack stack-8">
      <header className="spread">
        <div className="stack stack-2">
          <span className="micro">Operate</span>
          <h1>Insights</h1>
          <p className="prose secondary">
            Evidence-backed observations, each with an action you can take in one click. Capped at
            seven a day per person, grouped rather than repeated.
          </p>
        </div>
        <RunWatchersButton />
      </header>

      {dismissalRate > 0.5 ? (
        <div className="banner banner-attention">
          {(dismissalRate * 100).toFixed(0)}% of insights are being dismissed. Say why when you
          dismiss one: a watcher people call wrong stops running, while one people had already
          handled is re-timed rather than switched off. Each watcher&apos;s verdict is below.
        </div>
      ) : null}

      <WatcherSchedules
        canEdit={canEdit}
        watchers={watchers.map((watcher) => ({
          key: watcher.key,
          title: watcher.title,
          description: watcher.description,
          cron: watcher.cron,
          declaredCron: watcher.declaredCron,
          enabled: watcher.enabled,
          muted: watcher.muted,
          lastRunAt: watcher.lastRunAt ? watcher.lastRunAt.toISOString() : null,
          nextRunAt: watcher.nextRunAt ? watcher.nextRunAt.toISOString() : null,
          quality: watcher.quality
            ? {
                verdict: watcher.quality.verdict,
                reason: watcher.quality.reason,
                shown: watcher.quality.shown,
                rated: watcher.quality.rated,
              }
            : null,
        }))}
      />

      <section className="stack stack-5">
        {open.length === 0 ? (
          <div className="panel">
            <div className="empty stack stack-3">
              <p className="secondary">No open insights.</p>
              <p className="small muted">Run the watchers to look for stale threads, slipping work and aging approvals.</p>
            </div>
          </div>
        ) : (
          open.map((insight) => (
            <InsightCard
              key={insight.id}
              insight={{
                ...insight,
                createdAt: insight.createdAt.toISOString(),
                snoozedUntil: insight.snoozedUntil ? insight.snoozedUntil.toISOString() : null,
              }}
            />
          ))
        )}
      </section>

      {deferred.length > 0 ? (
        <section className="stack stack-5" data-testid="insights-deferred">
          <h2>Put off until later</h2>
          <p className="prose secondary" style={{ margin: 0 }}>
            These come back to the list above on the day, and whoever put one off is told. Nothing
            here says anything about the watcher — that is what dismissing is for.
          </p>
          <div className="panel">
            <div className="panel-body-flush table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Insight</th>
                    <th style={{ width: 140 }}>Watcher</th>
                    <th style={{ width: 130 }}>Back on</th>
                    <th style={{ width: 150 }}>Put off by</th>
                    <th style={{ width: 130 }} />
                  </tr>
                </thead>
                <tbody>
                  {deferred.map((insight) => (
                    <tr key={insight.id} data-testid="insight-deferred-row">
                      <td>{insight.title}</td>
                      <td className="small secondary">{insight.watcher.replace(/_/g, ' ')}</td>
                      <td className="small mono secondary">
                        {insight.snoozedUntil ? insight.snoozedUntil.toISOString().slice(0, 10) : '—'}
                      </td>
                      <td className="small secondary">{insight.snoozedByName ?? '—'}</td>
                      <td>
                        <BringBackInsight insightId={insight.id} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      {closed.length > 0 ? (
        <section className="stack stack-5">
          <h2>Resolved and dismissed</h2>
          <div className="panel">
            <div className="panel-body-flush table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Insight</th>
                    <th style={{ width: 140 }}>Watcher</th>
                    <th style={{ width: 120 }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {closed.map((insight) => (
                    <tr key={insight.id}>
                      <td>{insight.title}</td>
                      <td className="small secondary">{insight.watcher.replace(/_/g, ' ')}</td>
                      <td className="small secondary">{insight.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  )
}
