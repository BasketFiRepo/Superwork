-- 0019 · rollback

DROP INDEX IF EXISTS memory_pending_idx;
DROP INDEX IF EXISTS memory_recall_idx;
DROP INDEX IF EXISTS memory_one_confirmed_answer;

ALTER TABLE memory_facts DROP CONSTRAINT IF EXISTS memory_triple_present;
ALTER TABLE memory_facts DROP CONSTRAINT IF EXISTS memory_validity_ordered;
ALTER TABLE memory_facts DROP CONSTRAINT IF EXISTS memory_confirmed_by_a_person;
ALTER TABLE memory_facts DROP CONSTRAINT IF EXISTS memory_has_a_source;
ALTER TABLE memory_facts DROP CONSTRAINT IF EXISTS memory_scope_id_matches_scope;
ALTER TABLE memory_facts DROP CONSTRAINT IF EXISTS memory_scope_known;
ALTER TABLE memory_facts DROP CONSTRAINT IF EXISTS memory_state_known;
