import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePools, withTenant } from '@superwork/db'
import { asAgent, can, loadActor } from '@superwork/auth'
import {
  activateCustomTool,
  activeCustomTools,
  isPrivateHost,
  listCustomTools,
  reviewHost,
  revokeHost,
  saveCustomTool,
  validate,
  ValidationError,
  type SaveCustomToolInput,
} from '@superwork/core'
import { compose, customToolsFor } from '@superwork/tools'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Admin-authored HTTP tools (§22).
 *
 * The whole feature rests on one sentence: a custom tool must not be a permission bypass.
 * These assert the ways it could become one — an unreviewed host, a private address, a
 * credential in a form field, a permission the roles never granted, an undeclared argument
 * reaching the request, a tool escaping into another tenant's registry — and that each is
 * refused rather than merely discouraged.
 */

let org: TenantFixture
let other: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
/**
 * Reviewing a host and activating a tool require step-up authentication (§4.1), so the
 * admin flows below run on a session that has just re-authenticated. `session` stays
 * un-stepped-up, which is what the rest of the suite reads from.
 */
let confirmed: { organizationId: string; userId: string; timezone: string; steppedUpAt: Date }

const DEFINITION: SaveCustomToolInput = {
  name: 'lookup_order@v1',
  description: 'Look up an order in the ERP by its order number.',
  method: 'GET',
  urlTemplate: 'https://erp.example.com/api/orders/{orderNumber}',
  parameters: [
    { name: 'orderNumber', type: 'string', in: 'path', required: true, description: 'The order number.' },
    { name: 'expand', type: 'string', in: 'query', required: false, description: 'Extra fields to include.' },
  ],
  headers: {},
  riskTier: 'read',
  requiredPermissions: ['integration:read:org'],
}

beforeAll(async () => {
  org = await createTenant('ctools')
  other = await createTenant('ctools2')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
  confirmed = { ...session, steppedUpAt: new Date() }
})

afterAll(async () => {
  await destroyTenant('ctools')
  await destroyTenant('ctools2')
  await closePools()
})

describe('what a definition may say', () => {
  it('refuses anything that is not https', () => {
    expect(() => validate({ ...DEFINITION, urlTemplate: 'http://erp.example.com/api' })).toThrow(/https/i)
  })

  it('refuses private and link-local addresses', () => {
    for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.9', '169.254.169.254', 'db.internal']) {
      expect(isPrivateHost(host)).toBe(true)
    }
    expect(isPrivateHost('erp.example.com')).toBe(false)
    expect(() => validate({ ...DEFINITION, urlTemplate: 'https://169.254.169.254/latest/meta-data' })).toThrow(
      /private or link-local/i,
    )
  })

  it('refuses a literal credential in a header', () => {
    expect(() => validate({ ...DEFINITION, headers: { Authorization: 'Bearer sk-live-1234' } })).toThrow(/secret/i)
    expect(() => validate({ ...DEFINITION, headers: { Authorization: '${ERP_TOKEN}' } })).not.toThrow()
  })

  it('refuses a permission the roles do not grant', () => {
    expect(() => validate({ ...DEFINITION, requiredPermissions: ['settings:update:org'] })).toThrow(/not one/i)
  })

  it('refuses a URL placeholder that no parameter declares', () => {
    expect(() =>
      validate({ ...DEFINITION, urlTemplate: 'https://erp.example.com/api/orders/{secretId}' }),
    ).toThrow(/no parameter of that name/i)
  })

  it('refuses to call a write a read', () => {
    expect(() => validate({ ...DEFINITION, method: 'POST' })).toThrow(/not a read/i)
  })
})

describe('the reviewed host list', () => {
  it('will not activate a tool whose host nobody reviewed', async () => {
    const id = await withTenant(confirmed, async (ctx) => {
      const tool = await saveCustomTool(ctx, await loadActor(ctx), DEFINITION)
      return tool.id
    })

    await expect(
      withTenant(confirmed, async (ctx) => activateCustomTool(ctx, await loadActor(ctx), id)),
    ).rejects.toThrow(/nobody has reviewed/i)

    const active = await withTenant(confirmed, (ctx) => activeCustomTools(ctx))
    expect(active).toHaveLength(0)
  })

  it('activates once a named person has reviewed the host, and records who', async () => {
    const tool = await withTenant(confirmed, async (ctx) => {
      const actor = await loadActor(ctx)
      await reviewHost(ctx, actor, { host: 'erp.example.com', reason: 'Our order system. Read-only lookups.' })
      const [existing] = await listCustomTools(ctx, actor)
      return activateCustomTool(ctx, actor, existing!.id)
    })
    expect(tool.status).toBe('active')
    expect(tool.approvedByName).toBeTruthy()
    expect(tool.approvedAt).toBeTruthy()
  })

  it('disables every tool on a host the moment the host is revoked', async () => {
    const disabled = await withTenant(confirmed, async (ctx) => revokeHost(ctx, await loadActor(ctx), 'erp.example.com'))
    expect(disabled).toBe(1)
    expect(await withTenant(confirmed, (ctx) => activeCustomTools(ctx))).toHaveLength(0)

    // Put it back for the tests below.
    await withTenant(confirmed, async (ctx) => {
      const actor = await loadActor(ctx)
      await reviewHost(ctx, actor, { host: 'erp.example.com', reason: 'Re-reviewed.' })
      const [existing] = await listCustomTools(ctx, actor)
      await activateCustomTool(ctx, actor, existing!.id)
    })
  })

  it('refuses a wildcard or an internal name outright', async () => {
    await expect(
      withTenant(confirmed, async (ctx) => reviewHost(ctx, await loadActor(ctx), { host: '*.example.com', reason: 'x' })),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(
      withTenant(confirmed, async (ctx) =>
        reviewHost(ctx, await loadActor(ctx), { host: 'db.internal', reason: 'internal db' }),
      ),
    ).rejects.toThrow(/private network/i)
  })
})

describe('the tool the registry builds', () => {
  it('is an ordinary tool, gated by the same policy engine', async () => {
    const { tool, allowedForOwner, allowedForViewer } = await withTenant(confirmed, async (ctx) => {
      const built = (await customToolsFor(ctx)).get('lookup_order@v1')!
      const owner = await loadActor(ctx, org.ownerId)
      const viewer = await loadActor(ctx, org.viewerId)
      const context = { type: 'integration', organizationId: ctx.organizationId, riskTier: built.riskTier }
      return {
        tool: built,
        allowedForOwner: can(owner, 'integration:read', context).allow,
        allowedForViewer: can(viewer, 'integration:read', context).allow,
      }
    })

    expect(tool.name).toBe('lookup_order@v1')
    // Never reversible: Superwork cannot construct an inverse for somebody else's system.
    expect(tool.reversible).toBe(false)
    expect(tool.preview).toBeTypeOf('function')
    expect(allowedForOwner).toBe(true)
    expect(allowedForViewer).toBe(false)
  })

  it('drops an argument the definition never declared', async () => {
    const tool = await withTenant(confirmed, async (ctx) => (await customToolsFor(ctx)).get('lookup_order@v1')!)
    const parsed = tool.inputSchema.safeParse({ orderNumber: 'A-1', callbackUrl: 'https://evil.example/steal' })
    expect(parsed.success).toBe(false)
  })

  it('encodes arguments as data at every position', async () => {
    const definition = await withTenant(confirmed, async (ctx) => {
      const [existing] = await listCustomTools(ctx, await loadActor(ctx))
      return existing!
    })
    const request = compose(definition, { orderNumber: '../../admin?x=1', expand: 'a b&c' })
    expect(request.url).toContain('%2F')
    expect(request.url).not.toContain('../..')
    expect(request.url).toContain('expand=a+b%26c')
  })

  it('runs credential-free, and says the response was simulated', async () => {
    const result = await withTenant(confirmed, async (ctx) => {
      const actor = await loadActor(ctx)
      const agent = await asAgent(ctx, actor, {
        agentId: 'test',
        agentName: 'Test',
        mode: 'execute',
        toolGrants: ['*'],
        maxSensitivity: 'internal',
      })
      const tool = (await customToolsFor(ctx)).get('lookup_order@v1')!
      return tool.execute(
        { orderNumber: 'A-1' },
        {
          organizationId: ctx.organizationId,
          principalUserId: actor.userId,
          agentRunId: org.runId,
          stepId: 'step',
          idempotencyKey: 'key',
          traceId: 'trace',
          tenantDb: ctx,
          policy: agent,
          dryRun: false,
        },
      )
    })
    expect(result.ok).toBe(true)
    expect((result as { value: { simulated: boolean } }).value.simulated).toBe(true)
  })

  it('never appears in another organization’s registry', async () => {
    const theirs = await withTenant(
      { organizationId: other.organizationId, userId: other.ownerId, timezone: 'Europe/London' },
      (ctx) => customToolsFor(ctx),
    )
    expect(theirs.has('lookup_order@v1')).toBe(false)
    expect(theirs.size).toBe(0)
  })
})
