import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import { compileWorkflow } from '@superwork/ai'
import {
  checkCapacity,
  getWorkflow,
  PermissionError,
  saveCompiled,
  setWorkflowLimits,
  StepUpRequiredError,
  ValidationError,
  WORKFLOW_LIMITS,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * The two throttles an automation runs under (ADR 0046).
 *
 * `workflows.max_concurrent_runs` and `daily_action_cap` have existed since migration 0007,
 * are read on every firing, are both enforced — and nothing has ever written either. Every
 * workflow in every organization has run on the column defaults, 1 and 100, and the skip
 * message told people to "raise the cap" when there was no way to raise anything.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let stepped: { organizationId: string; userId: string; timezone: string; steppedUpAt: Date }
let memberSession: { organizationId: string; userId: string; timezone: string }
let workflowId: string
let versionId: string

beforeAll(async () => {
  org = await createTenant('workflow-throttles')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  stepped = { ...session, steppedUpAt: new Date() }
  memberSession = { organizationId: org.organizationId, userId: org.memberId, timezone: TZ }

  await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const compiled = compileWorkflow(
      'Every weekday at 9, find customer threads with no reply for 3 days and draft a follow-up, and tell the account owner.',
    )
    const workflow = await saveCompiled(ctx, actor, { description: 'The loop test workflow', compiled })
    workflowId = workflow.id
    versionId = workflow.currentVersionId!
  })
})

afterAll(async () => {
  await destroyTenant('workflow-throttles')
  await closePools()
})

describe('a number nobody chose says so', () => {
  it('starts on the defaults, attributed to nobody', async () => {
    await withTenant(session, async (ctx) => {
      const workflow = await getWorkflow(ctx, await loadActor(ctx), workflowId)
      expect(workflow.maxConcurrentRuns).toBe(1)
      expect(workflow.dailyActionCap).toBe(100)
      expect(workflow.limitsSetByName).toBeNull()
      expect(workflow.limitsSetAt).toBeNull()
    })
  })
})

describe('setting them', () => {
  it('needs a say over automations, not a read of them', async () => {
    await withTenant(memberSession, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        setWorkflowLimits(ctx, actor, {
          workflowId,
          maxConcurrentRuns: 1,
          dailyActionCap: 10,
          reason: 'Trying it on.',
        }),
      ).rejects.toThrow(PermissionError)
    })
  })

  it('refuses a change nobody explained', async () => {
    await withTenant(stepped, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        setWorkflowLimits(ctx, actor, { workflowId, maxConcurrentRuns: 1, dailyActionCap: 10, reason: 'x' }),
      ).rejects.toThrow(ValidationError)
    })
  })

  it('lowers without asking for a password, because lowering only ever narrows', async () => {
    const tightened = await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      return setWorkflowLimits(ctx, actor, {
        workflowId,
        maxConcurrentRuns: 1,
        dailyActionCap: 10,
        reason: 'Ten drafts a day is as much as anybody will read.',
      })
    })
    expect(tightened.dailyActionCap).toBe(10)
    expect(tightened.limitsSetByName).toBeTruthy()
    expect(tightened.limitsReason).toContain('anybody will read')
  })

  it('asks for a fresh proof when either number goes up', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        setWorkflowLimits(ctx, actor, {
          workflowId,
          maxConcurrentRuns: 1,
          dailyActionCap: 40,
          reason: 'The Monday backlog needs more than ten.',
        }),
      ).rejects.toThrow(StepUpRequiredError)

      // And the same for the concurrency, which is the one that produces a Monday morning
      // with two hundred approvals waiting.
      await expect(
        setWorkflowLimits(ctx, actor, {
          workflowId,
          maxConcurrentRuns: 3,
          dailyActionCap: 10,
          reason: 'Let it overlap.',
        }),
      ).rejects.toThrow(StepUpRequiredError)
    })
  })

  it('refuses "unlimited", whatever number is used to spell it', async () => {
    await withTenant(stepped, async (ctx) => {
      const actor = await loadActor(ctx)
      for (const [runs, cap] of [
        [0, 10],
        [1, 0],
        [1, WORKFLOW_LIMITS.dailyActionCap.max + 1],
        [WORKFLOW_LIMITS.maxConcurrentRuns.max + 1, 10],
        [1, 2.5],
      ]) {
        await expect(
          setWorkflowLimits(ctx, actor, {
            workflowId,
            maxConcurrentRuns: runs!,
            dailyActionCap: cap!,
            reason: 'Trying to take the ceiling off.',
          }),
        ).rejects.toThrow(ValidationError)
      }
    })
  })

  it('cannot be taken off by whatever writes the row', async () => {
    await expect(
      adminSql()`UPDATE workflows SET daily_action_cap = 1000000 WHERE id = ${workflowId}`,
    ).rejects.toThrow(/workflows_limits_are_sane/)
  })

  it('cannot be recorded as somebody’s decision without a name and a reason', async () => {
    await expect(
      adminSql()`
        UPDATE workflows SET limits_set_by = NULL, limits_set_at = now(), limits_reason = NULL
        WHERE id = ${workflowId} AND limits_set_by IS NOT NULL`,
    ).resolves.toBeDefined() // clearing the attribution entirely is how a default is expressed
    await expect(
      adminSql()`
        UPDATE workflows SET limits_set_by = ${org.ownerId}, limits_set_at = now(), limits_reason = 'x'
        WHERE id = ${workflowId}`,
    ).rejects.toThrow(/workflows_limits_are_attributed/)
  })
})

describe('the number the screen shows is the number the scheduler enforces', () => {
  it('holds the workflow once the day’s cap is reached', async () => {
    // Restore an attributed row after the constraint probes above.
    await withTenant(stepped, async (ctx) => {
      const actor = await loadActor(ctx)
      await setWorkflowLimits(ctx, actor, {
        workflowId,
        maxConcurrentRuns: 2,
        dailyActionCap: 2,
        reason: 'Small enough to demonstrate the cap in a test.',
      })
    })

    // Two successful tool calls today, made by this workflow, through the shape the counter
    // reads: a workflow-triggered run with the workflow id in its context.
    await withTenant(session, async (ctx) => {
      const [run] = await ctx.sql<{ id: string }[]>`
        INSERT INTO agent_runs (
          organization_id, principal_user_id, mode, status, request, trigger, trace_id,
          ui_context, created_by
        ) VALUES (
          ${ctx.organizationId}, ${org.ownerId}, 'execute', 'succeeded', 'throttle fixture',
          'workflow', ${'trace-throttle'}, ${ctx.sql.json({ workflowId })}, ${org.ownerId}
        ) RETURNING id`
      for (const ordinal of [1, 2]) {
        await ctx.sql`
          INSERT INTO tool_calls (
            organization_id, run_id, tool_name, idempotency_key, args_hash, ok, created_by
          ) VALUES (
            ${ctx.organizationId}, ${run!.id}, 'draft_email', ${'throttle-' + ordinal},
            ${'hash' + ordinal}, true, ${org.ownerId}
          )`
      }
    })

    const held = await withTenant(session, async (ctx) => {
      const workflow = await getWorkflow(ctx, await loadActor(ctx), workflowId)
      return checkCapacity(ctx, workflow)
    })
    expect(held.usedToday).toBe(2)
    expect(held.allow).toBe(false)
    expect(held.reason).toMatch(/already done 2 things today and its cap is 2/)

    // Raising it is what un-holds it — which is the whole point of the number being settable.
    const freed = await withTenant(stepped, async (ctx) => {
      const actor = await loadActor(ctx)
      await setWorkflowLimits(ctx, actor, {
        workflowId,
        maxConcurrentRuns: 2,
        dailyActionCap: 20,
        reason: 'Two was the test, twenty is the working number.',
      })
      return checkCapacity(ctx, await getWorkflow(ctx, actor, workflowId))
    })
    expect(freed.allow).toBe(true)
    expect(freed.remaining).toBe(18)
  })

  it('holds it while earlier runs are unfinished, up to the number set', async () => {
    await withTenant(session, async (ctx) => {
      for (const ordinal of [1, 2]) {
        await ctx.sql`
          INSERT INTO workflow_runs (
            organization_id, workflow_id, workflow_version_id, status, trigger, simulated,
            idempotency_key, created_by
          ) VALUES (
            ${ctx.organizationId}, ${workflowId}, ${versionId}, 'awaiting_approval', 'schedule',
            false, ${'throttle-' + ordinal}, ${org.ownerId}
          )`
      }
    })

    const held = await withTenant(session, async (ctx) => {
      const workflow = await getWorkflow(ctx, await loadActor(ctx), workflowId)
      return checkCapacity(ctx, workflow)
    })
    expect(held.unfinished).toBe(2)
    expect(held.allow).toBe(false)
    expect(held.reason).toMatch(/still unfinished/)
  })

  it('writes what changed, and what it was before', async () => {
    const [entry] = await adminSql()<{ diff: Record<string, { from: unknown; to: unknown }> }[]>`
      SELECT diff FROM audit_logs
      WHERE organization_id = ${org.organizationId} AND action = 'workflow.limits_set'
      ORDER BY occurred_at DESC LIMIT 1`
    expect(entry!.diff['dailyActionCap']).toEqual({ from: 2, to: 20 })
  })
})
