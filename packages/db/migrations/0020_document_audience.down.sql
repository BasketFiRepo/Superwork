-- 0020 · rollback

DROP INDEX IF EXISTS document_permissions_lookup_idx;
DROP INDEX IF EXISTS document_permissions_role_once;
DROP INDEX IF EXISTS document_permissions_subject_once;

ALTER TABLE document_permissions DROP COLUMN IF EXISTS granted_by;
ALTER TABLE document_permissions DROP COLUMN IF EXISTS reason;

ALTER TABLE document_permissions DROP CONSTRAINT IF EXISTS document_permissions_one_subject;
ALTER TABLE document_permissions DROP CONSTRAINT IF EXISTS document_permissions_relation_known;
ALTER TABLE document_permissions DROP CONSTRAINT IF EXISTS document_permissions_subject_known;
