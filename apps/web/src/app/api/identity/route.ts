import { NextResponse } from 'next/server'
import { setResidency, updateIdentitySettings } from '@superwork/core'
import type { Role } from '@superwork/db'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const session = await requireSession()
  const body = await request.json().catch(() => ({}))
  try {
    if (body.region) {
      await withActor(session, (ctx, actor) => setResidency(ctx, actor, String(body.region)))
      return NextResponse.json({ ok: true })
    }
    const settings = await withActor(session, (ctx, actor) =>
      updateIdentitySettings(ctx, actor, {
        ssoEnabled: Boolean(body.ssoEnabled),
        ssoProvider: body.ssoProvider ?? null,
        // Where the directory publishes the key that signs an assertion (ADR 0087). The
        // repository refuses anything that is not https, and refuses to enable SSO without one.
        ssoMetadataUrl: body.ssoMetadataUrl ?? null,
        verifiedDomains: Array.isArray(body.verifiedDomains) ? body.verifiedDomains.map(String) : [],
        jitProvisioning: Boolean(body.jitProvisioning),
        defaultRole: (body.defaultRole ?? 'member') as Role,
        scimEnabled: Boolean(body.scimEnabled),
      }),
    )
    return NextResponse.json(settings)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'That could not be saved.' },
      { status: 400 },
    )
  }
}
