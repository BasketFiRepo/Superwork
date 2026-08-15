import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  agentGrants,
  monitoringPolicy,
  removeAgentGrant,
  setAgentGrant,
  setMonitoringPolicy,
} from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('monitoring'),
    nudgeBudgetPerPersonPerDay: z.number().int().min(0).max(20).optional(),
    noSurprisesReviewHours: z.number().int().min(1).max(168).optional(),
    reason: z.string().min(4).max(500),
  }),
  z.object({
    action: z.literal('grant'),
    capability: z.string().min(2).max(40),
    toolPattern: z.string().min(1).max(80),
    effect: z.enum(['allow', 'deny']),
    maxSensitivity: z.enum(['public', 'internal', 'confidential', 'restricted']).optional(),
    departmentId: z.string().uuid().nullish(),
    reason: z.string().min(4).max(500),
  }),
  z.object({ action: z.literal('remove_grant'), id: z.string().uuid(), reason: z.string().min(4).max(500) }),
])

export async function GET() {
  const session = await requireSession()
  try {
    const payload = await withActor(session, async (ctx, actor) => ({
      monitoring: await monitoringPolicy(ctx, actor),
      grants: await agentGrants(ctx, actor),
    }))
    return NextResponse.json(payload)
  } catch (error) {
    return errorResponse(error, 'Not permitted.')
  }
}

/**
 * The controls the agent's own refusal has always pointed at. Changing what agents may do
 * asks for the password again (§4.1); tightening how hard people may be chased does not,
 * because that direction only ever protects somebody.
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
    const payload = await withActor(session, async (ctx, actor) => {
      if (body.action === 'monitoring') {
        return {
          monitoring: await setMonitoringPolicy(ctx, actor, {
            nudgeBudgetPerPersonPerDay: body.nudgeBudgetPerPersonPerDay,
            noSurprisesReviewHours: body.noSurprisesReviewHours,
            reason: body.reason,
          }),
        }
      }
      if (body.action === 'grant') {
        return {
          grants: await setAgentGrant(ctx, actor, {
            capability: body.capability,
            toolPattern: body.toolPattern,
            effect: body.effect,
            maxSensitivity: body.maxSensitivity,
            departmentId: body.departmentId,
            reason: body.reason,
          }),
        }
      }
      return { grants: await removeAgentGrant(ctx, actor, { id: body.id, reason: body.reason }) }
    })
    return NextResponse.json(payload)
  } catch (error) {
    return errorResponse(error)
  }
}
