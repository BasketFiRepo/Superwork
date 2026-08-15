import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireSession, withActor } from '@/lib/session'
import {
  getSpace,
  listDocuments,
  listShares,
  listTeams,
  NotFoundError,
  PermissionError,
  shareableRelations,
} from '@superwork/core'
import { ShareObject } from '@/components/ShareObject'

export const dynamic = 'force-dynamic'

/**
 * One knowledge space (§8.1) — the shelf, and what is on it.
 *
 * `knowledge_spaces` had been in the schema since migration 0004 with a seeded row and no
 * reader, and `documents.space_id` was written on every document and selected by nothing.
 * The library knew what it held and not where any of it lived.
 */
export default async function SpacePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params

  try {
    const { space, documents, shares, relations, people, teams } = await withActor(session, async (ctx, actor) => {
      const loaded = await getSpace(ctx, actor, id)
      return {
        space: loaded,
        // The same scope-aware read as the library, so what is listed here is what this
        // person could open there. A space share is what makes this non-empty for somebody
        // whose own scope would not have reached it.
        documents: await listDocuments(ctx, actor, { spaceId: id, limit: 200 }),
        shares: await listShares(ctx, actor, 'knowledge_space', id),
        relations: shareableRelations(actor, 'knowledge_space', id, ctx.organizationId),
        teams: await listTeams(ctx, actor).catch(() => []),
        people: await ctx.sql<{ id: string; name: string }[]>`
          SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = ${ctx.organizationId} AND m.deleted_at IS NULL AND m.status = 'active'
            AND m.user_id <> ${actor.userId}
          ORDER BY u.name`,
      }
    })

    const hidden = space.documentCount - documents.length

    return (
      <div className="stack stack-8">
        <header className="stack stack-3">
          <Link className="small secondary" href="/knowledge">
            ← Knowledge
          </Link>
          <h1>{space.name}</h1>
          <div className="row wrap">
            <span className="chip mono">{space.slug}</span>
            <span className="chip">{space.documentCount} filed</span>
            {space.departmentName ? <span className="chip">{space.departmentName}</span> : null}
            <span className="chip">new documents default to {space.defaultSensitivity}</span>
          </div>
          {space.description ? <p className="prose secondary">{space.description}</p> : null}
        </header>

        <ShareObject
          objectType="knowledge_space"
          objectId={space.id}
          relations={relations}
          shares={shares.map((entry) => ({
            id: entry.id,
            subjectType: entry.subjectType,
            subjectName: entry.subjectName,
            relation: entry.relation,
            reason: entry.reason,
            grantedByName: entry.grantedByName,
            expiresAt: entry.expiresAt ? entry.expiresAt.toISOString() : null,
            expired: entry.expired,
            canRevoke: entry.canRevoke,
          }))}
          people={people}
          teams={teams.map((team) => ({ id: team.id, name: team.name }))}
        />

        <section className="panel" data-testid="space-documents">
          <div className="panel-header">
            <h2>What is on this shelf</h2>
            <span className="small muted">
              {documents.length === 0 ? 'Nothing you can see' : `${documents.length} of ${space.documentCount}`}
            </span>
          </div>

          {hidden > 0 ? (
            <div className="panel-body">
              <p className="small secondary" style={{ margin: 0 }} data-testid="space-hidden">
                {hidden} {hidden === 1 ? 'document is' : 'documents are'} filed here that you cannot
                open — classified above your access, or restricted to a named circulation list.
                They are counted rather than listed: the count is already on the shelf, the
                titles are not yours.
              </p>
            </div>
          ) : null}

          {documents.length === 0 ? (
            <div className="panel-body">
              <div className="empty small secondary">
                Nothing here you can read. A space can be shared with you, which lends a read of
                what is filed in it.
              </div>
            </div>
          ) : (
            <div className="panel-body-flush table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Document</th>
                    <th style={{ width: 130 }}>Kind</th>
                    <th style={{ width: 130 }}>Classification</th>
                    <th style={{ width: 110 }}>Indexed</th>
                  </tr>
                </thead>
                <tbody>
                  {documents.map((document) => (
                    <tr key={document.id} data-testid="space-document-row">
                      <td>
                        <Link href={`/knowledge/${document.id}`}>{document.title}</Link>
                      </td>
                      <td className="small secondary">{document.docType}</td>
                      <td>
                        <span className="chip">{document.sensitivity}</span>
                      </td>
                      <td className="small secondary">
                        {document.indexStatus === 'indexed' ? `${document.chunkCount} sections` : document.indexStatus}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    )
  } catch (error) {
    if (error instanceof NotFoundError) notFound()
    if (error instanceof PermissionError) {
      return (
        <div className="panel">
          <div className="empty small secondary">{error.message}</div>
        </div>
      )
    }
    throw error
  }
}
