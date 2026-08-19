import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  activateCustomTool,
  CUSTOM_TOOL_PERMISSIONS,
  listCustomTools,
  listHosts,
  reviewHost,
  revokeHost,
  saveCustomTool,
  setCustomToolLimits,
  setCustomToolStatus,
} from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Parameter = z.object({
  name: z.string().min(1).max(40),
  type: z.enum(['string', 'number', 'boolean']),
  in: z.enum(['path', 'query', 'body']),
  required: z.boolean(),
  description: z.string().max(300),
})

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'),
    id: z.string().uuid().optional(),
    name: z.string().min(3).max(60),
    description: z.string().min(10).max(500),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    urlTemplate: z.string().min(8).max(500),
    parameters: z.array(Parameter).max(20).default([]),
    headers: z.record(z.string().max(300)).default({}),
    riskTier: z.enum(['read', 'low', 'high']),
    requiredPermissions: z.array(z.enum(CUSTOM_TOOL_PERMISSIONS)).min(1),
    timeoutMs: z.number().int().min(500).max(30_000).optional(),
    redactions: z.array(z.string().max(40)).max(20).optional(),
  }),
  z.object({ action: z.literal('activate'), id: z.string().uuid() }),
  // The budgets (ADR 0050). Bounds are the repository's to state; this checks the shape.
  z.object({
    action: z.literal('limits'),
    id: z.string().uuid(),
    perRunLimit: z.number().int(),
    perHourLimit: z.number().int(),
    reason: z.string().min(4).max(500),
  }),
  z.object({ action: z.literal('disable'), id: z.string().uuid() }),
  z.object({ action: z.literal('review_host'), host: z.string().min(3).max(253), reason: z.string().min(3).max(300) }),
  z.object({ action: z.literal('revoke_host'), host: z.string().min(3).max(253) }),
])

export async function GET() {
  const session = await requireSession()
  try {
    const payload = await withActor(session, async (ctx, actor) => ({
      tools: await listCustomTools(ctx, actor),
      hosts: await listHosts(ctx, actor),
    }))
    return NextResponse.json(payload)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Not permitted.' },
      { status: 403 },
    )
  }
}

/**
 * Everything an admin can do to a custom tool (§22). The validation that matters — https
 * only, no private addresses, no literal credentials, only declared parameters, only
 * permissions the roles actually grant — lives in the repository, so the API and the tests
 * check the same rules.
 */
export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That could not be read.' }, { status: 400 })
  }

  try {
    const result = await withActor(session, async (ctx, actor) => {
      switch (parsed.data.action) {
        case 'save':
          return { tool: await saveCustomTool(ctx, actor, parsed.data) }
        case 'activate':
          return { tool: await activateCustomTool(ctx, actor, parsed.data.id) }
        case 'limits':
          return { tool: await setCustomToolLimits(ctx, actor, parsed.data) }
        case 'disable':
          return { tool: await setCustomToolStatus(ctx, actor, parsed.data.id, 'disabled') }
        case 'review_host':
          return { host: await reviewHost(ctx, actor, parsed.data) }
        case 'revoke_host':
          return { disabled: await revokeHost(ctx, actor, parsed.data.host) }
      }
    })
    return NextResponse.json(result)
  } catch (error) {
    return errorResponse(error)
  }
}
