DROP TRIGGER IF EXISTS document_versions_close_superseded ON document_versions;
DROP FUNCTION IF EXISTS sw_close_superseded_document();

DROP TRIGGER IF EXISTS documents_effective_dates_cascade ON documents;
DROP FUNCTION IF EXISTS sw_chunk_effective_dates();

DROP INDEX IF EXISTS documents_effective_to_idx;

ALTER TABLE document_chunks DROP CONSTRAINT IF EXISTS document_chunks_effective_range;
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_effective_range;
