-- Undoes 0069. The trail, its append-only trigger and the runtime's SELECT are all 0005's and
-- 0008's and stay; what goes is the two indexes the reader needs to be usable.

DROP INDEX IF EXISTS audit_logs_entity_idx;
DROP INDEX IF EXISTS audit_logs_principal_idx;
