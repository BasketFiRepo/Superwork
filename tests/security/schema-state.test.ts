import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { adminSql, appSql, closePools, forgetSchemaState, MIGRATIONS, schemaState } from '@superwork/db'

/**
 * Whether the database underneath this build matches it (ADR 0062).
 *
 * A deployment answered every request with a digest for five hours because `permission_grants`
 * had never been applied to it. These tests are about the three things that make the replacement
 * trustworthy: that the check can be run at all by the role a request actually uses, that it says
 * what is missing, and that it never becomes the failure it exists to explain.
 */

afterAll(async () => {
  await closePools()
})

beforeEach(() => {
  forgetSchemaState()
})

describe('the check itself', () => {
  it('runs on the connection a request has, not the owner’s', async () => {
    // Migration 0055 grants exactly this and nothing else. Without it the check throws on the
    // very pool it has to work on, which would make it the outage rather than the explanation.
    const rows = await appSql()<{ id: string }[]>`SELECT id FROM schema_migrations LIMIT 1`
    expect(rows.length).toBeGreaterThan(0)
  })

  it('and the runtime still cannot write to the ledger', async () => {
    // A runtime that could write this table could tell itself the schema is newer than it is.
    await expect(
      appSql()`INSERT INTO schema_migrations (id, name, checksum) VALUES ('9999', 'invented', 'x')`,
    ).rejects.toThrow(/permission denied/i)
  })

  it('says a fully migrated database is fine', async () => {
    const state = await schemaState()
    expect(state).toEqual({ ok: true, pending: [], empty: false, opaque: false, unknown: false })
  })

  it('reads a database from before the grant as behind, not as a shrug', async () => {
    // The situation this check meets on its own first deployment, every time: the database it is
    // there to diagnose is exactly the one that has not had the grant applied. Answering
    // "cannot tell" there would have made the whole thing useless on the day it shipped.
    await adminSql()`REVOKE SELECT ON schema_migrations FROM superwork_app`
    try {
      const state = await schemaState()
      expect(state.ok).toBe(false)
      expect(state.opaque).toBe(true)
      expect(state.unknown).toBe(false)
    } finally {
      await adminSql()`GRANT SELECT ON schema_migrations TO superwork_app`
    }
  })
})

describe('a database that is behind', () => {
  it('is reported with the migrations it is missing, by name', async () => {
    const missing = MIGRATIONS[MIGRATIONS.length - 1]!
    const id = missing.split('_')[0]!
    const [row] = await adminSql()<{ id: string; name: string; checksum: string }[]>`
      SELECT id, name, checksum FROM schema_migrations WHERE id = ${id}`
    expect(row, 'the newest migration is applied to this database').toBeDefined()

    // Take the row away, the way a database two releases behind the application has never had it.
    await adminSql()`DELETE FROM schema_migrations WHERE id = ${id}`
    try {
      const state = await schemaState()
      expect(state.ok).toBe(false)
      expect(state.empty).toBe(false)
      expect(state.pending).toEqual([missing])
    } finally {
      await adminSql()`
        INSERT INTO schema_migrations (id, name, checksum, applied_at)
        VALUES (${row!.id}, ${row!.name}, ${row!.checksum}, now())`
    }
  })

  it('and is asked again every time, so applying them fixes it without a redeploy', async () => {
    const missing = MIGRATIONS[MIGRATIONS.length - 1]!
    const id = missing.split('_')[0]!
    const [row] = await adminSql()<{ id: string; name: string; checksum: string }[]>`
      SELECT id, name, checksum FROM schema_migrations WHERE id = ${id}`
    await adminSql()`DELETE FROM schema_migrations WHERE id = ${id}`

    expect((await schemaState()).ok).toBe(false)
    // The migration lands, and the very next request notices — no process restart in between.
    await adminSql()`
      INSERT INTO schema_migrations (id, name, checksum, applied_at)
      VALUES (${row!.id}, ${row!.name}, ${row!.checksum}, now())`
    expect((await schemaState()).ok).toBe(true)
  })

  it('stops asking once it is satisfied, so it costs one query and not one per request', async () => {
    expect((await schemaState()).ok).toBe(true)
    // Satisfied. Now take a migration away without forgetting: a schema that matches this build
    // cannot stop matching it without a deploy, so there is nothing to re-read.
    const id = MIGRATIONS[MIGRATIONS.length - 1]!.split('_')[0]!
    const [row] = await adminSql()<{ id: string; name: string; checksum: string }[]>`
      SELECT id, name, checksum FROM schema_migrations WHERE id = ${id}`
    await adminSql()`DELETE FROM schema_migrations WHERE id = ${id}`
    try {
      expect((await schemaState()).ok).toBe(true)
    } finally {
      await adminSql()`
        INSERT INTO schema_migrations (id, name, checksum, applied_at)
        VALUES (${row!.id}, ${row!.name}, ${row!.checksum}, now())`
    }
  })
})
