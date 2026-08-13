import { NextResponse } from 'next/server'
import { connectCapability, disconnectCapability, listConnections, recordHealth } from '@superwork/core'
import {
  capabilityCatalogue,
  chatProvider,
  crmProvider,
  emailProvider,
  financeProvider,
  identityProvider,
  type Capability,
} from '@superwork/integrations'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/** The provider actually resolved for a capability, so a health check is not a fiction. */
function providerFor(capability: Capability) {
  switch (capability) {
    case 'email':
      return emailProvider()
    case 'chat':
      return chatProvider()
    case 'finance':
      return financeProvider()
    case 'crm':
      return crmProvider()
    case 'identity':
      return identityProvider()
    default:
      return null
  }
}

export async function POST(request: Request) {
  const session = await requireSession()
  const body = await request.json().catch(() => ({}))
  const capability = String(body.capability ?? '') as Capability
  const action = String(body.action ?? '')

  const descriptor = capabilityCatalogue().find((entry) => entry.capability === capability)
  if (!descriptor) return NextResponse.json({ error: 'Unknown capability.' }, { status: 400 })

  const provider = providerFor(capability)
  if (!provider) {
    return NextResponse.json(
      { error: `${descriptor.label} has no provider in this build. It is listed so you can see what it would give you.` },
      { status: 400 },
    )
  }

  try {
    if (action === 'disconnect') {
      await withActor(session, (ctx, actor) =>
        disconnectCapability(ctx, actor, capability, String(body.reason ?? '')),
      )
      return NextResponse.json({ ok: true })
    }

    const health = await provider.healthCheck()

    if (action === 'connect') {
      const connection = await withActor(session, (ctx, actor) =>
        connectCapability(ctx, actor, {
          capability,
          vendor: provider.name,
          mode: provider.mode,
          scopes: Object.entries(provider.capabilities)
            .filter(([, enabled]) => enabled)
            .map(([name]) => name),
          health: { ok: health.ok, message: health.message, errorRate: health.errorRate },
        }),
      )
      return NextResponse.json(connection)
    }

    if (action === 'test') {
      await withActor(session, async (ctx) => {
        await recordHealth(ctx, capability, {
          ok: health.ok,
          message: health.message,
          errorRate: health.errorRate,
          tokenExpiresAt: health.tokenExpiresAt,
        })
      })
      const connections = await withActor(session, (ctx, actor) => listConnections(ctx, actor))
      return NextResponse.json(connections.find((connection) => connection.capability === capability) ?? {})
    }

    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'That did not work.' },
      { status: 400 },
    )
  }
}
