import Link from 'next/link'
import { requireSession, withActor } from '@/lib/session'
import { knowledgeHealth, listDocuments } from '@superwork/core'
import { UploadDocument } from '@/components/UploadDocument'

export const dynamic = 'force-dynamic'

/** Knowledge (§17). Primary action: find or capture. */
export default async function KnowledgePage() {
  const session = await requireSession()
  const { documents, health } = await withActor(session, async (ctx, actor) => ({
    documents: await listDocuments(ctx, actor, { limit: 100 }),
    health: await knowledgeHealth(ctx),
  }))

  const quarantined = documents.filter((d) => d.indexStatus === 'quarantined')

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Know</span>
        <h1>Company memory</h1>
        <p className="prose secondary">
          {health.totalChunks} indexed passages across {documents.length} documents. Every document
          shows its index status and how often the agent has cited it.
        </p>
      </header>

      {quarantined.length > 0 ? (
        <div className="banner banner-critical" role="alert">
          <div className="stack stack-2">
            <strong>Suspicious content detected</strong>
            {quarantined.map((doc) => (
              <span key={doc.id}>
                “{doc.title}” is quarantined from retrieval. {doc.quarantineReason}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <UploadDocument />

      <section className="grid-2">
        <div className="panel">
          <div className="panel-header">
            <h2>Knowledge health</h2>
          </div>
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th style={{ width: 90 }}>Documents</th>
                </tr>
              </thead>
              <tbody>
                {health.byStatus.map((row) => (
                  <tr key={row.status}>
                    <td>{row.status}</td>
                    <td className="num">{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2>Questions with no answer</h2>
          </div>
          {health.topUnanswered.length === 0 ? (
            <div className="empty small secondary">Every question so far had a source behind it.</div>
          ) : (
            <div className="panel-body-flush table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Question</th>
                    <th style={{ width: 70 }}>Asked</th>
                  </tr>
                </thead>
                <tbody>
                  {health.topUnanswered.map((row) => (
                    <tr key={row.query}>
                      <td className="small">{row.query}</td>
                      <td className="num">{row.occurrences}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="panel-body hairline-top small muted">
            This list tells you exactly which documents the organization is missing.
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Documents</h2>
        </div>
        <div className="panel-body-flush table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Title</th>
                <th style={{ width: 110 }}>Type</th>
                <th style={{ width: 120 }}>Classification</th>
                <th style={{ width: 110 }}>Index</th>
                <th style={{ width: 90 }}>Passages</th>
                <th style={{ width: 90 }}>Cited</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id} data-testid="document-row">
                  <td>
                    <Link href={`/knowledge/${doc.id}`}>{doc.title}</Link>
                  </td>
                  <td className="small secondary">{doc.docType}</td>
                  <td>
                    <span className={doc.sensitivity === 'restricted' ? 'chip chip-critical' : 'chip'}>
                      {doc.sensitivity}
                    </span>
                  </td>
                  <td>
                    <span
                      className={
                        doc.indexStatus === 'indexed'
                          ? 'chip chip-positive'
                          : doc.indexStatus === 'quarantined' || doc.indexStatus === 'failed'
                            ? 'chip chip-critical'
                            : 'chip'
                      }
                    >
                      {doc.indexStatus}
                    </span>
                  </td>
                  <td className="num">{doc.chunkCount}</td>
                  <td className="num">{doc.citationCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
