import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireSession, withActor } from '@/lib/session'
import { getDocumentBody, NotFoundError, PermissionError } from '@superwork/core'
import { DeleteDocument } from '@/components/DeleteDocument'

export const dynamic = 'force-dynamic'

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params

  try {
    const { document, body } = await withActor(session, (ctx, actor) => getDocumentBody(ctx, actor, id))

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
