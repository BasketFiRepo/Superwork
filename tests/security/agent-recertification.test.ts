import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  certificationState,
  getAgent,
  monitoringPolicy,
  PermissionError,
  recertifyAgent,
  setMonitoringPolicy,
  StepUpRequiredError,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * An agent somebody still stands behind (ADR 0068).
 *
 * `agents.recertified_at` has existed since migration 0006, is selected into `AgentPersona` and
 * again by the AI-governance screen's own query, and is written by nothing and rendered
 * nowhere. The control it was for is the one publishing cannot express: publishing takes two
 * people and happens when something *changes*, so an agent that has not changed is never
 * re-examined by any flow this product has.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let owner: { organizationId: string; userId: string; timezone: string }
let member: { organizationId: string; userId: string; timezone: string }
let agentId: string

async function seedAgent(key: string, mode: string): Promise<string> {
  const [row] = await adminSql()<{ id: string }[]>`
    INSERT INTO agents (organization_id, key, name, purpose, owner_user_id, mode, status,
                        tool_grants, max_sensitivity, is_demo, created_by)
    VALUES (${org.organizationId}, ${key}, ${`Agent ${key}`}, 'Does a thing.', ${org.ownerId},
            ${mode}::sw_agent_mode, 'active', ARRAY['*'], 'internal', true, ${org.ownerId})
    RETURNING id`
  return row!.id
}

beforeAll(async () => {
  org = await createTenant('agent-recert')
  owner = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  member = { organizationId: org.organizationId, userId: org.memberId, timezone: TZ }
  agentId = await seedAgent('recert-subject', 'execute')
})

afterAll(async () => {
  await destroyTenant('agent-recert')
  await closePools()
})

describe('the rule, which three places have to agree about', () => {
  const base = { name: 'Superwork', publishedVersion: 3, recertifiedByName: 'Maya' }

  it('says nobody has, when nobody has', () => {
    const state = certificationState({ ...base, recertifiedAt: null, recertifiedVersion: null }, 90)
    expect(state.state).toBe('never')
    expect(state.stale).toBe(true)
    expect(state.summary).toMatch(/Nobody has confirmed/i)
  })

  it('is current when it is about the configuration that is running', () => {
    const state = certificationState(
      { ...base, recertifiedAt: new Date('2026-08-01'), recertifiedVersion: 3 },
      90,
      new Date('2026-08-21'),
    )
    expect(state.state).toBe('current')
    expect(state.stale).toBe(false)
    expect(state.dueAt?.toISOString().slice(0, 10)).toBe('2026-10-30')
  })

  /**
   * The half that matters more than the interval: an attestation is about a configuration, not
   * about an agent. Republishing makes it stale the same day, and the refusal can say which
   * version was actually read.
   */
  it('goes stale the moment the agent is republished, whatever the date says', () => {
    const state = certificationState(
      { ...base, recertifiedAt: new Date('2026-08-20'), recertifiedVersion: 2 },
      90,
      new Date('2026-08-21'),
    )
    expect(state.state).toBe('changed')
    expect(state.stale).toBe(true)
    expect(state.summary).toMatch(/version 2 .* version 3 now/is)
  })

  it('expires when the organization’s interval has passed, and says by how much', () => {
    const state = certificationState(
      { ...base, recertifiedAt: new Date('2026-01-01'), recertifiedVersion: 3 },
      90,
      new Date('2026-08-21'),
    )
    expect(state.state).toBe('expired')
    expect(state.daysOverdue).toBeGreaterThan(140)
    expect(state.summary).toMatch(/more than 90 days ago/i)
  })
})

describe('saying an agent may still do what it does', () => {
  it('asks for a fresh password, because re-attesting a capability is granting one', async () => {
    await withTenant(owner, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        recertifyAgent(ctx, actor, { agentId, note: 'Checked the tools and the clearance.' }),
      ).rejects.toThrow(StepUpRequiredError)
    })
  })

  it('will not take a click with nothing written on it', async () => {
    await withTenant(owner, async (ctx) => {
      const actor = { ...(await loadActor(ctx)), steppedUpAt: new Date() }
      await expect(
        recertifyAgent(ctx, actor, { agentId, note: 'fine' }),
      ).rejects.toThrow(ValidationError)
    })
  })

  it('records who, when, what they read, and against which version', async () => {
    const after = await withTenant(owner, async (ctx) => {
      const actor = { ...(await loadActor(ctx)), steppedUpAt: new Date() }
      return recertifyAgent(ctx, actor, {
        agentId,
        note: 'Still the right tools and the right clearance for what it does.',
      })
    })
    expect(after.recertifiedAt).toBeInstanceOf(Date)
    expect(after.recertifiedByName).not.toBeNull()
    expect(after.recertifiedVersion).toBe(after.publishedVersion)
    expect(after.recertificationNote).toMatch(/right clearance/i)

    const [entry] = await adminSql()<{ diff: Record<string, { from: unknown; to: unknown }> }[]>`
      SELECT diff FROM audit_logs
      WHERE organization_id = ${org.organizationId} AND entity_id = ${agentId}
        AND action = 'agent.recertified'
      ORDER BY occurred_at DESC LIMIT 1`
    // What was stood behind, so the trail says more than that somebody pressed a button.
    expect(entry!.diff.mode!.to).toBe('execute')
    expect(entry!.diff.maxSensitivity!.to).toBe('internal')
  })

  it('is never the assistant vouching for its own capability', async () => {
    await withTenant(owner, async (ctx) => {
      const actor = await loadActor(ctx)
      const asAgent = {
        ...actor,
        steppedUpAt: new Date(),
        type: 'agent' as const,
        agent: {
          agentId,
          agentName: 'Superwork',
          mode: 'execute' as const,
          orgGrant: [],
          denied: [],
          toolGrants: ['*'],
          maxSensitivity: 'internal' as const,
          capabilityDowngraded: false,
        },
      }
      await expect(
        recertifyAgent(ctx, asAgent, { agentId, note: 'I am quite sure I am fine.' }),
      ).rejects.toThrow(/Only a person can confirm/i)
    })
  })

  it('is not something a member may do', async () => {
    await withTenant(member, async (ctx) => {
      const actor = { ...(await loadActor(ctx)), steppedUpAt: new Date() }
      await expect(
        recertifyAgent(ctx, actor, { agentId, note: 'A member should not be able to.' }),
      ).rejects.toThrow(PermissionError)
    })
  })
})

describe('the record the database keeps', () => {
  it('will not hold a date with no name on it, whatever writes the row', async () => {
    await expect(
      adminSql()`
        UPDATE agents SET recertified_at = now(), recertified_by = NULL,
                          recertified_version = 1, recertification_note = 'x'
        WHERE organization_id = ${org.organizationId} AND id = ${agentId}`,
    ).rejects.toThrow(/agents_recertification_attributed/)
  })

  it('will not take a signature from another organization', async () => {
    const other = await createTenant('agent-recert-other')
    try {
      await expect(
        adminSql()`
          UPDATE agents SET recertified_at = now(), recertified_by = ${other.ownerId},
                            recertified_version = 1, recertification_note = 'Not from here.'
          WHERE organization_id = ${org.organizationId} AND id = ${agentId}`,
      ).rejects.toThrow(/member of the same organization/i)
    } finally {
      await destroyTenant('agent-recert-other')
    }
  })

  it('refuses an interval that means never, and one that means nothing', async () => {
    await withTenant(owner, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        setMonitoringPolicy(ctx, actor, {
          agentRecertificationDays: 3,
          reason: 'Too short to be a review.',
        }),
      ).rejects.toThrow(/between 7 and 365/i)
      await expect(
        setMonitoringPolicy(ctx, actor, {
          agentRecertificationDays: 3650,
          reason: 'Ten years is not a policy.',
        }),
      ).rejects.toThrow(/between 7 and 365/i)
    })
  })

  it('and refuses it in the row as well, not only in the function', async () => {
    await expect(
      adminSql()`
        INSERT INTO monitoring_policies (organization_id, agent_recertification_days, created_by)
        VALUES (${org.organizationId}, 3650, ${org.ownerId})`,
    ).rejects.toThrow(/monitoring_recertification_sane/)
  })

  it('keeps the organization’s own interval, and hands back the schema default until it is set', async () => {
    const before = await withTenant(owner, async (ctx) => monitoringPolicy(ctx))
    expect(before.agentRecertificationDays).toBe(90)

    await withTenant(owner, async (ctx) =>
      setMonitoringPolicy(ctx, await loadActor(ctx), {
        agentRecertificationDays: 30,
        reason: 'We review what our agents may do every month.',
      }),
    )
    const after = await withTenant(owner, async (ctx) => monitoringPolicy(ctx))
    expect(after.agentRecertificationDays).toBe(30)
  })
})

describe('what a stale attestation costs', () => {
  /**
   * Not the agent — the *unattended* mode. Everything short of autopilot goes on working, and a
   * person is back in the loop for the rest. Blocking a stale agent outright would be a policy
   * this product does not get to invent on an organization's behalf; withholding the one mode
   * whose premise is that somebody signed off recently is the same rule stated where it bites.
   */
  it('is autopilot, and nothing else', async () => {
    const unattended = await seedAgent('recert-autopilot', 'autopilot')
    const agent = await withTenant(owner, async (ctx) => getAgent(ctx, await loadActor(ctx), unattended))
    const state = certificationState(agent, 90)
    expect(state.state).toBe('never')
    expect(state.stale).toBe(true)

    // The mode on the row is untouched: the ceiling is decided per run, so recertifying
    // restores it without anybody editing the agent.
    expect(agent.mode).toBe('autopilot')
  })
})
