-- 0012 · rollback

DROP INDEX IF EXISTS notifications_fanout_idx;
DROP INDEX IF EXISTS memberships_lookup_idx;
DROP INDEX IF EXISTS tasks_assignee_keyset_idx;

DROP TABLE IF EXISTS tenant_placements CASCADE;
DROP TABLE IF EXISTS nudges CASCADE;
DROP TABLE IF EXISTS jurisdiction_changes CASCADE;

ALTER TABLE departments DROP COLUMN IF EXISTS legal_entity_id;
DROP TABLE IF EXISTS legal_entities CASCADE;

DROP TABLE IF EXISTS relation_tuples CASCADE;
DROP TABLE IF EXISTS department_quotas CASCADE;

DROP INDEX IF EXISTS agent_runs_department_idx;
DROP INDEX IF EXISTS agent_runs_queue_idx;
ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS queue_class_known,
  DROP COLUMN IF EXISTS queue_wait_ms,
  DROP COLUMN IF EXISTS claimed_by,
  DROP COLUMN IF EXISTS claimed_at,
  DROP COLUMN IF EXISTS queued_at,
  DROP COLUMN IF EXISTS queue_class,
  DROP COLUMN IF EXISTS department_id;
