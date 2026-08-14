import { NextResponse } from 'next/server'
import { z } from 'zod'
import { compileWorkflow } from '@superwork/ai'
import { listWorkflows, saveCompiled } from '@superwork/core'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.object({
  description: z.string().min(8).max(600),
  workflowId: z.string().uuid().optional(),
  ownerUserId: z.string().uuid().optional(),
  /** Compile and show, without saving anything. */
  compileOnly: z.boolean().default(false),
})

export async function GET() {
  const session = await requireSession()
  const workflows = await withActor(session, (ctx, actor) => listWorkflows(ctx, actor))
  return NextResponse.json({ workflows })
}

/**
 * Compiling happens here, never on the client (§10.3). What a person typed is the input;
 * the graph that gets stored is the one this server produced from it, so a hand-crafted
 * request body cannot introduce a node the compiler would not emit.
 */
export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Describe the automation in a sentence or two.' }, { status: 400 })
  }

  const compiled = compileWorkflow(parsed.data.description)
  if (parsed.data.compileOnly) {
    return NextResponse.json({ compiled })
  }
  if (compiled.unsupported) {
    return NextResponse.json({ error: compiled.unsupported, compiled }, { status: 400 })
  }

  try {
    const workflow = await withActor(session, (ctx, actor) =>
      saveCompiled(ctx, actor, {
        description: parsed.data.description,
        compiled,
        ...(parsed.data.workflowId ? { workflowId: parsed.data.workflowId } : {}),
        ...(parsed.data.ownerUserId ? { ownerUserId: parsed.data.ownerUserId } : {}),
      }),
    )
    return NextResponse.json({ workflow, compiled })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'That could not be saved.' },
      { status: 400 },
    )
  }
}
