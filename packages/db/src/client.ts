import postgres from 'postgres'
import { env } from '@superwork/config'

export type Sql = postgres.Sql<{}>

/**
 * A piece of SQL built by the tagged template and nested inside another query. Composing
 * fragments is how a predicate can be written once and used by two queries that need to
 * agree — as opposed to building SQL from strings, which this codebase never does.
 */
export type Fragment = postgres.PendingQuery<postgres.Row[]>

let appPool: Sql | null = null
let authPool: Sql | null = null
let adminPool: Sql | null = null

function connectionFor(role: 'app' | 'auth' | 'admin'): string {
  const base = env().DATABASE_URL
  if (role === 'admin') return env().DATABASE_ADMIN_URL ?? base
  const url = new URL(base)
  // The runtime never connects as the table owner: an owner would bypass RLS.
  url.username = role === 'app' ? 'superwork_app' : 'superwork_auth'
  return url.toString()
}

function makePool(role: 'app' | 'auth' | 'admin'): Sql {
  return postgres(connectionFor(role), {
    max: role === 'admin' ? 2 : 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    onnotice: () => {},
    types: {
      // pgvector round-trips as a bracketed float list.
      vector: {
        to: 0,
        from: [],
        serialize: (v: number[]) => `[${v.join(',')}]`,
        parse: (v: string) => v.slice(1, -1).split(',').map(Number),
      },
    },
  })
}

/** Tenant runtime pool. Every query through this pool is subject to RLS. */
export function appSql(): Sql {
  if (!appPool) appPool = makePool('app')
  return appPool
}

/** Pre-tenant pool used only to resolve a login into a session. */
export function authSql(): Sql {
  if (!authPool) authPool = makePool('auth')
  return authPool
}

/** Owner pool. Migrations, seeding and diagnostics only — never request handling. */
export function adminSql(): Sql {
  if (!adminPool) adminPool = makePool('admin')
  return adminPool
}

export async function closePools(): Promise<void> {
  await Promise.all([appPool?.end({ timeout: 5 }), authPool?.end({ timeout: 5 }), adminPool?.end({ timeout: 5 })])
  appPool = authPool = adminPool = null
}
