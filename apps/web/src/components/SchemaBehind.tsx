/**
 * What a deployment shows instead of every screen when its database is behind the application.
 *
 * The alternative is what this replaces, and it is not hypothetical: a deployment answered every
 * request with *"Application error: a server-side exception has occurred"* and a digest for five
 * hours, because `permission_grants` — migration 0051 — had never been applied to it. The code
 * was correct. Working that out took the platform's log viewer, a search for the digest, and
 * knowing that a Postgres `42P01` on a table added two releases ago means the schema is behind
 * rather than the application broken.
 *
 * `NotConfigured` makes the same argument about environment variables, and this is the sentence
 * from it that applies unchanged: a throw during a render reaches the browser as a digest and
 * nothing else. The person most likely to be looking at this page is the one who can go and fix
 * it, so it names what has not been applied and the two ways to apply it.
 *
 * Only migration names are rendered — the words already in the repository. No connection string,
 * no host, no database name: whoever loads the site while it is behind sees this.
 */
export function SchemaBehind({
  pending,
  empty,
  opaque,
}: {
  pending: string[]
  empty: boolean
  /** Behind, and unable to enumerate: this database predates the grant that lets it answer. */
  opaque: boolean
}) {
  // A long list is the "nothing was ever provisioned" case, and reading all of it helps nobody.
  const shown = pending.slice(0, 8)
  const rest = pending.length - shown.length

  return (
    <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 'var(--s-6)' }}>
      <div className="panel" style={{ width: 'min(640px, 100%)' }}>
        <div className="panel-body stack stack-6">
          <div className="stack stack-2">
            <div className="row-tight">
              <span className="dot" style={{ background: 'var(--attention)' }} />
              <span className="micro">Superwork</span>
            </div>
            <h1>{empty ? 'The database is empty' : 'The database is behind'}</h1>
            <p className="small secondary prose">
              {opaque ? (
                <>
                  This deployment is running against a database that is behind the application. It
                  cannot say by how many migrations, and that is itself the answer: reading the
                  list requires a grant that arrives in one of the migrations this database has
                  not had applied.
                </>
              ) : empty ? (
                <>
                  This deployment is connected to a database that has never had the schema applied
                  to it. Nothing is wrong with the application — it has nothing to read.
                </>
              ) : (
                <>
                  This deployment is running against a database that is{' '}
                  <strong>
                    {pending.length} {pending.length === 1 ? 'migration' : 'migrations'}
                  </strong>{' '}
                  behind the application. Nothing is wrong with the code: it is asking for tables
                  and columns that have not been created yet, and every screen would fail on the
                  first one it needed.
                </>
              )}
            </p>
          </div>

          <ul className="stack stack-2" style={{ listStyle: 'none', margin: 0, padding: 0 }} hidden={opaque}>
            {shown.map((name) => (
              <li key={name} className="banner banner-attention">
                <code className="mono small">{name}</code>
              </li>
            ))}
            {rest > 0 ? (
              <li className="small muted">
                and {rest} more — every migration in the repository, in order.
              </li>
            ) : null}
          </ul>

          <div className="stack stack-3">
            <p className="small secondary prose">
              Apply them from a browser with the{' '}
              <strong>Provision the database</strong> workflow in GitHub Actions, or from a
              checkout with <code className="mono">pnpm db:migrate</code>. Use{' '}
              <code className="mono">db:migrate</code> and not{' '}
              <code className="mono">db:reset</code>: reset drops the schema and everything in it.
            </p>
            <p className="small muted prose">
              No redeploy is needed afterwards — this is the database being behind, not the
              application being wrong, and the next request will notice. See{' '}
              <code className="mono">docs/deployment.md</code>.
            </p>
          </div>
        </div>
      </div>
    </main>
  )
}
