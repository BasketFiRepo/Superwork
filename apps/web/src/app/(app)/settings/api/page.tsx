import { requireSession, withActor } from '@/lib/session'
import { listApiKeys, API_SCOPES } from '@superwork/auth'
import { ApiKeyManager } from '@/components/ApiKeyManager'

export const dynamic = 'force-dynamic'

/**
 * Keys for the public API and the MCP server (§22). A key acts as a person, holds named
 * scopes, is rate limited, and every call it makes is logged against it.
 */
export default async function ApiSettingsPage() {
  const session = await requireSession()

  let keys: Awaited<ReturnType<typeof listApiKeys>> = []
  let denied: string | null = null
  try {
    keys = await withActor(session, (ctx, actor) => listApiKeys(ctx, actor))
  } catch (error) {
    denied = error instanceof Error ? error.message : 'You cannot manage API keys.'
  }

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Admin</span>
        <h1>API and MCP</h1>
        <p className="prose secondary">
          A key acts as a named person: it can never read or change anything that person
          could not. Scopes narrow it further, the rate limit is counted in the database,
          and every call appears against the key.
        </p>
      </header>

      {denied ? (
        <div className="panel">
          <div className="empty small secondary">{denied}</div>
        </div>
      ) : (
        <ApiKeyManager
          scopes={[...API_SCOPES]}
          keys={keys.map((key) => ({
            id: key.id,
            name: key.name,
            prefix: key.prefix,
            scopes: key.scopes,
            principalName: key.principalName,
            rateLimitPerMinute: key.rateLimitPerMinute,
            lastUsedAt: key.lastUsedAt ? key.lastUsedAt.toISOString() : null,
            revokedAt: key.revokedAt ? key.revokedAt.toISOString() : null,
            requestsLastDay: key.requestsLastDay,
          }))}
        />
      )}

      <section className="panel">
        <div className="panel-header">
          <h2>Custom tools</h2>
          <span className="chip chip-positive">built</span>
        </div>
        <div className="panel-body stack stack-2">
          <p className="small secondary">
            An HTTP endpoint of your own, described by a schema and callable by an agent —
            through the same registry, the same permission check, the same approval card and
            the same audit trail as a built-in tool. A tool cannot be activated until a named
            person has reviewed its host.
          </p>
          <div>
            <a className="btn btn-sm" href="/settings/tools">
              Define a tool
            </a>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Endpoints</h2>
        </div>
        <div className="panel-body-flush table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 90 }}>Method</th>
                <th>Path</th>
                <th style={{ width: 160 }}>Scope</th>
                <th>What it does</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono small">GET</td>
                <td className="mono small">/api/v1/tasks</td>
                <td className="mono small">tasks:read</td>
                <td className="small secondary">Tasks the principal may see.</td>
              </tr>
              <tr>
                <td className="mono small">POST</td>
                <td className="mono small">/api/v1/tasks</td>
                <td className="mono small">tasks:write</td>
                <td className="small secondary">Creates a task, through the same permission check as the UI.</td>
              </tr>
              <tr>
                <td className="mono small">GET</td>
                <td className="mono small">/api/v1/knowledge/search</td>
                <td className="mono small">knowledge:read</td>
                <td className="small secondary">Hybrid retrieval with the ACL predicate inside the query.</td>
              </tr>
              <tr>
                <td className="mono small">GET</td>
                <td className="mono small">/api/v1/runs</td>
                <td className="mono small">runs:read</td>
                <td className="small secondary">The principal&rsquo;s agent runs, with cost and status.</td>
              </tr>
              <tr>
                <td className="mono small">POST</td>
                <td className="mono small">/api/v1/runs</td>
                <td className="mono small">runs:write</td>
                <td className="small secondary">
                  Starts a run in assist mode. An API caller can have work proposed, never executed unattended.
                </td>
              </tr>
              <tr>
                <td className="mono small">POST</td>
                <td className="mono small">/api/mcp</td>
                <td className="mono small">mcp:read</td>
                <td className="small secondary">
                  MCP server — <span className="mono">initialize</span>, <span className="mono">tools/list</span>,{' '}
                  <span className="mono">tools/call</span>. Read-tier tools only.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="panel-body hairline-top">
          <span className="small muted">
            Authenticate with <span className="mono">Authorization: Bearer sw_…</span>. Responses are JSON;
            errors carry a machine-readable <span className="mono">error</span> and a sentence you can show a person.
          </span>
        </div>
      </section>
    </div>
  )
}
