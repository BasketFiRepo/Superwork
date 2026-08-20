-- 0055 — A database that can say where it is.
--
-- A deployment answered every request with "a server-side exception has occurred" and a digest
-- for five hours. The code was correct; `permission_grants` — migration 0051 — had never been
-- applied to that database. The only way to learn that was to open the platform's log viewer and
-- match a digest against an error nobody had seen.
--
-- The application already refuses to render on an incomplete *environment* and names the missing
-- variables, because "a throw during a render reaches the browser as a digest and nothing else".
-- A database behind the application is the same failure with a different cause, and the check
-- that spots it has to run on the connection a request actually has — `superwork_app`, never the
-- owner, which is for migrations and diagnostics and not for request handling.
--
-- So the runtime role may read the migration ledger. It is four columns of deployment metadata:
-- no tenant data, no organization_id, nothing under RLS. SELECT only — a runtime that could write
-- this table could tell itself the schema is newer than it is.

GRANT SELECT ON schema_migrations TO superwork_app;
