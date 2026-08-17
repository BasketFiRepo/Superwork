-- 0039 — When a document stopped being true.
--
-- `documents.effective_to` and `document_chunks.effective_to` have existed since migration
-- 0004 and nothing has ever written to them or read them. Their opening halves are used:
-- `effective_from` is carried into every chunk and stated in the contextual header the model
-- reads, so a passage says when it started applying.
--
-- Nothing says when it stopped. So the 2024 Master Services Agreement — which the demo's own
-- amendment supersedes, and which says so in its first line — is retrieved, ranked and cited
-- as current. Retrieval down-ranks a superseded *version* of a document (§7.3); it has no
-- notion of a document whose term has simply ended. This is the one remaining place where the
-- product gives a wrong answer rather than lacking a feature: an expired clause quoted with a
-- citation is worse than no answer, because it looks like an answer.
--
-- Expired is not deleted. "What did the old contract say" is a real question and the passage
-- has to remain findable to answer it — labelled and down-ranked, the same treatment a
-- superseded version already gets, for the same reason.

ALTER TABLE documents
  ADD CONSTRAINT documents_effective_range
    CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from);

ALTER TABLE document_chunks
  ADD CONSTRAINT document_chunks_effective_range
    CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from);

-- "What has expired, and what expires soon", which is the read the knowledge health panel
-- wants and which nothing could answer.
CREATE INDEX documents_effective_to_idx
  ON documents (organization_id, effective_to)
  WHERE effective_to IS NOT NULL AND deleted_at IS NULL;

/**
 * A chunk's dates are its document's.
 *
 * `ingestDocument` writes both onto the chunks it creates, which is right at ingest time and
 * wrong from the next edit onwards: changing the document's term would leave every passage
 * still claiming the old one, and the passage is what the model reads. Two places that must
 * agree, so the agreement is the database's (ADR 0028).
 */
CREATE OR REPLACE FUNCTION sw_chunk_effective_dates() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
    UPDATE document_chunks
    SET effective_from = NEW.effective_from, effective_to = NEW.effective_to, updated_at = now()
    WHERE organization_id = NEW.organization_id AND document_id = NEW.id;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER documents_effective_dates_cascade
  AFTER UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION sw_chunk_effective_dates();

/**
 * Superseding something closes it.
 *
 * When one document's version supersedes another's and the new one states when it takes
 * effect, the old one stopped applying the day before. That is what supersession *means*, and
 * leaving it to be typed twice is how the demo ended up with a 2024 agreement that its own
 * 2025 amendment had replaced and that retrieval still called current.
 *
 * Only fills a blank. A date somebody stated explicitly is theirs, and a trigger that
 * overwrote it would be the product arguing with the person who knows the contract.
 */
CREATE OR REPLACE FUNCTION sw_close_superseded_document() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  starts date;
  older uuid;
BEGIN
  IF NEW.supersedes_version_id IS NULL THEN RETURN NULL; END IF;

  SELECT d.effective_from INTO starts
  FROM documents d WHERE d.id = NEW.document_id;
  IF starts IS NULL THEN RETURN NULL; END IF;

  SELECT v.document_id INTO older
  FROM document_versions v WHERE v.id = NEW.supersedes_version_id;
  IF older IS NULL OR older = NEW.document_id THEN RETURN NULL; END IF;

  UPDATE documents
  SET effective_to = starts - 1, updated_at = now()
  WHERE id = older AND organization_id = NEW.organization_id
    AND effective_to IS NULL
    AND (effective_from IS NULL OR effective_from <= starts - 1);

  RETURN NULL;
END
$$;

CREATE TRIGGER document_versions_close_superseded
  AFTER INSERT OR UPDATE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION sw_close_superseded_document();
