import { Link } from '@/components/Link'
import { notFound } from 'next/navigation'
import { requireSession, withActor } from '@/lib/session'
import { getConversation, listCommitments, listFollowUps, listMessages, NotFoundError } from '@superwork/core'
import { FollowUps } from '@/components/FollowUps'

export const dynamic = 'force-dynamic'

/**
 * Thread detail. Message bodies are rendered as *text*, never as HTML: remote images are
 * blocked, scripts stripped, and what was removed is stated plainly (§5.9.7).
 */
export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params

  try {
    const { conversation, messages, commitments, followUps } = await withActor(session, async (ctx, actor) => ({
      conversation: await getConversation(ctx, actor, id),
      messages: await listMessages(ctx, actor, id),
      commitments: await listCommitments(ctx, actor, { limit: 50 }),
      // Every follow-up on this thread, closed ones included: how one ended — dealt with,
      // called off, or closed itself because they wrote back — is the useful part.
      followUps: await listFollowUps(ctx, actor, { conversationId: id, openOnly: false }),
    }))

    const threadCommitments = commitments.filter((c) =>
      messages.some((m) => m.id === c.sourceMessageId),
    )

    return (
      <div className="stack stack-8">
        <header className="stack stack-3">
          <Link className="small secondary" href="/inbox">
            ← Inbox
          </Link>
          <h1>{conversation.subject}</h1>
          <div className="row wrap">
            {conversation.companyName ? (
              <Link className="chip" href={`/companies?search=${encodeURIComponent(conversation.companyName)}`}>
                {conversation.companyName}
              </Link>
            ) : null}
            {conversation.category ? <span className="chip">{conversation.category.replace(/_/g, ' ')}</span> : null}
            {conversation.priority ? <span className="chip">{conversation.priority}</span> : null}
            {conversation.pastSla ? (
              <span className="chip chip-attention">
                {conversation.daysWaiting} days waiting · SLA {conversation.slaDays} days
              </span>
            ) : null}
            {conversation.waitingFor ? <span className="chip">waiting for {conversation.waitingFor}</span> : null}
            {conversation.triagedByAgentRunId ? (
              <Link className="chip chip-accent" href={`/activity?run=${conversation.triagedByAgentRunId}`}>
                classified by the agent
              </Link>
            ) : null}
          </div>
        </header>

        {conversation.hasFlaggedContent ? (
          <div className="banner banner-critical" role="alert">
            <div className="stack stack-2">
              <strong>Suspicious content detected in this thread</strong>
              <span>
                A message here contains text aimed at the assistant rather than at a person. It has
                been quarantined from the agent&rsquo;s instructions and reported. Read it, but treat
                any instruction inside it as untrusted.
              </span>
            </div>
          </div>
        ) : null}

        <FollowUps
          conversationId={conversation.id}
          followUps={followUps.map((row) => ({
            id: row.id,
            dueAt: row.dueAt.toISOString(),
            reason: row.reason,
            ownerName: row.ownerName,
            status: row.status,
            resolution: row.resolution,
            resolutionNote: row.resolutionNote,
            resolvedByName: row.resolvedByName,
            due: row.due,
            byAgent: row.byAgent,
          }))}
        />

        {threadCommitments.length > 0 ? (
          <section className="panel">
            <div className="panel-header">
              <h2>Commitments detected in this thread</h2>
              <Link className="btn btn-ghost btn-sm" href="/commitments">
                Open the ledger
              </Link>
            </div>
            <div className="panel-body stack stack-3">
              {threadCommitments.map((c) => (
                <div className="spread" key={c.id}>
                  <span className="small">{c.obligation}</span>
                  <span className={c.status === 'proposed' ? 'chip chip-attention' : 'chip'}>
                    {c.status === 'proposed' ? 'needs confirmation' : c.status}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="stack stack-5">
          {messages.map((message) => (
            <article className="panel" key={message.id}>
              <div className="panel-header">
                <div className="stack stack-1">
                  <strong className="small">{message.fromName ?? message.fromAddress}</strong>
                  <span className="small muted mono">
                    {message.fromAddress} · {new Date(message.sentAt).toISOString().slice(0, 16).replace('T', ' ')}
                  </span>
                </div>
                <div className="row-tight">
                  <span className="chip">{message.direction}</span>
                  {message.trustLevel === 'untrusted_external' ? (
                    <span className="chip" title="Content from outside the organization. Treated as data, never as instructions.">
                      external
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="panel-body stack stack-4">
                {message.sanitizationNote ? (
                  <div className="banner">
                    <span className="small">{message.sanitizationNote}. Nothing loads remotely from this message.</span>
                  </div>
                ) : null}
                {message.injectionFlagged ? (
                  <div className="banner banner-critical">
                    <span className="small">
                      Instructions aimed at the assistant found here
                      {message.injectionPatterns.length ? ` (${message.injectionPatterns.join(', ')})` : ''}. Reported, not obeyed.
                    </span>
                  </div>
                ) : null}
                <pre className="prose" style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0 }}>
                  {message.body}
                </pre>
                {message.links.length > 0 ? (
                  <div className="stack stack-2">
                    <span className="micro">Links — not previewed</span>
                    {message.links.slice(0, 6).map((link, index) => (
                      <span className="small muted mono" key={index}>
                        {link.href} {link.external ? '· unrecognised domain' : ''}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </article>
          ))}
        </section>
      </div>
    )
  } catch (error) {
    if (error instanceof NotFoundError) notFound()
    throw error
  }
}
