DROP TRIGGER IF EXISTS legal_entities_record_change ON legal_entities;
DROP FUNCTION IF EXISTS sw_record_jurisdiction_change();
DROP INDEX IF EXISTS jurisdiction_changes_recent_idx;
ALTER TABLE jurisdiction_changes DROP CONSTRAINT IF EXISTS jurisdiction_change_kind_known;
ALTER TABLE jurisdiction_changes DROP COLUMN IF EXISTS justified;
ALTER TABLE jurisdiction_changes DROP COLUMN IF EXISTS change_kind;
ALTER TABLE jurisdiction_changes RENAME COLUMN to_state TO to_profile;
ALTER TABLE jurisdiction_changes RENAME COLUMN from_state TO from_profile;
