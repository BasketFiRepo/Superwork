-- 0035 — Indexing becomes something that can be retried.
--
-- `ingestion_jobs` was created in migration 0004 with `attempts`, `last_error`,
-- `chunks_written`, `priority` and a `verification` jsonb, and nothing has ever written a
-- row. Ingestion runs inline inside the caller's transaction instead, which has three
-- consequences nobody could see:
--
--   A failed upload leaves *nothing*. `ingestDocument` marks the document `failed` and
--   rethrows; the rethrow aborts the enclosing transaction, so the document row and the
--   failure record both roll back. The person is told it did not work and the product keeps
--   no evidence that it was ever tried.
--
--   There is no re-index path at all. A document indexed while the embedding provider was
--   misbehaving, or one whose post-index verification warned that a section is unfindable,
--   can never be indexed again by any route in the product.
--
--   The verification result is computed on every ingest and then discarded, except for its
--   warnings, which are flattened into `documents.index_error` — a column that also holds
--   failure messages, so "this indexed but two sections are hard to find" and "this did not
--   index" read identically.
--
-- A queue fixes all three, and the two columns it needs are the two it never had.

ALTER TABLE ingestion_jobs
  -- When to try again. NULL on a job that will not be tried again — either because it
  -- succeeded or because it ran out of attempts and is now a person's problem.
  ADD COLUMN next_attempt_at timestamptz,
  -- Why this was queued, in the words the screen shows: "uploaded", "transcript",
  -- "re-index asked for by Maya Ellison". A queue nobody can read is a queue nobody trusts.
  ADD COLUMN reason text;

-- A job about no document is not a job.
ALTER TABLE ingestion_jobs
  ALTER COLUMN document_id SET NOT NULL;

ALTER TABLE ingestion_jobs
  ADD CONSTRAINT ingestion_jobs_counts_sane
    CHECK (attempts >= 0 AND chunks_written >= 0 AND priority > 0),
  ADD CONSTRAINT ingestion_jobs_verification_is_object
    CHECK (verification IS NULL OR jsonb_typeof(verification) = 'object'),
  -- The whole lifecycle, in one place, so no writer has to remember it.
  --
  --   pending    — waiting, and knows when it is next due
  --   processing — claimed, and knows when it was claimed
  --   failed     — either it will be tried again (next_attempt_at) or it has given up
  --                (finished_at), and never both, and never neither
  --   otherwise  — done; nothing is coming back for it
  ADD CONSTRAINT ingestion_jobs_lifecycle CHECK (
    CASE status
      WHEN 'pending'    THEN finished_at IS NULL AND next_attempt_at IS NOT NULL
      WHEN 'processing' THEN finished_at IS NULL AND started_at IS NOT NULL
      WHEN 'failed'     THEN (next_attempt_at IS NOT NULL) <> (finished_at IS NOT NULL)
      ELSE finished_at IS NOT NULL AND next_attempt_at IS NULL
    END
  );

-- One live job per document. Queueing a re-index twice while the first is still waiting
-- would index the same body twice and write two versions of it.
CREATE UNIQUE INDEX ingestion_jobs_one_live
  ON ingestion_jobs (organization_id, document_id)
  WHERE finished_at IS NULL AND deleted_at IS NULL;

-- The claim: what is due, worst priority first, oldest first within a priority. The index
-- created in 0004 has no organization and no due time, so it could not serve this.
DROP INDEX IF EXISTS ingestion_jobs_queue_idx;
CREATE INDEX ingestion_jobs_due_idx
  ON ingestion_jobs (organization_id, next_attempt_at, priority, created_at)
  WHERE finished_at IS NULL AND deleted_at IS NULL;

-- "What has been indexed lately, and what gave up", which is the read the screen wants.
CREATE INDEX ingestion_jobs_recent_idx
  ON ingestion_jobs (organization_id, created_at DESC)
  WHERE deleted_at IS NULL;

/**
 * The job and its document belong to the same organization.
 *
 * `document_id` has a foreign key but nothing ties it to `organization_id`, and the runner
 * reads the body of whatever document the row names — so a row crossing tenants would index
 * one company's contract into another's memory. Same reasoning as the watcher trigger in
 * 0034: when two facts must agree, the agreement is the database's.
 */
CREATE OR REPLACE FUNCTION sw_ingestion_job_same_org() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM documents
    WHERE id = NEW.document_id AND organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'an ingestion job must name a document in the same organization'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ingestion_jobs_same_org
  BEFORE INSERT OR UPDATE ON ingestion_jobs
  FOR EACH ROW EXECUTE FUNCTION sw_ingestion_job_same_org();
