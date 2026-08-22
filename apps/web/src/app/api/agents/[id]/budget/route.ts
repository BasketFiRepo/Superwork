import { NextResponse } from 'next/server'
import { z } from 'zod'
import { setAgentBudget } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * What an agent may do on a single run (§5.5, ADR 0077).
 *
 * The repository is the authority on the ceiling, on the reason, and on loosening arriving as a
 * `StepUpRequiredError` that becomes the password prompt at the caller. This layer only decides
 * that the request is well formed — and `.strict()` matters here: a key nobody enforces would be
 * a setting that silently does nothing.
 */
const Body = z
  .object({
    maxSteps: z.number().int().min(1).max(10_000).nullish(),
    maxToolCalls: z.number().int().min(1).max(10_000).nullish(),
    maxCostCents: z.number().int().min(1).max(1_000_000).nullish(),
    maxWallClockMs: z.number().int().min(1).max(86_400_000).nullish(),
    reason: z.string().min(8).max(500),
  })
  .strict()

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That could not be read.' }, { status: 400 })
  }
  const { reason, ...budget } = parsed.data
  try {
    const agent = await withActor(session, (ctx, actor) =>
      setAgentBudget(ctx, actor, {
        agentId: id,
        budget: Object.fromEntries(
          Object.entries(budget).filter(([, value]) => typeof value === 'number'),
        ) as Record<string, number>,
        reason,
      }),
    )
    return NextResponse.json({ agent })
  } catch (error) {
    return errorResponse(error)
  }
}
