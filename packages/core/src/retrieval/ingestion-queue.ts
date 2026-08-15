import { asJson, withTenant, type TenantContext, type TenantContextInput } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'
import { ingestDocument, type IngestResult } from './ingest.js'

/**
 * The ingestion queue (§7.1).
 *
 * `ingestion_jobs` was created in migration 0004 and never written to. Ingestion ran inline
 * inside the caller's transaction, which hid three things:
 *
 *   **A failed upload left nothing.** `ingestDocument` marks the document `failed` and then
 *   rethrows; the rethrow aborts the enclosing transaction, so the document row and the
 *   failure record roll back together. The person was told it did not work and the product
 *   kept no evidence it had ever been tried — nothing to retry, nothing to count.
 *
 *   **There was no re-index path at all.** A document indexed while the embedding provider
 *   was misbehaving stayed that way for good.
 *
 *   **The verification result was thrown away.** It is computed on every ingest and its
 *   warnings were flattened into `documents.index_error`, a column that also holds failure
 *   messages — so "indexed, but two sections are hard to find" and "did not index" read
 *   identically.
 *
 * A job is the record of one attempt to put a document into company memory: when, how many
 * times, how many sections, what the post-index check found, and — when it gave up — what
 * went wrong and whose problem it now is.
 */

/** How many times the queue tries on its own before it becomes a person's decision. */
export const MAX_ATTEMPTS = 5

export type JobStatus = 'pending' | 'processing' | 'indexed' | 'failed' | 'quarantined' | 'skipped'

export interface IngestionJobView {
  id: string
  documentId: string
  documentTitle: string
  status: JobStatus
  reason: string | null
  priority: number
  attempts: number
  chunksWritten: number
  lastError: string | null
  /** Null once it will not be tried again — either it is done, or it gave up. */
  nextAttemptAt: Date | null
  startedAt: Date | null
  finishedAt: Date | null
  /** What the post-index self-check found. Null until an attempt has completed. */
  verification: { sampled: number; answerable: number; warnings: string[] } | null
  /** True when the queue has stopped trying and is waiting for somebody. */
  gaveUp: boolean
  createdAt: Date
}

const SELECT_JOB = (ctx: TenantContext) => ctx.sql`
  SELECT j.id, j.document_id AS "documentId", d.title AS "documentTitle", j.status::text AS status,
         j.reason, j.priority, j.attempts, j.chunks_written AS "chunksWritten",
         j.last_error AS "lastError", j.next_attempt_at AS "nextAttemptAt",
         j.started_at AS "startedAt", j.finished_at AS "finishedAt", j.verification,
         (j.status = 'failed' AND j.finished_at IS NOT NULL) AS "gaveUp",
         j.created_at AS "createdAt"
  FROM ingestion_jobs j
  JOIN documents d ON d.id = j.document_id`

/**
 * Puts a document in the queue.
 *
 * No actor: this is the system's own call, used by the upload path and by the meeting
 * transcript writer. `requestReindex` is the one a person presses, and it checks permission
 * before calling this.
 */
export async function queueIngestion(
  ctx: TenantContext,
  input: { documentId: string; reason: string; priority?: number; notBefore?: Date },
): Promise<string | null> {
  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO ingestion_jobs (
      organization_id, document_id, status, priority, reason, next_attempt_at, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.documentId}, 'pending', ${input.priority ?? 100},
      ${input.reason}, ${input.notBefore ?? new Date()}, ${ctx.userId}
    )
    -- Already waiting its turn: a second request is the same request. The partial unique
    -- index is on the live rows only, so a finished job never blocks a new one.
    ON CONFLICT (organization_id, document_id) WHERE finished_at IS NULL AND deleted_at IS NULL
    DO NOTHING
    RETURNING id`
  return row?.id ?? null
}

/**
 * Records an ingestion that has already happened, as a finished job.
 *
 * The upload path still indexes inline — a document that is not indexed is not memory, and
 * making the person wait for a worker to catch up would be a worse product. What this adds is
 * that the attempt leaves a record: the queue is the history of every ingestion, not only of
 * the ones that needed retrying.
 */
export async function recordIngestion(
  ctx: TenantContext,
  input: { documentId: string; reason: string; result: IngestResult },
): Promise<void> {
  const { result } = input
  await ctx.sql`
    INSERT INTO ingestion_jobs (
      organization_id, document_id, status, reason, attempts, chunks_written, verification,
      started_at, finished_at, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.documentId}, ${result.status}, ${input.reason}, 1,
      ${result.chunks}, ${ctx.sql.json(asJson(result.verification))}, now(), now(), ${ctx.userId}
    )`
}

interface ClaimedJob {
  id: string
  documentId: string
  attempts: number
  reason: string | null
}

/**
 * Claims what is due. `SKIP LOCKED` so two workers never take the same document, which would
 * write two versions of one body.
 */
export async function claimIngestionJobs(ctx: TenantContext, limit = 5): Promise<ClaimedJob[]> {
  return ctx.sql<ClaimedJob[]>`
    UPDATE ingestion_jobs
    SET status = 'processing', attempts = attempts + 1, started_at = now(),
        next_attempt_at = NULL, updated_at = now()
    WHERE id IN (
      SELECT id FROM ingestion_jobs
      WHERE organization_id = ${ctx.organizationId}
        AND status IN ('pending', 'failed')
        AND finished_at IS NULL AND deleted_at IS NULL
        AND next_attempt_at IS NOT NULL AND next_attempt_at <= now()
      ORDER BY priority, created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, document_id AS "documentId", attempts, reason`
}

/**
 * The body to re-index, which is the current version's.
 *
 * A document with no stored version has nothing to index — its body only ever existed in the
 * request that uploaded it. That is not an error worth retrying, so it is skipped by name
 * rather than failed five times.
 */
async function bodyFor(
  ctx: TenantContext,
  documentId: string,
): Promise<{
  body: string
  title: string
  docType: string
  companyId: string | null
  projectId: string | null
  spaceId: string | null
  ownerId: string | null
  departmentId: string | null
  sensitivity: string
} | null> {
  const [row] = await ctx.sql<
    {
      body: string
      title: string
      docType: string
      companyId: string | null
      projectId: string | null
      spaceId: string | null
      ownerId: string | null
      departmentId: string | null
      sensitivity: string
    }[]
  >`
    SELECT dv.body, d.title, d.doc_type AS "docType", d.company_id AS "companyId",
           d.project_id AS "projectId", d.space_id AS "spaceId", d.owner_id AS "ownerId",
           d.department_id AS "departmentId", d.sensitivity::text AS sensitivity
    FROM documents d
    JOIN document_versions dv ON dv.id = d.current_version_id
    WHERE d.organization_id = ${ctx.organizationId} AND d.id = ${documentId} AND d.deleted_at IS NULL`
  return row ?? null
}

async function finishJob(
  ctx: TenantContext,
  jobId: string,
  result: IngestResult,
): Promise<void> {
  await ctx.sql`
    UPDATE ingestion_jobs
    SET status = ${result.status}, chunks_written = ${result.chunks},
        verification = ${ctx.sql.json(asJson(result.verification))},
        last_error = NULL, next_attempt_at = NULL, finished_at = now(), updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${jobId}`
}

async function skipJob(ctx: TenantContext, jobId: string, why: string): Promise<void> {
  await ctx.sql`
    UPDATE ingestion_jobs
    SET status = 'skipped', last_error = ${why}, next_attempt_at = NULL,
        finished_at = now(), updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${jobId}`
}

/**
 * Records a failure, and decides whether the queue tries again.
 *
 * Exponential backoff, then a terminus: after `MAX_ATTEMPTS` the job stops and says so, which
 * is what puts it on the screen a person looks at. A queue that retries for ever is a queue
 * that never tells anybody anything is wrong.
 */
async function failJob(
  ctx: TenantContext,
  jobId: string,
  error: string,
  attempts: number,
): Promise<void> {
  const giveUp = attempts >= MAX_ATTEMPTS
  const delaySeconds = Math.min(2 ** attempts * 15, 3600)
  await ctx.sql`
    UPDATE ingestion_jobs
    SET status = 'failed', last_error = ${error.slice(0, 2000)},
        next_attempt_at = ${giveUp ? null : ctx.sql`now() + make_interval(secs => ${delaySeconds})`},
        finished_at = ${giveUp ? ctx.sql`now()` : null},
        updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${jobId}`

  if (giveUp) {
    const [job] = await ctx.sql<{ documentId: string; title: string }[]>`
      SELECT j.document_id AS "documentId", d.title FROM ingestion_jobs j
      JOIN documents d ON d.id = j.document_id
      WHERE j.organization_id = ${ctx.organizationId} AND j.id = ${jobId}`
    if (job) {
      // The activity feed rather than a notification: nobody is being chased, and this is a
      // fact about a document rather than a task somebody owes.
      await writeActivity(ctx, {
        actorType: 'system',
        actorLabel: 'Superwork',
        verb: 'failed',
        entityType: 'document',
        entityId: job.documentId,
        entityLabel: job.title,
        summary: `Could not index “${job.title}” after ${attempts} attempts. ${error.slice(0, 200)}`,
      })
    }
  }
}

export interface IngestionRunOutcome {
  claimed: number
  indexed: number
  failed: number
  skipped: number
  gaveUp: number
}

/**
 * Runs what is due, one document at a time.
 *
 * Each job gets its own transaction, and a failure is recorded in a *further* one. Both
 * matter: a database error inside `ingestDocument` aborts the transaction it happened in, so
 * writing the failure on the same connection would silently fail too — and the job would be
 * left `processing` for ever with nothing to say why.
 */
export async function runIngestionJobs(
  session: TenantContextInput,
  limit = 5,
): Promise<IngestionRunOutcome> {
  const jobs = await withTenant(session, (ctx) => claimIngestionJobs(ctx, limit))
  const outcome: IngestionRunOutcome = { claimed: jobs.length, indexed: 0, failed: 0, skipped: 0, gaveUp: 0 }

  for (const job of jobs) {
    try {
      const result = await withTenant(session, async (ctx) => {
        const source = await bodyFor(ctx, job.documentId)
        if (!source) return null
        return ingestDocument(ctx, {
          documentId: job.documentId,
          body: source.body,
          title: source.title,
          docType: source.docType,
          sensitivityHint: source.sensitivity as never,
          // Filing is restated so a re-index cannot quietly unfile the document — the same
          // trap `ingestDocument` documents in its own UPDATE.
          companyId: source.companyId,
          projectId: source.projectId,
          spaceId: source.spaceId,
          ownerId: source.ownerId,
          departmentId: source.departmentId,
        })
      })

      if (!result) {
        await withTenant(session, (ctx) =>
          skipJob(
            ctx,
            job.id,
            'This document has no stored body to index. It was never successfully indexed, so there is nothing to re-index — upload it again.',
          ),
        )
        outcome.skipped += 1
        continue
      }

      await withTenant(session, (ctx) => finishJob(ctx, job.id, result))
      if (result.status === 'indexed') outcome.indexed += 1
      else outcome.skipped += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await withTenant(session, (ctx) => failJob(ctx, job.id, message, job.attempts))
      outcome.failed += 1
      if (job.attempts >= MAX_ATTEMPTS) outcome.gaveUp += 1
    }
  }

  return outcome
}

function guardRead(ctx: TenantContext, actor: Actor): void {
  const decision = can(actor, 'document:read', {
    type: 'document',
    organizationId: ctx.organizationId,
    riskTier: 'read',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
}

export interface IngestionBacklog {
  waiting: number
  running: number
  retrying: number
  gaveUp: number
  /** The jobs worth putting on a screen: everything unfinished, plus what gave up. */
  jobs: IngestionJobView[]
}

export async function ingestionBacklog(
  ctx: TenantContext,
  actor: Actor,
  limit = 20,
): Promise<IngestionBacklog> {
  guardRead(ctx, actor)
  const sql = ctx.sql

  const [counts] = await sql<{ waiting: number; running: number; retrying: number; gaveUp: number }[]>`
    SELECT
      count(*) FILTER (WHERE status = 'pending')::int AS waiting,
      count(*) FILTER (WHERE status = 'processing')::int AS running,
      count(*) FILTER (WHERE status = 'failed' AND finished_at IS NULL)::int AS retrying,
      count(*) FILTER (WHERE status = 'failed' AND finished_at IS NOT NULL)::int AS "gaveUp"
    FROM ingestion_jobs
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL`

  const jobs = await sql<IngestionJobView[]>`
    ${SELECT_JOB(ctx)}
    WHERE j.organization_id = ${ctx.organizationId} AND j.deleted_at IS NULL
      AND (j.finished_at IS NULL OR j.status = 'failed')
    ORDER BY (j.status = 'failed' AND j.finished_at IS NOT NULL) DESC, j.created_at DESC
    LIMIT ${limit}`

  return { ...counts!, jobs }
}

/** What happened to one document, most recent first — the "why is this not findable" answer. */
export async function documentIngestions(
  ctx: TenantContext,
  actor: Actor,
  documentId: string,
  limit = 5,
): Promise<IngestionJobView[]> {
  guardRead(ctx, actor)
  return ctx.sql<IngestionJobView[]>`
    ${SELECT_JOB(ctx)}
    WHERE j.organization_id = ${ctx.organizationId} AND j.document_id = ${documentId}
      AND j.deleted_at IS NULL
    ORDER BY j.created_at DESC
    LIMIT ${limit}`
}

/**
 * Asks for a document to be indexed again.
 *
 * Needs a say over the document rather than a read of it: re-indexing writes a new version,
 * supersedes the old chunks and can change the document's classification, which is not
 * something a reader should be able to set off.
 */
export async function requestReindex(
  ctx: TenantContext,
  actor: Actor,
  input: { documentId: string; reason?: string },
): Promise<IngestionJobView[]> {
  const [document] = await ctx.sql<
    { title: string; ownerId: string | null; departmentId: string | null; hasBody: boolean }[]
  >`
    SELECT title, owner_id AS "ownerId", department_id AS "departmentId",
           current_version_id IS NOT NULL AS "hasBody"
    FROM documents
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.documentId} AND deleted_at IS NULL`
  if (!document) throw new NotFoundError()

  const decision = can(actor, 'document:update', {
    type: 'document',
    id: input.documentId,
    organizationId: ctx.organizationId,
    ownerId: document.ownerId,
    departmentId: document.departmentId,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  if (!document.hasBody) {
    throw new ValidationError(
      `“${document.title}” has never been indexed, so there is no stored copy to index again. Upload it again instead.`,
    )
  }

  const reason = input.reason?.trim()
    ? `${actor.displayName} asked for it: ${input.reason.trim()}`
    : `Re-index asked for by ${actor.displayName}`

  // A job that gave up is woken rather than replaced, so the attempt count it gave up on
  // stays on the record next to the person who decided to try again.
  const [revived] = await ctx.sql<{ id: string }[]>`
    UPDATE ingestion_jobs
    SET status = 'pending', next_attempt_at = now(), finished_at = NULL,
        reason = ${reason}, updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND document_id = ${input.documentId}
      AND status = 'failed' AND finished_at IS NOT NULL AND deleted_at IS NULL
    RETURNING id`

  const jobId = revived?.id ?? (await queueIngestion(ctx, { documentId: input.documentId, reason, priority: 50 }))

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'document.reindex_requested',
    entityType: 'document',
    entityId: input.documentId,
    after: { reason, jobId, revived: revived !== undefined },
  })

  return documentIngestions(ctx, actor, input.documentId)
}
