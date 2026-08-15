import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  documentIngestions,
  EMBEDDING_DIMENSIONS,
  HashingEmbeddingProvider,
  ingestionBacklog,
  MAX_ATTEMPTS,
  NotFoundError,
  PermissionError,
  queueIngestion,
  requestReindex,
  runIngestionJobs,
  setEmbeddingProvider,
  uploadDocument,
  ValidationError,
  type EmbeddingProvider,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * The ingestion queue (ADR 0038).
 *
 * `ingestion_jobs` was created in migration 0004 and never written to: indexing ran inline
 * inside the caller's transaction, so a failure rolled back with it and there was no re-index
 * path anywhere in the product.
 *
 * The failures here are real ones — the embedding provider is swapped for one that throws,
 * which is the actual way this breaks — rather than rows hand-written to look broken.
 */

/** Fails the way a provider outage does: at embed time, after the version row is written. */
class BrokenEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'broken'
  readonly dimensions = EMBEDDING_DIMENSIONS
  async embed(): Promise<number[][]> {
    throw new Error('The embedding provider did not respond.')
  }
}

let org: TenantFixture
let other: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let viewerSession: { organizationId: string; userId: string; timezone: string }
let documentId: string

beforeAll(async () => {
  org = await createTenant('ingestion-queue')
  other = await createTenant('ingestion-queue-b')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
  viewerSession = { organizationId: org.organizationId, userId: org.viewerId, timezone: 'Europe/London' }

  await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const { document } = await uploadDocument(ctx, actor, {
      title: 'Cold chain handling standard',
      body: [
        '# Cold chain handling standard',
        '',
        '## Pre-cooling',
        'Trailers are pre-cooled to minus twenty degrees before any pallet is loaded.',
        '',
        '## Excursions',
        'Any temperature excursion beyond two degrees is reported to the customer within four hours.',
      ].join('\n'),
      docType: 'policy',
    })
    documentId = document.id
  })
})

afterEach(() => {
  setEmbeddingProvider(new HashingEmbeddingProvider())
})

afterAll(async () => {
  await destroyTenant('ingestion-queue')
  await destroyTenant('ingestion-queue-b')
  await closePools()
})

describe('every ingestion leaves a record', () => {
  it('records an ordinary upload, with what the post-index check found', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const history = await documentIngestions(ctx, actor, documentId)
      expect(history).toHaveLength(1)
      expect(history[0]!.status).toBe('indexed')
      expect(history[0]!.chunksWritten).toBeGreaterThan(0)
      // The whole reason the column exists: this used to be computed and thrown away.
      expect(history[0]!.verification?.sampled).toBeGreaterThan(0)
      expect(history[0]!.reason).toContain('Uploaded by')
    })
  })
})

describe('a document can be indexed again, which it never could', () => {
  it('refuses a reader, because re-indexing rewrites the document’s passages', async () => {
    await withTenant(viewerSession, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(requestReindex(ctx, actor, { documentId })).rejects.toThrow(PermissionError)
    })
  })

  it('refuses one that has no stored copy, rather than queueing work that cannot run', async () => {
    const [bare] = await adminSql()<{ id: string }[]>`
      INSERT INTO documents (organization_id, title, doc_type, sensitivity, index_status, is_demo, created_by)
      VALUES (${org.organizationId}, 'Never indexed', 'document', 'internal', 'pending', true, ${org.ownerId})
      RETURNING id`

    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(requestReindex(ctx, actor, { documentId: bare!.id })).rejects.toThrow(ValidationError)
    })
  })

  it('queues one, and the worker indexes it', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const history = await requestReindex(ctx, actor, { documentId, reason: 'Search misses the excursion rule.' })
      expect(history[0]!.status).toBe('pending')
      expect(history[0]!.reason).toContain('Search misses the excursion rule')
    })

    const outcome = await runIngestionJobs(session)
    expect(outcome.claimed).toBe(1)
    expect(outcome.indexed).toBe(1)

    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const history = await documentIngestions(ctx, actor, documentId)
      expect(history[0]!.status).toBe('indexed')
      expect(history[0]!.chunksWritten).toBeGreaterThan(0)
      expect(history[0]!.finishedAt).not.toBeNull()
    })
  })

  it('asking twice while it is still waiting is the same request', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await requestReindex(ctx, actor, { documentId })
      await requestReindex(ctx, actor, { documentId })
    })

    const [live] = await adminSql()<{ count: string }[]>`
      SELECT count(*)::text AS count FROM ingestion_jobs
      WHERE organization_id = ${org.organizationId} AND document_id = ${documentId}
        AND finished_at IS NULL AND deleted_at IS NULL`
    expect(Number(live!.count)).toBe(1)

    await runIngestionJobs(session)
  })
})

describe('a failure is durable, retried, and eventually somebody’s problem', () => {
  it('records the failure instead of losing it with the transaction', async () => {
    await withTenant(session, async (ctx) => {
      await requestReindex(ctx, await loadActor(ctx), { documentId })
    })

    setEmbeddingProvider(new BrokenEmbeddingProvider())
    const outcome = await runIngestionJobs(session)
    expect(outcome.failed).toBe(1)
    expect(outcome.gaveUp).toBe(0)

    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const [job] = await documentIngestions(ctx, actor, documentId)
      expect(job!.status).toBe('failed')
      expect(job!.lastError).toContain('did not respond')
      expect(job!.attempts).toBe(1)
      // Still coming back for it, so nobody is being asked to do anything yet.
      expect(job!.nextAttemptAt).not.toBeNull()
      expect(job!.gaveUp).toBe(false)
    })
  })

  it('gives up after the fifth try and says so out loud', async () => {
    setEmbeddingProvider(new BrokenEmbeddingProvider())

    // Backoff is real time, which a test should not wait for: each round is pulled forward
    // rather than the clock being faked, so the claim query under test is the real one.
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
      await adminSql()`
        UPDATE ingestion_jobs SET next_attempt_at = now() - interval '1 minute'
        WHERE organization_id = ${org.organizationId} AND document_id = ${documentId}
          AND finished_at IS NULL`
      await runIngestionJobs(session)
    }

    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const [job] = await documentIngestions(ctx, actor, documentId)
      expect(job!.attempts).toBe(MAX_ATTEMPTS)
      expect(job!.gaveUp).toBe(true)
      expect(job!.nextAttemptAt).toBeNull()
      expect(job!.finishedAt).not.toBeNull()
    })

    // And it is on the screen a person looks at, not only in the row.
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const backlog = await ingestionBacklog(ctx, actor)
      expect(backlog.gaveUp).toBe(1)
      expect(backlog.jobs[0]!.documentId).toBe(documentId)
    })

    const [activity] = await adminSql()<{ summary: string }[]>`
      SELECT summary FROM activities
      WHERE organization_id = ${org.organizationId} AND entity_id = ${documentId} AND verb = 'failed'
      ORDER BY occurred_at DESC LIMIT 1`
    expect(activity!.summary).toContain('after 5 attempts')
  })

  it('a person can try again, and the count it gave up on stays on the record', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const history = await requestReindex(ctx, actor, { documentId })
      expect(history[0]!.status).toBe('pending')
      // Woken rather than replaced: "we tried five times, then Maya decided to try again".
      expect(history[0]!.attempts).toBe(MAX_ATTEMPTS)
      expect(history[0]!.reason).toContain('Re-index asked for by')
    })

    const outcome = await runIngestionJobs(session)
    expect(outcome.indexed).toBe(1)

    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const backlog = await ingestionBacklog(ctx, actor)
      expect(backlog.gaveUp).toBe(0)
      expect(backlog.waiting + backlog.running + backlog.retrying).toBe(0)
    })
  })
})

describe('the queue is bounded by the tenant like everything else', () => {
  it('will not record a job whose document belongs to another organization', async () => {
    await expect(
      adminSql()`
        INSERT INTO ingestion_jobs (organization_id, document_id, status, next_attempt_at, is_demo)
        VALUES (${org.organizationId}, ${other.documentId}, 'pending', now(), true)`,
    ).rejects.toThrow(/same organization/)
  })

  it('does not show one tenant’s backlog to another', async () => {
    await withTenant(session, async (ctx) => {
      await queueIngestion(ctx, { documentId, reason: 'Left waiting on purpose.' })
    })

    await withTenant(
      { organizationId: other.organizationId, userId: other.ownerId, timezone: 'Europe/London' },
      async (ctx) => {
        const actor = await loadActor(ctx)
        const backlog = await ingestionBacklog(ctx, actor)
        expect(backlog.waiting).toBe(0)
        expect(backlog.jobs).toEqual([])
      },
    )

    // And a document from another tenant is not found rather than refused (§3.2).
    await withTenant(
      { organizationId: other.organizationId, userId: other.ownerId, timezone: 'Europe/London' },
      async (ctx) => {
        const actor = await loadActor(ctx)
        await expect(requestReindex(ctx, actor, { documentId })).rejects.toThrow(NotFoundError)
      },
    )

    await runIngestionJobs(session)
  })
})

describe('purging a document takes its indexing record with it', () => {
  it('leaves no evidence that it was ever indexed (§25.13)', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const { document } = await uploadDocument(ctx, actor, {
        title: 'Temporary note',
        body: '# Temporary note\n\nThis exists only to be deleted.',
      })
      const { purgeDocument } = await import('@superwork/core')
      await purgeDocument(ctx, document.id)

      const [row] = await ctx.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM ingestion_jobs
        WHERE organization_id = ${ctx.organizationId} AND document_id = ${document.id}`
      expect(Number(row!.count)).toBe(0)
    })
  })
})
