-- 0041 — Who decided this was confidential.
--
-- `documents.sensitivity_source` has existed since migration 0004 with a default of 'auto' and
-- nothing has ever written any other value. It could not: there is no way in the product for a
-- person to change a document's classification at all. So every classification in Superwork was
-- a regex's opinion, recorded as though nobody had one, and:
--
--   **A misclassification could not be corrected.** A false positive on `restricted` makes a
--   document unreadable to the people who need it, and a false negative leaves something
--   over-shared. Neither had a fix short of editing the database.
--
--   **An auditor could not tell the difference** between a classification a person weighed and
--   one a pattern guessed at. §4.3 spends its length on what a classification *does*; nothing
--   recorded where it came from.
--
--   **The classifier could only ever raise.** `classifyContent` takes the highest of what it
--   detects and the fallback it is given, so even if somebody had lowered a level, the next
--   re-index would put it straight back.

ALTER TABLE documents
  -- What the classifier last read the content as, kept even when a person overrode it. This is
  -- what makes the disagreement auditable rather than merely resolved.
  ADD COLUMN sensitivity_auto sw_sensitivity,
  ADD COLUMN sensitivity_set_by uuid REFERENCES users(id),
  ADD COLUMN sensitivity_set_at timestamptz,
  ADD COLUMN sensitivity_reason text;

ALTER TABLE documents
  ADD CONSTRAINT documents_sensitivity_source_known
    CHECK (sensitivity_source IN ('auto', 'human')),
  -- A human classification names the human and says why. A decision nobody signed is exactly
  -- the thing this column exists to stop being possible.
  ADD CONSTRAINT documents_human_classification_is_attributed
    CHECK (
      sensitivity_source <> 'human'
      OR (sensitivity_set_by IS NOT NULL AND sensitivity_set_at IS NOT NULL
          AND length(btrim(coalesce(sensitivity_reason, ''))) >= 4)
    );

-- Everything a person decided, most recent first: the read the compliance screen wants and
-- nothing could answer.
CREATE INDEX documents_human_classified_idx
  ON documents (organization_id, sensitivity_set_at DESC)
  WHERE sensitivity_source = 'human' AND deleted_at IS NULL;

/**
 * A person's decision reaches the passages.
 *
 * `document_chunks.sensitivity` is what retrieval actually filters on, classified per passage
 * with the document's level as the floor. A correction that stopped at the document would leave
 * every passage still carrying the level the person had just said was wrong — which is the level
 * that decides who can retrieve it. Somebody reclassifying a document is deciding about the
 * document and everything in it (ADR 0044).
 */
CREATE OR REPLACE FUNCTION sw_human_classification_cascade() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sensitivity_source = 'human'
     AND (NEW.sensitivity IS DISTINCT FROM OLD.sensitivity
          OR NEW.sensitivity_source IS DISTINCT FROM OLD.sensitivity_source) THEN
    UPDATE document_chunks
    SET sensitivity = NEW.sensitivity, updated_at = now()
    WHERE organization_id = NEW.organization_id AND document_id = NEW.id;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER documents_human_classification_cascade
  AFTER UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION sw_human_classification_cascade();
