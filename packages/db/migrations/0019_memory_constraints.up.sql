-- 0019 — The constraints agent memory needs in order to be used.
--
-- `memory_facts` was designed in 0006 — scope, subject/predicate/object, confidence, a
-- candidate → confirmed → superseded → forgotten state machine, supersedes_id,
-- conflict_flagged, validity dates, confirmed_by, source_run_id, source_citation — and
-- nothing has ever written a row to it. Two live code paths read it: `deleteDocument`
-- counts "memories forgotten" and `purgeDocument` forgets them, so both have been
-- reporting zero about an empty table since Phase 1.
--
-- Turning it on needs the rules the original migration left as comments. A comment saying
-- `-- candidate | confirmed | superseded | forgotten` does not stop 'confimed' being
-- written, and an unenforced state machine is a state machine that will eventually hold
-- every state at once.

ALTER TABLE memory_facts
  ADD CONSTRAINT memory_state_known
    CHECK (state IN ('candidate', 'confirmed', 'superseded', 'forgotten'));

ALTER TABLE memory_facts
  ADD CONSTRAINT memory_scope_known
    CHECK (scope IN ('organization', 'department', 'project', 'company', 'user'));

-- An organization-wide fact has no scope_id; every narrower scope must say what it is
-- scoped to, or it is an organization-wide fact wearing a disguise.
ALTER TABLE memory_facts
  ADD CONSTRAINT memory_scope_id_matches_scope
    CHECK ((scope = 'organization') = (scope_id IS NULL));

-- Nothing is remembered without a source. This is the rule that separates a memory from
-- a rumour: every fact the assistant recalls has to be traceable to a document passage
-- somebody can open and disagree with.
ALTER TABLE memory_facts
  ADD CONSTRAINT memory_has_a_source
    CHECK (
      state = 'forgotten'
      OR (source_citation IS NOT NULL AND source_citation ? 'documentId' AND source_citation ? 'anchor')
    );

-- A confirmed fact names the person who confirmed it. "The system decided this is true"
-- is exactly the thing this table must not be able to say.
ALTER TABLE memory_facts
  ADD CONSTRAINT memory_confirmed_by_a_person
    CHECK (state <> 'confirmed' OR confirmed_by IS NOT NULL);

ALTER TABLE memory_facts
  ADD CONSTRAINT memory_validity_ordered
    CHECK (valid_to IS NULL OR valid_to > valid_from);

ALTER TABLE memory_facts
  ADD CONSTRAINT memory_triple_present
    CHECK (length(btrim(subject)) > 0 AND length(btrim(predicate)) > 0 AND length(btrim(object)) > 0);

-- The important one. Two confirmed answers to the same question are not a conflict to be
-- surfaced later — they are a state the database refuses to be in at all. A new fact that
-- would contradict a confirmed one has to supersede it, which leaves the old answer, the
-- new answer, and who changed their mind, all on the record.
CREATE UNIQUE INDEX memory_one_confirmed_answer
  ON memory_facts (
    organization_id, scope, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(btrim(subject)), lower(btrim(predicate))
  )
  WHERE state = 'confirmed' AND deleted_at IS NULL;

-- Recall reads confirmed facts for a scope, newest first, on every grounded run.
CREATE INDEX memory_recall_idx
  ON memory_facts (organization_id, state, scope, scope_id, valid_from DESC)
  WHERE deleted_at IS NULL;

-- The review screen reads candidates and conflicts, which are rare rows in a large table.
CREATE INDEX memory_pending_idx
  ON memory_facts (organization_id, created_at DESC)
  WHERE state = 'candidate' AND deleted_at IS NULL;
