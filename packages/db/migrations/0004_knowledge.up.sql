-- 0004 · Company memory: documents, versions, chunks, hybrid search index.

CREATE TYPE sw_index_status AS ENUM (
  'pending', 'processing', 'indexed', 'failed', 'quarantined', 'skipped'
);

CREATE TABLE knowledge_spaces (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  department_id   uuid REFERENCES departments(id),
  name            text NOT NULL,
  slug            text NOT NULL,
  description     text,
  default_sensitivity sw_sensitivity NOT NULL DEFAULT 'internal',
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX knowledge_spaces_slug_key ON knowledge_spaces (organization_id, lower(slug)) WHERE deleted_at IS NULL;

CREATE TABLE documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  space_id        uuid REFERENCES knowledge_spaces(id) ON DELETE SET NULL,
  company_id      uuid REFERENCES companies(id) ON DELETE SET NULL,
  project_id      uuid REFERENCES projects(id) ON DELETE SET NULL,
  title           text NOT NULL,
  doc_type        text NOT NULL DEFAULT 'document',  -- contract | invoice | sop | policy | note | ...
  mime_type       text NOT NULL DEFAULT 'text/markdown',
  source          text NOT NULL DEFAULT 'upload',    -- upload | integration | knowledge_page | transcript
  storage_key     text,
  content_hash    text,
  sensitivity     sw_sensitivity NOT NULL DEFAULT 'internal',
  sensitivity_source text NOT NULL DEFAULT 'auto',   -- auto | human
  owner_id        uuid REFERENCES users(id),
  department_id   uuid REFERENCES departments(id),
  effective_from  date,
  effective_to    date,
  current_version_id uuid,
  index_status    sw_index_status NOT NULL DEFAULT 'pending',
  index_error     text,
  indexed_at      timestamptz,
  -- Quarantined documents are excluded from retrieval entirely (§5.9.6).
  quarantine_reason text,
  citation_count  integer NOT NULL DEFAULT 0,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX documents_org_status_idx ON documents (organization_id, index_status, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX documents_title_trgm_idx ON documents USING gin (title gin_trgm_ops);

CREATE TABLE document_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id     uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal         integer NOT NULL,
  body            text NOT NULL,
  content_hash    text NOT NULL,
  note            text,
  -- A newer contract supersedes its predecessor; superseded content is down-ranked (§7.3).
  supersedes_version_id uuid REFERENCES document_versions(id),
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX document_versions_key ON document_versions (document_id, ordinal);

ALTER TABLE documents ADD CONSTRAINT documents_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES document_versions(id) ON DELETE SET NULL;

CREATE TABLE document_chunks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id     uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id      uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  ordinal         integer NOT NULL,
  heading_path    text NOT NULL DEFAULT '',
  -- Anchors are mandatory: a citation must deep-link to the exact location (§7.2).
  anchor          text NOT NULL,
  content         text NOT NULL,
  -- Contextual header prepended at embed time; dramatically improves recall (§7.1).
  context_header  text NOT NULL DEFAULT '',
  token_count     integer NOT NULL DEFAULT 0,
  sensitivity     sw_sensitivity NOT NULL DEFAULT 'internal',
  is_superseded   boolean NOT NULL DEFAULT false,
  effective_from  date,
  effective_to    date,
  embedding       vector(384),
  tsv             tsvector,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX document_chunks_key ON document_chunks (version_id, ordinal);
CREATE INDEX document_chunks_org_doc_idx ON document_chunks (organization_id, document_id);
CREATE INDEX document_chunks_tsv_idx ON document_chunks USING gin (tsv);
CREATE INDEX document_chunks_embedding_idx ON document_chunks
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE OR REPLACE FUNCTION sw_document_chunks_tsv() RETURNS trigger AS $$
BEGIN
  NEW.tsv := setweight(to_tsvector('english', coalesce(NEW.heading_path, '')), 'A')
          || setweight(to_tsvector('english', coalesce(NEW.context_header, '')), 'B')
          || setweight(to_tsvector('english', coalesce(NEW.content, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER document_chunks_tsv_trg
  BEFORE INSERT OR UPDATE OF content, context_header, heading_path ON document_chunks
  FOR EACH ROW EXECUTE FUNCTION sw_document_chunks_tsv();

-- Explicit grants beyond the document's own sensitivity/department scoping.
CREATE TABLE document_permissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id     uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  subject_type    text NOT NULL,       -- user | team | department | role
  subject_id      uuid,
  subject_role    sw_role,
  relation        text NOT NULL DEFAULT 'viewer',   -- viewer | editor | owner
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX document_permissions_doc_idx ON document_permissions (organization_id, document_id);

CREATE TABLE ingestion_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id     uuid REFERENCES documents(id) ON DELETE CASCADE,
  status          sw_index_status NOT NULL DEFAULT 'pending',
  priority        integer NOT NULL DEFAULT 100,
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  chunks_written  integer NOT NULL DEFAULT 0,
  -- Post-index self check (§7.1 Verify): sample questions must be answerable.
  verification    jsonb,
  started_at      timestamptz,
  finished_at     timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE INDEX ingestion_jobs_queue_idx ON ingestion_jobs (status, priority, created_at) WHERE deleted_at IS NULL;

-- Queries the org asked that retrieval could not answer. The most valuable metric in §7.6.
CREATE TABLE unanswered_queries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  query           text NOT NULL,
  top_score       numeric(6,4),
  occurrences     integer NOT NULL DEFAULT 1,
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX unanswered_queries_key ON unanswered_queries (organization_id, lower(query));

SELECT sw_attach_touch(t) FROM (VALUES
  ('knowledge_spaces'::regclass), ('documents'), ('document_versions'), ('document_chunks'),
  ('document_permissions'), ('ingestion_jobs'), ('unanswered_queries')
) AS x(t);
