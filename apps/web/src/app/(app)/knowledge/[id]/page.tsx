import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireSession, withActor } from '@/lib/session'
import { documentAudience, getDocumentBody, NotFoundError, PermissionError } from '@superwork/core'
import { DeleteDocument } from '@/components/DeleteDocument'
import { DocumentAudience } from '@/components/DocumentAudience'

export const dynamic = 'force-dynamic'

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params

  try {
    const { document, body, audience, people, departments } = await withActor(session, async (ctx, actor) => {
      const loaded = await getDocumentBody(ctx, actor, id)
      return {
        ...loaded,
        audience: await documentAudience(ctx, actor, id),
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
