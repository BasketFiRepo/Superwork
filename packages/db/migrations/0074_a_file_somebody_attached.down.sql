DROP INDEX IF EXISTS documents_storage_key_idx;

ALTER TABLE documents
  DROP CONSTRAINT IF EXISTS documents_file_is_described,
  DROP CONSTRAINT IF EXISTS documents_file_is_whole;

ALTER TABLE documents
  DROP COLUMN IF EXISTS file_name,
  DROP COLUMN IF EXISTS file_bytes;
