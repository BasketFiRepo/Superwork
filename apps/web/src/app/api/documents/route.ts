import { NextResponse } from 'next/server'
import { z } from 'zod'
import { uploadDocument } from '@superwork/core'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.object({
  title: z.string().min(1).max(300),
  body: z.string().min(1).max(400_000),
  docType: z.string().max(40).default('document'),
  untrusted: z.boolean().default(false),
})

export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'That document could not be read.' }, { status: 400 })

  try {
    const { ingest } = await withActor(session, (ctx, actor) =>
      uploadDocument(ctx, actor, {
        title: parsed.data.title,
        body: parsed.data.body,
        docType: parsed.data.docType,
        untrusted: parsed.data.untrusted,
      }),
    )
    return NextResponse.json({
      status: ingest.status,
      chunks: ingest.chunks,
      sensitivity: ingest.sensitivity,
      quarantineReason: ingest.quarantineReason ?? null,
      warnings: ingest.verification.warnings,
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'That document could not be indexed.' },
      { status: 400 },
    )
  }
}
