import { adminSql, withTenant } from '@superwork/db'
import { hashPassword } from '@superwork/auth'

/**
 * Two isolated organizations, built through the same code paths the product uses.
 * The cross-tenant pack asserts that a member of B can reach nothing in A.
 */

export interface TenantFixture {
  organizationId: string
  ownerId: string
  memberId: string
  viewerId: string
  taskId: string
  documentId: string
  companyId: string
  runId: string
}

export async function createTenant(slug: string): Promise<TenantFixture> {
  const sql = adminSql()
  await sql`DELETE FROM organizations WHERE slug = ${slug}`

  const [org] = await sql<{ id: string }[]>`
    INSERT INTO organizations (name, slug, timezone, is_demo)
    VALUES (${`Fixture ${slug}`}, ${slug}, 'Europe/London', true) RETURNING id`
  const organizationId = org!.id

  const password = await hashPassword('fixture')
  const makeUser = async (role: string, key: string) => {
    const email = `${key}.${slug}@fixture.example`
    await sql`DELETE FROM users WHERE lower(email) = lower(${email})`
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO users (email, name, password_hash, timezone, is_demo)
      VALUES (${email}, ${`${key} ${slug}`}, ${password}, 'Europe/London', true) RETURNING id`
    await sql`
      INSERT INTO memberships (organization_id, user_id, role, is_demo)
      VALUES (${organizationId}, ${user!.id}, ${role}, true)`
    return user!.id
  }

  const ownerId = await makeUser('owner', 'owner')
  const memberId = await makeUser('member', 'member')
  const viewerId = await makeUser('viewer', 'viewer')

  const seeded = await withTenant({ organizationId, userId: ownerId, timezone: 'Europe/London' }, async (ctx) => {
    const [company] = await ctx.sql<{ id: string }[]>`
      INSERT INTO companies (organization_id, name, type, is_demo, created_by)
      VALUES (${organizationId}, ${`${slug} Customer`}, 'customer', true, ${ownerId}) RETURNING id`
    const [task] = await ctx.sql<{ id: string }[]>`
      INSERT INTO tasks (organization_id, title, status, priority, assignee_id, is_demo, created_by)
      VALUES (${organizationId}, ${`${slug} secret task`}, 'todo', 'medium', ${memberId}, true, ${ownerId})
      RETURNING id`
    const [document] = await ctx.sql<{ id: string }[]>`
      INSERT INTO documents (organization_id, title, doc_type, sensitivity, index_status, is_demo, created_by)
      VALUES (${organizationId}, ${`${slug} confidential document`}, 'contract', 'confidential', 'indexed', true, ${ownerId})
      RETURNING id`
    const [run] = await ctx.sql<{ id: string }[]>`
      INSERT INTO agent_runs (organization_id, principal_user_id, mode, status, request, trace_id, is_demo, created_by)
      VALUES (${organizationId}, ${ownerId}, 'ask', 'succeeded', ${`${slug} run`}, ${`trace-${slug}`}, true, ${ownerId})
      RETURNING id`
    return { companyId: company!.id, taskId: task!.id, documentId: document!.id, runId: run!.id }
  })

  return { organizationId, ownerId, memberId, viewerId, ...seeded }
}

/**
 * Puts a person outside their own quiet hours for the moment the caller runs.
 *
 * Notifications and reminders now wait for a person's quiet hours (ADR 0047), and the schema's
 * default window is 18:30–08:30 — so a pack asserting that something *arrives* is asserting
 * something about the hour it runs at unless it says otherwise. This says otherwise: a window
 * two hours from now, which contains no moment this test will use.
 */
export async function makeReachable(organizationId: string, userId: string): Promise<void> {
  const from = new Date(Date.now() + 2 * 3_600_000)
  const to = new Date(Date.now() + 4 * 3_600_000)
  const clock = (instant: Date) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant)
  const sql = adminSql()
  await sql`
    INSERT INTO notification_preferences (organization_id, user_id, quiet_hours, is_demo, created_by)
    VALUES (${organizationId}, ${userId},
            ${sql.json({ start: clock(from), end: clock(to) })}, true, ${userId})
    ON CONFLICT (organization_id, user_id) WHERE deleted_at IS NULL
    DO UPDATE SET quiet_hours = EXCLUDED.quiet_hours, updated_at = now()`
  await adminSql()`UPDATE users SET timezone = 'UTC' WHERE id = ${userId}`
}

export async function destroyTenant(slug: string): Promise<void> {
  const sql = adminSql()
  await sql`DELETE FROM organizations WHERE slug = ${slug}`
  await sql`DELETE FROM users WHERE email LIKE ${`%.${slug}@fixture.example`}`
}

/** Every tenant table, discovered from the catalogue so a new table cannot be forgotten. */
export async function tenantTables(): Promise<string[]> {
  const rows = await adminSql()<{ relname: string }[]>`
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id' AND a.attnum > 0
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname`
  return rows.map((r) => r.relname)
}
