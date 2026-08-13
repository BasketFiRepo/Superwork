import { requireSession, withActor } from '@/lib/session'
import { queueSnapshot, queueWaitPercentiles, budget, PermissionError } from '@superwork/core'
import { QuotaEditor } from '@/components/QuotaEditor'

export const dynamic = 'force-dynamic'

/**
 * The agent run queue (§26.6). Fair-share scheduling is invisible when it works, which is
 * exactly why it needs a screen: this is where an admin sees that no department is being
 * starved, and where the weights are set.
 */
export default async function QueuePage() {
  const session = await requireSession()

  let data: {
    rows: Awaited<ReturnType<typeof queueSnapshot>>
    waits: Awaited<ReturnType<typeof queueWaitPercentiles>>
  } | null = null
  let denied: string | null = null

  try {
    data = await withActor(session, async (ctx, actor) => ({
      rows: await queueSnapshot(ctx, actor),
      waits: await queueWaitPercentiles(ctx),
    }))
  } catch (error) {
    if (error instanceof PermissionError) denied = error.message
    else throw error
  }

  const target = budget('queue_wait')

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Admin</span>
        <h1>Agent run queue</h1>
        <p className="prose secondary">
          Runs are scheduled by share, not by arrival. A department that queues two hundred
          jobs at nine o&rsquo;clock gets its share of the workers and no more — everybody
          else keeps moving.
        </p>
      </header>

      {denied ? (
        <div className="panel">
          <div className="empty small secondary">{denied}</div>
        </div>
      ) : data ? (
        <>
          <section className="panel" data-testid="queue-health">
            <div className="panel-header">
              <h2>Wait</h2>
              <span className={`chip${data.waits.p95Ms <= target.targetMs ? ' chip-positive' : ' chip-critical'}`}>
                p95 {data.waits.p95Ms} ms against {target.targetMs} ms
              </span>
            </div>
            <div className="panel-body row wrap" style={{ gap: 'var(--s-8)' }}>
              <Figure label="Samples (1h)" value={data.waits.samples} />
              <Figure label="p50" value={`${data.waits.p50Ms} ms`} />
              <Figure label="p95" value={`${data.waits.p95Ms} ms`} />
              <Figure label="Worst" value={`${data.waits.maxMs} ms`} />
            </div>
            <div className="panel-body hairline-top">
              <span className="small muted">
                §26.9 target: {target.label.toLowerCase()} under {target.targetMs / 1000}s at {target.referenceScale}.
              </span>
            </div>
          </section>

          <QuotaEditor
            rows={data.rows.map((row) => ({
              departmentId: row.departmentId,
              departmentName: row.departmentName,
              weight: row.weight,
              maxConcurrent: row.maxConcurrent,
              runsPerHour: row.runsPerHour,
              deficit: row.deficit,
              queued: row.queued,
              running: row.running,
              ranLastHour: row.ranLastHour,
              oldestWaitMs: row.oldestWaitMs,
            }))}
          />
        </>
      ) : null}
    </div>
  )
}

function Figure({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stack stack-1">
      <span className="micro">{label}</span>
      <span className="num" style={{ fontSize: 22 }}>
        {value}
      </span>
    </div>
  )
}
