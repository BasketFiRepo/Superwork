import { listMemories, PermissionError, type MemoryFact } from '@superwork/core'
import { requireSession, withActor } from '@/lib/session'
import { MemoryReview, type FactRow } from '@/components/MemoryReview'

export const dynamic = 'force-dynamic'

const toRow = (fact: MemoryFact): FactRow => ({
  id: fact.id,
  subject: fact.subject,
  predicate: fact.predicate,
  object: fact.object,
  scopeLabel: fact.scopeLabel,
  confidence: fact.confidence,
  volatile: fact.volatile,
  stale: fact.stale,
  documentId: fact.citation?.documentId ?? null,
  documentTitle: fact.citation?.documentTitle ?? null,
  anchor: fact.citation?.anchor ?? null,
  snippet: fact.citation?.snippet ?? null,
  agreedOn: fact.state === 'confirmed' ? fact.validFrom.toISOString() : null,
  confirmedByName: fact.confirmedByName,
  createdAt: fact.createdAt.toISOString(),
})

/**
 * What the assistant remembers (§9.3). Everything here is scoped by the permissions of the
 * document each fact came from, so two people can open this screen and see different lists
 * — a memory is a shorter way of quoting its source, and it reaches exactly the people who
 * could have read that source.
 */
export default async function MemoryPage() {
  const session = await requireSession()

  let memory: Awaited<ReturnType<typeof listMemories>> | null = null
  let denied: string | null = null
  try {
    memory = await withActor(session, (ctx, actor) => listMemories(ctx, actor))
  } catch (error) {
    if (error instanceof PermissionError) denied = error.message
    else throw error
  }

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Know</span>
        <h1>What the assistant remembers</h1>
        <p className="prose secondary">
          When the assistant answers from a document it notices what looked like a settled fact
          and proposes it here. Nothing is used until a person agrees with it, everything keeps
          the passage it came from, and changing one supersedes the old answer rather than
          overwriting it — so “what did we think last quarter, and who changed it” stays a
          question with an answer.
        </p>
      </header>

      {denied ? (
        <div className="panel">
          <div className="empty small secondary">{denied}</div>
        </div>
      ) : (
        <MemoryReview
          memory={{
            candidates: (memory?.candidates ?? []).map(toRow),
            confirmed: (memory?.confirmed ?? []).map(toRow),
            conflicts: (memory?.conflicts ?? []).map((pair) => ({
              candidate: toRow(pair.candidate),
              confirmed: toRow(pair.confirmed),
            })),
            stale: (memory?.stale ?? []).map(toRow),
          }}
        />
      )}
    </div>
  )
}
