import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor, type Actor } from '@superwork/auth'
import { DEFAULT_RUN_BUDGET } from '@superwork/config'
import { getAgent, setAgentBudget, StepUpRequiredError } from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * A budget this agent runs under (ADR 0077).
 *
 * `agents.budget` has existed since migration 0006 and nothing consulted it — not the runtime,
 * not Agent Studio. Every agent in every organization ran on `DEFAULT_RUN_BUDGET`, a product
 * constant, while the column that exists to say otherwise was read into the persona and dropped.
 *
 * The brake was already built: `checkBudget` stops a run on steps, tool calls, spend and wall
 * clock and reports which one it was. What was missing was the lever.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let owner: { organizationId: string; userId: string; timezone: string }
let actor: Actor
/** The same person, holding a password proof from the last five minutes. */
let proven: Actor
let agentId: string

const WHY = 'It only ever reads, so a long run means it is stuck rather than working.'

async function budgetOf(): Promise<Record<string, number>> {
  const [row] = await adminSql()<{ budget: Record<string, number> }[]>`
    SELECT budget FROM agents WHERE id = ${agentId}`
  return row!.budget
}

async function reset() {
  await adminSql()`
    UPDATE agents SET budget = '{}'::jsonb, budget_set_by = NULL, budget_set_at = NULL,
                      budget_reason = NULL
    WHERE id = ${agentId}`
}

beforeAll(async () => {
  org = await createTenant('agent-budget')
  owner = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  actor = await withTenant(owner, async (ctx) => loadActor(ctx))
  proven = { ...actor, steppedUpAt: new Date() }
  const [row] = await adminSql()<{ id: string }[]>`
    INSERT INTO agents (organization_id, key, name, purpose, owner_user_id, mode, status,
                        tool_grants, max_sensitivity, is_demo, created_by)
    VALUES (${org.organizationId}, 'budget-subject', 'Researcher', 'Reads and cites.',
            ${org.ownerId}, 'ask'::sw_agent_mode, 'active', ARRAY['*'], 'internal', true,
            ${org.ownerId})
    RETURNING id`
  agentId = row!.id
})

afterAll(async () => {
  await destroyTenant('agent-budget')
  await closePools()
})

describe('what an agent ran under before', () => {
  it('the product’s own numbers, and nothing could say otherwise', async () => {
    await reset()
    const agent = await withTenant(owner, async (ctx) => getAgent(ctx, actor, agentId))
    expect(agent.budget).toEqual({})
    expect(agent.budgetSetByName).toBeNull()
  })
})

describe('tightening', () => {
  it('asks for a reason and nothing else', async () => {
    await reset()
    // No `steppedUpAt` on this actor. Deciding an agent may do less is the direction that
    // should be easy.
    const after = await withTenant(owner, async (ctx) =>
      setAgentBudget(ctx, actor, { agentId, budget: { maxSteps: 8, maxCostCents: 10 }, reason: WHY }),
    )
    expect(after.budget).toEqual({ maxSteps: 8, maxCostCents: 10 })
    expect(after.budgetReason).toBe(WHY)
    expect(after.budgetSetAt).toBeInstanceOf(Date)
    expect(after.budgetSetByName).toBeTruthy()
  })

  it('and refuses a reasonless one, because a stopped run reads as a fault', async () => {
    await expect(
      withTenant(owner, async (ctx) =>
        setAgentBudget(ctx, actor, { agentId, budget: { maxSteps: 4 }, reason: 'no' }),
      ),
    ).rejects.toThrow(/Say why/i)
  })
})

describe('loosening', () => {
  it('asks for a password, because it lets the agent do more unattended', async () => {
    await reset()
    await withTenant(owner, async (ctx) =>
      setAgentBudget(ctx, actor, { agentId, budget: { maxSteps: 8 }, reason: WHY }),
    )
    await expect(
      withTenant(owner, async (ctx) =>
        setAgentBudget(ctx, actor, { agentId, budget: { maxSteps: 12 }, reason: 'It needs more room.' }),
      ),
    ).rejects.toThrow(StepUpRequiredError)
  })

  it('including dropping a limit back to the product’s own', async () => {
    // An empty object is not "no budget" — it is the product's own, which is more than 8 steps.
    await expect(
      withTenant(owner, async (ctx) =>
        setAgentBudget(ctx, actor, { agentId, budget: {}, reason: 'Back to the default.' }),
      ),
    ).rejects.toThrow(StepUpRequiredError)
  })

  it('and goes through with one', async () => {
    const after = await withTenant(owner, async (ctx) =>
      setAgentBudget(ctx, proven, { agentId, budget: { maxSteps: 12 }, reason: 'It needs more room.' }),
    )
    expect(after.budget.maxSteps).toBe(12)
  })

  it('but never above the product’s limit, whatever proof is offered', async () => {
    await expect(
      withTenant(owner, async (ctx) =>
        setAgentBudget(ctx, proven, {
          agentId,
          budget: { maxSteps: DEFAULT_RUN_BUDGET.maxSteps + 1 },
          reason: 'We would like more.',
        }),
      ),
    ).rejects.toThrow(/cannot be raised above the product limit/i)
  })
})

describe('what it refuses outright', () => {
  it('a setting the runtime does not read', async () => {
    await expect(
      withTenant(owner, async (ctx) =>
        setAgentBudget(ctx, proven, {
          agentId,
          budget: { runsPerDay: 200 } as never,
          reason: 'A number from another vocabulary.',
        }),
      ),
    ).rejects.toThrow(/no setting called "runsPerDay"/i)
  })

  it('and zero, which is switched off rather than limited', async () => {
    await expect(
      withTenant(owner, async (ctx) =>
        setAgentBudget(ctx, proven, { agentId, budget: { maxSteps: 0 }, reason: 'None at all.' }),
      ),
    ).rejects.toThrow(/at least 1/i)
  })
})

describe('what the database holds to, whatever writes the row', () => {
  /**
   * `adminSql()` is the owner connection — the most privileged writer there is. A rule only the
   * repository keeps is a rule anything holding a connection can break.
   */
  it('refuses a budget above the product’s limit', async () => {
    await expect(
      adminSql()`UPDATE agents SET budget = '{"maxSteps": 500}'::jsonb WHERE id = ${agentId}`,
    ).rejects.toThrow(/cannot be raised above the product limit/i)
  })

  it('refuses a key nothing reads', async () => {
    await expect(
      adminSql()`UPDATE agents SET budget = '{"runsPerDay": 200}'::jsonb WHERE id = ${agentId}`,
    ).rejects.toThrow(/no setting called/i)
  })

  it('refuses a fraction and a zero', async () => {
    await expect(
      adminSql()`UPDATE agents SET budget = '{"maxSteps": 2.5}'::jsonb WHERE id = ${agentId}`,
    ).rejects.toThrow(/whole number/i)
    await expect(
      adminSql()`UPDATE agents SET budget = '{"maxSteps": 0}'::jsonb WHERE id = ${agentId}`,
    ).rejects.toThrow(/at least 1/i)
  })

  it('refuses a tightening with nobody’s name against it', async () => {
    // From a row with the triple cleared: with a name and a date already on it, a reason on its
    // own satisfies the CHECK, which is the CHECK working rather than a gap.
    await reset()
    await expect(
      adminSql()`UPDATE agents SET budget_reason = 'Because.' WHERE id = ${agentId}`,
    ).rejects.toThrow(/agents_budget_attributed/i)
  })

  it('and a setter from another organization', async () => {
    const other = await createTenant('agent-budget-b')
    try {
      await expect(
        adminSql()`
          UPDATE agents SET budget_set_by = ${other.ownerId}, budget_set_at = now(),
                            budget_reason = 'Not from here.'
          WHERE id = ${agentId}`,
      ).rejects.toThrow(/member of the same organization/i)
    } finally {
      await destroyTenant('agent-budget-b')
    }
  })

  it('but leaves an unrelated edit to the agent alone', async () => {
    // The two-trigger split: a guard narrowed to the arriving value, so an edit over some other
    // column is not refused for a budget it never touched.
    await reset()
    await withTenant(owner, async (ctx) =>
      setAgentBudget(ctx, actor, { agentId, budget: { maxSteps: 6 }, reason: WHY }),
    )
    await adminSql()`UPDATE agents SET purpose = 'Reads, cites, and nothing else.' WHERE id = ${agentId}`
    expect((await budgetOf()).maxSteps).toBe(6)
  })
})
