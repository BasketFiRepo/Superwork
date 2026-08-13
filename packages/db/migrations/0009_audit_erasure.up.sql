-- 0009 · Reconcile append-only auditing with the right to erasure.
--
-- `audit_logs` must be append-only for the application (§3.6), but retention policies
-- and DSAR deletion have to genuinely cascade — a deletion that leaves audit rows behind
-- is a compliance hole (§21). So:
--
--   • UPDATE is refused for every role, always. History is never rewritten.
--   • DELETE is refused for the application role (and already REVOKEd from it).
--   • DELETE by the owner role is permitted, which is how the retention and erasure
--     jobs — and ON DELETE CASCADE from a purged organization — can complete.

CREATE OR REPLACE FUNCTION sw_audit_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit_logs is append-only: history cannot be rewritten';
  END IF;

  IF TG_OP = 'DELETE' AND current_user = 'superwork_app' THEN
    RAISE EXCEPTION 'audit_logs is append-only for the application role; erasure runs through the retention job';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
