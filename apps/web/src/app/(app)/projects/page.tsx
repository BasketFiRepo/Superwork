import Link from 'next/link'
import { requireSession, withActor } from '@/lib/session'
import { computeProjectHealth, listProjects, PermissionError } from '@superwork/core'

export const dynamic = 'force-dynamic'

async function loadProjects(session: Awaited<ReturnType<typeof requireSession>>) {
  return withActor(session, async (ctx, actor) => {
    const rows = await listProjects(ctx, actor)
    return Promise.all(rows.map(async (row) => ({ ...row, health: await computeProjectHealth(ctx, row.id) })))
  })
}

/** Projects (§17). Primary action: unblock. Health is computed, never invented. */
export default async function ProjectsPage() {
  const session = await requireSession()

  // This used to be a raw query with no permission check on it — RLS kept it inside the
  // organization and nothing narrowed it further, so a team-scoped role saw every project
  // in the company. `listProjects` asks which rows the actor may consider.
  //
  // Caught outside `withActor`, not inside: a refusal swallowed inside the callback leaves
  // the transaction to commit around it, and if it was the database that objected the
  // commit re-raises what the catch just hid (ADR 0020).
  let projects: Array<Awaited<ReturnType<typeof loadProjects>>[number]> = []
  let denied: string | null = null
  try {
    projects = await loadProjects(session)
  } catch (error) {
    if (!(error instanceof PermissionError)) throw error
    denied = error.message
  }

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Work</span>
        <h1>Projects</h1>
        <p className="prose secondary">
          Health is computed in SQL from overdue ratio, blocked count, milestone slack and activity
          velocity. Hover a score to see the arithmetic — the model only explains it.
        </p>
      </header>

      {denied ? (
        <div className="panel">
          <div className="empty small secondary">{denied}</div>
        </div>
      ) : null}

      {!denied && projects.length === 0 ? (
        <div className="panel">
          <div className="empty small secondary" data-testid="projects-empty">
            No projects you can see. Your access covers your own team&rsquo;s work and anything
            shared with you directly.
          </div>
        </div>
      ) : null}

      <div className="stack stack-5">
        {projects.map((project) => (
          <article className="panel" key={project.id}>
            <div className="panel-header">
              <div className="stack stack-2">
                <h2>
                  <Link href={`/projects/${project.id}`}>{project.name}</Link>
                </h2>
                <span className="small muted">
                  {project.companyName ?? 'Internal'} · owner {project.ownerName ?? 'unassigned'} · {project.status}
                </span>
              </div>
              <div className="row-tight">
                <span
                  className={
                    project.health.band === 'healthy'
                      ? 'chip chip-positive'
                      : project.health.band === 'watch'
                        ? 'chip'
                        : 'chip chip-critical'
                  }
                >
                  {project.health.band.replace(/_/g, ' ')}
                </span>
                <span className="metric" style={{ fontSize: 20, fontWeight: 600 }}>
                  {project.health.score}
                </span>
              </div>
            </div>
            <div className="panel-body-flush table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Component</th>
                    <th style={{ width: 110 }}>Contribution</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {project.health.components.map((component) => (
                    <tr key={component.name}>
                      <td>{component.name}</td>
                      <td className="num" style={{ color: component.contribution < 0 ? 'var(--critical)' : 'var(--ink)' }}>
                        {component.contribution}
                      </td>
                      <td className="small secondary">{component.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="panel-body hairline-top row">
              <Link className="btn btn-sm" href={`/projects/${project.id}`}>
                Open it
              </Link>
              <Link className="btn btn-sm btn-ghost" href={`/tasks?filter=all&project=${project.id}`}>
                See its tasks
              </Link>
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}
