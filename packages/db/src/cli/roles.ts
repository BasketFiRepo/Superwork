import { adminSql, closePools, connectionFor } from '../client.js'

/**
 * Set the two runtime roles to the password this configuration will actually present.
 *
 * Migration 0008 has to create `superwork_app` and `superwork_auth` with *some* password,
 * and a migration cannot know the one a given deployment will use — so it writes a
 * development default. Every hosted deployment therefore has one manual step between a
 * migrated database and a working sign-in, and skipping it produces `password
 * authentication failed for user "superwork_auth"` at the first login and nowhere earlier.
 * That step is this command.
 *
 * The password is not read from configuration directly but derived from `connectionFor`,
 * the same function the pools use. Whatever the runtime will present is what gets set,
 * whether that comes from DATABASE_URL or from a DATABASE_APP_URL override.
 */

const ROLES = [
  ['superwork_app', 'app'],
  ['superwork_auth', 'auth'],
] as const

/** ALTER ROLE cannot take a bind parameter for the password, so it is inlined and quoted. */
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`

try {
  const sql = adminSql()

  // Which database this reached is the thing most worth printing: the failure this command
  // exists to fix looks identical to having run it against the wrong branch entirely.
  const [where] = await sql<{ db: string; role: string; server: string | null }[]>`
    SELECT current_database() AS db, current_user AS role, inet_server_addr()::text AS server`
  console.log(`Connected to ${where?.db} as ${where?.role}.\n`)

  const missing: string[] = []
  for (const [role, pool] of ROLES) {
    const [found] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ${role}`
    if (!found?.n) {
      missing.push(role)
      continue
    }

    const password = new URL(connectionFor(pool)).password
    if (!password) throw new Error(`The connection string for ${role} carries no password.`)

    await sql.unsafe(`ALTER ROLE ${role} PASSWORD ${quote(password)}`)
    console.log(`  ${role} — password set`)
  }

  if (missing.length) {
    throw new Error(
      `${missing.join(' and ')} ${missing.length > 1 ? 'do' : 'does'} not exist in this database.\n` +
        'Migration 0008 creates them, so this database has not been migrated — or these\n' +
        'credentials point at a different database than the migrations ran against.\n' +
        'Run `pnpm db:migrate` against this same DATABASE_ADMIN_URL first.',
    )
  }

  console.log('\nBoth runtime roles now accept the password this configuration presents.')
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await closePools()
}
