import { NextResponse } from 'next/server'
import { z } from 'zod'
import { approvalPolicies, savePolicy, setPolicyEnabled } from '@superwork/core'
import { allTools } from '@superwork/tools'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Rule = z.object({
  match: z.object({
    tools: z.array(z.string().max(120)).max(20).optional(),
    minWrites: z.number().int().min(1).max(10_000).optional(),
    minRisk: z.enum(['read', 'low', 'high']).optional(),
    actorType: z.enum(['user', 'agent']).optional(),
    mode: z.enum(['ask', 'assist', 'execute', 'autopilot']).optional(),
  }),
  require: z
    .object({
      approverRole: z.enum(['owner', 'admin', 'manager', 'member', 'viewer', 'guest', 'service']).optional(),
      slaHours: z.number().int().min(1).max(168).optional(),
    })
    .optional(),
  effect: z.enum(['require', 'deny']),
})

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    name: z.string().min(3).max(120),
    description: z.string().max(500).optional(),
    rule: Rule,
    priority: z.number().int().min(1).max(1000).optional(),
  }),
  z.object({
    action: z.literal('toggle'),
    policyId: z.string().uuid(),
    enabled: z.boolean(),
    reason: z.string().min(8).max(500),
  }),
])

export async function GET() {
  const session = await requireSession()
  try {
    const policies = await withActor(session, (ctx) => approvalPolicies(ctx))
    return NextResponse.json({ policies })
  } catch (error) {
    return errorResponse(error, 'Not permitted.')
  }
}

/**
 * Both directions need step-up. Adding a rule only tightens, so it does not strictly need
 * one — but it arrives through the same screen as turning a rule off, and a control that
 * asks sometimes teaches people to click through when it does (§4.1).
 */
export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That could not be read.' }, { status: 400 })
  }
  // Bound outside the closure: narrowing a property access does not survive into a callback.
  const body = parsed.data
  try {
    const policies = await withActor(session, async (ctx, actor) => {
      if (body.action === 'create') {
        await savePolicy(
          ctx,
          actor,
          {
            name: body.name,
            description: body.description ?? null,
            rule: body.rule,
            priority: body.priority,
          },
          allTools().map((tool) => tool.name),
        )
      } else {
        await setPolicyEnabled(ctx, actor, {
          policyId: body.policyId,
          enabled: body.enabled,
          reason: body.reason,
        })
      }
      return approvalPolicies(ctx)
    })
    return NextResponse.json({ policies })
  } catch (error) {
    return errorResponse(error)
  }
}
