DROP INDEX IF EXISTS memberships_department_idx;

ALTER TABLE nudges DROP COLUMN IF EXISTS held_reason;

ALTER TABLE departments DROP CONSTRAINT IF EXISTS departments_holiday_calendar_known;
