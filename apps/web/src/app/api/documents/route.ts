import { NextResponse } from 'next/server'
import { z } from 'zod'
import { uploadDocument } from '@superwork/core'
import { errorResponse } from '@/lib/errors'
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
    // Through the one mapper, so a refusal answers 403 and a document filed above the filer's
    // own ceiling answers 400 with the sentence that says why — the screen branches on the
    // class rather than on prose somebody will reword.
    return errorResponse(error, 'That document could not be indexed.')
  }
}
