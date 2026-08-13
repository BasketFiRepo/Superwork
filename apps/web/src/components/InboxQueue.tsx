'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * The triage queue (§12.3).
 *
 * Keyboard-driven, because operations people live here: j/k to move, e to archive,
 * s to snooze, f to mark waiting, t to make a task, r to draft a reply, ? for the sheet.
 * Every action is optimistic with a rollback toast if the server disagrees (§15.2).
 */

export interface QueueItem {
  id: string
  subject: string
  companyName: string | null
  ownerName: string | null
  category: string | null
  priority: string | null
  sentiment: string | null
  daysWaiting: number
  pastSla: boolean
  slaDays: number
  messageCount: number
  waitingFor: string | null
  hasFlaggedContent: boolean
  triagedAt: string | null
  lastDirection: string | null
}

const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: 'j / k', label: 'Move down / up' },
  { keys: 'e', label: 'Archive' },
  { keys: 's', label: 'Snooze one day' },
  { keys: 'f', label: 'Mark as waiting on them' },
  { keys: 't', label: 'Create a task from this thread' },
  { keys: 'r', label: 'Draft a reply' },
  { keys: 'Enter', label: 'Open the thread' },
  { keys: '?', label: 'This sheet' },
]

export function InboxQueue({ items, view }: { items: QueueItem[]; view: string }) {
  const router = useRouter()
  const [rows, setRows] = useState(items)
  const [cursor, setCursor] = useState(0)
  const [toast, setToast] = useState<string | null>(null)
  const [showHelp, setShowHelp] = useState(false)
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setRows(items)
    setCursor((c) => Math.min(c, Math.max(0, items.length - 1)))
  }, [items])

  const act = useCallback(
    async (item: QueueItem, action: string, extra: Record<string, unknown> = {}) => {
      // Optimistic: the row leaves the queue immediately, and comes back if the call fails.
      const snapshot = rows
      if (action === 'archive' || action === 'snooze') {
        setRows((current) => current.filter((r) => r.id !== item.id))
      }
      setBusy(true)
      const response = await fetch(`/api/inbox/${item.id}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      })
      setBusy(false)

      if (!response.ok) {
        setRows(snapshot)
        const body = await response.json().catch(() => ({ error: 'That could not be applied.' }))
        setToast(body.error)
        return
      }
      setToast(
        action === 'archive'
          ? `Archived "${truncate(item.subject)}"`
          : action === 'snooze'
            ? `Snoozed "${truncate(item.subject)}" for a day`
            : action === 'waiting'
              ? `Marked as waiting on ${item.companyName ?? 'them'}`
              : 'Done',
      )
      router.refresh()
    },
    [rows, router],
  )

  const askAgent = useCallback(
    async (item: QueueItem, request: string) => {
      setBusy(true)
      const response = await fetch('/api/agent/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request, mode: 'execute', uiContext: { route: '/inbox', conversationId: item.id } }),
      })
      setBusy(false)
      setToast(
        response.ok
          ? 'Started. The plan will appear in the agent rail for approval before anything changes.'
          : 'That could not be started.',
      )
    },
    [],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (event.metaKey || event.ctrlKey || event.altKey) return

      const item = rows[cursor]
      switch (event.key) {
        case 'j':
          event.preventDefault()
          setCursor((c) => Math.min(c + 1, rows.length - 1))
          break
        case 'k':
          event.preventDefault()
          setCursor((c) => Math.max(c - 1, 0))
          break
        case 'e':
          if (item) {
            event.preventDefault()
            void act(item, view === 'archived' ? 'unarchive' : 'archive')
          }
          break
        case 's':
          if (item) {
            event.preventDefault()
            void act(item, 'snooze', { snoozeHours: 24 })
          }
          break
        case 'f':
          if (item) {
            event.preventDefault()
            void act(item, item.waitingFor ? 'clear_waiting' : 'waiting', { waitingFor: 'their reply' })
          }
          break
        case 't':
          if (item) {
            event.preventDefault()
            void askAgent(item, `Create a follow-up task for the thread "${item.subject}".`)
          }
          break
        case 'r':
          if (item) {
            event.preventDefault()
            void askAgent(item, `Draft a reply to the thread "${item.subject}".`)
          }
          break
        case 'Enter':
          if (item) {
            event.preventDefault()
            router.push(`/inbox/${item.id}`)
          }
          break
        case '?':
          event.preventDefault()
          setShowHelp((v) => !v)
          break
        case 'Escape':
          setShowHelp(false)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [act, askAgent, cursor, rows, router, view])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  if (rows.length === 0) {
    return (
      <div className="panel">
        <div className="empty stack stack-3">
          <p className="secondary">
            {view === 'queue' ? 'The queue is clear.' : 'Nothing in this view.'}
          </p>
          <p className="small muted">
            Threads reappear here when a customer replies, a snooze expires, or the triage run
            finds something new.
          </p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="panel" ref={listRef}>
        <div className="panel-body-flush">
          {rows.map((item, index) => (
            <div
              key={item.id}
              data-index={index}
              data-testid="inbox-row"
              data-selected={index === cursor}
              onClick={() => setCursor(index)}
              onDoubleClick={() => router.push(`/inbox/${item.id}`)}
              style={{
                display: 'grid',
                gridTemplateColumns: '4px 1fr auto',
                gap: 'var(--s-5)',
                alignItems: 'center',
                padding: 'var(--s-4) var(--s-6)',
                borderBottom: '1px solid var(--hairline)',
                background: index === cursor ? 'var(--surface-selected)' : undefined,
                cursor: 'pointer',
              }}
            >
              <span
                style={{
                  width: 3,
                  height: 22,
                  borderRadius: 2,
                  background:
                    item.priority === 'urgent'
                      ? 'var(--p-urgent)'
                      : item.priority === 'high'
                        ? 'var(--p-high)'
                        : 'transparent',
                }}
              />
              <div className="stack stack-1" style={{ minWidth: 0 }}>
                <div className="row-tight" style={{ minWidth: 0 }}>
                  <strong className="small" style={{ whiteSpace: 'nowrap' }}>
                    {item.companyName ?? 'Internal'}
                  </strong>
                  <span className="small secondary" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.subject}
                  </span>
                </div>
                <div className="row-tight">
                  {item.category ? (
                    <span className="chip">{item.category.replace(/_/g, ' ')}</span>
                  ) : (
                    <span className="chip">untriaged</span>
                  )}
                  {item.pastSla ? (
                    <span className="chip chip-attention">
                      {item.daysWaiting}d · SLA {item.slaDays}d
                    </span>
                  ) : (
                    <span className="small muted">{item.daysWaiting}d</span>
                  )}
                  {item.waitingFor ? <span className="chip">waiting: {item.waitingFor}</span> : null}
                  {item.hasFlaggedContent ? (
                    <span className="chip chip-critical" title="This thread contains content that tried to instruct the assistant.">
                      suspicious content
                    </span>
                  ) : null}
                  {item.sentiment === 'negative' ? <span className="chip chip-critical">negative</span> : null}
                </div>
              </div>
              <span className="small muted mono" style={{ whiteSpace: 'nowrap' }}>
                {item.messageCount} msg · {item.ownerName ?? 'unowned'}
              </span>
            </div>
          ))}
        </div>
        <div className="panel-body hairline-top spread">
          <span className="small muted">
            {rows.length} in this view · j/k to move, e archive, s snooze, f waiting, t task, r reply, ? for help
          </span>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowHelp(true)}>
            Shortcuts
          </button>
        </div>
      </div>

      {toast ? (
        <div
          role="status"
          className="banner banner-accent"
          style={{ position: 'fixed', bottom: 'var(--s-8)', left: '50%', transform: 'translateX(-50%)', zIndex: 50 }}
        >
          <span>{toast}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setToast(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {showHelp ? (
        <div
          className="cmdk-backdrop"
          role="dialog"
          aria-modal="true"
          data-testid="shortcut-help"
          onClick={() => setShowHelp(false)}
        >
          <div className="cmdk" onClick={(e) => e.stopPropagation()}>
            <div className="panel-header">
              <h2>Inbox shortcuts</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowHelp(false)}>
                Close
              </button>
            </div>
            <div className="panel-body stack stack-3">
              {SHORTCUTS.map((s) => (
                <div className="spread" key={s.keys}>
                  <span className="small">{s.label}</span>
                  <kbd className="chip mono">{s.keys}</kbd>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {busy ? <span className="visually-hidden">Working</span> : null}
    </>
  )
}

function truncate(value: string): string {
  return value.length > 40 ? `${value.slice(0, 37)}…` : value
}
