DROP TRIGGER IF EXISTS ingestion_jobs_same_org ON ingestion_jobs;
DROP FUNCTION IF EXISTS sw_ingestion_job_same_org();

DROP INDEX IF EXISTS ingestion_jobs_recent_idx;
DROP INDEX IF EXISTS ingestion_jobs_due_idx;
DROP INDEX IF EXISTS ingestion_jobs_one_live;

CREATE INDEX ingestion_jobs_queue_idx
  ON ingestion_jobs (status, priority, created_at) WHERE deleted_at IS NULL;

ALTER TABLE ingestion_jobs
  DROP CONSTRAINT IF EXISTS ingestion_jobs_lifecycle,
  DROP CONSTRAINT IF EXISTS ingestion_jobs_verification_is_object,
  DROP CONSTRAINT IF EXISTS ingestion_jobs_counts_sane;

ALTER TABLE ingestion_jobs ALTER COLUMN document_id DROP NOT NULL;

ALTER TABLE ingestion_jobs
  DROP COLUMN IF EXISTS reason,
  DROP COLUMN IF EXISTS next_attempt_at;
