import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import {
  EVENT_NAMES,
  activateWorkflow,
  createTask,
  emitEvent,
  eventsSince,
  saveCompiled,
  unknownEventMessage,
} from '@superwork/core'
import { compileWorkflow } from '@superwork/ai'
import { causeDepth, dispatchEvents, subscriptions, MAX_EVENT_DEPTH } from '@superwork/agent'
import { loadActor } from '@superwork/auth'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * A workflow that runs when something happens (ADR 0090).
 *
 * `events` was created in migration 0005 with the comment "Workflow triggers and watchers read
 * from here", and `workflow_runs.trigger_payload`, `is_replay` and `run_depth` in 0007. Nothing
 * wrote or read any of them, so a workflow could run on a clock or when somebody pressed a button.
 *
 * The bug this pack holds shut is the silent one: `activateWorkflow` scheduled a workflow whose
 * trigger was a schedule and had **no else**, so an event-triggered workflow was set active,
 * published, audited as activated and shown on the screen as running — and nothing would ever
 * fire it. An automation that does nothing looks exactly like an automation with nothing to do.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }

beforeAll(async () => {
  org = await createTenant('event-triggered-workflows')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
})

afterAll(async () => {
  await destroyTenant('event-triggered-workflows')
  await closePools()
})

describe('the list of what can be subscribed to', () => {
  it('is the same list the database will accept', async () => {
    // Two places a fact lives — the constant the compiler and the activation gate read, and the
    // CHECK beside the rows. The same shape as the feature flags of ADR 0022, for the same reason:
    // a name in one and not the other is a subscription that is accepted and never delivered.
    const [row] = await adminSql()<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conname = 'events_name_known'`
    for (const name of EVENT_NAMES) {
      expect(row!.definition, `${name} is emitted but the table would refuse it`).toContain(name)
    }
  })

  it('refuses to record a name nothing raises', async () => {
    await expect(
      adminSql()`
        INSERT INTO events (organization_id, name, entity_type, created_by)
        VALUES (${org.organizationId}, 'contract.signed', 'company', ${org.ownerId})`,
    ).rejects.toThrow(/events_name_known/)
  })
})

describe('the compiler', () => {
  it('builds an event trigger from a sentence somebody would write', () => {
    const compiled = compileWorkflow(
      'When an email arrives, find customer threads that have gone quiet and draft a reply',
    )
    expect(compiled.unsupported).toBeNull()
    expect(compiled.graph.trigger.kind).toBe('event')
    expect(compiled.graph.trigger.spec).toBe('message.received')
  })

  it('says out loud that an event trigger runs once per event', () => {
    const compiled = compileWorkflow('When an email arrives, find threads that have gone quiet and create a task')
    expect(compiled.risks.some((risk) => /once every time/.test(risk.message))).toBe(true)
  })

  it('refuses a moment the product cannot hear, rather than quietly compiling a button', () => {
    // The worst available outcome: somebody asks for an automation and is handed something that
    // only runs when they run it, with nothing on the screen saying so.
    const compiled = compileWorkflow(
      'When a contract is signed, find overdue tasks and create a task for the owner',
    )
    expect(compiled.unsupported).toMatch(/could not tell which moment you meant/)
    expect(compiled.unsupported).toMatch(/message.received/)
  })

  it('lets a schedule win when a sentence somehow says both', () => {
    // "every morning" is a rate the author chose. Honouring the event would run it far more often.
    const compiled = compileWorkflow(
      'Every morning, when an email arrives, find threads that have gone quiet and create a task',
    )
    expect(compiled.graph.trigger.kind).toBe('schedule')
  })
})

describe('activation', () => {
  const build = async (description: string) =>
    withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      return saveCompiled(ctx, actor, { description, compiled: compileWorkflow(description) })
    })

  it('refuses a trigger nothing will ever fire, naming the way out', async () => {
    const workflow = await build('When an email arrives, find threads that have gone quiet and create a task')

    // Rewritten under the workflow's feet to a name nothing raises — which is what a live
    // compiler, or a hand-edited graph, can produce and the mock one cannot.
    await adminSql()`
      UPDATE workflow_versions
      SET graph = jsonb_set(graph, '{trigger,spec}', '"contract.signed"')
      WHERE organization_id = ${org.organizationId} AND workflow_id = ${workflow.id}`
    // Past the dry-run gate, which is the earlier and more fundamental refusal: this test is
    // about the one after it, and a fixture that never reaches it proves nothing.
    const [version] = await adminSql()<{ id: string }[]>`
      SELECT id FROM workflow_versions
      WHERE organization_id = ${org.organizationId} AND workflow_id = ${workflow.id}
      ORDER BY ordinal DESC LIMIT 1`
    const [simulation] = await adminSql()<{ id: string }[]>`
      INSERT INTO workflow_runs (organization_id, workflow_id, workflow_version_id, status, trigger,
                                 simulated, idempotency_key, created_by)
      VALUES (${org.organizationId}, ${workflow.id}, ${version!.id}, 'succeeded', 'simulation', true,
              ${'sim-' + Math.random()}, ${org.ownerId})
      RETURNING id`
    await adminSql()`
      UPDATE workflows SET simulated_ok = true, last_simulation_id = ${simulation!.id}
      WHERE organization_id = ${org.organizationId} AND id = ${workflow.id}`

    await expect(
      withTenant(session, async (ctx) =>
        activateWorkflow(ctx, await loadActor(ctx), { workflowId: workflow.id }),
      ),
    ).rejects.toThrow(/active and silent forever/)
  })

  it('names both ways out rather than just refusing', () => {
    const message = unknownEventMessage('contract.signed')
    expect(message).toContain('message.received')
    expect(message).toMatch(/raise "contract.signed" from the code where it happens/)
  })
})

describe('what arrival raises', () => {
  it('records a task being opened, with enough to act on without loading the row', async () => {
    const before = new Date(Date.now() - 60_000)
    const task = await withTenant(session, async (ctx) =>
      createTask(ctx, await loadActor(ctx), { title: 'Chase the Halden consignment' }),
    )
    const events = await withTenant(session, (ctx) => eventsSince(ctx, 'task.created', before))
    const raised = events.find((event) => event.entityId === task.id)
    expect(raised, 'creating a task must be something an automation can be told about').toBeDefined()
    expect(raised!.payload['title']).toBe('Chase the Halden consignment')
  })

  it('marks it with the trace of whatever caused it', async () => {
    // The load-bearing part. A workflow run opens a trace and carries it into everything it does,
    // so an event raised by a run already says which run raised it — which is how depth is derived
    // rather than threaded through the tool layer.
    const before = new Date(Date.now() - 60_000)
    await withTenant({ ...session, traceId: 'trace-for-the-depth-test' }, async (ctx) =>
      createTask(ctx, await loadActor(ctx), { title: 'Raised inside a known trace' }),
    )
    const events = await withTenant(session, (ctx) => eventsSince(ctx, 'task.created', before))
    expect(events.some((event) => event.traceId === 'trace-for-the-depth-test')).toBe(true)
  })
})

describe('the depth guard', () => {
  it('reads zero for something a person did', async () => {
    const depth = await withTenant(session, (ctx) => causeDepth(ctx, 'a-trace-no-run-owns'))
    expect(depth).toBe(0)
  })

  it('reads zero for an event with no trace at all', async () => {
    const depth = await withTenant(session, (ctx) => causeDepth(ctx, null))
    expect(depth).toBe(0)
  })

  it('counts one link deeper than the run that caused it', async () => {
    // The hazard is not hypothetical: `create_task@v1` is one of the two actions the compiler can
    // emit and `task.created` is one of the three events it can subscribe to, so one sentence can
    // build a workflow that triggers itself.
    const version = await aVersion()
    const [run] = await adminSql()<{ id: string }[]>`
      INSERT INTO agent_runs (organization_id, principal_user_id, mode, request, trigger, trace_id, created_by)
      VALUES (${org.organizationId}, ${org.ownerId}, 'execute', 'Depth fixture', 'workflow',
              'trace-of-a-workflow-run', ${org.ownerId})
      RETURNING id`
    await adminSql()`
      INSERT INTO workflow_runs (organization_id, workflow_id, workflow_version_id, status, trigger,
                                 run_depth, agent_run_ids, idempotency_key, created_by)
      SELECT ${org.organizationId}, workflow_id, id, 'succeeded', 'event', 1,
             ARRAY[${run!.id}::uuid], ${'depth-fixture-' + Date.now()}, ${org.ownerId}
      FROM workflow_versions WHERE id = ${version.id}`

    const depth = await withTenant(session, (ctx) => causeDepth(ctx, 'trace-of-a-workflow-run'))
    expect(depth).toBe(2)
    expect(MAX_EVENT_DEPTH).toBeGreaterThan(0)
  })
})

describe('what the database refuses to store', () => {
  it('a payload on a run nothing caused', async () => {
    // A manual run has no event behind it, so a payload against one is a fact with no source —
    // the same pairing the scan counts have with `sanitized_at` (ADR 0089).
    const run = await aManualRun()
    await expect(
      adminSql()`
        UPDATE workflow_runs SET trigger_payload = '{"event":"task.created"}'::jsonb
        WHERE organization_id = ${org.organizationId} AND id = ${run}`,
    ).rejects.toThrow(/workflow_runs_payload_needs_a_cause/)
  })

  it('a depth on a run nothing caused', async () => {
    const run = await aManualRun()
    await expect(
      adminSql()`
        UPDATE workflow_runs SET run_depth = 2
        WHERE organization_id = ${org.organizationId} AND id = ${run}`,
    ).rejects.toThrow(/workflow_runs_depth_needs_a_cause/)
  })

  it('a replay of nothing', async () => {
    const run = await aManualRun()
    await expect(
      adminSql()`
        UPDATE workflow_runs SET is_replay = true
        WHERE organization_id = ${org.organizationId} AND id = ${run}`,
    ).rejects.toThrow(/workflow_runs_replay_needs_an_event/)
  })
})

describe('the dispatcher', () => {
  it('finds nothing to do when nothing subscribes, and says so without running anything', async () => {
    const outcome = await dispatchEvents(session)
    expect(outcome.ran).toBe(0)
    expect(outcome.failed).toBe(0)
  })

  it('matches an active workflow to the event it named', async () => {
    const description = 'When an email arrives, find customer threads that have gone quiet and create a task'
    const workflow = await withTenant(session, async (ctx) =>
      saveCompiled(ctx, await loadActor(ctx), { description, compiled: compileWorkflow(description) }),
    )
    await adminSql()`
      UPDATE workflows SET status = 'active' WHERE organization_id = ${org.organizationId} AND id = ${workflow.id}`

    const found = await withTenant(session, (ctx) => subscriptions(ctx, 'message.received'))
    expect(found.map((row) => row.workflowId)).toContain(workflow.id)

    // And is not offered events it did not ask for.
    const others = await withTenant(session, (ctx) => subscriptions(ctx, 'approval.decided'))
    expect(others.map((row) => row.workflowId)).not.toContain(workflow.id)
  })

  it('runs a subscribed workflow once for an event, and never twice', async () => {
    const [conversation] = await adminSql()<{ id: string }[]>`
      INSERT INTO conversations (organization_id, subject, channel, created_by)
      VALUES (${org.organizationId}, 'Consignment 2026-014', 'email', ${org.ownerId}) RETURNING id`
    const [message] = await adminSql()<{ id: string }[]>`
      INSERT INTO messages (organization_id, conversation_id, direction, from_address, to_addresses,
                            sent_at, body_text, trust_level, created_by)
      VALUES (${org.organizationId}, ${conversation!.id}, 'inbound', 'ingrid@halden.example',
              ${['ops@northwind.example']}, now(), 'Any news?', 'untrusted_external', ${org.ownerId})
      RETURNING id`
    const eventId = await withTenant(session, (ctx) =>
      emitEvent(ctx, {
        name: 'message.received',
        entityType: 'message',
        entityId: message!.id,
        payload: { from: 'ingrid@halden.example' },
        actorType: 'integration',
      }),
    )

    const first = await dispatchEvents(session)
    expect(first.matched).toBeGreaterThan(0)

    const [run] = await adminSql()<{ trigger: string; trigger_payload: Record<string, unknown>; run_depth: number }[]>`
      SELECT trigger, trigger_payload, run_depth FROM workflow_runs
      WHERE organization_id = ${org.organizationId} AND trigger = 'event'
        AND idempotency_key NOT LIKE 'depth-fixture%'
      ORDER BY created_at DESC LIMIT 1`
    expect(run!.trigger).toBe('event')
    // Why this run happened, answerable from the run alone — which is the question the audit
    // review asks and `trigger_payload` was declared in 0007 to answer.
    expect(run!.trigger_payload['event']).toBe('message.received')
    expect(run!.trigger_payload['eventId']).toBe(eventId)
    expect(run!.trigger_payload['entityId']).toBe(message!.id)
    expect(run!.run_depth).toBe(0)

    // The second sweep is the property that makes a cursor unnecessary: the run's idempotency key
    // against a unique index is the dispatch record, so re-examining an event costs a lookup.
    const second = await dispatchEvents(session)
    expect(second.matched, 'an event already dispatched must not be dispatched again').toBe(0)
    expect(second.alreadyRun).toBeGreaterThan(0)
  })
})

/** A published version to hang a fixture run off, independent of what other tests have built. */
async function aVersion(): Promise<{ id: string; workflowId: string }> {
  const [workflow] = await adminSql()<{ id: string }[]>`
    INSERT INTO workflows (organization_id, name, status, created_by)
    VALUES (${org.organizationId}, 'Fixture workflow', 'draft', ${org.ownerId}) RETURNING id`
  const [version] = await adminSql()<{ id: string }[]>`
    INSERT INTO workflow_versions (organization_id, workflow_id, ordinal, graph, created_by)
    VALUES (${org.organizationId}, ${workflow!.id}, 1, '{"trigger":{"kind":"manual"},"nodes":[]}'::jsonb,
            ${org.ownerId})
    RETURNING id`
  return { id: version!.id, workflowId: workflow!.id }
}

/** A run nothing caused — the state the three constraints below are about. */
async function aManualRun(): Promise<string> {
  const version = await aVersion()
  const [run] = await adminSql()<{ id: string }[]>`
    INSERT INTO workflow_runs (organization_id, workflow_id, workflow_version_id, status, trigger,
                               idempotency_key, created_by)
    VALUES (${org.organizationId}, ${version.workflowId}, ${version.id}, 'succeeded', 'manual',
            ${'manual-fixture-' + Math.random()}, ${org.ownerId})
    RETURNING id`
  return run!.id
}
