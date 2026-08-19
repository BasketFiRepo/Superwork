import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import { compileWorkflow } from '@superwork/ai'
import { activateWorkflow, listWorkflowRuns, saveCompiled } from '@superwork/core'
import { runWorkflow, simulateWorkflow } from '@superwork/agent'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Why a step stopped (ADR 0053).
 *
 * `workflow_step_runs.error` is selected by `listWorkflowRuns` straight into the run detail
 * screen and no code path had ever written it. The larger half of the same problem: the
 * executor's `try` sat outside the node loop, so a node that threw left **no row at all** — the
 * step list ended at the last thing that worked, the run said it failed, and nothing said which
 * step was the one.
 *
 * The failing step is made to fail for real: the stored graph's query node is pointed at an
 * aggregate that does not exist, which is what `runAggregate` refuses. Nothing here asserts
 * against a fake thrown error.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let workflowId: string

beforeAll(async () => {
  org = await createTenant('workflow-step-errors')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }

  await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const compiled = compileWorkflow(
      'Every weekday at 9, find customer threads with no reply for 3 days and draft a follow-up, and tell the account owner.',
    )
    const workflow = await saveCompiled(ctx, actor, { description: 'The step error workflow', compiled })
    workflowId = workflow.id
  })
})

afterAll(async () => {
  await destroyTenant('workflow-step-errors')
  await closePools()
})

/** The aggregate the compiled graph really asked for, so mending it puts back what was there. */
let originalQueryRef = ''

/** Points the stored graph's query node at an aggregate the product does not have. */
async function breakTheQueryNode(): Promise<void> {
  if (!originalQueryRef) {
    const [row] = await adminSql()<{ ref: string }[]>`
      SELECT node->>'ref' AS ref
      FROM workflow_versions v, jsonb_array_elements(v.graph->'nodes') AS node
      WHERE v.organization_id = ${org.organizationId} AND v.workflow_id = ${workflowId}
        AND node->>'type' = 'query'
      LIMIT 1`
    originalQueryRef = row!.ref
  }
  await adminSql()`
    UPDATE workflow_versions
    SET graph = jsonb_set(
          graph,
          '{nodes}',
          (
            SELECT jsonb_agg(
              CASE WHEN node->>'type' = 'query'
                   THEN jsonb_set(node, '{ref}', '"an_aggregate_that_does_not_exist"'::jsonb)
                   ELSE node END
            )
            FROM jsonb_array_elements(graph->'nodes') AS node
          )
        )
    WHERE organization_id = ${org.organizationId}
      AND workflow_id = ${workflowId}`
}

async function mendTheQueryNode(): Promise<void> {
  await adminSql()`
    UPDATE workflow_versions
    SET graph = jsonb_set(
          graph,
          '{nodes}',
          (
            SELECT jsonb_agg(
              CASE WHEN node->>'type' = 'query'
                   THEN jsonb_set(node, '{ref}', to_jsonb(${originalQueryRef}::text))
                   ELSE node END
            )
            FROM jsonb_array_elements(graph->'nodes') AS node
          )
        )
    WHERE organization_id = ${org.organizationId}
      AND workflow_id = ${workflowId}`
}

describe('a step that stopped says so, in its own row', () => {
  it('writes a row for the node that threw, with the reason on it', async () => {
    await breakTheQueryNode()
    const outcome = await simulateWorkflow(session, { workflowId })
    expect(outcome.status).toBe('failed')

    // The step list used to end at the trigger. It now carries the node that broke.
    const failed = outcome.steps.filter((step) => step.status === 'failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]!.nodeType).toBe('query')
    expect(failed[0]!.error).toMatch(/an_aggregate_that_does_not_exist/)

    const rows = await adminSql()<
      { status: string; nodeType: string; error: string | null; durationMs: number | null }[]
    >`
      SELECT status, node_type AS "nodeType", error, duration_ms AS "durationMs"
      FROM workflow_step_runs
      WHERE organization_id = ${org.organizationId} AND workflow_run_id = ${outcome.runId}
      ORDER BY ordinal`
    // The trigger succeeded and the query failed, and both are on the record.
    expect(rows.map((row) => row.status)).toEqual(['succeeded', 'failed'])
    expect(rows[1]!.error).toContain('an_aggregate_that_does_not_exist')
    expect(rows[1]!.durationMs).not.toBeNull()
    expect(rows[1]!.durationMs!).toBeGreaterThanOrEqual(0)

    await mendTheQueryNode()
  })

  it('reaches the screen through the same reader the run detail uses', async () => {
    await breakTheQueryNode()
    const outcome = await simulateWorkflow(session, { workflowId })
    expect(outcome.status).toBe('failed')

    const [run] = await withTenant(session, async (ctx) =>
      listWorkflowRuns(ctx, await loadActor(ctx), { workflowId, limit: 1 }),
    )
    expect(run!.id).toBe(outcome.runId)
    const step = run!.steps.find((row) => row.status === 'failed')
    expect(step).toBeDefined()
    expect(step!.error).toContain('an_aggregate_that_does_not_exist')
    // And the step that was fine carries no reason, so the screen shows one failure not two.
    expect(run!.steps.filter((row) => row.error !== null)).toHaveLength(1)

    await mendTheQueryNode()
  })

  it('takes the failure class from the error rather than calling everything a tool', async () => {
    await breakTheQueryNode()
    const outcome = await simulateWorkflow(session, { workflowId })
    // `runAggregate` refuses an unknown aggregate with a ValidationError, and that class is
    // what the run records. It used to record 'tool' — a value not even in the taxonomy.
    expect(outcome.failureClass).toBe('validation')

    const [agentRun] = await adminSql()<{ failureClass: string | null; failureDetail: string | null }[]>`
      SELECT failure_class AS "failureClass", failure_detail AS "failureDetail"
      FROM agent_runs
      WHERE organization_id = ${org.organizationId} AND id = ANY(
        SELECT unnest(agent_run_ids) FROM workflow_runs WHERE id = ${outcome.runId})`
    if (agentRun) {
      expect(agentRun.failureClass).toBe('validation')
      expect(agentRun.failureDetail).toContain('an_aggregate_that_does_not_exist')
    }

    await mendTheQueryNode()
  })

  it('records how long each step took, on a run that works', async () => {
    const outcome = await simulateWorkflow(session, { workflowId })
    expect(outcome.status).not.toBe('failed')

    const rows = await adminSql()<{ status: string; durationMs: number | null; error: string | null }[]>`
      SELECT status, duration_ms AS "durationMs", error FROM workflow_step_runs
      WHERE organization_id = ${org.organizationId} AND workflow_run_id = ${outcome.runId}
      ORDER BY ordinal`
    expect(rows.length).toBeGreaterThan(1)
    // Every step timed, and not one of them carrying a reason it did not need.
    expect(rows.every((row) => row.durationMs !== null)).toBe(true)
    expect(rows.every((row) => row.error === null)).toBe(true)
  })
})

describe('the database will not store a failure that does not say why', () => {
  it('refuses a failed step with no reason', async () => {
    const [run] = await adminSql()<{ id: string }[]>`
      SELECT id FROM workflow_runs WHERE organization_id = ${org.organizationId} LIMIT 1`
    await expect(
      adminSql()`
        INSERT INTO workflow_step_runs (
          organization_id, workflow_run_id, node_id, node_type, ordinal, status, created_by
        ) VALUES (
          ${org.organizationId}, ${run!.id}, 'n1', 'query', 99, 'failed', ${org.ownerId}
        )`,
    ).rejects.toThrow(/workflow_step_runs_failed_says_why/)
  })

  it('refuses a reason on a step that did not fail, which would read as a failure', async () => {
    const [run] = await adminSql()<{ id: string }[]>`
      SELECT id FROM workflow_runs WHERE organization_id = ${org.organizationId} LIMIT 1`
    await expect(
      adminSql()`
        INSERT INTO workflow_step_runs (
          organization_id, workflow_run_id, node_id, node_type, ordinal, status, error, created_by
        ) VALUES (
          ${org.organizationId}, ${run!.id}, 'n2', 'query', 98, 'succeeded', 'something went wrong',
          ${org.ownerId}
        )`,
    ).rejects.toThrow(/workflow_step_runs_failed_says_why/)
  })

  it('refuses a status the executor never writes, and a negative duration', async () => {
    const [run] = await adminSql()<{ id: string }[]>`
      SELECT id FROM workflow_runs WHERE organization_id = ${org.organizationId} LIMIT 1`
    await expect(
      adminSql()`
        INSERT INTO workflow_step_runs (
          organization_id, workflow_run_id, node_id, node_type, ordinal, status, created_by
        ) VALUES (${org.organizationId}, ${run!.id}, 'n3', 'query', 97, 'exploded', ${org.ownerId})`,
    ).rejects.toThrow(/workflow_step_runs_status_known/)

    await expect(
      adminSql()`
        INSERT INTO workflow_step_runs (
          organization_id, workflow_run_id, node_id, node_type, ordinal, status, duration_ms, created_by
        ) VALUES (${org.organizationId}, ${run!.id}, 'n4', 'query', 96, 'succeeded', -1, ${org.ownerId})`,
    ).rejects.toThrow(/workflow_step_runs_duration_sane/)
  })
})

describe('a real run, not only a dry one', () => {
  it('records the failing step when the workflow is running for real', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await activateWorkflow(ctx, actor, { workflowId, ownerUserId: org.ownerId })
    })
    await breakTheQueryNode()

    const outcome = await runWorkflow(session, { workflowId, trigger: 'manual' })
    expect(outcome.status).toBe('failed')
    expect(outcome.steps.some((step) => step.status === 'failed' && step.error)).toBe(true)

    const [row] = await adminSql()<{ error: string | null }[]>`
      SELECT error FROM workflow_step_runs
      WHERE organization_id = ${org.organizationId} AND workflow_run_id = ${outcome.runId}
        AND status = 'failed'`
    expect(row!.error).toContain('an_aggregate_that_does_not_exist')

    // And the run's own sentence still says what happened, which it always did.
    const [runRow] = await adminSql()<{ error: string | null; status: string }[]>`
      SELECT error, status::text AS status FROM workflow_runs
      WHERE organization_id = ${org.organizationId} AND id = ${outcome.runId}`
    expect(runRow!.status).toBe('failed')
    expect(runRow!.error).toContain('an_aggregate_that_does_not_exist')

    await mendTheQueryNode()
  })
})
