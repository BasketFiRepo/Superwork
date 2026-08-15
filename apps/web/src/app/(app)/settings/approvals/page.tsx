import { requireSession, withActor } from '@/lib/session'
import { approvalPolicies, evaluateApprovalPolicies, PermissionError } from '@superwork/core'
import { allTools } from '@superwork/tools'
import { ApprovalPolicies } from '@/components/ApprovalPolicies'

export const dynamic = 'force-dynamic'

/**
 * Settings → Approvals (§11.1).
 *
 * The rules were seeded in migration 0005 and read by nothing, while the gate carried its
 * own copy of one of them as a constant. This is where they become visible, changeable and
 * answerable — and, just as importantly, where the product says what a rule cannot do.
 */
export default async function ApprovalPoliciesPage() {
  const session = await requireSession()

  let policies: Awaited<ReturnType<typeof approvalPolicies>> = []
  let denied: string | null = null
  try {
    policies = await withActor(session, (ctx) => approvalPolicies(ctx))
  } catch (error) {
    if (!(error instanceof PermissionError)) throw error
    denied = error.message
  }

  const tools = allTools()
    .filter((tool) => tool.riskTier !== 'read')
    .map((tool) => ({ name: tool.name, label: tool.name.replace(/@v\d+$/, '').replace(/_/g, ' '), riskTier: tool.riskTier }))
    .sort((a, b) => a.label.localeCompare(b.label))

  // What the current set does to two plans people actually run. Computed here from the same
  // evaluator the gate uses, so the worked example cannot drift from the behaviour.
  const worked = [
    {
      label: 'An agent drafts one outbound email',
      facts: { tools: ['send_email@v1'], writes: 1, riskTier: 'high' as const, actorType: 'agent' as const, mode: 'execute' as const },
    },
    {
      label: 'An agent creates 25 follow-up tasks',
      facts: { tools: ['create_task@v1'], writes: 25, riskTier: 'low' as const, actorType: 'agent' as const, mode: 'execute' as const },
    },
    {
      label: 'Autopilot tries something irreversible',
      facts: { tools: ['send_email@v1'], writes: 1, riskTier: 'high' as const, actorType: 'agent' as const, mode: 'autopilot' as const },
    },
  ].map((sample) => ({ label: sample.label, outcome: evaluateApprovalPolicies(policies, sample.facts) }))

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Settings</span>
        <h1>Approvals</h1>
        <p className="prose secondary">
          Which proposed actions stop for a person, who may decide them, and by when. These
          rules governed nothing until now — the gate carried its own copy of one of them.
        </p>
      </header>

      {denied ? (
        <div className="panel">
          <div className="empty small secondary">{denied}</div>
        </div>
      ) : (
        <>
          <ApprovalPolicies
            policies={policies.map((policy) => ({
              id: policy.id,
              name: policy.name,
              description: policy.description,
              rule: policy.rule,
              priority: policy.priority,
              enabled: policy.enabled,
            }))}
            tools={tools}
          />

          <section className="panel" data-testid="policy-worked">
            <div className="panel-header">
              <h2>What that means in practice</h2>
              <span className="small muted">run through the same evaluator the gate uses</span>
            </div>
            <div className="panel-body-flush table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>If this were proposed</th>
                    <th style={{ width: 130 }}>Outcome</th>
                    <th>Because</th>
                  </tr>
                </thead>
                <tbody>
                  {worked.map((row) => (
                    <tr key={row.label} data-testid="policy-worked-row">
                      <td className="small">{row.label}</td>
                      <td>
                        <span className={row.outcome.denied ? 'chip chip-critical' : 'chip'}>
                          {row.outcome.denied
                            ? 'refused'
                            : row.outcome.approverRole
                              ? `a ${row.outcome.approverRole} decides`
                              : 'held for a person'}
                        </span>
                      </td>
                      <td className="small secondary">
                        {row.outcome.reason}
                        {row.outcome.matched.length > 0 ? (
                          <div className="small muted">
                            matched: {row.outcome.matched.map((m) => m.name).join(', ')}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
