import { NextResponse } from 'next/server'
import { z } from 'zod'
import { detectDuplicateContacts, mergeContacts, rejectMergeCandidate } from '@superwork/core'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

const Body = z.object({
  action: z.enum(['merge', 'reject', 'detect']),
  candidateId: z.string().uuid().optional(),
  keep: z.record(z.enum(['primary', 'duplicate'])).optional(),
})

export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Could not read the request.' }, { status: 400 })

  try {
    const result = await withActor(session, async (ctx, actor) => {
      if (parsed.data.action === 'detect') return { detected: await detectDuplicateContacts(ctx, actor) }
      if (!parsed.data.candidateId) throw new Error('A candidate is required.')
      if (parsed.data.action === 'reject') {
        await rejectMergeCandidate(ctx, actor, parsed.data.candidateId)
        return { rejected: true }
      }
      const contact = await mergeContacts(ctx, actor, {
        candidateId: parsed.data.candidateId,
        keep: parsed.data.keep ?? {},
      })
      return { merged: contact.id }
    })
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'That merge could not be applied.' },
      { status: 400 },
    )
  }
}
