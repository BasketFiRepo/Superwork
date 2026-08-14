import { NextResponse } from 'next/server'
import { createLegalEntity, recordConsultation, setJurisdiction, type JurisdictionProfile } from '@superwork/core'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const session = await requireSession()
  const body = await request.json().catch(() => ({}))

  try {
    if (body.action === 'create_entity') {
      const entity = await withActor(session, (ctx, actor) =>
        createLegalEntity(ctx, actor, {
          name: String(body.name ?? ''),
          country: String(body.country ?? 'DE'),
        }),
      )
      return NextResponse.json(entity)
    }

    if (body.action === 'set_profile') {
      await withActor(session, (ctx, actor) =>
        setJurisdiction(ctx, actor, {
          legalEntityId: String(body.legalEntityId ?? ''),
          profile: String(body.profile ?? 'works_council') as JurisdictionProfile,
          justification: String(body.justification ?? ''),
          approvedBy: body.approvedBy ?? null,
        }),
      )
      return NextResponse.json({ ok: true })
    }

    if (body.action === 'record_consultation') {
      await withActor(session, (ctx, actor) =>
        recordConsultation(ctx, actor, {
          legalEntityId: String(body.legalEntityId ?? ''),
          status: body.status,
          reference: body.reference ?? null,
        }),
      )
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'That could not be recorded.' },
      { status: 400 },
    )
  }
}
