import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import { checkRateLimit, getTool } from '@superwork/tools'
import { compileWorkflow } from '@superwork/ai'
import { continueWorkflowAfterApproval, runWorkflow, simulateWorkflow } from '@superwork/agent'
import {
  activateWorkflow,
  CUSTOM_TOOL_LIMITS,
  decideApproval,
  getCustomTool,
  saveCompiled,
  reviewHost,
  saveCustomTool,
  setCustomToolLimits,
  StepUpRequiredError,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * A budget that stops something (ADR 0050).
 *
 * Every tool in the registry has declared `rateLimit: { perRun, perOrgPerHour }` since Phase 1
 * and nothing ever read it — twenty built-ins with hand-picked numbers, two columns on
 * `custom_tools`, and no code path consulting any of them. For a custom tool it was worse: the
 * columns were read out of the row and handed to the registry, so they looked enforced, while
 * `saveCustomTool` never wrote either — every admin-authored tool ran on a migration default.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let stepped: { organizationId: string; userId: string; timezone: string; steppedUpAt: Date }
let toolId: string
let runId: string

beforeAll(async () => {
  org = await createTenant('tool-budgets')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  stepped = { ...session, steppedUpAt: new Date() }

  await withTenant(stepped, async (ctx) => {
    const actor = await loadActor(ctx)
    await reviewHost(ctx, actor, { host: 'erp.fixture.example', reason: 'The fixture order system.' })
    const tool = await saveCustomTool(ctx, actor, {
      name: 'fixture_orders@v1',
      description: 'Reads an order from the fixture ERP.',
      method: 'GET',
      urlTemplate: 'https://erp.fixture.example/orders/{id}',
      parameters: [
        { name: 'id', type: 'string', in: 'path', required: true, description: 'The order number.' },
      ],
      headers: {},
      riskTier: 'read',
      requiredPermissions: ['integration:read:org'],
    })
    toolId = tool.id
  })

  const [run] = await adminSql()<{ id: string }[]>`
    INSERT INTO agent_runs (
      organization_id, principal_user_id, mode, status, request, trace_id, is_demo, created_by
    ) VALUES (
      ${org.organizationId}, ${org.ownerId}, 'execute', 'running', 'budget fixture',
      'trace-budget', true, ${org.ownerId}
    ) RETURNING id`
  runId = run!.id
})

afterAll(async () => {
  await destroyTenant('tool-budgets')
  await closePools()
})

/** A call that really happened, which is the only thing either budget counts. */
async function recordCalls(toolName: string, count: number, options: { hoursAgo?: number } = {}) {
  for (let index = 0; index < count; index++) {
    await adminSql()`
      INSERT INTO tool_calls (
        organization_id, run_id, tool_name, risk_tier, idempotency_key, args_hash, ok,
        created_at, is_demo, created_by
      ) VALUES (
        ${org.organizationId}, ${runId}, ${toolName}, 'read',
        ${`budget-${toolName}-${Date.now()}-${index}-${Math.round(performance.now() * 1000)}`},
        ${'hash'}, true,
        now() - make_interval(hours => ${options.hoursAgo ?? 0}), true, ${org.ownerId}
      )`
  }
}

describe('the numbers a custom tool runs under', () => {
  it('starts on the defaults, attributed to nobody', async () => {
    await withTenant(session, async (ctx) => {
      const tool = await getCustomTool(ctx, await loadActor(ctx), toolId)
      expect(tool.perRunLimit).toBe(5)
      expect(tool.perHourLimit).toBe(200)
      expect(tool.limitsSetByName).toBeNull()
      expect(tool.usedThisHour).toBe(0)
    })
  })

  it('lowers without asking, and records who decided and why', async () => {
    const tightened = await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      return setCustomToolLimits(ctx, actor, {
        id: toolId,
        perRunLimit: 2,
        perHourLimit: 3,
        reason: 'The supplier asked us to slow down.',
      })
    })
    expect(tightened.perRunLimit).toBe(2)
    expect(tightened.perHourLimit).toBe(3)
    expect(tightened.limitsSetByName).toBeTruthy()
    expect(tightened.limitsReason).toContain('slow down')
  })

  it('asks for a fresh proof when either number goes up', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        setCustomToolLimits(ctx, actor, {
          id: toolId,
          perRunLimit: 2,
          perHourLimit: 50,
          reason: 'We need more headroom.',
        }),
      ).rejects.toThrow(StepUpRequiredError)
    })
  })

  it('refuses an hourly budget below what one run may use', async () => {
    await withTenant(stepped, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        setCustomToolLimits(ctx, actor, {
          id: toolId,
          perRunLimit: 10,
          perHourLimit: 4,
          reason: 'Incoherent on purpose.',
        }),
      ).rejects.toThrow(/below the 10 one run may use/i)
    })
  })

  it('refuses “unlimited”, whatever number is used to spell it', async () => {
    await withTenant(stepped, async (ctx) => {
      const actor = await loadActor(ctx)
      for (const [run, hour] of [
        [0, 10],
        [1, 0],
        [1, CUSTOM_TOOL_LIMITS.perHourLimit.max + 1],
        [CUSTOM_TOOL_LIMITS.perRunLimit.max + 1, 5000],
        [1.5, 10],
      ]) {
        await expect(
          setCustomToolLimits(ctx, actor, {
            id: toolId,
            perRunLimit: run!,
            perHourLimit: hour!,
            reason: 'Trying to take the ceiling off.',
          }),
        ).rejects.toThrow(ValidationError)
      }
    })
  })

  it('cannot be taken off by whatever writes the row', async () => {
    await expect(
      adminSql()`UPDATE custom_tools SET per_hour_limit = 100000 WHERE id = ${toolId}`,
    ).rejects.toThrow(/custom_tool_limits_sane/)
    await expect(
      adminSql()`UPDATE custom_tools SET per_run_limit = 50, per_hour_limit = 3 WHERE id = ${toolId}`,
    ).rejects.toThrow(/custom_tool_limits_sane/)
  })

  it('cannot be recorded as somebody’s decision without a name and a reason', async () => {
    await expect(
      adminSql()`
        UPDATE custom_tools SET limits_set_by = ${org.ownerId}, limits_set_at = now(), limits_reason = 'x'
        WHERE id = ${toolId}`,
    ).rejects.toThrow(/custom_tool_limits_attributed/)
  })
})

describe('and what the budget then stops', () => {
  it('lets a call through while the run is inside its budget', async () => {
    await withTenant(session, async (ctx) => {
      const tool = { name: 'fixture_orders@v1', rateLimit: { perRun: 2, perOrgPerHour: 3 } }
      const verdict = await checkRateLimit(ctx, tool, runId)
      expect(verdict.allow).toBe(true)
      expect(verdict.usedThisRun).toBe(0)
    })
  })

  it('stops the run that has already done it too often, and says which budget', async () => {
    await recordCalls('fixture_orders@v1', 2)
    await withTenant(session, async (ctx) => {
      const tool = { name: 'fixture_orders@v1', rateLimit: { perRun: 2, perOrgPerHour: 3 } }
      const verdict = await checkRateLimit(ctx, tool, runId)
      expect(verdict.allow).toBe(false)
      expect(verdict.usedThisRun).toBe(2)
      expect(verdict.reason).toMatch(/this run has already called/i)
    })
  })

  it('stops the organization that has done it too often this hour, whichever run asks', async () => {
    await recordCalls('fixture_orders@v1', 2)
    const [other] = await adminSql()<{ id: string }[]>`
      INSERT INTO agent_runs (
        organization_id, principal_user_id, mode, status, request, trace_id, is_demo, created_by
      ) VALUES (
        ${org.organizationId}, ${org.ownerId}, 'execute', 'running', 'second run',
        'trace-budget-2', true, ${org.ownerId}
      ) RETURNING id`

    await withTenant(session, async (ctx) => {
      const tool = { name: 'fixture_orders@v1', rateLimit: { perRun: 2, perOrgPerHour: 3 } }
      // A fresh run, so the per-run budget is untouched — and the hour still stops it.
      const verdict = await checkRateLimit(ctx, tool, other!.id)
      expect(verdict.usedThisRun).toBe(0)
      expect(verdict.allow).toBe(false)
      expect(verdict.reason).toMatch(/in the last hour/i)
      expect(verdict.reason).toMatch(/rolling one/i)
    })
  })

  it('is a rolling hour, so what happened yesterday does not count', async () => {
    await recordCalls('older_tool@v1', 50, { hoursAgo: 26 })
    await withTenant(session, async (ctx) => {
      const tool = { name: 'older_tool@v1', rateLimit: { perRun: 5, perOrgPerHour: 10 } }
      const verdict = await checkRateLimit(ctx, tool, null)
      expect(verdict.usedThisHour).toBe(0)
      expect(verdict.allow).toBe(true)
    })
  })

  it('refuses the step inside a real workflow run, not only in the counter', async () => {
    // End to end: the demo's follow-up workflow calls `draft_email@v1`, which declares an
    // hourly budget of its own. Fill that hour and the step is refused by the executor —
    // which is the whole claim, since the number was declared and read by nothing.
    const draft = getTool('draft_email@v1')!
    await recordCalls('draft_email@v1', draft.rateLimit.perOrgPerHour)

    // A thread for the workflow to actually match, so the draft step is reached at all.
    await withTenant(session, async (ctx) => {
      const [conversation] = await ctx.sql<{ id: string }[]>`
        INSERT INTO conversations (
          organization_id, subject, company_id, status, last_message_at, last_direction, is_demo, created_by
        ) VALUES (
          ${ctx.organizationId}, 'Renewal terms', ${org.companyId}, 'open',
          now() - interval '20 days', 'inbound', true, ${org.ownerId}
        ) RETURNING id`
      await ctx.sql`
        INSERT INTO contacts (organization_id, company_id, name, emails, is_demo, created_by)
        VALUES (${ctx.organizationId}, ${org.companyId}, 'Sam Buyer', ARRAY['sam@customer.example'], true, ${org.ownerId})`
      await ctx.sql`
        INSERT INTO messages (
          organization_id, conversation_id, direction, from_name, from_address, body_text, sent_at, is_demo, created_by
        ) VALUES (
          ${ctx.organizationId}, ${conversation!.id}, 'inbound', 'Sam Buyer', 'sam@customer.example',
          'Can you confirm the renewal terms?', now() - interval '20 days', true, ${org.ownerId}
        )`
    })

    const sentence = 'Every weekday at 9, find customer threads that have gone quiet and draft a follow-up.'
    const workflowId = await withTenant(session, async (ctx) => {
      const saved = await saveCompiled(ctx, await loadActor(ctx), {
        description: sentence,
        compiled: compileWorkflow(sentence),
      })
      return saved.id
    })
    await simulateWorkflow(session, { workflowId, windowDays: 30 })
    await withTenant(session, async (ctx) =>
      activateWorkflow(ctx, await loadActor(ctx), { workflowId, ownerUserId: org.ownerId }),
    )

    // The run prepares the change and stops for a person, as it always does — the tool is
    // called when the approval is granted, which is where the budget meets it.
    const run = await runWorkflow(session, { workflowId, trigger: 'manual' })
    expect(run.status).toBe('awaiting_approval')
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await decideApproval(ctx, actor, {
        approvalId: run.approvalId!,
        decision: 'approve',
        reason: 'Fine by me — the budget is what should stop this, not me.',
      })
    })

    const resumed = await continueWorkflowAfterApproval(session, run.runId)
    const stopped = [resumed.note ?? '', ...resumed.steps.map((step) => step.detail)].join(' | ')
    expect(stopped).toMatch(/in the last hour/i)

    // And nothing was drafted, which is what a budget stopping something means.
    await withTenant(session, async (ctx) => {
      const [row] = await ctx.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM email_drafts WHERE organization_id = ${ctx.organizationId}`
      expect(row!.count).toBe(0)
    })
  })

  it('measures a built-in tool against the numbers it declares in its own source', async () => {
    // The point of the whole increment: these numbers were declared on every tool and read by
    // nothing. `draft_email@v1` carries its own, and the gate now reads them.
    const draft = getTool('draft_email@v1')
    expect(draft?.rateLimit.perRun).toBeGreaterThan(0)
    await recordCalls('draft_email@v1', draft!.rateLimit.perRun)

    await withTenant(session, async (ctx) => {
      const verdict = await checkRateLimit(ctx, draft!, runId)
      expect(verdict.allow).toBe(false)
      expect(verdict.perRun).toBe(draft!.rateLimit.perRun)
    })
  })
})
