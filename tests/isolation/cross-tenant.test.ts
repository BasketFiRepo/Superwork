import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import { getDocument, getTask, hybridSearch, listTasks, runAggregate } from '@superwork/core'
import { getRun } from '@superwork/core'
import { createTenant, destroyTenant, tenantTables, type TenantFixture } from '../helpers/fixtures.js'

/**
 * The mandatory cross-tenant pack (§3.2).
 *
 * For every table and every read path, a member of Org B attempts to reach Org A and
 * must be told the resource does not exist — 404, never 403, so existence does not leak.
 */

let orgA: TenantFixture
let orgB: TenantFixture

beforeAll(async () => {
  orgA = await createTenant('iso-a')
  orgB = await createTenant('iso-b')
})

afterAll(async () => {
  await destroyTenant('iso-a')
  await destroyTenant('iso-b')
  await closePools()
})

describe('database layer', () => {
  it('every tenant table has RLS enabled, forced, and a policy', async () => {
    const tables = await tenantTables()
    expect(tables.length).toBeGreaterThan(40)

    const rows = await adminSql()<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policies: number }[]>`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
             (SELECT count(*)::int FROM pg_policies p
               WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY(${tables})`

    const unprotected = rows.filter((r) => !r.relrowsecurity || !r.relforcerowsecurity || r.policies === 0)
    expect(unprotected.map((r) => r.relname)).toEqual([])
  })

  it('neither application role can bypass row level security', async () => {
    const rows = await adminSql()<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }[]>`
      SELECT rolname, rolbypassrls, rolsuper FROM pg_roles
      WHERE rolname IN ('superwork_app', 'superwork_auth')`
    expect(rows).toHaveLength(2)
    for (const role of rows) {
      expect(role.rolbypassrls, `${role.rolname} must not have BYPASSRLS`).toBe(false)
      expect(role.rolsuper, `${role.rolname} must not be a superuser`).toBe(false)
    }
  })

  it('selects every tenant table as org B and never sees an org A row', async () => {
    const tables = await tenantTables()
    await withTenant({ organizationId: orgB.organizationId, userId: orgB.ownerId, timezone: 'UTC' }, async (ctx) => {
      for (const table of tables) {
        const rows = await ctx.sql.unsafe(
          `SELECT count(*)::int AS leaked FROM ${table} WHERE organization_id = $1`,
          [orgA.organizationId],
        )
        expect(Number((rows[0] as unknown as { leaked: number } | undefined)?.leaked ?? -1), `${table} leaked org A rows`).toBe(0)
      }
    })
  })

  it('cannot write a row belonging to another organization', async () => {
    await expect(
      withTenant({ organizationId: orgB.organizationId, userId: orgB.ownerId, timezone: 'UTC' }, async (ctx) => {
        await ctx.sql`
          INSERT INTO tasks (organization_id, title, status, priority, created_by)
          VALUES (${orgA.organizationId}, 'smuggled', 'todo', 'medium', ${orgB.ownerId})`
      }),
    ).rejects.toThrow()
  })

  it('cannot update another organization’s row', async () => {
    await withTenant({ organizationId: orgB.organizationId, userId: orgB.ownerId, timezone: 'UTC' }, async (ctx) => {
      const result = await ctx.sql`UPDATE tasks SET title = 'hijacked' WHERE id = ${orgA.taskId}`
      expect(result.count).toBe(0)
    })
    await withTenant({ organizationId: orgA.organizationId, userId: orgA.ownerId, timezone: 'UTC' }, async (ctx) => {
      const [row] = await ctx.sql<{ title: string }[]>`SELECT title FROM tasks WHERE id = ${orgA.taskId}`
      expect(row?.title).toContain('secret task')
    })
  })

  it('audit_logs is append-only for the application role', async () => {
    await withTenant({ organizationId: orgA.organizationId, userId: orgA.ownerId, timezone: 'UTC' }, async (ctx) => {
      await ctx.sql`
        INSERT INTO audit_logs (organization_id, actor_type, action, entity_type)
        VALUES (${ctx.organizationId}, 'user', 'test.write', 'task')`
    })
    await expect(
      withTenant({ organizationId: orgA.organizationId, userId: orgA.ownerId, timezone: 'UTC' }, async (ctx) => {
        await ctx.sql`UPDATE audit_logs SET action = 'tampered' WHERE organization_id = ${ctx.organizationId}`
      }),
    ).rejects.toThrow()
  })
})

describe('repository layer', () => {
  it('reports another tenant’s task as not found, not forbidden', async () => {
    await withTenant({ organizationId: orgB.organizationId, userId: orgB.ownerId, timezone: 'UTC' }, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(getTask(ctx, actor, orgA.taskId)).rejects.toThrow(/not found/i)
    })
  })

  it('reports another tenant’s document as not found', async () => {
    await withTenant({ organizationId: orgB.organizationId, userId: orgB.ownerId, timezone: 'UTC' }, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(getDocument(ctx, actor, orgA.documentId)).rejects.toThrow(/not found/i)
    })
  })

  it('reports another tenant’s agent run as not found', async () => {
    await withTenant({ organizationId: orgB.organizationId, userId: orgB.ownerId, timezone: 'UTC' }, async (ctx) => {
      await expect(getRun(ctx, orgA.runId)).rejects.toThrow(/not found/i)
    })
  })

  it('list and aggregate paths never return another tenant’s rows', async () => {
    await withTenant({ organizationId: orgB.organizationId, userId: orgB.ownerId, timezone: 'UTC' }, async (ctx) => {
      const actor = await loadActor(ctx)
      const tasks = await listTasks(ctx, actor, { limit: 200 })
      expect(tasks.tasks.some((t) => t.id === orgA.taskId)).toBe(false)
      expect(tasks.tasks.every((t) => t.title.includes('iso-b'))).toBe(true)

      const overdue = await runAggregate(ctx, actor, 'tasks_overdue', { limit: 200 })
      expect(overdue.rows.some((r) => r['id'] === orgA.taskId)).toBe(false)
    })
  })

  it('retrieval never surfaces another tenant’s chunks', async () => {
    await withTenant({ organizationId: orgA.organizationId, userId: orgA.ownerId, timezone: 'UTC' }, async (ctx) => {
      const [version] = await ctx.sql<{ id: string }[]>`
        INSERT INTO document_versions (organization_id, document_id, ordinal, body, content_hash, created_by)
        VALUES (${ctx.organizationId}, ${orgA.documentId}, 1, 'kryptonite pricing schedule', 'hash-a', ${orgA.ownerId})
        RETURNING id`
      await ctx.sql`
        INSERT INTO document_chunks (organization_id, document_id, version_id, ordinal, anchor, content, sensitivity, created_by)
        VALUES (${ctx.organizationId}, ${orgA.documentId}, ${version!.id}, 0, '#a', 'kryptonite pricing schedule', 'internal', ${orgA.ownerId})`
      await ctx.sql`UPDATE documents SET current_version_id = ${version!.id} WHERE id = ${orgA.documentId}`
    })

    await withTenant({ organizationId: orgB.organizationId, userId: orgB.ownerId, timezone: 'UTC' }, async (ctx) => {
      const actor = await loadActor(ctx)
      const result = await hybridSearch(ctx, actor, 'kryptonite pricing schedule')
      expect(result.chunks).toHaveLength(0)
      expect(result.noAnswer).toBe(true)
    })
  })

  it('memory never crosses organizations', async () => {
    await withTenant({ organizationId: orgA.organizationId, userId: orgA.ownerId, timezone: 'UTC' }, async (ctx) => {
      // A confirmed fact names who agreed and what it came from (0019). This is about
      // tenant isolation, so the row is built the way a real one is rather than minimally.
      await ctx.sql`
        INSERT INTO memory_facts (
          organization_id, scope, subject, predicate, object, state, confirmed_by, source_citation, created_by
        ) VALUES (
          ${ctx.organizationId}, 'organization', 'Org A', 'prefers', 'email', 'confirmed', ${orgA.ownerId},
          ${ctx.sql.json({ documentId: orgA.documentId, anchor: '#preferences' })}, ${orgA.ownerId}
        )`
    })
    await withTenant({ organizationId: orgB.organizationId, userId: orgB.ownerId, timezone: 'UTC' }, async (ctx) => {
      const rows = await ctx.sql<{ subject: string }[]>`SELECT subject FROM memory_facts`
      expect(rows.some((r) => r.subject === 'Org A')).toBe(false)
    })
  })

  it('a tenant context cannot be constructed without a principal', async () => {
    await expect(
      withTenant({ organizationId: orgA.organizationId, userId: '', timezone: 'UTC' }, async () => null),
    ).rejects.toThrow(/principal/i)
  })
})
