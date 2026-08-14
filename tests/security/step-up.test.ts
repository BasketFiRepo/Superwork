import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { asAgent, loadActor, login, stepUp, STEP_UP_MAX_FAILURES } from '@superwork/auth'
import {
  activateCustomTool,
  assertSteppedUp,
  isSteppedUp,
  reviewHost,
  saveCustomTool,
  STEP_UP_MAX_AGE_MS,
  StepUpRequiredError,
  PermissionError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Step-up authentication (§4.1).
 *
 * What it defends against is a session, not a password: an unlocked laptop, a lifted
 * cookie, a tab left open in a shared room. The properties worth asserting are that the
 * proof is required where it is claimed, that it goes stale, that it belongs to one session
 * rather than to the person, that an agent can never supply it, that it is recorded, and
 * that a stolen session cannot be turned into a password oracle.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
const PASSWORD = 'fixture'

function actorAt(steppedUpAt: Date | null) {
  return {
    type: 'user' as const,
    userId: org.ownerId,
    organizationId: org.organizationId,
    role: 'owner' as const,
    displayName: 'Owner',
    departmentIds: [],
    teamIds: [],
    extraPermissions: [],
    steppedUpAt,
  }
}

beforeAll(async () => {
  org = await createTenant('stepup')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
})

afterAll(async () => {
  await destroyTenant('stepup')
  await closePools()
})

describe('the freshness rule', () => {
  it('counts a recent confirmation and not an old one', () => {
    expect(isSteppedUp(actorAt(new Date()))).toBe(true)
    expect(isSteppedUp(actorAt(new Date(Date.now() - STEP_UP_MAX_AGE_MS + 5_000)))).toBe(true)
    expect(isSteppedUp(actorAt(new Date(Date.now() - STEP_UP_MAX_AGE_MS - 1_000)))).toBe(false)
    expect(isSteppedUp(actorAt(null))).toBe(false)
  })

  it('says what to do rather than "not permitted"', () => {
    try {
      assertSteppedUp(actorAt(null), 'custom_tool.activate')
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(StepUpRequiredError)
      expect((error as StepUpRequiredError).message).toMatch(/confirm your password/i)
      expect((error as StepUpRequiredError).action).toBe('custom_tool.activate')
    }
  })

  it('cannot be satisfied by an agent, however it was configured', async () => {
    const agent = await withTenant(session, async (ctx) =>
      asAgent(ctx, await loadActor(ctx), {
        agentId: 'test',
        agentName: 'Test',
        mode: 'autopilot',
        toolGrants: ['*'],
        maxSensitivity: 'restricted',
      }),
    )
    // Even handed a fresh timestamp, an agent has no keyboard to be sitting at.
    const withProof = { ...agent, steppedUpAt: new Date() }
    expect(() => assertSteppedUp(withProof, 'agent.publish')).toThrow(/only a person can confirm/i)
    try {
      assertSteppedUp(withProof, 'agent.publish')
    } catch (error) {
      expect(error).toBeInstanceOf(PermissionError)
      expect(error).not.toBeInstanceOf(StepUpRequiredError)
    }
  })
})

describe('proving it', () => {
  it('stamps the session, and a wrong password does not', async () => {
    const result = await login(`owner.stepup@fixture.example`, PASSWORD)
    expect(result).not.toBeNull()

    const wrong = await stepUp(result!.token, 'not-the-password')
    expect(wrong.ok).toBe(false)

    const right = await stepUp(result!.token, PASSWORD)
    expect(right.ok).toBe(true)

    const [row] = await adminSql()<{ stepped_up_at: Date | null; step_up_failures: number }[]>`
      SELECT stepped_up_at, step_up_failures FROM sessions WHERE user_id = ${org.ownerId}
      ORDER BY created_at DESC LIMIT 1`
    expect(row?.stepped_up_at).toBeTruthy()
    // A success clears the failure count; otherwise one typo a week would lock somebody out.
    expect(row?.step_up_failures).toBe(0)
  })

  it('is not granted by signing in — that is a different proof about a different moment', async () => {
    const result = await login(`owner.stepup@fixture.example`, PASSWORD)
    expect(result!.identity.steppedUpAt).toBeNull()
  })

  it('belongs to one session, not to the person', async () => {
    const first = await login(`owner.stepup@fixture.example`, PASSWORD)
    const second = await login(`owner.stepup@fixture.example`, PASSWORD)
    await stepUp(first!.token, PASSWORD)

    const { resolveSession } = await import('@superwork/auth')
    expect((await resolveSession(first!.token))?.steppedUpAt).toBeTruthy()
    // The same human, another tab. Confirming in one is not confirming in the other.
    expect((await resolveSession(second!.token))?.steppedUpAt).toBeNull()
  })

  it('will not become a password oracle for a stolen session', async () => {
    const result = await login(`owner.stepup@fixture.example`, PASSWORD)
    for (let attempt = 0; attempt < STEP_UP_MAX_FAILURES; attempt += 1) {
      await stepUp(result!.token, `guess-${attempt}`)
    }
    const locked = await stepUp(result!.token, PASSWORD)
    expect(locked.ok).toBe(false)
    expect(locked.ok === false && locked.reason).toMatch(/too many failed attempts/i)

    // The lock is narrow: the session still works for everything it could already do.
    const { resolveSession } = await import('@superwork/auth')
    expect(await resolveSession(result!.token)).not.toBeNull()
  })
})

describe('where it is required', () => {
  it('refuses to review a host without it, and allows it with', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        reviewHost(ctx, await loadActor(ctx), { host: 'erp.example.com', reason: 'Order system.' }),
      ),
    ).rejects.toBeInstanceOf(StepUpRequiredError)

    const reviewed = await withTenant({ ...session, steppedUpAt: new Date() }, async (ctx) =>
      reviewHost(ctx, await loadActor(ctx), { host: 'erp.example.com', reason: 'Order system.' }),
    )
    expect(reviewed.host).toBe('erp.example.com')
  })

  it('refuses to activate a tool without it', async () => {
    const toolId = await withTenant({ ...session, steppedUpAt: new Date() }, async (ctx) => {
      const tool = await saveCustomTool(ctx, await loadActor(ctx), {
        name: 'lookup_order@v1',
        description: 'Look up an order in the ERP by its number.',
        method: 'GET',
        urlTemplate: 'https://erp.example.com/api/orders/{orderNumber}',
        parameters: [
          { name: 'orderNumber', type: 'string', in: 'path', required: true, description: 'The order number.' },
        ],
        headers: {},
        riskTier: 'read',
        requiredPermissions: ['integration:read:org'],
      })
      return tool.id
    })

    await expect(
      withTenant(session, async (ctx) => activateCustomTool(ctx, await loadActor(ctx), toolId)),
    ).rejects.toBeInstanceOf(StepUpRequiredError)

    // Saving a draft does not need it: a draft reaches nothing.
    const stillDraft = await withTenant({ ...session, steppedUpAt: new Date() }, async (ctx) => {
      const { getCustomTool } = await import('@superwork/core')
      return getCustomTool(ctx, await loadActor(ctx), toolId)
    })
    expect(stillDraft.status).toBe('draft')

    const active = await withTenant({ ...session, steppedUpAt: new Date() }, async (ctx) =>
      activateCustomTool(ctx, await loadActor(ctx), toolId),
    )
    expect(active.status).toBe('active')
  })

  it('records the proof on the audit row, from the context rather than the caller', async () => {
    const [stamped] = await adminSql()<{ stepped_up_at: Date | null }[]>`
      SELECT stepped_up_at FROM audit_logs
      WHERE organization_id = ${org.organizationId} AND action = 'custom_tool.activated'
      ORDER BY occurred_at DESC LIMIT 1`
    expect(stamped?.stepped_up_at).toBeTruthy()

    // The column is a fact about the request, not a restatement of which rule applied: a
    // session that had not re-authenticated leaves it null, so it can be relied on.
    await withTenant(session, async (ctx) =>
      saveCustomTool(ctx, await loadActor(ctx), {
        name: 'lookup_invoice@v1',
        description: 'Look up an invoice in the ERP by its number.',
        method: 'GET',
        urlTemplate: 'https://erp.example.com/api/invoices/{invoiceNumber}',
        parameters: [
          { name: 'invoiceNumber', type: 'string', in: 'path', required: true, description: 'The invoice number.' },
        ],
        headers: {},
        riskTier: 'read',
        requiredPermissions: ['integration:read:org'],
      }),
    )
    const [unstamped] = await adminSql()<{ stepped_up_at: Date | null }[]>`
      SELECT stepped_up_at FROM audit_logs
      WHERE organization_id = ${org.organizationId} AND action = 'custom_tool.saved'
      ORDER BY occurred_at DESC LIMIT 1`
    expect(unstamped?.stepped_up_at).toBeNull()
  })
})
