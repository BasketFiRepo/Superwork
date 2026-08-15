import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import { ledgerReport, listRunMessages, monthPeriod, spendSnapshot } from '@superwork/core'
import { generateBriefing } from '@superwork/agent'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Agent messages (ADR 0040).
 *
 * `agent_messages` was created in migration 0003 and never written to, so a run could say it
 * cost four cents and not which step, which model, or how long any of it took.
 *
 * Two writers already kept that number and they had drifted. Some model calls reached the
 * run's totals and never reached metering at all; and both run paths *also* wrote a
 * `unit = 'agent_run'` usage record carrying the run's whole cost on top of the per-call rows,
 * so month-to-date spend was counted roughly twice and the §19.2 cap tripped at about half the
 * real figure. The test that matters most here is the one that adds those up.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let runId: string

beforeAll(async () => {
  org = await createTenant('agent-messages')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }

  // A real model call through a real agent path, rather than a hand-written row: the point
  // is that the writers agree, and hand-writing both would prove nothing about them.
  await generateBriefing(session, org.ownerId, { kind: 'daily', force: true })

  const [run] = await adminSql()<{ id: string }[]>`
    SELECT id FROM agent_runs WHERE organization_id = ${org.organizationId} ORDER BY created_at DESC LIMIT 1`
  runId = run!.id
})

afterAll(async () => {
  await destroyTenant('agent-messages')
  await destroyTenant('agent-messages-b')
  await closePools()
})

describe('what the model was asked, and what it cost', () => {
  it('records the call with its model, tokens, latency and task class', async () => {
    await withTenant(session, async (ctx) => {
      const messages = await listRunMessages(ctx, runId)
      expect(messages).toHaveLength(1)
      const message = messages[0]!
      expect(message.taskClass).toBe('briefing.narrative')
      expect(message.model).not.toBeNull()
      expect(message.tokensIn).toBeGreaterThan(0)
      expect(message.tokensOut).toBeGreaterThan(0)
      expect(message.latencyMs).not.toBeNull()
      expect(message.content.length).toBeGreaterThan(0)
      // The demo runs on the deterministic mock, and every screen badges that (§5.12).
      expect(message.simulated).toBe(true)
    })
  })

  it('makes the run’s totals the sum of its messages, kept by the database', async () => {
    const [run] = await adminSql()<{ tokensIn: number; tokensOut: number; cost: number }[]>`
      SELECT tokens_in AS "tokensIn", tokens_out AS "tokensOut", cost_cents::float8 AS cost
      FROM agent_runs WHERE id = ${runId}`
    const [sum] = await adminSql()<{ tokensIn: string; tokensOut: string; cost: string }[]>`
      SELECT sum(tokens_in)::text AS "tokensIn", sum(tokens_out)::text AS "tokensOut",
             sum(cost_cents)::text AS cost
      FROM agent_messages WHERE run_id = ${runId} AND deleted_at IS NULL`

    expect(run!.tokensIn).toBe(Number(sum!.tokensIn))
    expect(run!.tokensOut).toBe(Number(sum!.tokensOut))
    expect(run!.cost).toBeCloseTo(Number(sum!.cost), 4)
    expect(run!.tokensIn).toBeGreaterThan(0)
  })

  it('recomputes rather than increments, so a corrected message leaves the total right', async () => {
    await adminSql()`
      INSERT INTO agent_messages (organization_id, run_id, role, content, task_class, model,
                                  tokens_in, tokens_out, cost_cents, latency_ms, is_demo, created_by)
      VALUES (${org.organizationId}, ${runId}, 'assistant', 'A second call.', 'agent.answer',
              'mock', 100, 20, 0.5, 30, true, ${org.ownerId})`

    const [added] = await adminSql()<{ cost: number; tokensIn: number }[]>`
      SELECT cost_cents::float8 AS cost, tokens_in AS "tokensIn" FROM agent_runs WHERE id = ${runId}`
    expect(added!.tokensIn).toBeGreaterThan(100)

    await adminSql()`
      DELETE FROM agent_messages WHERE run_id = ${runId} AND content = 'A second call.'`

    const [restored] = await adminSql()<{ cost: number }[]>`
      SELECT cost_cents::float8 AS cost FROM agent_runs WHERE id = ${runId}`
    expect(restored!.cost).toBeCloseTo(added!.cost - 0.5, 4)
  })
})

describe('the spend is counted once', () => {
  it('meters exactly what the model calls cost, and no run-level copy of it', async () => {
    const [metered] = await adminSql()<{ total: string; runRows: string; runCost: string }[]>`
      SELECT coalesce(sum(cost_cents), 0)::text AS total,
             count(*) FILTER (WHERE unit = 'agent_run')::text AS "runRows",
             coalesce(sum(cost_cents) FILTER (WHERE unit = 'agent_run'), 0)::text AS "runCost"
      FROM usage_records WHERE organization_id = ${org.organizationId} AND agent_run_id = ${runId}`
    const [messages] = await adminSql()<{ cost: string }[]>`
      SELECT coalesce(sum(cost_cents), 0)::text AS cost
      FROM agent_messages WHERE run_id = ${runId} AND deleted_at IS NULL`

    // The regression: metered spend used to be the per-call rows *plus* a row carrying the
    // whole run again. It is now exactly the model calls.
    expect(Number(metered!.total)).toBeCloseTo(Number(messages!.cost), 4)
    // A run-level row may still exist to count the run; it must not carry the cost twice.
    expect(Number(metered!.runCost)).toBe(0)
  })

  it('so month-to-date spend is what the model calls actually came to', async () => {
    await withTenant(session, async (ctx) => {
      const snapshot = await spendSnapshot(ctx)
      const [messages] = await ctx.sql<{ cost: string }[]>`
        SELECT coalesce(sum(m.cost_cents), 0)::text AS cost
        FROM agent_messages m
        WHERE m.organization_id = ${ctx.organizationId} AND m.deleted_at IS NULL
          AND m.created_at >= date_trunc('month', now())`
      expect(snapshot.monthToDateCents).toBeCloseTo(Number(messages!.cost), 4)
      expect(snapshot.monthToDateCents).toBeGreaterThan(0)
    })
  })
})

describe('the ledger can finally say where the spend went', () => {
  it('breaks it down by model and by the kind of call, from the same rows', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const report = await ledgerReport(ctx, actor, monthPeriod(new Date(), TZ))

      expect(report.models.length).toBeGreaterThan(0)
      const narrative = report.models.find((row) => row.taskClass === 'briefing.narrative')
      expect(narrative).toBeDefined()
      expect(narrative!.calls).toBeGreaterThan(0)
      expect(narrative!.simulated).toBe(true)

      const fromModels = report.models.reduce((total, row) => total + row.costCents, 0)
      const [sum] = await ctx.sql<{ cost: string }[]>`
        SELECT coalesce(sum(cost_cents), 0)::text AS cost FROM agent_messages
        WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
          AND created_at >= date_trunc('month', now())`
      expect(fromModels).toBeCloseTo(Number(sum!.cost), 4)
    })
  })
})

describe('the row is bounded by the tenant and by its own shape', () => {
  it('refuses a message whose run belongs to another organization', async () => {
    const other = await createTenant('agent-messages-b')
    await expect(
      adminSql()`
        INSERT INTO agent_messages (organization_id, run_id, role, content, is_demo, created_by)
        VALUES (${org.organizationId}, ${other.runId}, 'assistant', 'Not yours.', true, ${org.ownerId})`,
    ).rejects.toThrow(/same organization/)
  })

  it('refuses a role it does not know, an empty body, and a negative cost', async () => {
    await expect(
      adminSql()`
        INSERT INTO agent_messages (organization_id, run_id, role, content, is_demo, created_by)
        VALUES (${org.organizationId}, ${runId}, 'oracle', 'Hello.', true, ${org.ownerId})`,
    ).rejects.toThrow(/agent_messages_role_known/)

    await expect(
      adminSql()`
        INSERT INTO agent_messages (organization_id, run_id, role, content, is_demo, created_by)
        VALUES (${org.organizationId}, ${runId}, 'assistant', '   ', true, ${org.ownerId})`,
    ).rejects.toThrow(/agent_messages_content_present/)

    await expect(
      adminSql()`
        INSERT INTO agent_messages (organization_id, run_id, role, content, cost_cents, is_demo, created_by)
        VALUES (${org.organizationId}, ${runId}, 'assistant', 'Cheap.', -1, true, ${org.ownerId})`,
    ).rejects.toThrow(/agent_messages_counts_sane/)
  })
})
