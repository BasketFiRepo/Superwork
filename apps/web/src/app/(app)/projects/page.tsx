import Link from 'next/link'
import { requireSession, withActor } from '@/lib/session'
import { computeProjectHealth } from '@superwork/core'

export const dynamic = 'force-dynamic'

/** Projects (§17). Primary action: unblock. Health is computed, never invented. */
export default async function ProjectsPage() {
  const session = await requireSession()

  const projects = await withActor(session, async (ctx) => {
    const rows = await ctx.sql<{ id: string; name: string; status: string; ownerName: string | null; companyName: string | null }[]>`
      SELECT p.id, p.name, p.status, u.name AS "ownerName", c.name AS "companyName"
      FROM projects p
      LEFT JOIN users u ON u.id = p.owner_id
      LEFT JOIN companies c ON c.id = p.company_id
      WHERE p.organization_id = ${ctx.organizationId} AND p.deleted_at IS NULL
      ORDER BY p.status, p.name`
    return Promise.all(rows.map(async (row) => ({ ...row, health: await computeProjectHealth(ctx, row.id) })))
  })

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

      <div className="stack stack-5">
        {projects.map((project) => (
          <article className="panel" key={project.id}>
            <div className="panel-header">
              <div className="stack stack-2">
                <h2>{project.name}</h2>
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
            <div className="panel-body hairline-top">
              <Link className="btn btn-sm" href={`/tasks?filter=all&project=${project.id}`}>
                See its tasks
              </Link>
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}
