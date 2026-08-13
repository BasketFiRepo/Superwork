-- 0004 · rollback
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_current_version_fk;

DROP TABLE IF EXISTS unanswered_queries CASCADE;
DROP TABLE IF EXISTS ingestion_jobs CASCADE;
DROP TABLE IF EXISTS document_permissions CASCADE;
DROP TABLE IF EXISTS document_chunks CASCADE;
DROP TABLE IF EXISTS document_versions CASCADE;
DROP TABLE IF EXISTS documents CASCADE;
DROP TABLE IF EXISTS knowledge_spaces CASCADE;

DROP FUNCTION IF EXISTS sw_document_chunks_tsv();
DROP TYPE IF EXISTS sw_index_status;
