'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Summarizing a meeting records decisions and *proposes* action items. It never creates
 * a task: accepting an action item runs through the ordinary plan → approval path so the
 * result stays reversible (§12.5).
 */
export function MeetingSummaryPanel({
  meetingId,
  hasTranscript,
  existingSummary,
}: {
  meetingId: string
  hasTranscript: boolean
  existingSummary: string | null
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [summary, setSummary] = useState(existingSummary)
  const [result, setResult] = useState<{
    decisionsRecorded: number
    commitmentsProposed: number
    openQuestions: { question: string; anchor: string }[]
    risks: { risk: string; anchor: string }[]
    actionItems: { title: string; ownerName: string | null; mentionedOwner: string | null; direction: string; anchor: string }[]
    injectionWarnings: { anchor: string; speaker: string; patterns: string[] }[]
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function summarize() {
    setBusy(true)
    setError(null)
    const response = await fetch(`/api/meetings/${meetingId}/summarize`, { method: 'POST' })
    setBusy(false)
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: 'That could not be summarized.' }))
      setError(body.error)
      return
    }
    const body = await response.json()
    setSummary(body.summary)
    setResult(body)
    router.refresh()
  }

  async function createTasks() {
    setBusy(true)
    await fetch('/api/agent/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: 'Create tasks from the confirmed action items in this meeting.',
        mode: 'execute',
        uiContext: { route: `/meetings/${meetingId}`, meetingId },
      }),
    })
    setBusy(false)
    setError('Started. The plan will appear in the agent rail for approval before any task is created.')
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Summary</h2>
        <div className="row-tight">
          <button className="btn btn-sm" onClick={summarize} disabled={busy || !hasTranscript}>
            {busy ? 'Reading the transcript…' : summary ? 'Re-summarize' : 'Summarize'}
          </button>
          {result && result.commitmentsProposed > 0 ? (
            <button className="btn btn-primary btn-sm" onClick={createTasks} disabled={busy}>
              Create tasks from action items
            </button>
          ) : null}
        </div>
      </div>
      <div className="panel-body stack stack-5">
        {!hasTranscript ? (
          <p className="small muted">
            There is no transcript on this meeting yet. Attach one and the summary, decisions and
            action items become available.
          </p>
        ) : summary ? (
          <p className="prose">{summary}</p>
        ) : (
          <p className="small muted">Not summarized yet.</p>
        )}

        {error ? <div className="banner banner-accent">{error}</div> : null}

        {result ? (
          <div className="stack stack-5">
            {result.injectionWarnings?.length ? (
              <div className="banner banner-attention stack stack-2">
                <span className="small">
                  {result.injectionWarnings.length === 1 ? 'A moment' : `${result.injectionWarnings.length} moments`} in
                  this transcript contained instructions aimed at the assistant. They were left in the record and out of
                  the summary — nothing was decided or assigned from them.
                </span>
                {result.injectionWarnings.map((warning, index) => (
                  <span className="small secondary" key={index}>
                    <span className="mono muted">{warning.anchor}</span> {warning.speaker}
                  </span>
                ))}
              </div>
            ) : null}

            {result.actionItems.length > 0 ? (
              <div className="stack stack-3">
                <span className="micro">Action items — proposed, not created</span>
                {result.actionItems.map((item, index) => (
                  <div className="spread" key={index}>
                    <span className="small">
                      <span className="mono muted">{item.anchor}</span> {item.title}
                    </span>
                    <div className="row-tight">
                      <span className="chip">{item.direction === 'we_owe' ? 'we owe' : 'they owe'}</span>
                      {item.ownerName ? (
                        <span className="chip">{item.ownerName}</span>
                      ) : (
                        <span
                          className="chip chip-attention"
                          title={
                            item.mentionedOwner
                              ? `"${item.mentionedOwner}" was named but was not in the room, so nobody has been assigned.`
                              : 'No owner could be identified from what was said.'
                          }
                        >
                          owner unclear
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {result.openQuestions.length > 0 ? (
              <div className="stack stack-2">
                <span className="micro">Open questions</span>
                {result.openQuestions.map((q, index) => (
                  <span className="small secondary" key={index}>
                    <span className="mono muted">{q.anchor}</span> {q.question}
                  </span>
                ))}
              </div>
            ) : null}

            {result.risks.length > 0 ? (
              <div className="stack stack-2">
                <span className="micro">Risks raised</span>
                {result.risks.map((r, index) => (
                  <span className="small secondary" key={index}>
                    <span className="mono muted">{r.anchor}</span> {r.risk}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}
