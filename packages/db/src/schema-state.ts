import { appSql } from './client.js'
import { MIGRATIONS, migrationId } from './schema-manifest.js'

/**
 * Does the database underneath this build have the schema this build was written against?
 *
 * A deployment answered every request with *"a server-side exception has occurred"* and a
 * digest for five hours, because `permission_grants` — added by migration 0051 — had never
 * been applied to it. The code was correct. The schema underneath it was two releases behind,
 * and the only way to learn that was to open the platform's log viewer and match a digest
 * against an error nobody had seen.
 *
 * `layout.tsx` already refuses to render on an incomplete *environment* for exactly this
 * reason, and says which variables are missing. A database that is behind the application is
 * the same failure with a different cause, and deserves the same answer: a page that names
 * what has not been applied and what to run.
 *
 * Three decisions worth stating:
 *
 * **It reads through the application's own pool**, not the owner's — `adminSql` is for
 * migrations, seeding and diagnostics, never request handling. That needed a grant, which is
 * migration 0055, and it is a read on four columns of deployment metadata carrying no
 * tenant data and no RLS.
 *
 * **Once satisfied it never asks again.** A schema that matches this build cannot stop
 * matching it without a deploy, so the query costs one round trip per process and nothing
 * after. While it is *not* satisfied it is asked on every request, which is what lets a
 * deployment recover the moment somebody applies the migrations — no redeploy, exactly as
 * the provisioning workflow promises.
 *
 * **A check that cannot answer says so and stands aside.** If the query fails for any reason
 * other than the two it recognises, this reports `unknown` and the request carries on to
 * whatever it was going to do. The point is to explain a failure that was going to happen
 * anyway, never to become one.
 *
 * The two it recognises are both "behind", and the second is the one that nearly made this
 * useless. A database this build could not read the ledger on is a database that has not had
 * migration 0055 — the grant — applied to it, which is to say a database at least one migration
 * behind. The first deployment of this check meets exactly that, every time: the very situation
 * it exists to explain is the one where it has just lost the privilege to enumerate. So a
 * privilege error is not a shrug, it is the answer, given without the list.
 */

export interface SchemaState {
  /** True when every migration this build knows about has been applied. */
  ok: boolean
  /** Migrations this build was compiled against that the database does not have. */
  pending: string[]
  /** True when `schema_migrations` is not there at all: nothing has ever been provisioned. */
  empty: boolean
  /**
   * True when the database is behind and cannot say by how much: it does not yet carry the
   * grant that lets the runtime read the ledger, which is itself a migration.
   */
  opaque: boolean
  /** True when the question could not be answered, in which case nothing is blocked. */
  unknown: boolean
}

const SATISFIED: SchemaState = { ok: true, pending: [], empty: false, opaque: false, unknown: false }
const UNKNOWN: SchemaState = { ok: true, pending: [], empty: false, opaque: false, unknown: true }

/** Postgres: `undefined_table`. Raised when nothing has ever been migrated here. */
const UNDEFINED_TABLE = '42P01'
/** Postgres: `insufficient_privilege`. Raised by a database from before migration 0055. */
const INSUFFICIENT_PRIVILEGE = '42501'

let satisfied = false

/** For tests, which need a process that has not already answered the question. */
export function forgetSchemaState(): void {
  satisfied = false
}

export function comparePending(applied: Iterable<string>): string[] {
  const have = new Set(applied)
  return MIGRATIONS.filter((name) => !have.has(migrationId(name)))
}

export async function schemaState(): Promise<SchemaState> {
  if (satisfied) return SATISFIED

  let rows: { id: string }[]
  try {
    rows = await appSql()<{ id: string }[]>`SELECT id FROM schema_migrations`
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === UNDEFINED_TABLE) {
      return { ok: false, pending: [...MIGRATIONS], empty: true, opaque: false, unknown: false }
    }
    if (code === INSUFFICIENT_PRIVILEGE) {
      return { ok: false, pending: [], empty: false, opaque: true, unknown: false }
    }
    return UNKNOWN
  }

  const pending = comparePending(rows.map((row) => row.id))
  if (pending.length === 0) {
    satisfied = true
    return SATISFIED
  }
  return { ok: false, pending, empty: false, opaque: false, unknown: false }
}
