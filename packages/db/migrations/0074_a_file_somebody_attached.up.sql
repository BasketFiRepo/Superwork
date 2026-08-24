-- 0074 — A file somebody attached.
--
-- `StorageProvider` has been declared in `contracts.ts` since Phase 2 with **no implementation at
-- all** — no mock, no resolver, no caller. `documents.storage_key` and `documents.mime_type` have
-- been empty just as long, and `ingest.ts` carries a comment reading "binary parsing lives behind
-- the StorageProvider", pointing at something that does not exist.
--
-- So you could not attach a file to anything in Superwork. Every document is markdown somebody
-- pasted in.
--
-- This is ADR 0084's twin, one step earlier. There the abstraction had a mock and no consumer;
-- here it has neither, which is why the columns were easy to read as "an integration nobody built"
-- rather than as the smaller thing they were.

-- ---------------------------------------------------------------------------------------------
-- A file is a key and a type, or it is neither

-- `storage_key` says where the bytes are; `mime_type` says what they are. A key with the default
-- `text/markdown` beside it describes a PDF as markdown to everything downstream — the viewer, the
-- ingest pipeline, the browser. A type with no key is a document claiming a file it does not have.
--
-- `mime_type` carries a NOT NULL default, so "no file" is the default value rather than NULL, and
-- the constraint has to say that rather than pair two nullables.
ALTER TABLE documents
  ADD CONSTRAINT documents_file_is_whole CHECK (
    (storage_key IS NULL AND mime_type = 'text/markdown')
    OR (storage_key IS NOT NULL AND mime_type <> 'text/markdown')
  );

-- What was actually stored, so a reader knows before fetching and a purge knows what it removed.
ALTER TABLE documents
  ADD COLUMN file_bytes integer,
  ADD COLUMN file_name text;

ALTER TABLE documents
  ADD CONSTRAINT documents_file_is_described CHECK (
    storage_key IS NULL
    OR (file_bytes IS NOT NULL AND file_bytes > 0 AND file_name IS NOT NULL AND length(btrim(file_name)) > 0)
  );

-- ---------------------------------------------------------------------------------------------
-- The read the purge makes

-- §25.13: deleting a document takes its derived data with it, and now that includes the bytes.
-- `purgeDocument` has to know which key to remove before the row goes, and a purge that ran over
-- an organization would otherwise scan.
CREATE INDEX documents_storage_key_idx
  ON documents (organization_id, storage_key)
  WHERE storage_key IS NOT NULL;
