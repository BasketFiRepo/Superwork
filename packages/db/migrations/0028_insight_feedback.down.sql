DROP INDEX IF EXISTS insight_feedback_org_created_idx;
DROP INDEX IF EXISTS insight_feedback_one_per_person;
ALTER TABLE insight_feedback DROP CONSTRAINT IF EXISTS insight_feedback_unhelpful_has_reason;
ALTER TABLE insight_feedback DROP CONSTRAINT IF EXISTS insight_feedback_reason_known;
