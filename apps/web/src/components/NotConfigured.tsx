import type { EnvIssue } from '@superwork/config'

/**
 * What a deployment shows instead of every screen when its environment is incomplete.
 *
 * The alternative is what this replaces: `env()` throws on the first render, Next catches
 * it, and the browser is told "a server-side exception has occurred" and given a digest —
 * a number that means nothing without the platform's log viewer open beside it. The
 * variables are named here because the person most likely to be looking at this page is
 * the one who can go and set them.
 *
 * Only variable names and the schema's own static messages are rendered. No value is ever
 * echoed, because whoever loads the site while it is misconfigured sees this.
 */
export function NotConfigured({ issues }: { issues: EnvIssue[] }) {
  return (
    <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 'var(--s-6)' }}>
      <div className="panel" style={{ width: 'min(640px, 100%)' }}>
        <div className="panel-body stack stack-6">
          <div className="stack stack-2">
            <div className="row-tight">
              <span className="dot" style={{ background: 'var(--attention)' }} />
              <span className="micro">Superwork</span>
            </div>
            <h1>Not configured</h1>
            <p className="small secondary prose">
              The application built and started, then stopped here: it has no complete
              environment to run against. Nothing is broken in the code — the{' '}
              {issues.length === 1 ? 'variable' : 'variables'} below {issues.length === 1 ? 'is' : 'are'}{' '}
              missing or invalid on this deployment.
            </p>
          </div>

          <ul className="stack stack-3" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {issues.map((issue) => (
              <li key={`${issue.variable}:${issue.message}`} className="banner banner-attention">
                <span className="stack stack-2">
                  <code className="mono">{issue.variable}</code>
                  <span className="small">{issue.message}</span>
                </span>
              </li>
            ))}
          </ul>

          <div className="stack stack-3">
            <p className="small secondary prose">
              Set these where the deployment reads its configuration — a hosting platform&rsquo;s
              environment settings, or the <code className="mono">.env</code> file at the
              repository root when running locally — and deploy again. Existing deployments do
              not pick up new values on their own.
            </p>
            <p className="small muted prose">
              <code className="mono">docs/deployment.md</code> has the full sequence, including
              the database roles the runtime expects and the two connection strings it needs.
            </p>
          </div>
        </div>
      </div>
    </main>
  )
}
