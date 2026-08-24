import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  ATTACHABLE_TYPES,
  attachFile,
  deleteDocument,
  fileFor,
  MAX_ATTACHMENT_BYTES,
} from '@superwork/core'
import { MockStorageProvider, storageKeyFor } from '@superwork/integrations'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * A file somebody attached (ADR 0085).
 *
 * `StorageProvider` was declared in `contracts.ts` since Phase 2 with **no implementation at all**
 * — no mock, no resolver, no caller — while `documents.storage_key` and `documents.mime_type` sat
 * empty and `ingest.ts` carried a comment pointing at it. You could not attach a file to anything.
 *
 * Two rules this file exists to hold: **possession is never permission**, and **deleting a
 * document takes the bytes with it** (§25.13).
 */

const TZ = 'Europe/London'
let org: TenantFixture
let owner: { organizationId: string; userId: string; timezone: string }
let viewer: { organizationId: string; userId: string; timezone: string }
let store: MockStorageProvider

const PDF = Buffer.from('%PDF-1.7\nthe rate card\n')

async function aDocument(title: string): Promise<string> {
  const [row] = await adminSql()<{ id: string }[]>`
    INSERT INTO documents (organization_id, title, doc_type, sensitivity, index_status, is_demo, created_by, owner_id)
    VALUES (${org.organizationId}, ${title}, 'contract', 'internal', 'indexed', true, ${org.ownerId}, ${org.ownerId})
    RETURNING id`
  return row!.id
}

beforeAll(async () => {
  org = await createTenant('document-file')
  owner = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  viewer = { organizationId: org.organizationId, userId: org.viewerId, timezone: TZ }
  store = new MockStorageProvider()
})

afterAll(async () => {
  await destroyTenant('document-file')
  await closePools()
})

describe('attaching one', () => {
  it('stores the bytes and records what they are', async () => {
    const id = await aDocument('Halden rate card')
    const attached = await withTenant(owner, async (ctx) =>
      attachFile(
        ctx,
        await loadActor(ctx),
        { documentId: id, fileName: 'rates.pdf', contentType: 'application/pdf', body: PDF },
        store,
        storageKeyFor,
      ),
    )
    expect(attached.bytes).toBe(PDF.byteLength)
    expect(store.has(storageKeyFor(org.organizationId, PDF))).toBe(true)

    const [row] = await adminSql()<{ mime_type: string; storage_key: string; file_name: string }[]>`
      SELECT mime_type, storage_key, file_name FROM documents WHERE id = ${id}`
    expect(row!.mime_type).toBe('application/pdf')
    expect(row!.file_name).toBe('rates.pdf')
  })

  it('and refuses a type it does not keep', async () => {
    const id = await aDocument('A page')
    await expect(
      withTenant(owner, async (ctx) =>
        attachFile(
          ctx,
          await loadActor(ctx),
          { documentId: id, fileName: 'x.html', contentType: 'text/html', body: Buffer.from('<b>hi</b>') },
          store,
          storageKeyFor,
        ),
      ),
    ).rejects.toThrow(/does not keep/i)
  })

  it('and the list is an allowlist, so nothing a browser executes is on it', async () => {
    // An allowlist refuses what it does not know; a blocklist admits it. The types that matter
    // are the ones a browser will happily run.
    expect(Object.keys(ATTACHABLE_TYPES)).not.toContain('text/html')
    expect(Object.keys(ATTACHABLE_TYPES)).not.toContain('image/svg+xml')
    expect(Object.keys(ATTACHABLE_TYPES)).not.toContain('application/javascript')
  })

  it('and refuses one that is too big, saying how big it was', async () => {
    const id = await aDocument('Too much')
    const huge = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 1)
    await expect(
      withTenant(owner, async (ctx) =>
        attachFile(
          ctx,
          await loadActor(ctx),
          { documentId: id, fileName: 'big.pdf', contentType: 'application/pdf', body: huge },
          store,
          storageKeyFor,
        ),
      ),
    ).rejects.toThrow(/The limit is 20MB/i)
  })

  it('and refuses an empty one', async () => {
    const id = await aDocument('Nothing')
    await expect(
      withTenant(owner, async (ctx) =>
        attachFile(
          ctx,
          await loadActor(ctx),
          { documentId: id, fileName: 'empty.pdf', contentType: 'application/pdf', body: Buffer.alloc(0) },
          store,
          storageKeyFor,
        ),
      ),
    ).rejects.toThrow(/empty/i)
  })

  it('and a viewer cannot attach one, because it changes the document', async () => {
    const id = await aDocument('Not yours to change')
    await expect(
      withTenant(viewer, async (ctx) =>
        attachFile(
          ctx,
          await loadActor(ctx),
          { documentId: id, fileName: 'rates.pdf', contentType: 'application/pdf', body: PDF },
          store,
          storageKeyFor,
        ),
      ),
    ).rejects.toThrow()
  })
})

describe('what the database will not let come apart', () => {
  it('a key with no type describing it is refused', async () => {
    // Size and name supplied, so `file_is_described` is satisfied and this isolates the other
    // constraint. A row that violates both tells you only which one Postgres checked first.
    const id = await aDocument('Half a file')
    await expect(
      adminSql()`
        UPDATE documents SET storage_key = 'org/abc', file_bytes = 10, file_name = 'x.pdf'
        WHERE id = ${id}`,
    ).rejects.toThrow(/file_is_whole/i)
  })

  it('and a type with no key behind it is refused', async () => {
    const id = await aDocument('A claim')
    await expect(
      adminSql()`UPDATE documents SET mime_type = 'application/pdf' WHERE id = ${id}`,
    ).rejects.toThrow(/file_is_whole/i)
  })

  it('and a key with no size or name is refused', async () => {
    const id = await aDocument('Undescribed')
    await expect(
      adminSql()`
        UPDATE documents SET storage_key = 'org/abc', mime_type = 'application/pdf' WHERE id = ${id}`,
    ).rejects.toThrow(/file_is_described/i)
  })
})

describe('possession is never permission', () => {
  it('the file is behind the same question the document is behind', async () => {
    const id = await aDocument('Confidential terms')
    await adminSql()`UPDATE documents SET sensitivity = 'confidential' WHERE id = ${id}`
    await withTenant(owner, async (ctx) =>
      attachFile(
        ctx,
        await loadActor(ctx),
        { documentId: id, fileName: 'terms.pdf', contentType: 'application/pdf', body: Buffer.from('%PDF terms') },
        store,
        storageKeyFor,
      ),
    )

    /**
     * A viewer's ceiling does not reach `confidential`, so the file is refused — and it is
     * refused by *name*, not as absence.
     *
     * That is the existing design and worth stating rather than "fixing": within an organization
     * a classification refusal says what the level is and who it reaches, because somebody who
     * can see the document in a list needs to know why they cannot open it. Absence is the answer
     * across a tenant boundary (§3.2), which is a different question.
     */
    const refusal = await withTenant(viewer, async (ctx) =>
      fileFor(ctx, await loadActor(ctx), id).then(
        () => '',
        (error: Error) => error.message,
      ),
    )
    expect(refusal).toMatch(/confidential/i)
    expect(refusal).not.toBe('')
  })

  it('and knowing the key is not enough to be given the file', async () => {
    /**
     * The key is a content hash under the organization. It is not a secret and is not treated as
     * one — there is no route that takes a key, only one that takes a document id and asks
     * `can()`. Asserted against the route, because "there is no such endpoint" is exactly the
     * claim a later change makes quietly untrue.
     */
    const route = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('../../apps/web/src/app/api/documents/[id]/file/route.ts', import.meta.url),
        'utf8',
      ),
    )
    expect(route).toMatch(/fileFor\(ctx, actor, id\)/)
    expect(route).not.toMatch(/searchParams\.get\(['"]key/)
  })

  it('and the contract no longer offers a URL that works on possession', async () => {
    const contracts = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../packages/integrations/src/contracts.ts', import.meta.url), 'utf8'),
    )
    const iface = /export interface StorageProvider[\s\S]*?\n}/.exec(contracts)?.[0] ?? ''
    expect(iface).toBeTruthy()
    expect(iface).toMatch(/put\(/)
    expect(iface).not.toMatch(/signedUrl/)
  })

  it('and it is served as an attachment, never rendered in the origin', async () => {
    const route = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('../../apps/web/src/app/api/documents/[id]/file/route.ts', import.meta.url),
        'utf8',
      ),
    )
    expect(route).toMatch(/content-disposition['"]:\s*`attachment/)
    expect(route).toMatch(/x-content-type-options['"]:\s*'nosniff'/)
  })
})

describe('deleting takes the bytes with it (§25.13)', () => {
  it('the stored file is gone, not just the row', async () => {
    const id = await aDocument('Delete me')
    const body = Buffer.from('%PDF the one that goes')
    await withTenant(owner, async (ctx) =>
      attachFile(
        ctx,
        await loadActor(ctx),
        { documentId: id, fileName: 'gone.pdf', contentType: 'application/pdf', body },
        store,
        storageKeyFor,
      ),
    )
    const key = storageKeyFor(org.organizationId, body)
    expect(store.has(key)).toBe(true)

    const removed = await withTenant(owner, async (ctx) =>
      deleteDocument(ctx, await loadActor(ctx), { documentId: id, reason: 'Superseded by the 2027 card.' }, store),
    )
    expect(removed.file).toBe('gone.pdf')
    expect(store.has(key)).toBe(false)
  })

  it('and a file two documents share survives the first deletion', async () => {
    /**
     * The bytes are keyed by content hash, so the same file attached twice is one object.
     * Removing it with the first document would quietly break the second — a worse failure than
     * leaving an orphan, and the reason the purge counts before it removes.
     */
    const shared = Buffer.from('%PDF the same terms')
    const key = storageKeyFor(org.organizationId, shared)
    const first = await aDocument('Copy one')
    const second = await aDocument('Copy two')
    for (const id of [first, second]) {
      await withTenant(owner, async (ctx) =>
        attachFile(
          ctx,
          await loadActor(ctx),
          { documentId: id, fileName: 'shared.pdf', contentType: 'application/pdf', body: shared },
          store,
          storageKeyFor,
        ),
      )
    }

    await withTenant(owner, async (ctx) =>
      deleteDocument(ctx, await loadActor(ctx), { documentId: first, reason: 'A duplicate we do not need.' }, store),
    )
    expect(store.has(key)).toBe(true)

    await withTenant(owner, async (ctx) =>
      deleteDocument(ctx, await loadActor(ctx), { documentId: second, reason: 'And now the last of them.' }, store),
    )
    expect(store.has(key)).toBe(false)
  })

  it('and the audit record says the file went', async () => {
    const [entry] = await adminSql()<{ diff: Record<string, unknown> }[]>`
      SELECT diff FROM audit_logs
      WHERE organization_id = ${org.organizationId} AND action = 'document.deleted'
      ORDER BY occurred_at DESC LIMIT 1`
    expect(JSON.stringify(entry!.diff)).toMatch(/fileRemoved/)
  })
})

describe('the provider that had no implementation', () => {
  it('the mock keeps what it is given and gives it back', async () => {
    const provider = new MockStorageProvider()
    const put = await provider.put('org/x', PDF, 'application/pdf')
    expect(put.bytes).toBe(PDF.byteLength)
    expect(await provider.get('org/x')).toEqual(PDF)
    await provider.remove('org/x')
    await expect(provider.get('org/x')).rejects.toThrow(/not in storage/i)
  })

  it('and the same bytes land on one key, whichever organization asks', async () => {
    const a = storageKeyFor('org-a', PDF)
    const b = storageKeyFor('org-b', PDF)
    // Same content, different organizations, different keys — a key is never a way across a
    // tenant boundary even when the bytes are identical.
    expect(a).not.toBe(b)
    expect(storageKeyFor('org-a', PDF)).toBe(a)
  })
})
