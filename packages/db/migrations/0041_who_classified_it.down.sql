DROP TRIGGER IF EXISTS documents_human_classification_cascade ON documents;
DROP FUNCTION IF EXISTS sw_human_classification_cascade();

DROP INDEX IF EXISTS documents_human_classified_idx;

ALTER TABLE documents
  DROP CONSTRAINT IF EXISTS documents_human_classification_is_attributed,
  DROP CONSTRAINT IF EXISTS documents_sensitivity_source_known;

ALTER TABLE documents
  DROP COLUMN IF EXISTS sensitivity_reason,
  DROP COLUMN IF EXISTS sensitivity_set_at,
  DROP COLUMN IF EXISTS sensitivity_set_by,
  DROP COLUMN IF EXISTS sensitivity_auto;
