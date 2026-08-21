import { Link } from '@/components/Link'
import { notFound } from 'next/navigation'
import { requireSession, withActor } from '@/lib/session'
import {
  certificationState,
  getAgent,
  monitoringPolicy,
  listAgentVersions,
  listChangeRequests,
  listSimulations,
  NotFoundError,
  personaSnapshot,
  PermissionError,
} from '@superwork/core'
import { allTools } from '@superwork/tools'
import { listDigests } from '@superwork/agent'
import { DigestPanel } from '@/components/DigestPanel'
import { AgentStudio } from '@/components/AgentStudio'

export const dynamic = 'force-dynamic'

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params

  let data
  let denied: string | null = null
  try {
    data = await withActor(session, async (ctx, actor) => {
      const agent = await getAgent(ctx, actor, id)
      const policy = await monitoringPolicy(ctx)
      const [changes, versions, simulations, digests, people, departments] = await Promise.all([
        listChangeRequests(ctx, actor, { agentId: id, limit: 20 }),
        listAgentVersions(ctx, actor, id),
        listSimulations(ctx, actor, id, 5),
        listDigests(ctx, id, 8),
        ctx.sql<{ id: string; name: string }[]>`
          SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = ${ctx.organizationId} AND m.deleted_at IS NULL AND m.status = 'active'
          ORDER BY u.name`,
        ctx.sql<{ id: string; name: string }[]>`
          SELECT id, name FROM departments
          WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL ORDER BY name`,
      ])
      return {
        agent,
        changes,
        versions,
        simulations,
        digests,
        people,
        departments,
        viewerId: actor.userId,
        // Whether anybody still stands behind what this may do (ADR 0068). The same rule the
        // runtime uses to decide the mode ceiling, so the screen and the run agree.
        certification: certificationState(agent, policy.agentRecertificationDays),
        recertificationDays: policy.agentRecertificationDays,
      }
    })
  } catch (error) {
    if (error instanceof NotFoundError) notFound()
    if (error instanceof PermissionError) denied = error.message
    else throw error
  }

  if (denied) {
    return (
      <div className="panel">
        <div className="empty small secondary">{denied}</div>
      </div>
    )
  }
  if (!data) notFound()

  // The catalogue an admin picks from: every registered tool, with the risk tier that
  // decides whether the gate will hold it for approval.
  const tools = allTools().map((tool) => ({
    name: tool.name,
    riskTier: tool.riskTier,
    description: tool.description,
  }))

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <Link className="small" href="/settings/agents">
          ← Agents
        </Link>
        <div className="row-tight">
          <h1>{data.agent.name}</h1>
          <span
            className={`chip${data.agent.status === 'active' ? ' chip-positive' : data.agent.status === 'paused' ? ' chip-attention' : ''}`}
          >
            {data.agent.status}
          </span>
          <span className="chip mono">{data.agent.key}</span>
          <span className="chip">v{data.agent.currentVersion}</span>
        </div>
        <p className="prose secondary">{data.agent.purpose}</p>
      </header>

      <AgentStudio
        agent={{
          agentId: data.agent.agentId,
          name: data.agent.name,
          status: data.agent.status,
          currentVersion: data.agent.currentVersion,
          ownerName: data.agent.ownerName,
          publishedByName: data.agent.publishedByName,
          publishedAt: data.agent.publishedAt ? data.agent.publishedAt.toISOString() : null,
        }}
        certification={{
          state: data.certification.state,
          summary: data.certification.summary,
          stale: data.certification.stale,
          daysOverdue: data.certification.daysOverdue,
          intervalDays: data.recertificationDays,
          note: data.agent.recertificationNote,
        }}
        snapshot={personaSnapshot(data.agent)}
        tools={tools}
        people={data.people}
        departments={data.departments}
        viewerId={data.viewerId}
        changes={data.changes.map((change) => ({
          id: change.id,
          status: change.status,
          justification: change.justification,
          requestedBy: change.requestedBy,
          requestedByName: change.requestedByName,
          decidedByName: change.decidedByName,
          decisionNote: change.decisionNote,
          simulationId: change.simulationId,
          diff: change.diff.map((field) => ({
            field: String(field.field),
            from: JSON.stringify(field.from),
            to: JSON.stringify(field.to),
            widens: field.widens,
          })),
          createdAt: change.createdAt.toISOString(),
        }))}
        versions={data.versions.map((version) => ({
          id: version.id,
          ordinal: version.ordinal,
          justification: version.justification,
          publishedByName: version.publishedByName,
          secondApproverName: version.secondApproverName,
          createdAt: version.createdAt.toISOString(),
        }))}
        simulations={data.simulations.map((simulation) => ({
          id: simulation.id,
          windowFrom: simulation.windowFrom.toISOString(),
          windowTo: simulation.windowTo.toISOString(),
          totals: simulation.totals,
          findings: simulation.findings,
          proposals: simulation.proposals,
          createdAt: simulation.createdAt.toISOString(),
        }))}
      />

      <DigestPanel
        agentId={data.agent.agentId}
        agentName={data.agent.name}
        ownerName={data.agent.ownerName}
        digests={data.digests.map((digest) => ({
          id: digest.id,
          periodFrom: digest.periodFrom.toISOString(),
          periodTo: digest.periodTo.toISOString(),
          narrative: digest.narrative,
          facts: digest.facts,
        }))}
      />
    </div>
  )
}
