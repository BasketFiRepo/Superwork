import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireSession, withActor } from '@/lib/session'
import {
  documentAudience,
  documentIngestions,
  getDocumentBody,
  listShares,
  listTeams,
  NotFoundError,
  PermissionError,
  shareableRelations,
} from '@superwork/core'
import { DeleteDocument } from '@/components/DeleteDocument'
import { DocumentAudience } from '@/components/DocumentAudience'
import { DocumentIndexing } from '@/components/DocumentIndexing'
import { ShareObject } from '@/components/ShareObject'

export const dynamic = 'force-dynamic'

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params

  try {
    const { document, body, audience, people, departments, shares, teams, relations, indexing } = await withActor(session, async (ctx, actor) => {
      const loaded = await getDocumentBody(ctx, actor, id)
      return {
        ...loaded,
        audience: await documentAudience(ctx, actor, id),
        indexing: await documentIngestions(ctx, actor, id),
        shares: await listShares(ctx, actor, 'document', id),
        relations: shareableRelations(actor, 'document', id, ctx.organizationId),
        teams: await listTeams(ctx, actor).catch(() => []),
        people: await ctx.sql<{ id: string; name: string }[]>`
          SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = ${ctx.organizationId} AND m.deleted_at IS NULL AND m.status = 'active'
          ORDER BY u.name`,
        departments: await ctx.sql<{ id: string; name: string }[]>`
          SELECT id, name FROM departments
          WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL ORDER BY name`,
      }
    })

    return (
      <div className="stack stack-8">
        <header className="stack stack-3">
          <Link className="small secondary" href="/knowledge">
            ← Company memory
          </Link>
          <h1>{document.title}</h1>
          <div className="row wrap">
            <span className="chip">{document.docType}</span>
            <span className={document.sensitivity === 'restricted' ? 'chip chip-critical' : 'chip'}>
              {document.sensitivity}
            </span>
            <span className="chip">{document.chunkCount} indexed passages</span>
            <span className="chip">referenced by the AI {document.citationCount} times</span>
            {document.companyName ? <span className="chip">{document.companyName}</span> : null}
            {document.spaceId ? (
              <Link className="chip" href={`/knowledge/spaces/${document.spaceId}`}>
                {document.spaceName ?? 'space'}
              </Link>
            ) : null}
          </div>
          {document.indexError ? (
            <div className="banner banner-attention">{document.indexError}</div>
          ) : null}
        </header>

        <DocumentAudience
          documentId={document.id}
          audience={{
            restricted: audience.restricted,
            sensitivity: audience.sensitivity,
            entries: audience.entries.map((entry) => ({
              id: entry.id,
              subjectType: entry.subjectType,
              subjectName: entry.subjectName,
              relation: entry.relation,
              reason: entry.reason,
              grantedByName: entry.grantedByName,
            })),
            blockedByClassification: audience.blockedByClassification,
          }}
          people={people}
          departments={departments}
        />

        <ShareObject
          objectType="document"
          objectId={document.id}
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

        <DocumentIndexing
          documentId={document.id}
          history={indexing.map((row) => ({
            id: row.id,
            status: row.status,
            reason: row.reason,
            attempts: row.attempts,
            chunksWritten: row.chunksWritten,
            lastError: row.lastError,
            gaveUp: row.gaveUp,
            createdAt: row.createdAt.toISOString(),
            verification: row.verification,
          }))}
        />

        <DeleteDocument
          documentId={document.id}
          title={document.title}
          chunkCount={document.chunkCount}
          citationCount={document.citationCount}
        />

        <article className="panel">
          <div className="panel-body">
            <pre className="prose" style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0 }}>
              {body}
            </pre>
          </div>
        </article>
      </div>
    )
  } catch (error) {
    if (error instanceof NotFoundError) notFound()
    if (error instanceof PermissionError) {
      return (
        <div className="panel">
          <div className="empty stack stack-3">
            <h2>You do not have access to this document</h2>
            <p className="prose secondary">{error.message}</p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <Link className="btn" href="/knowledge">
                Back to company memory
              </Link>
            </div>
          </div>
        </div>
      )
    }
    throw error
  }
}
