import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePools, withTenant } from '@superwork/db'
import { checkRateLimit, issueApiKey, loadActor, resolveApiKey, revokeApiKey } from '@superwork/auth'
import {
  createAgentDraft,
  decideChange,
  getAgent,
  listAgentVersions,
  personaSnapshot,
  requestChange,
  rollbackAgent,
  setAgentStatus,
} from '@superwork/core'
import { checkAutopilotCaps, digestNarrative, simulateAgent, type DigestFacts } from '@superwork/agent'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Phase 3's second acceptance criterion (§24): "an agent can be created, permissioned,
 * simulated against last week's data, and published through change control without an
 * engineer."
 *
 * The properties worth asserting are the ones that make change control real: a new agent
 * can do nothing, a widening is visible, the requester cannot approve their own change,
 * a published version can be rolled back, and the caps stop unattended work.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let agentId: string

beforeAll(async () => {
  org = await createTenant('studio')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }

  // The fixture's second admin-capable person: change control needs two people.
  await withTenant(session, async (ctx) => {
    await ctx.sql`
      UPDATE memberships SET role = 'admin'
      WHERE organization_id = ${ctx.organizationId} AND user_id = ${org.memberId}`
  })

  agentId = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx, org.ownerId)
    const agent = await createAgentDraft(ctx, actor, {
      key: 'sla_watch',
      name: 'SLA Watch',
      purpose: 'Chase the customers who have gone quiet and draft replies.',
    })
    return agent.agentId
  })
})

afterAll(async () => {
  await destroyTenant(org.organizationId)
  await closePools()
})

describe('creating an agent', () => {
  it('starts where it can do the least damage', async () => {
    await withTenant(session, async (ctx) => {
      const agent = await getAgent(ctx, await loadActor(ctx, org.ownerId), agentId)
      expect(agent.status).toBe('draft')
      expect(agent.mode).toBe('ask')
      expect(agent.toolGrants).toEqual([])
    })
  })

  it('cannot be switched on without going through a change', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx, org.ownerId)
      await expect(setAgentStatus(ctx, actor, { agentId, status: 'active' })).rejects.toThrow(/change request/i)
    })
  })

  it('refuses a wildcard grant to anything that can act', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx, org.ownerId)
      const agent = await getAgent(ctx, actor, agentId)
      await expect(
        requestChange(ctx, actor, {
          agentId,
          proposed: { ...personaSnapshot(agent), mode: 'execute', toolGrants: ['*'] },
          justification: 'Give it everything.',
        }),
      ).rejects.toThrow(/may not hold every tool/i)
    })
  })
})

describe('change control', () => {
  let changeId: string

  it('records what widens the agent’s reach', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx, org.ownerId)
      const agent = await getAgent(ctx, actor, agentId)
      const change = await requestChange(ctx, actor, {
        agentId,
        proposed: {
          ...personaSnapshot(agent),
          mode: 'assist',
          toolGrants: ['create_task@v1', 'draft_email@v1'],
          scheduleCron: '0 8 * * 1-5',
        },
        justification: 'Chasing overdue accounts by hand takes an hour a day.',
      })
      changeId = change.id
      expect(change.status).toBe('awaiting_approval')
      const widened = change.diff.filter((field) => field.widens).map((field) => field.field)
      expect(widened).toEqual(expect.arrayContaining(['mode', 'toolGrants']))
    })
  })

  it('will not let the requester approve their own change', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx, org.ownerId)
      await expect(decideChange(ctx, actor, { changeRequestId: changeId, decision: 'approve' })).rejects.toThrow(
        /somebody else has to approve/i,
      )
    })
  })

  it('publishes when a second person approves, and records both names', async () => {
    // Approving publishes, so the approver's session must have re-authenticated (§4.1).
    await withTenant({ ...session, userId: org.memberId, steppedUpAt: new Date() }, async (ctx) => {
      const approver = await loadActor(ctx, org.memberId)
      const published = await decideChange(ctx, approver, {
        changeRequestId: changeId,
        decision: 'approve',
        note: 'Caps look right.',
      })
      expect(published.status).toBe('published')

      const agent = await getAgent(ctx, approver, agentId)
      expect(agent.status).toBe('active')
      expect(agent.mode).toBe('assist')
      expect(agent.toolGrants).toContain('draft_email@v1')

      const versions = await listAgentVersions(ctx, approver, agentId)
      expect(versions).toHaveLength(1)
      expect(versions[0]!.publishedByName).toBeTruthy()
      expect(versions[0]!.secondApproverName).toBeTruthy()
      expect(versions[0]!.publishedByName).not.toBe(versions[0]!.secondApproverName)
    })
  })

  it('rolls back to a version that was already approved', async () => {
    await withTenant({ ...session, steppedUpAt: new Date() }, async (ctx) => {
      const actor = await loadActor(ctx, org.ownerId)
      const versions = await listAgentVersions(ctx, actor, agentId)
      const agent = await rollbackAgent(ctx, actor, {
        agentId,
        versionId: versions[0]!.id,
        reason: 'It was drafting too much.',
      })
      expect(agent.mode).toBe('assist')
    })
  })
})

describe('simulation', () => {
  it('produces proposals without executing anything', async () => {
    const simulation = await simulateAgent(session, { agentId, windowDays: 7, maxOccasions: 1 })

    expect(simulation.totals.occasions).toBe(1)
    expect(simulation.status).toBe('succeeded')

    await withTenant(session, async (ctx) => {
      // The proof that nothing ran: no tool call was written by the simulated run.
      const [row] = await ctx.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM tool_calls t
        JOIN agent_runs r ON r.id = t.run_id
        WHERE t.organization_id = ${ctx.organizationId} AND t.risk_tier <> 'read'`
      expect(Number(row!.count)).toBe(0)

      const [tasks] = await ctx.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM tasks
        WHERE organization_id = ${ctx.organizationId} AND created_by_agent_run_id IS NOT NULL`
      expect(Number(tasks!.count)).toBe(0)
    })
  })
})

describe('autopilot caps', () => {
  it('refuses to start a plan that would cross the daily cap', async () => {
    await withTenant(session, async (ctx) => {
      const verdict = await checkAutopilotCaps(ctx, {
        agentId,
        dailyCap: 2,
        weeklyCapCents: 500,
        plannedActions: 3,
      })
      expect(verdict.allow).toBe(false)
      expect(verdict.reason).toMatch(/against a cap of 2/)
    })
  })

  it('refuses once the weekly spend cap is reached', async () => {
    await withTenant(session, async (ctx) => {
      await ctx.sql`
        INSERT INTO agent_runs (organization_id, principal_user_id, agent_id, mode, status, request, trace_id, cost_cents, is_demo, created_by)
        VALUES (${ctx.organizationId}, ${org.ownerId}, ${agentId}, 'autopilot', 'succeeded',
                'expensive', 'trace-cap', 600, true, ${org.ownerId})`
      const verdict = await checkAutopilotCaps(ctx, {
        agentId,
        dailyCap: 100,
        weeklyCapCents: 500,
        plannedActions: 1,
      })
      expect(verdict.allow).toBe(false)
      expect(verdict.reason).toMatch(/weekly cap/i)
    })
  })

  it('lets an ad-hoc run through — it is attended by definition', async () => {
    await withTenant(session, async (ctx) => {
      const verdict = await checkAutopilotCaps(ctx, {
        agentId: null,
        dailyCap: 1,
        weeklyCapCents: 1,
        plannedActions: 10,
      })
      expect(verdict.allow).toBe(true)
    })
  })
})

describe('the weekly digest', () => {
  const facts: DigestFacts = {
    agentName: 'SLA Watch',
    runs: 4,
    actions: 6,
    byTool: [{ tool: 'create_task', times: 6 }],
    approvalsRequested: 2,
    approvalsApproved: 1,
    approvalsRejected: 1,
    runsUndone: 1,
    failures: 0,
    costCents: 42,
    dailyCap: 5,
    weeklyCapCents: 500,
    capHits: 0,
    peopleAffected: [{ userId: 'u1', name: 'Sarah Lindqvist', items: 3 }],
  }

  it('states no number the facts do not contain', () => {
    const from = new Date('2026-08-03T00:00:00Z')
    const to = new Date('2026-08-10T00:00:00Z')
    const narrative = digestNarrative(facts, from, to, 'Europe/London')

    const allowed = new Set<number>([
      facts.runs,
      facts.actions,
      facts.approvalsRequested,
      facts.approvalsApproved,
      facts.approvalsRejected,
      facts.runsUndone,
      facts.failures,
      facts.dailyCap,
      ...facts.byTool.map((row) => row.times),
      ...facts.peopleAffected.map((person) => person.items),
      // The dates and the two money figures, as they are written.
      2026, 8, 3, 10, 0.42, 5.0, 42, 500, 5,
    ])
    const stated = [...narrative.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]))
    const invented = stated.filter((value) => !allowed.has(value))
    expect(invented, `narrative: ${narrative}`).toEqual([])
  })

  it('tells the owner that the people named can see it', () => {
    const narrative = digestNarrative(facts, new Date(), new Date(), 'Europe/London')
    expect(narrative).toContain('Sarah Lindqvist')
    expect(narrative).toMatch(/can see that this was reported to you/i)
  })
})

describe('API keys', () => {
  it('acts as a person, holds only the scopes it was given, and is shown once', async () => {
    const issued = await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx, org.ownerId)
      return issueApiKey(ctx, actor, { name: 'dashboard', scopes: ['tasks:read'] })
    })

    expect(issued.secret.startsWith(issued.prefix)).toBe(true)

    await withTenant(session, async (ctx) => {
      const [row] = await ctx.sql<{ secret_hash: string }[]>`
        SELECT secret_hash FROM api_keys WHERE organization_id = ${ctx.organizationId} AND id = ${issued.id}`
      // The secret itself is never stored.
      expect(row!.secret_hash).not.toContain(issued.secret)
    })

    const resolved = await resolveApiKey(`Bearer ${issued.secret}`)
    expect(resolved?.organizationId).toBe(org.organizationId)
    expect(resolved?.principalUserId).toBe(org.ownerId)
    expect(resolved?.scopes).toEqual(['tasks:read'])

    expect(await resolveApiKey(`Bearer ${issued.prefix}_wrong`)).toBeNull()
    expect(await resolveApiKey(null)).toBeNull()
  })

  it('stops resolving the moment it is revoked', async () => {
    const issued = await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx, org.ownerId)
      return issueApiKey(ctx, actor, { name: 'temporary', scopes: ['runs:read'] })
    })
    expect(await resolveApiKey(issued.secret)).not.toBeNull()

    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx, org.ownerId)
      await revokeApiKey(ctx, actor, issued.id)
    })
    expect(await resolveApiKey(issued.secret)).toBeNull()
  })

  it('refuses a key with no scopes', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx, org.ownerId)
      await expect(issueApiKey(ctx, actor, { name: 'useless', scopes: [] })).rejects.toThrow(/can do nothing/i)
    })
  })

  it('counts its rate limit from the request log', async () => {
    const issued = await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx, org.ownerId)
      return issueApiKey(ctx, actor, { name: 'busy', scopes: ['tasks:read'], rateLimitPerMinute: 2 })
    })
    const key = (await resolveApiKey(issued.secret))!

    await withTenant(session, async (ctx) => {
      expect((await checkRateLimit(ctx, key)).allow).toBe(true)
      for (let index = 0; index < 2; index += 1) {
        await ctx.sql`
          INSERT INTO api_requests (organization_id, api_key_id, method, path, status, created_by)
          VALUES (${ctx.organizationId}, ${key.keyId}, 'GET', '/api/v1/tasks', 200, ${org.ownerId})`
      }
      const limit = await checkRateLimit(ctx, key)
      expect(limit.allow).toBe(false)
      expect(limit.used).toBe(2)
    })
  })
})
