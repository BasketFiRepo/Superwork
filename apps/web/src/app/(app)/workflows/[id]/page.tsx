import Link from 'next/link'
import { notFound } from 'next/navigation'
import { checkCapacity, describeCron, getWorkflow, listWorkflowRuns } from '@superwork/core'
import { can } from '@superwork/auth'
import { requireSession, withActor } from '@/lib/session'
import { ScheduleEditor } from '@/components/ScheduleEditor'
import { WorkflowControls } from '@/components/WorkflowControls'
import { WorkflowGraphView, type CompiledView } from '@/components/WorkflowGraphView'
import { WorkflowThrottle } from '@/components/WorkflowThrottle'

export const dynamic = 'force-dynamic'

/** One workflow: what it says it does, what a dry run showed, and what it has done. */
export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params

  const data = await withActor(session, async (ctx, actor) => {
    const workflow = await getWorkflow(ctx, actor, id).catch(() => null)
    if (!workflow) return null
    const runs = await listWorkflowRuns(ctx, actor, { workflowId: id, limit: 10 })
    const members = await ctx.sql<{ id: string; name: string }[]>`
      SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ${ctx.organizationId} AND m.deleted_at IS NULL AND m.status = 'active'
        AND m.role IN ('admin', 'manager', 'member')
      ORDER BY u.name`
    // The same count the scheduler makes, from the same function: a screen that offers to
    // change a limit has to show what that limit is doing right now (ADR 0046).
    const capacity = await checkCapacity(ctx, workflow)
    const change = can(actor, 'workflow:update', {
      type: 'workflow',
      organizationId: ctx.organizationId,
      riskTier: 'high',
    })
    return { workflow, runs, members, capacity, change }
  })

  if (!data) notFound()
  const { workflow, runs, members, capacity, change } = data
  const compiled: CompiledView | null = workflow.graph
    ? { name: workflow.name, graph: workflow.graph, readback: workflow.readback, risks: workflow.risks, unsupported: null }
    : null

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">
          <Link href="/workflows">Workflows</Link>
        </span>
        <h1>{workflow.name}</h1>
        <p className="small secondary">
          Version {workflow.currentVersionOrdinal ?? '—'} · {workflow.status} · owner{' '}
          {workflow.ownerName ?? 'unassigned'}
        </p>
      </header>

      {compiled ? (
        <section className="panel">
          <div className="panel-header">
            <h2>What it does</h2>
            <span className="small muted">Compiled from “{workflow.description}”</span>
          </div>
          <div className="panel-body">
            <WorkflowGraphView compiled={compiled} />
          </div>
        </section>
      ) : null}

      <WorkflowThrottle
        workflowId={workflow.id}
        maxConcurrentRuns={workflow.maxConcurrentRuns}
        dailyActionCap={workflow.dailyActionCap}
        setByName={workflow.limitsSetByName}
        setAt={workflow.limitsSetAt ? workflow.limitsSetAt.toISOString() : null}
        reason={workflow.limitsReason}
        capacity={{
          unfinished: capacity.unfinished,
          usedToday: capacity.usedToday,
          remaining: capacity.remaining,
          allow: capacity.allow,
          reason: capacity.reason,
        }}
        canEdit={change.allow}
        denialReason={change.reason}
      />

      {workflow.status === 'active' || workflow.scheduleCron ? (
        <section className="panel" data-testid="workflow-schedule">
          <div className="panel-header">
            <h2>On the clock</h2>
            <span className={workflow.scheduleEnabled ? 'chip chip-positive' : 'chip chip-attention'}>
              {workflow.scheduleEnabled ? 'firing' : 'stopped'}
            </span>
          </div>
          <div className="panel-body stack stack-5">
            <p className="prose" style={{ margin: 0 }}>
              {workflow.scheduleCron
                ? `Runs ${describeCron(workflow.scheduleCron, workflow.scheduleTimezone ?? 'UTC')} — the company's timezone, not the server's, and the same on the morning the clocks change.`
                : 'It runs when somebody runs it. Give it a schedule and the worker will fire it.'}
            </p>
            <div className="row wrap small secondary">
              <span>
                Next: {workflow.nextRunAt ? workflow.nextRunAt.toISOString().slice(0, 16).replace('T', ' ') : '—'} UTC
              </span>
              <span>
                Last: {workflow.lastRunAt ? workflow.lastRunAt.toISOString().slice(0, 16).replace('T', ' ') : 'never'}
              </span>
              {workflow.skippedTotal ? <span>{workflow.skippedTotal} firings skipped</span> : null}
            </div>
            {workflow.lastSkippedReason ? (
              <div className="banner">
                <span>Last skipped firing: {workflow.lastSkippedReason}</span>
              </div>
            ) : null}

            {workflow.status === 'active' ? (
              <ScheduleEditor
                workflowId={workflow.id}
                cron={workflow.scheduleCron}
                timezone={workflow.scheduleTimezone ?? 'UTC'}
                catchUpPolicy={workflow.scheduleCatchUp ?? 'run_once'}
                enabled={workflow.scheduleEnabled ?? false}
              />
            ) : (
              <p className="small muted" style={{ margin: 0 }}>
                Only an active workflow has a clock. Dry-run this version and activate it to choose when it runs.
              </p>
            )}
          </div>
        </section>
      ) : null}

      <WorkflowControls
        workflow={{
          id: workflow.id,
          status: workflow.status,
          simulatedOk: workflow.simulatedOk,
          ownerUserId: workflow.ownerUserId,
        }}
        members={members}
      />

      <section className="panel">
        <div className="panel-header">
          <h2>Runs</h2>
          <span className="small muted">Dry runs and real ones, in order</span>
        </div>
        {runs.length === 0 ? (
          <div className="empty stack stack-2">
            <p className="secondary">It has never run.</p>
            <p className="small muted">A dry run reads real data and stops before every effect.</p>
          </div>
        ) : (
          <div className="panel-body stack stack-5">
            {runs.map((run) => (
              <article key={run.id} className="stack stack-2" style={{ paddingLeft: 'var(--s-5)', borderLeft: '1px solid var(--hairline)' }}>
                <div className="row-tight">
                  <span className={run.simulated ? 'chip' : 'chip chip-positive'}>
                    {run.simulated ? 'dry run' : 'real'}
                  </span>
                  <span className="small">{run.status.replace(/_/g, ' ')}</span>
                  <span className="small muted">
                    version {run.versionOrdinal} · {run.startedAt ? run.startedAt.toISOString().slice(0, 16).replace('T', ' ') : '—'}
                  </span>
                </div>
                {run.error ? <p className="small" style={{ margin: 0 }}>{run.error}</p> : null}
                <ul className="stack stack-2 small secondary" style={{ margin: 0, paddingLeft: 'var(--s-7)' }}>
                  {run.steps.map((step, index) => (
                    <li key={index}>
                      <strong>{step.label}</strong> — {step.status}
                      {step.detail ? ` · ${step.detail}` : ''}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
