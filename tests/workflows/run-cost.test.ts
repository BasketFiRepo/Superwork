import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * What a workflow run costs (ADR 0073).
 *
 * `workflow_runs.cost_cents` was selected into every `WorkflowRunView` and rendered nowhere, and
 * `workflow_step_runs.cost_cents` was read by nothing at all. Reading the engine for why turned
 * up something better than a bug: a workflow run does not call the model. `query` runs SQL,
 * `for_each` fans out, `action` compiles planned tool calls from the graph, `approval` raises an
 * approval, `notify` writes notifications. Zero is the right answer, not a stale one.
 *
 * So the work is to make zero mean "the agent runs say so" rather than "nobody ever wrote it".
 */

let org: TenantFixture
let owner: { organizationId: string; userId: string; timezone: string }
let workflowId: string
let versionId: string

async function openRun(agentRunIds: string[] = []): Promise<string> {
  const [row] = await adminSql()<{ id: string }[]>`
    INSERT INTO workflow_runs (organization_id, workflow_id, workflow_version_id, status, trigger,
                               simulated, agent_run_ids, idempotency_key, is_demo, created_by)
    VALUES (${org.organizationId}, ${workflowId}, ${versionId}, 'running', 'manual', false,
            ${agentRunIds}::uuid[], ${`cost-${Math.random().toString(36).slice(2)}`}, true,
            ${org.ownerId})
    RETURNING id`
  return row!.id
}

async function newAgentRun(): Promise<string> {
  const [row] = await adminSql()<{ id: string }[]>`
    INSERT INTO agent_runs (organization_id, principal_user_id, mode, status, request, trace_id,
                            is_demo, created_by)
    VALUES (${org.organizationId}, ${org.ownerId}, 'execute', 'running', 'Workflow: nightly',
            ${`trace-cost-${Math.random().toString(36).slice(2)}`}, true, ${org.ownerId})
    RETURNING id`
  return row!.id
}

async function cost(runId: string): Promise<number> {
  const [row] = await adminSql()<{ cost: number }[]>`
    SELECT cost_cents::float8 AS cost FROM workflow_runs WHERE id = ${runId}`
  return row!.cost
}

/** The only writer of model spend, which is what makes an agent run's cost move. */
async function spend(agentRunId: string, cents: number) {
  await adminSql()`
    INSERT INTO agent_messages (organization_id, run_id, role, content, task_class, model,
                               tokens_in, tokens_out, cost_cents, latency_ms, created_by)
    VALUES (${org.organizationId}, ${agentRunId}, 'assistant', 'Summarised the thread.',
            'summarize', 'claude-test', 400, 120, ${cents}, 900, ${org.ownerId})`
}

beforeAll(async () => {
  org = await createTenant('workflow-run-cost')
  owner = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
  const [workflow] = await adminSql()<{ id: string }[]>`
    INSERT INTO workflows (organization_id, name, description, status, owner_user_id, is_demo,
                           created_by)
    VALUES (${org.organizationId}, 'Nightly chase', 'Chase quiet threads.', 'active',
            ${org.ownerId}, true, ${org.ownerId})
    RETURNING id`
  workflowId = workflow!.id
  const [version] = await adminSql()<{ id: string }[]>`
    INSERT INTO workflow_versions (organization_id, workflow_id, ordinal, graph, readback, is_demo,
                                   created_by)
    VALUES (${org.organizationId}, ${workflowId}, 1, '{"nodes":[]}'::jsonb,
            'Chases threads nobody has answered.', true, ${org.ownerId})
    RETURNING id`
  versionId = version!.id
})

afterAll(async () => {
  await destroyTenant('workflow-run-cost')
  await closePools()
})

describe('a run that spent nothing', () => {
  it('says zero because its agent runs say so, not because nobody wrote it', async () => {
    const runId = await openRun([await newAgentRun()])
    expect(await cost(runId)).toBe(0)
  })

  it('and a simulated run has no agent run to ask, which is also zero', async () => {
    expect(await cost(await openRun([]))).toBe(0)
  })
})

describe('a run whose agent run does spend', () => {
  /**
   * Nothing on the engine's path calls a model today. This is the case the column exists for:
   * the day a step does, the number is already right, and it is right *by construction* rather
   * than because somebody remembered to add a line beside the model call.
   */
  it('follows it, without application code being asked to remember', async () => {
    const agentRunId = await newAgentRun()
    const runId = await openRun([agentRunId])
    expect(await cost(runId)).toBe(0)

    await spend(agentRunId, 12.5)
    expect(await cost(runId)).toBe(12.5)
  })

  it('and follows a correction down as well as up', async () => {
    const agentRunId = await newAgentRun()
    const runId = await openRun([agentRunId])
    await spend(agentRunId, 8)
    await spend(agentRunId, 4)
    expect(await cost(runId)).toBe(12)

    // Recomputed, not incremented: a deleted message leaves the total right rather than drifted
    // by the size of the correction.
    await adminSql()`
      DELETE FROM agent_messages WHERE organization_id = ${org.organizationId}
        AND run_id = ${agentRunId} AND cost_cents = 4`
    expect(await cost(runId)).toBe(8)
  })

  it('sums the runs it hangs off, not just the first', async () => {
    const first = await newAgentRun()
    const second = await newAgentRun()
    const runId = await openRun([first, second])
    await spend(first, 3)
    await spend(second, 7)
    expect(await cost(runId)).toBe(10)
  })

  it('and a run that has nothing to do with it does not move', async () => {
    const mine = await newAgentRun()
    const runId = await openRun([mine])
    await spend(await newAgentRun(), 99)
    expect(await cost(runId)).toBe(0)
  })
})

describe('what application code may claim', () => {
  it('nothing — the number is the database’s to write', async () => {
    const agentRunId = await newAgentRun()
    const runId = await openRun([agentRunId])
    await spend(agentRunId, 5)
    // Writing it directly is not refused, it is overruled: the same one-writer arrangement
    // `agent_runs.cost_cents` has had since 0037. Two places holding one number is how they
    // come to disagree.
    await adminSql()`UPDATE workflow_runs SET cost_cents = 4000 WHERE id = ${runId}`
    expect(await cost(runId)).toBe(5)
  })

  /**
   * The hole this test opened. The trigger first carried a WHEN guard on `agent_run_ids`
   * changing, and `SET agent_run_ids = agent_run_ids` is not a distinct array — so the guard
   * declined to fire and a made-up number stuck. The gap in a derived column is exactly where
   * somebody writes the column without touching its inputs.
   */
  it('including when the write pretends to touch the column it is derived from', async () => {
    const agentRunId = await newAgentRun()
    const runId = await openRun([agentRunId])
    await spend(agentRunId, 6)
    await adminSql()`
      UPDATE workflow_runs SET agent_run_ids = agent_run_ids, cost_cents = 4000 WHERE id = ${runId}`
    expect(await cost(runId)).toBe(6)
  })

  it('and an unrelated edit to the row leaves the number alone', async () => {
    const agentRunId = await newAgentRun()
    const runId = await openRun([agentRunId])
    await spend(agentRunId, 9)
    await adminSql()`UPDATE workflow_runs SET status = 'succeeded' WHERE id = ${runId}`
    expect(await cost(runId)).toBe(9)
  })
})

describe('the step column', () => {
  it('is gone, because a per-step figure would have to be invented', async () => {
    // Model spend is recorded per call on `agent_messages`, which carries a task class and no
    // node id. Splitting a run's cost across its steps would mean choosing a rule — evenly? by
    // duration? by tool? — and printing the answer as a measurement.
    const columns = await adminSql()<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'workflow_step_runs' AND column_name = 'cost_cents'`
    expect(columns).toHaveLength(0)
  })

  it('and the run is still readable through the repository that lost it', async () => {
    const { listWorkflowRuns } = await import('@superwork/core')
    const { loadActor } = await import('@superwork/auth')
    const runs = await withTenant(owner, async (ctx) =>
      listWorkflowRuns(ctx, await loadActor(ctx), { workflowId }),
    )
    expect(runs.length).toBeGreaterThan(0)
    expect(runs.every((run) => typeof run.costCents === 'number')).toBe(true)
  })
})
