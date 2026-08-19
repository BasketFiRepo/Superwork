import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { withTenant, type TenantContext } from '@superwork/db'
import { loadActor, resolveSession, SESSION_COOKIE, type Actor } from '@superwork/auth'
import { resolveFlags, type FlagSet } from '@superwork/config'

export interface AppSession {
  userId: string
  organizationId: string
  organizationName: string
  isDemo: boolean
  timezone: string
  /** The ISO code money is written in on every screen (ADR 0052). */
  currency: string
  name: string
  email: string
  flags: FlagSet
  killSwitch: boolean
  /** When this session last re-proved its identity (§4.1), or null. */
  steppedUpAt: Date | null
}

/** Resolves the signed-in user, or sends them to the sign-in page. */
export async function requireSession(): Promise<AppSession> {
  const store = await cookies()
  const identity = await resolveSession(store.get(SESSION_COOKIE)?.value)
  if (!identity?.organizationId) redirect('/login')

  return withTenant(
    { organizationId: identity.organizationId, userId: identity.userId, timezone: identity.timezone },
    async (ctx) => {
      const [org] = await ctx.sql<
        { name: string; is_demo: boolean; agent_kill_switch: boolean; timezone: string; currency: string }[]
      >`
        SELECT name, is_demo, agent_kill_switch, timezone, currency::text AS currency
        FROM organizations WHERE id = ${ctx.organizationId}`
      const overrides = await ctx.sql<{ flag: string; enabled: boolean; user_id: string | null }[]>`
        SELECT flag, enabled, user_id FROM feature_flag_overrides
        WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
          AND (user_id IS NULL OR user_id = ${identity.userId})`

      const orgOverrides: Partial<FlagSet> = {}
      const userOverrides: Partial<FlagSet> = {}
      for (const row of overrides) {
        const target = row.user_id ? userOverrides : orgOverrides
        ;(target as Record<string, boolean>)[row.flag] = row.enabled
      }

      return {
        userId: identity.userId,
        organizationId: identity.organizationId!,
        organizationName: org?.name ?? 'Organization',
        isDemo: org?.is_demo ?? false,
        timezone: identity.timezone || org?.timezone || 'UTC',
        // How money is written on every screen. It was a column nothing read, so every
        // organization saw pounds (ADR 0052).
        currency: org?.currency ?? 'GBP',
        name: identity.name,
        email: identity.email,
        flags: resolveFlags(orgOverrides, userOverrides),
        killSwitch: org?.agent_kill_switch ?? false,
        steppedUpAt: identity.steppedUpAt,
      }
    },
  )
}

/** Runs `fn` inside the tenant transaction with the actor already loaded. */
export async function withActor<T>(
  session: AppSession,
  fn: (ctx: TenantContext, actor: Actor) => Promise<T>,
): Promise<T> {
  return withTenant(
    {
      organizationId: session.organizationId,
      userId: session.userId,
      timezone: session.timezone,
      steppedUpAt: session.steppedUpAt,
    },
    async (ctx) => fn(ctx, await loadActor(ctx)),
  )
}

export async function optionalSession(): Promise<AppSession | null> {
  const store = await cookies()
  const identity = await resolveSession(store.get(SESSION_COOKIE)?.value)
  if (!identity?.organizationId) return null
  return requireSession()
}
