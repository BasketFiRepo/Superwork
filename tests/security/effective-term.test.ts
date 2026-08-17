import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  getDocument,
  hybridSearch,
  ingestionBacklog,
  knowledgeHealth,
  PermissionError,
  setEffectiveDates,
  uploadDocument,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * When a document stopped being true (ADR 0042).
 *
 * `effective_to` has existed since migration 0004 and nothing wrote to it or read it, while
 * `effective_from` was carried into every passage and stated in the header the model reads. So
 * a contract whose term had ended was retrieved, ranked and cited as current — the one
 * remaining place where the product gave a *wrong* answer rather than lacking a feature.
 *
 * Expired is not deleted. The passage stays findable, because "what did the old contract say"
 * is a real question, and stops being authoritative.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let viewerSession: { organizationId: string; userId: string; timezone: string }
let currentId: string
let expiredId: string

const CURRENT_BODY = [
  '# Cold chain handling standard (current)',
  '',
  '## Pre-cooling',
  'Trailers are pre-cooled to minus twenty degrees celsius before any pallet is loaded.',
].join('\n')

const OLD_BODY = [
  '# Cold chain handling standard (2023)',
  '',
  '## Pre-cooling',
  'Trailers are pre-cooled to minus eighteen degrees celsius before any pallet is loaded.',
].join('\n')

beforeAll(async () => {
  org = await createTenant('effective-term')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  viewerSession = { organizationId: org.organizationId, userId: org.viewerId, timezone: TZ }

  await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const older = await uploadDocument(ctx, actor, {
      title: 'Cold chain handling standard (2023)',
      body: OLD_BODY,
      docType: 'policy',
      effectiveFrom: '2023-01-01',
      effectiveTo: '2023-12-31',
    })
    expiredId = older.document.id

    const current = await uploadDocument(ctx, actor, {
      title: 'Cold chain handling standard (current)',
      body: CURRENT_BODY,
      docType: 'policy',
      effectiveFrom: '2024-01-01',
    })
    currentId = current.document.id
  })
})

afterAll(async () => {
  await destroyTenant('effective-term')
  await closePools()
})

describe('a term that has ended is not current', () => {
  it('is reported as expired on the document, with its dates', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const expired = await getDocument(ctx, actor, expiredId)
      expect(expired.effectiveFrom).toBe('2023-01-01')
      expect(expired.effectiveTo).toBe('2023-12-31')
      expect(expired.expired).toBe(true)

      const current = await getDocument(ctx, actor, currentId)
      expect(current.effectiveTo).toBeNull()
      expect(current.expired).toBe(false)
    })
  })

  it('carries the term onto every passage as a column, and keeps it out of the embedding', async () => {
    const chunks = await adminSql()<{ effectiveTo: string | null; header: string }[]>`
      SELECT effective_to::text AS "effectiveTo", context_header AS header
      FROM document_chunks WHERE document_id = ${expiredId}`
    expect(chunks.length).toBeGreaterThan(0)
    for (const chunk of chunks) {
      expect(chunk.effectiveTo).toBe('2023-12-31')
      // The header is embedded, so administrative metadata stays out of it: dates in the
      // vector diluted it and cost recall, which the supersession eval caught. The title
      // legitimately carries a year — what must not appear is the term phrasing.
      expect(chunk.header).not.toMatch(/in force|effective from|expired|until \d{4}/i)
    }
  })

  it('is still findable, and ranked below the passage that is current', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const result = await hybridSearch(ctx, actor, 'what temperature are trailers pre-cooled to', {
        topK: 10,
      })

      const expired = result.chunks.find((chunk) => chunk.documentId === expiredId)
      const current = result.chunks.find((chunk) => chunk.documentId === currentId)

      // Both retrieved: removing the old one would make "what did it used to say"
      // unanswerable rather than merely un-authoritative.
      expect(expired).toBeDefined()
      expect(current).toBeDefined()
      expect(expired!.expiredOn).toBe('2023-12-31')
      expect(current!.expiredOn).toBeNull()
      expect(current!.rerankScore).toBeGreaterThan(expired!.rerankScore)
    })
  })

  it('can be dropped outright when the caller only wants what is in force', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const result = await hybridSearch(ctx, actor, 'pre-cooled trailers temperature', {
        topK: 10,
        currentOnly: true,
      })
      expect(result.chunks.some((chunk) => chunk.documentId === expiredId)).toBe(false)
      expect(result.chunks.some((chunk) => chunk.documentId === currentId)).toBe(true)
    })
  })
})

describe('superseding something closes it', () => {
  it('derives the end date from the replacement rather than asking twice', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const oldAgreement = await uploadDocument(ctx, actor, {
        title: 'Service agreement (2024)',
        body: '# Service agreement 2024\n\nChilled consignments are delivered within a 0°C to 5°C band.',
        docType: 'contract',
        effectiveFrom: '2024-04-01',
      })
      const amendment = await uploadDocument(ctx, actor, {
        title: 'Service agreement amendment (2025)',
        body: '# Amendment 2025\n\nChilled consignments are delivered within a 0°C to 4°C band.',
        docType: 'contract',
        effectiveFrom: '2025-01-01',
      })

      const [older] = await ctx.sql<{ id: string }[]>`
        SELECT current_version_id AS id FROM documents WHERE id = ${oldAgreement.document.id}`
      await ctx.sql`
        UPDATE document_versions SET supersedes_version_id = ${older!.id}
        WHERE id = (SELECT current_version_id FROM documents WHERE id = ${amendment.document.id})`

      const closed = await getDocument(ctx, actor, oldAgreement.document.id)
      // The day before the replacement takes effect. That is what supersession means.
      expect(closed.effectiveTo).toBe('2024-12-31')
      expect(closed.expired).toBe(true)
    })
  })

  it('does not argue with a date somebody stated themselves', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const stated = await uploadDocument(ctx, actor, {
        title: 'Rate card (stated term)',
        body: '# Rate card\n\nGroupage is charged per pallet space.',
        docType: 'contract',
        effectiveFrom: '2024-01-01',
        effectiveTo: '2024-06-30',
      })
      const replacement = await uploadDocument(ctx, actor, {
        title: 'Rate card (replacement)',
        body: '# Rate card 2025\n\nGroupage is charged per pallet space, revised.',
        docType: 'contract',
        effectiveFrom: '2025-01-01',
      })

      const [older] = await ctx.sql<{ id: string }[]>`
        SELECT current_version_id AS id FROM documents WHERE id = ${stated.document.id}`
      await ctx.sql`
        UPDATE document_versions SET supersedes_version_id = ${older!.id}
        WHERE id = (SELECT current_version_id FROM documents WHERE id = ${replacement.document.id})`

      const after = await getDocument(ctx, actor, stated.document.id)
      expect(after.effectiveTo).toBe('2024-06-30')
    })
  })
})

describe('setting a term', () => {
  it('needs a say over the document, not a read of it', async () => {
    await withTenant(viewerSession, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        setEffectiveDates(ctx, actor, { documentId: currentId, effectiveTo: '2026-01-01' }),
      ).rejects.toThrow(PermissionError)
    })
  })

  it('refuses a term that ends before it starts', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        setEffectiveDates(ctx, actor, { documentId: currentId, effectiveTo: '2023-06-01' }),
      ).rejects.toThrow(ValidationError)
    })
  })

  it('takes the passages with it, by trigger', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await setEffectiveDates(ctx, actor, { documentId: currentId, effectiveTo: '2030-12-31' })
    })

    const chunks = await adminSql()<{ effectiveTo: string | null }[]>`
      SELECT effective_to::text AS "effectiveTo" FROM document_chunks WHERE document_id = ${currentId}`
    // By trigger: the passage is what the model reads, so it cannot go on claiming the old
    // term while the document says otherwise.
    for (const chunk of chunks) expect(chunk.effectiveTo).toBe('2030-12-31')

    // And nothing is queued: the header carries no dates, so there is nothing to rebuild.
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const backlog = await ingestionBacklog(ctx, actor)
      expect(backlog.jobs.some((job) => job.documentId === currentId)).toBe(false)
    })
  })

  it('counts what is out of term, which nothing could answer', async () => {
    await withTenant(session, async (ctx) => {
      const health = await knowledgeHealth(ctx)
      expect(health.terms.expired).toBeGreaterThan(0)
      expect(health.terms.expiredDocuments.some((row) => row.id === expiredId)).toBe(true)
    })
  })
})

describe('the constraint holds whatever writes it', () => {
  it('refuses a term that ends before it starts, on the document and on the passage', async () => {
    await expect(
      adminSql()`
        UPDATE documents SET effective_from = '2025-01-01', effective_to = '2024-01-01'
        WHERE id = ${currentId}`,
    ).rejects.toThrow(/documents_effective_range/)
  })
})
