-- 0020 — The constraints a circulation list needs, and a way to tell the two grant
-- mechanisms apart.
--
-- `document_permissions` was created in migration 0004 and nothing has ever written to it.
-- It is read in three places that matter — both arms of `hybridSearch` and, since 0019,
-- memory recall — so its branch has been evaluated on every retrieval since Phase 1 and has
-- never matched anything.
--
-- It is worth distinguishing from the mechanism that *did* get built. `relation_tuples` are
-- additive: a tuple grants one person one relation on one object, and never takes anything
-- away. `document_permissions` is the opposite shape, and the predicate in `search.ts` says
-- so — while any row exists for a document, only the subjects named may retrieve it. That
-- is a circulation list, and it is the thing an HR file or a signed contract actually needs.
--
-- The two disagreeing was a live bug: sharing a document through the interface wrote a
-- tuple, so the recipient could open the document's page, while retrieval consulted this
-- table and never saw the grant. "I shared it with you" and "the assistant cannot find it"
-- were both true.

ALTER TABLE document_permissions
  ADD CONSTRAINT document_permissions_subject_known
    CHECK (subject_type IN ('user', 'team', 'department', 'role'));

ALTER TABLE document_permissions
  ADD CONSTRAINT document_permissions_relation_known
    CHECK (relation IN ('viewer', 'editor', 'owner'));

-- A grant names exactly one subject. A row carrying both a subject_id and a subject_role is
-- two grants wearing one row, and the ACL predicate would match on either — which is how a
-- circulation list quietly becomes wider than the person who wrote it believes.
ALTER TABLE document_permissions
  ADD CONSTRAINT document_permissions_one_subject
    CHECK (
      (subject_type = 'role' AND subject_role IS NOT NULL AND subject_id IS NULL)
      OR (subject_type <> 'role' AND subject_id IS NOT NULL AND subject_role IS NULL)
    );

-- The same subject twice on one list is not two grants. Without this, revoking one leaves
-- the other behind and the person keeps access nobody can see a reason for.
--
-- Two indexes rather than one over a coalesced expression: casting the role enum to text
-- is only STABLE, so it cannot appear in an index, and a plain unique index would treat the
-- NULL subject_id of every role grant as distinct — which is exactly the duplicate this is
-- meant to prevent.
CREATE UNIQUE INDEX document_permissions_subject_once
  ON document_permissions (organization_id, document_id, subject_type, subject_id)
  WHERE deleted_at IS NULL AND subject_type <> 'role';

CREATE UNIQUE INDEX document_permissions_role_once
  ON document_permissions (organization_id, document_id, subject_role)
  WHERE deleted_at IS NULL AND subject_type = 'role';

-- Who put somebody on a list, and why. The table had `created_by` and nothing else: a
-- circulation list that cannot say why anybody is on it is one nobody can prune later.
ALTER TABLE document_permissions ADD COLUMN reason text;
ALTER TABLE document_permissions ADD COLUMN granted_by uuid REFERENCES users(id);

-- The ACL subquery runs twice per retrieval and once per recalled memory, always as
-- "are there any rows for this document, and does one of them match me". The existing
-- index covers the first half; this covers the second without a heap fetch.
CREATE INDEX document_permissions_lookup_idx
  ON document_permissions (organization_id, document_id, subject_type, subject_id)
  WHERE deleted_at IS NULL;
