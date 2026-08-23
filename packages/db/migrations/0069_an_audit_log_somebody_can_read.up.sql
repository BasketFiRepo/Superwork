-- 0069 — An audit log somebody can read.
--
-- `writeAudit` is called from all over this product: every classification, every grant, every
-- send, every erasure. `audit_logs` is append-only, enforced by a trigger since 0005, and the
-- runtime role was granted `SELECT, INSERT` on it in 0008 — the SELECT half deliberately, and
-- then never used.
--
-- Nothing reads it. The only two queries against the table in the whole repository are the
-- retention sweep counting rows to delete and the erasure preview counting rows about a person.
-- There is no repository function, no screen, and no way for anybody to look at it.
--
-- Meanwhile `audit:read:org` has been in the administrator's grant list since the ladder was
-- built. So the role list offers a capability, the trail is written everywhere, and the two have
-- never been connected: a permission with no feature behind it, which is the same failure as a
-- column with no writer, one layer up.
--
-- This migration is the small half. What was missing was the reader, and the reader needs the
-- two indexes below.

-- "What has this person done", which is the read the personal record makes — and the one an
-- investigation makes when an account is thought to be compromised. `audit_logs_org_time_idx`
-- from 0005 covers the whole organization by time and cannot help either.
CREATE INDEX audit_logs_principal_idx
  ON audit_logs (organization_id, principal_user_id, occurred_at DESC)
  WHERE principal_user_id IS NOT NULL;

-- "What has happened to this record", which is the question somebody actually arrives with:
-- why is this document classified restricted, who changed this agent, when did this thread
-- become somebody else's.
CREATE INDEX audit_logs_entity_idx
  ON audit_logs (organization_id, entity_type, entity_id, occurred_at DESC)
  WHERE entity_id IS NOT NULL;
