import { NextResponse } from 'next/server'
import { issueApiKey, revokeApiKey, type ApiScope } from '@superwork/auth'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const session = await requireSession()
  const body = await request.json().catch(() => ({}))
  try {
    const issued = await withActor(session, (ctx, actor) =>
      issueApiKey(ctx, actor, {
        name: String(body.name ?? 'Untitled key'),
        scopes: (body.scopes ?? []) as ApiScope[],
        rateLimitPerMinute: Number(body.rateLimitPerMinute ?? 60),
      }),
    )
    // The secret is returned exactly once, here, and never stored in a readable form.
    return NextResponse.json(issued)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'That key could not be issued.' },
      { status: 400 },
    )
  }
}

export async function DELETE(request: Request) {
  const session = await requireSession()
  const body = await request.json().catch(() => ({}))
  try {
    await withActor(session, (ctx, actor) => revokeApiKey(ctx, actor, String(body.keyId ?? '')))
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'That key could not be revoked.' },
      { status: 400 },
    )
  }
}
