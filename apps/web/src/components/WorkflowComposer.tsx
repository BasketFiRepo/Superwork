'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { WorkflowGraphView, type CompiledView } from './WorkflowGraphView'

/**
 * Natural-language authoring (§10.3).
 *
 * Describe → compile → read the graph *and* the plain-English readback → see the risks the
 * compiler found and what it did about them → save. Activation is not offered here: it
 * lives behind the dry run, on the workflow's own page.
 */
export function WorkflowComposer({ examples }: { examples: string[] }) {
  const router = useRouter()
  const [description, setDescription] = useState('')
  const [compiled, setCompiled] = useState<CompiledView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function post(compileOnly: boolean) {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description, compileOnly }),
    })
    const body = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(body.error)
      if (body.compiled) setCompiled(body.compiled)
      return
    }
    if (compileOnly) {
      setCompiled(body.compiled)
      if (body.compiled?.unsupported) setError(body.compiled.unsupported)
      return
    }
    router.push(`/workflows/${body.workflow.id}`)
    router.refresh()
  }

  return (
    <section className="panel" data-testid="workflow-composer">
      <div className="panel-header">
        <h2>Describe an automation</h2>
        <span className="small muted">Plain language. Nothing is created until you save it.</span>
      </div>
      <div className="panel-body stack stack-5">
        <label className="stack stack-2" htmlFor="workflow-description">
          <span className="micro">What should happen?</span>
          <textarea
            id="workflow-description"
            className="textarea"
            rows={3}
            value={description}
            onChange={(event) => {
              setDescription(event.target.value)
              setCompiled(null)
            }}
            placeholder="Every weekday at 9, find customer threads with no reply for 5 days and draft a follow-up."
          />
        </label>

        <div className="row wrap">
          {examples.map((example) => (
            <button
              key={example}
              type="button"
              className="btn btn-ghost small"
              onClick={() => {
                setDescription(example)
                setCompiled(null)
              }}
            >
              {example}
            </button>
          ))}
        </div>

        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        {compiled && !compiled.unsupported ? <WorkflowGraphView compiled={compiled} /> : null}

        <div className="row wrap">
          <button className="btn" data-testid="workflow-compile" onClick={() => post(true)} disabled={busy || description.trim().length < 8}>
            {busy ? 'Working…' : 'Compile and show me'}
          </button>
          <button
            className="btn btn-primary"
            data-testid="workflow-save"
            onClick={() => post(false)}
            disabled={busy || !compiled || Boolean(compiled.unsupported)}
            title={compiled ? 'Saves as a draft. A dry run is still required before it can run.' : 'Compile it first.'}
          >
            Save as draft
          </button>
        </div>
      </div>
    </section>
  )
}
