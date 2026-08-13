import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { adminSql } from './client.js'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

export interface Migration {
  id: string
  name: string
  upPath: string
  downPath: string
}

export async function listMigrations(): Promise<Migration[]> {
  const files = await readdir(MIGRATIONS_DIR)
  const ups = files.filter((f) => f.endsWith('.up.sql')).sort()
  return ups.map((f) => {
    const name = f.replace('.up.sql', '')
    return {
      id: name.split('_')[0] ?? name,
      name,
      upPath: join(MIGRATIONS_DIR, f),
      downPath: join(MIGRATIONS_DIR, `${name}.down.sql`),
    }
  })
}

async function ensureTable(): Promise<void> {
  const sql = adminSql()
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          text PRIMARY KEY,
      name        text NOT NULL,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`
}

export async function applied(): Promise<Set<string>> {
  await ensureTable()
  const rows = await adminSql()<{ id: string }[]>`SELECT id FROM schema_migrations ORDER BY id`
  return new Set(rows.map((r) => r.id))
}

export async function up(target?: string): Promise<string[]> {
  const sql = adminSql()
  const done = await applied()
  const pending = (await listMigrations()).filter((m) => !done.has(m.id) && (!target || m.id <= target))
  const run: string[] = []

  for (const migration of pending) {
    const body = await readFile(migration.upPath, 'utf8')
    const checksum = createHash('sha256').update(body).digest('hex')
    // Each migration is one transaction: a failure leaves no partial schema.
    await sql.begin(async (tx) => {
      await tx.unsafe(body)
      await tx`INSERT INTO schema_migrations (id, name, checksum)
               VALUES (${migration.id}, ${migration.name}, ${checksum})`
    })
    run.push(migration.name)
  }
  return run
}

export async function down(steps = 1): Promise<string[]> {
  const sql = adminSql()
  await ensureTable()
  const rows = await sql<{ id: string; name: string }[]>`
    SELECT id, name FROM schema_migrations ORDER BY id DESC LIMIT ${steps}`
  const all = await listMigrations()
  const reverted: string[] = []

  for (const row of rows) {
    const migration = all.find((m) => m.id === row.id)
    if (!migration) throw new Error(`No rollback file found for applied migration ${row.name}`)
    const body = await readFile(migration.downPath, 'utf8')
    await sql.begin(async (tx) => {
      await tx.unsafe(body)
      await tx`DELETE FROM schema_migrations WHERE id = ${row.id}`
    })
    reverted.push(migration.name)
  }
  return reverted
}

/** Drops and rebuilds the schema. Development and CI only. */
export async function reset(): Promise<void> {
  const sql = adminSql()
  await sql.unsafe(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO postgres;
  `)
  await up()
}
