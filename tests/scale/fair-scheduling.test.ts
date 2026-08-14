import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import { claimNextRun, enqueueRun, queueSnapshot, queueWaitPercentiles, setQuota } from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Phase 4's second acceptance criterion (§24): "no department can starve another's agent
 * runs."
 *
 * The test that matters is the one that fails under first-come-first-served: one
 * department queues a bulk job of two hundred runs, another queues five a moment later,
 * and the second must not wait for the first to finish.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
const departments: Record<string, string> = {}

const BULK = 200
const SMALL = 5

async function enqueue(departmentId: string, count: number, queueClass: 'interactive' | 'bulk' = 'interactive') {
  const ids: string[] = []
  await withTenant(session, async (ctx) => {
    for (let index = 0; index < count; index += 1) {
      const [run] = await ctx.sql<{ id: string }[]>`
        INSERT INTO agent_runs (organization_id, principal_user_id, mode, status, request, trace_id, is_demo, created_by)
        VALUES (${ctx.organizationId}, ${org.ownerId}, 'ask', 'queued', ${`run ${index}`},
                ${`trace-${departmentId.slice(0, 8)}-${queueClass}-${index}`}, true, ${org.ownerId})
        RETURNING id`
      await enqueueRun(ctx, { runId: run!.id, departmentId, queueClass })
      ids.push(run!.id)
    }
  })
  return ids
}

/** Claims `count` runs and reports which department each came from. */
async function drain(count: number): Promise<string[]> {
  const served: string[] = []
  await withTenant(session, async (ctx) => {
    for (let index = 0; index < count; index += 1) {
      const claimed = await claimNextRun(ctx, 'test-worker', { maxConcurrentPerDepartment: 1000 })
      if (!claimed) break
      served.push(claimed.departmentId ?? 'none')
      // The scheduler counts what is *running*; finishing keeps the concurrency cap out
      // of the way so this test measures ordering rather than admission.
      await ctx.sql`
        UPDATE agent_runs SET status = 'succeeded' WHERE organization_id = ${ctx.organizationId} AND id = ${claimed.runId}`
    }
  })
  return served
}

beforeAll(async () => {
  org = await createTenant('scheduling')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }

  await withTenant(session, async (ctx) => {
    for (const name of ['Operations', 'Finance', 'Commercial']) {
      const [row] = await ctx.sql<{ id: string }[]>`
        INSERT INTO departments (organization_id, name, path, is_demo, created_by)
        VALUES (${ctx.organizationId}, ${name}, ${name.toLowerCase()}, true, ${org.ownerId})
        RETURNING id`
      departments[name] = row!.id
    }
    await ctx.sql`
      DELETE FROM agent_runs WHERE organization_id = ${ctx.organizationId} AND id = ${org.runId}`
  })
})

afterAll(async () => {
  await destroyTenant(org.organizationId)
  await closePools()
})

describe('fair-share scheduling', () => {
  it('does not make a small department wait behind a bulk job', async () => {
    await enqueue(departments['Operations']!, BULK, 'bulk')
    await enqueue(departments['Finance']!, SMALL)

    const served = await drain(20)
    const financePositions = served
      .map((department, index) => ({ department, index }))
      .filter((entry) => entry.department === departments['Finance'])
      .map((entry) => entry.index)

    // Under first-come-first-served, Finance would be at positions 200–204.
    expect(financePositions).toHaveLength(SMALL)
    expect(Math.max(...financePositions)).toBeLessThan(12)
    // Its first run goes almost immediately: interactive beats bulk of the same weight.
    expect(financePositions[0]).toBeLessThanOrEqual(1)
  })

  it('splits the queue in proportion to weight when everybody is busy', async () => {
    await withTenant(session, async (ctx) => {
      await ctx.sql`DELETE FROM agent_runs WHERE organization_id = ${ctx.organizationId}`
      await ctx.sql`UPDATE department_quotas SET deficit = 0 WHERE organization_id = ${ctx.organizationId}`
      const actor = await loadActor(ctx, org.ownerId)
      await setQuota(ctx, actor, {
        departmentId: departments['Operations']!,
        weight: 3,
        maxConcurrent: 100,
        runsPerHour: 10_000,
      })
      await setQuota(ctx, actor, {
        departmentId: departments['Finance']!,
        weight: 1,
        maxConcurrent: 100,
        runsPerHour: 10_000,
      })
    })

    await enqueue(departments['Operations']!, 60)
    await enqueue(departments['Finance']!, 60)

    const served = await drain(40)
    const operations = served.filter((id) => id === departments['Operations']).length
    const finance = served.filter((id) => id === departments['Finance']).length

    // 3:1 with rounding slack. What matters is that neither is zero and the heavier
    // department does get more.
    expect(finance).toBeGreaterThan(0)
    expect(operations).toBeGreaterThan(finance)
    expect(operations / finance).toBeGreaterThan(1.8)
    expect(operations / finance).toBeLessThan(4.5)
  })

  it('holds a department at its concurrency cap without blocking the others', async () => {
    await withTenant(session, async (ctx) => {
      await ctx.sql`DELETE FROM agent_runs WHERE organization_id = ${ctx.organizationId}`
      await ctx.sql`UPDATE department_quotas SET deficit = 0 WHERE organization_id = ${ctx.organizationId}`
      const actor = await loadActor(ctx, org.ownerId)
      await setQuota(ctx, actor, { departmentId: departments['Operations']!, weight: 1, maxConcurrent: 2, runsPerHour: 10_000 })
      await setQuota(ctx, actor, { departmentId: departments['Commercial']!, weight: 1, maxConcurrent: 10, runsPerHour: 10_000 })
    })

    await enqueue(departments['Operations']!, 10)
    await enqueue(departments['Commercial']!, 10)

    // Claim without finishing anything: Operations fills its two slots and stops there.
    const served: string[] = []
    await withTenant(session, async (ctx) => {
      for (let index = 0; index < 8; index += 1) {
        const claimed = await claimNextRun(ctx, 'test-worker')
        if (!claimed) break
        served.push(claimed.departmentId ?? 'none')
      }
    })

    const operations = served.filter((id) => id === departments['Operations']).length
    const commercial = served.filter((id) => id === departments['Commercial']).length
    expect(operations).toBe(2)
    expect(commercial).toBeGreaterThanOrEqual(4)
  })

  it('reports the queue and the wait it is producing', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx, org.ownerId)
      const snapshot = await queueSnapshot(ctx, actor)
      expect(snapshot.length).toBeGreaterThanOrEqual(3)
      expect(snapshot.some((row) => row.queued > 0 || row.running > 0)).toBe(true)

      const waits = await queueWaitPercentiles(ctx)
      expect(waits.samples).toBeGreaterThan(0)
      // §26.9: interactive queue wait p95 < 2s. Nothing is contending here, so this is a
      // floor check on the measurement rather than a load result.
      expect(waits.p95Ms).toBeLessThan(2000)
    })
  })

  it('never hands the same run to two workers', async () => {
    await withTenant(session, async (ctx) => {
      await ctx.sql`DELETE FROM agent_runs WHERE organization_id = ${ctx.organizationId}`
    })
    await enqueue(departments['Operations']!, 12)

    // Two schedulers racing over the same queue.
    const [first, second] = await Promise.all([
      withTenant(session, async (ctx) => {
        const ids: string[] = []
        for (let index = 0; index < 6; index += 1) {
          const claimed = await claimNextRun(ctx, 'worker-a', { maxConcurrentPerDepartment: 1000 })
          if (claimed) ids.push(claimed.runId)
        }
        return ids
      }),
      withTenant(session, async (ctx) => {
        const ids: string[] = []
        for (let index = 0; index < 6; index += 1) {
          const claimed = await claimNextRun(ctx, 'worker-b', { maxConcurrentPerDepartment: 1000 })
          if (claimed) ids.push(claimed.runId)
        }
        return ids
      }),
    ])

    const all = [...first, ...second]
    expect(new Set(all).size).toBe(all.length)
  })
})
