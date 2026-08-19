-- 0053 — What was said, and when.
--
-- `interactions` is the relationship timeline. The company screen reads it — ten rows, newest
-- first — and `last_interaction_at` is derived from it, which is what the quiet-account watcher
-- acts on. Only an agent has ever been able to add to it: `logInteraction` is reachable through
-- `log_interaction@v1` and from nowhere else, so a person who rang a customer this morning could
-- watch the product decide the account had gone quiet.
--
-- Three things the table has never held, all of them enforced somewhere else or nowhere:
--
--   **The kind.** `log_interaction@v1` declares `z.enum(['email','call','meeting','note','task'])`
--   and the column is bare `text`. The vocabulary lived in one tool's input schema, which is not
--   a place a vocabulary can be relied on from.
--
--   **What it is about.** `listInteractions` selects by `company_id`, so a row attached to
--   neither a company nor a contact is written and then never read by anything — invisible, and
--   still counted by nothing.
--
--   **A summary worth reading.** The tool asks for at least three characters; the repository
--   refused only the empty string.
--
-- What is deliberately *not* a constraint: an interaction dated in the future. A CHECK cannot
-- call `now()`, and a row that was legitimate when written must not become invalid as the clock
-- passes it. The repository refuses it, with a sentence.

ALTER TABLE interactions
  ADD CONSTRAINT interactions_kind_known
    CHECK (kind IN ('email', 'call', 'meeting', 'note', 'task')),
  ADD CONSTRAINT interactions_summary_said
    CHECK (length(btrim(summary)) >= 3 AND length(summary) <= 2000),
  -- An interaction about nobody is a row nothing will ever show.
  ADD CONSTRAINT interactions_about_somebody
    CHECK (company_id IS NOT NULL OR contact_id IS NOT NULL);

-- The other half of the timeline: a contact's own. The company index has existed since
-- migration 0003 and this one has not, so "what have we said to this person" was a scan.
CREATE INDEX interactions_contact_idx
  ON interactions (organization_id, contact_id, occurred_at DESC)
  WHERE contact_id IS NOT NULL AND deleted_at IS NULL;
