'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * ⌘K (§14.2). Three modes in one surface:
 *   Navigate (default) · Act (`>`) · Ask (`?` or a plain sentence)
 * Keyboard-only operation throughout.
 */

interface Entry {
  id: string
  label: string
  hint: string
  run: () => void
}

export function CommandBar() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((value) => !value)
      }
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      queueMicrotask(() => inputRef.current?.focus())
    }
  }, [open])

  const ask = useCallback(
    async (text: string) => {
      setOpen(false)
      await fetch('/api/agent/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request: text, mode: 'assist', uiContext: { route: window.location.pathname } }),
      })
      router.push('/agent')
      router.refresh()
    },
    [router],
  )

  const entries = useMemo<Entry[]>(() => {
    const go = (href: string, label: string, hint: string): Entry => ({
      id: href,
      label,
      hint,
      run: () => {
        setOpen(false)
        router.push(href)
      },
    })

    if (query.startsWith('>')) {
      const text = query.slice(1).trim()
      return [
        go('/tasks?new=1', 'Create a task', 'Act'),
        go('/knowledge?upload=1', 'Add a document to company memory', 'Act'),
        go('/settings/ai-governance', 'Open AI governance', 'Act'),
      ].filter((entry) => !text || entry.label.toLowerCase().includes(text.toLowerCase()))
    }

    if (query.startsWith('?') || /\s/.test(query.trim())) {
      const text = query.replace(/^\?/, '').trim()
      if (text.length > 2) {
        return [{ id: 'ask', label: `Ask the agent: "${text}"`, hint: 'Ask', run: () => void ask(text) }]
      }
    }

    return [
      go('/', 'Today', 'Navigate'),
      go('/tasks', 'Tasks', 'Navigate'),
      go('/approvals', 'Approvals', 'Navigate'),
      go('/insights', 'Insights', 'Navigate'),
      go('/knowledge', 'Knowledge', 'Navigate'),
      go('/agent', 'Agent', 'Navigate'),
      go('/activity', 'Activity', 'Navigate'),
      go('/settings/ai-governance', 'AI governance', 'Navigate'),
    ].filter((entry) => !query || entry.label.toLowerCase().includes(query.toLowerCase()))
  }, [ask, query, router])

  return (
    <>
      <button className="btn btn-sm btn-ghost" onClick={() => setOpen(true)} aria-keyshortcuts="Meta+K">
        Search or ask
        <span className="mono muted">⌘K</span>
      </button>

      {open ? (
        <div className="cmdk-backdrop" role="dialog" aria-modal="true" aria-label="Command bar" onClick={() => setOpen(false)}>
          <div className="cmdk" onClick={(event) => event.stopPropagation()}>
            <input
              ref={inputRef}
              className="cmdk-input"
              placeholder="Jump to…  ·  > to act  ·  ? to ask the agent"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActive(0)
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  setActive((i) => Math.min(i + 1, entries.length - 1))
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setActive((i) => Math.max(i - 1, 0))
                }
                if (event.key === 'Enter') {
                  event.preventDefault()
                  entries[active]?.run()
                }
              }}
            />
            <div className="cmdk-list">
              {entries.length === 0 ? (
                <div className="empty small secondary">Nothing matches. Press ? to ask the agent instead.</div>
              ) : (
                entries.map((entry, index) => (
                  <button
                    key={entry.id}
                    className="cmdk-item"
                    data-active={index === active}
                    onMouseEnter={() => setActive(index)}
                    onClick={entry.run}
                  >
                    <span>{entry.label}</span>
                    <span className="micro" style={{ marginLeft: 'auto' }}>
                      {entry.hint}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
