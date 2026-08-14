import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import { compileWorkflow } from '@superwork/ai'
import {
  activateWorkflow,
  claimDueSchedules,
  describeCron,
  getWorkflow,
  nextOccurrence,
  occurrencesBetween,
  parseCron,
  saveCompiled,
  scheduleFor,
  setWorkflowStatus,
} from '@superwork/core'
import { runDueWorkflows, simulateWorkflow } from '@superwork/agent'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Scheduled workflows (§10.2, §2.4).
 *
 * The properties worth asserting are the ones a schedule gets wrong quietly: a cron
 * evaluated in the wrong timezone, a firing lost or doubled on the morning the clocks
 * change, a worker that was down overnight waking up and firing twelve hours at somebody,
 * two workers both deciding it is their turn, and an automation that stopped firing without
 * saying so.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }

beforeAll(async () => {
  org = await createTenant('wfsched')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
})

afterAll(async () => {
  await destroyTenant('wfsched')
  await closePools()
})

describe('cron, in a timezone', () => {
  it('parses the grammar it claims to support and rejects the rest', () => {
    expect(parseCron('0 9 * * 1-5')).not.toBeNull()
    expect(parseCron('*/15 * * * *')).not.toBeNull()
    expect(parseCron('0 9 * *')).toBeNull()
    expect(parseCron('0 99 * * *')).toBeNull()
    expect(parseCron('nonsense')).toBeNull()
  })

  it('fires at nine where the company is, not nine UTC', () => {
    // 1 July: London is BST (UTC+1), so 09:00 local is 08:00 UTC.
    const summer = nextOccurrence('0 9 * * *', 'Europe/London', new Date('2026-07-01T00:00:00Z'))
    expect(summer?.toISOString()).toBe('2026-07-01T08:00:00.000Z')

    // 1 December: GMT, so 09:00 local is 09:00 UTC.
    const winter = nextOccurrence('0 9 * * *', 'Europe/London', new Date('2026-12-01T00:00:00Z'))
    expect(winter?.toISOString()).toBe('2026-12-01T09:00:00.000Z')
  })

  it('fires once a day across the clock change, not twice and not never', () => {
    // The UK clocks go back on 25 October 2026 and forward on 29 March 2026.
    const autumn = occurrencesBetween(
      '0 9 * * *',
      'Europe/London',
      new Date('2026-10-23T00:00:00Z'),
      new Date('2026-10-28T00:00:00Z'),
    )
    expect(autumn).toHaveLength(5)
    const spring = occurrencesBetween(
      '0 9 * * *',
      'Europe/London',
      new Date('2026-03-27T00:00:00Z'),
      new Date('2026-04-01T00:00:00Z'),
    )
    expect(spring).toHaveLength(5)
  })

  it('skips the weekend for a weekday schedule', () => {
    // 2026-08-14 is a Friday; the next weekday firing is Monday the 17th.
    const next = nextOccurrence('0 9 * * 1-5', 'Europe/London', new Date('2026-08-14T09:00:00Z'))
    expect(next?.toISOString().slice(0, 10)).toBe('2026-08-17')
  })

  it('describes itself in words, because a cron string is not an explanation', () => {
    expect(describeCron('0 9 * * 1-5', 'Europe/London')).toBe('every weekday at 09:00 Europe/London')
    expect(describeCron('30 6 * * *', 'UTC')).toBe('every day at 06:30 UTC')
  })
})

describe('the schedule of a workflow', () => {
  async function activated(sentence: string): Promise<string> {
    const workflowId = await withTenant(session, async (ctx) => {
      const saved = await saveCompiled(ctx, await loadActor(ctx), {
        description: sentence,
        compiled: compileWorkflow(sentence),
      })
      return saved.id
    })
    await simulateWorkflow(session, { workflowId, windowDays: 7 })
    await withTenant(session, async (ctx) =>
      activateWorkflow(ctx, await loadActor(ctx), { workflowId, ownerUserId: org.ownerId }),
    )
    return workflowId
  }

  it('starts firing only when it is activated', async () => {
    const sentence = 'Every weekday at 9, find overdue tasks and create a task.'
    const workflowId = await withTenant(session, async (ctx) => {
      const saved = await saveCompiled(ctx, await loadActor(ctx), {
        description: sentence,
        compiled: compileWorkflow(sentence),
      })
      return saved.id
    })
    expect(await withTenant(session, (ctx) => scheduleFor(ctx, 'workflow', workflowId))).toBeNull()

    await simulateWorkflow(session, { workflowId, windowDays: 7 })
    await withTenant(session, async (ctx) =>
      activateWorkflow(ctx, await loadActor(ctx), { workflowId, ownerUserId: org.ownerId }),
    )

    const schedule = await withTenant(session, (ctx) => scheduleFor(ctx, 'workflow', workflowId))
    expect(schedule?.cron).toBe('0 9 * * 1-5')
    expect(schedule?.timezone).toBe('Europe/London')
    expect(schedule?.enabled).toBe(true)
    expect(schedule?.nextRunAt?.getTime()).toBeGreaterThan(Date.now())
  })

  it('comes off the clock when it is paused', async () => {
    const workflowId = await activated('Each morning at 7, find overdue tasks and create a task.')
    await withTenant(session, async (ctx) =>
      setWorkflowStatus(ctx, await loadActor(ctx), { workflowId, status: 'paused' }),
    )
    const schedule = await withTenant(session, (ctx) => scheduleFor(ctx, 'workflow', workflowId))
    expect(schedule?.enabled).toBe(false)
  })

  it('comes off the clock when it is edited, because the new version was never dry-run', async () => {
    const workflowId = await activated('Each morning at 6, find overdue tasks and create a task.')
    await withTenant(session, async (ctx) =>
      saveCompiled(ctx, await loadActor(ctx), {
        workflowId,
        description: 'Each morning at 11, find overdue tasks and create a task.',
        compiled: compileWorkflow('Each morning at 11, find overdue tasks and create a task.'),
      }),
    )
    const schedule = await withTenant(session, (ctx) => scheduleFor(ctx, 'workflow', workflowId))
    expect(schedule?.enabled).toBe(false)
    const workflow = await withTenant(session, async (ctx) => getWorkflow(ctx, await loadActor(ctx), workflowId))
    expect(workflow.status).toBe('draft')
  })
})

describe('claiming what is due', () => {
  it('claims a schedule once and advances it, so a second sweep finds nothing', async () => {
    const sentence = 'Each morning at 5, find overdue tasks and create a task.'
    const workflowId = await withTenant(session, async (ctx) => {
      const saved = await saveCompiled(ctx, await loadActor(ctx), {
        description: sentence,
        compiled: compileWorkflow(sentence),
      })
      return saved.id
    })
    await simulateWorkflow(session, { workflowId, windowDays: 7 })
    await withTenant(session, async (ctx) =>
      activateWorkflow(ctx, await loadActor(ctx), { workflowId, ownerUserId: org.ownerId }),
    )

    // Pretend the firing was due a minute ago.
    const due = new Date(Date.now() - 60_000)
    await withTenant(session, async (ctx) => {
      await ctx.sql`
        UPDATE schedules SET next_run_at = ${due}
        WHERE organization_id = ${ctx.organizationId} AND kind = 'workflow' AND target_id = ${workflowId}`
    })

    const first = await withTenant(session, (ctx) => claimDueSchedules(ctx, 'workflow'))
    const claimed = first.filter((entry) => entry.targetId === workflowId)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]!.runs).toBe(1)
    expect(claimed[0]!.nextRunAt?.getTime()).toBeGreaterThan(Date.now())

    const second = await withTenant(session, (ctx) => claimDueSchedules(ctx, 'workflow'))
    expect(second.filter((entry) => entry.targetId === workflowId)).toHaveLength(0)
  })

  it('catches up once rather than firing a lost night all at once, and says how many it dropped', async () => {
    const sentence = 'Each morning at 4, find overdue tasks and create a task.'
    const workflowId = await withTenant(session, async (ctx) => {
      const saved = await saveCompiled(ctx, await loadActor(ctx), {
        description: sentence,
        compiled: compileWorkflow(sentence),
      })
      return saved.id
    })
    await simulateWorkflow(session, { workflowId, windowDays: 7 })
    await withTenant(session, async (ctx) =>
      activateWorkflow(ctx, await loadActor(ctx), { workflowId, ownerUserId: org.ownerId }),
    )

    // A worker that has been down for a week: seven firings were due.
    await withTenant(session, async (ctx) => {
      await ctx.sql`
        UPDATE schedules SET next_run_at = now() - interval '7 days'
        WHERE organization_id = ${ctx.organizationId} AND kind = 'workflow' AND target_id = ${workflowId}`
    })

    const claimed = (await withTenant(session, (ctx) => claimDueSchedules(ctx, 'workflow'))).find(
      (entry) => entry.targetId === workflowId,
    )
    expect(claimed?.runs).toBe(1)
    expect(claimed?.skipped).toBeGreaterThanOrEqual(6)
    expect(claimed?.skippedReason).toMatch(/missed/i)

    const schedule = await withTenant(session, (ctx) => scheduleFor(ctx, 'workflow', workflowId))
    expect(schedule?.skippedTotal).toBeGreaterThanOrEqual(6)
    expect(schedule?.lastSkippedReason).toMatch(/missed/i)
  })
})

describe('the sweep', () => {
  it('runs what is due and reports what it held back', async () => {
    const sentence = 'Each morning at 3, find overdue tasks and create a task.'
    const workflowId = await withTenant(session, async (ctx) => {
      const saved = await saveCompiled(ctx, await loadActor(ctx), {
        description: sentence,
        compiled: compileWorkflow(sentence),
      })
      return saved.id
    })
    await simulateWorkflow(session, { workflowId, windowDays: 7 })
    await withTenant(session, async (ctx) =>
      activateWorkflow(ctx, await loadActor(ctx), { workflowId, ownerUserId: org.ownerId }),
    )
    // Everything else this suite activated comes off the clock, so the sweep is about one.
    await withTenant(session, async (ctx) => {
      await ctx.sql`
        UPDATE schedules SET enabled = false
        WHERE organization_id = ${ctx.organizationId} AND kind = 'workflow' AND target_id <> ${workflowId}`
      await ctx.sql`
        UPDATE schedules SET next_run_at = now() - interval '1 minute'
        WHERE organization_id = ${ctx.organizationId} AND kind = 'workflow' AND target_id = ${workflowId}`
    })

    const sweep = await runDueWorkflows(session)
    expect(sweep.claimed).toBe(1)
    expect(sweep.ran + sweep.skipped).toBeGreaterThan(0)

    // Nothing is due now, so a second sweep is a no-op rather than a repeat.
    const again = await runDueWorkflows(session)
    expect(again.claimed).toBe(0)
  })

  it('holds a firing back while the last batch is still waiting for a person', async () => {
    const sentence = 'Each morning at 2, find customer threads that have gone quiet and draft a follow-up.'
    const workflowId = await withTenant(session, async (ctx) => {
      const saved = await saveCompiled(ctx, await loadActor(ctx), {
        description: sentence,
        compiled: compileWorkflow(sentence),
      })
      return saved.id
    })
    await simulateWorkflow(session, { workflowId, windowDays: 7 })
    await withTenant(session, async (ctx) =>
      activateWorkflow(ctx, await loadActor(ctx), { workflowId, ownerUserId: org.ownerId }),
    )

    // An earlier run of this workflow is still awaiting a decision.
    await withTenant(session, async (ctx) => {
      const [version] = await ctx.sql<{ id: string }[]>`
        SELECT current_version_id AS id FROM workflows
        WHERE organization_id = ${ctx.organizationId} AND id = ${workflowId}`
      await ctx.sql`
        INSERT INTO workflow_runs (
          organization_id, workflow_id, workflow_version_id, status, trigger, simulated,
          idempotency_key, created_by
        ) VALUES (
          ${ctx.organizationId}, ${workflowId}, ${version!.id}, 'awaiting_approval', 'schedule', false,
          ${`stuck-${Date.now()}`}, ${org.ownerId}
        )`
    })

    const { checkCapacity } = await import('@superwork/agent')
    const capacity = await withTenant(session, async (ctx) =>
      checkCapacity(ctx, await getWorkflow(ctx, await loadActor(ctx), workflowId)),
    )
    expect(capacity.allow).toBe(false)
    expect(capacity.reason).toMatch(/waiting for somebody to approve/i)
  })
})
