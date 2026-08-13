-- 0009 · rollback: restore the unconditional append-only guard.
CREATE OR REPLACE FUNCTION sw_audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;
