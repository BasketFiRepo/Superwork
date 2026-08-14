/**
 * The DAG, rendered (§10.3.3) — beside the plain-English readback, never instead of it.
 * A person approves the sentence; the graph is there so they can check it says what the
 * sentence says.
 */

export interface CompiledView {
  name: string
  graph: {
    trigger: { kind: string; spec: string; description: string }
    nodes: { id: string; type: string; label: string; ref?: string; next: string[] }[]
  }
  readback: string
  risks: { severity: string; message: string; mitigation: string | null }[]
  unsupported: string | null
}

const SHAPE: Record<string, string> = {
  trigger: 'when',
  query: 'find',
  for_each: 'for each',
  action: 'do',
  approval: 'ask',
  notify: 'tell',
}

export function WorkflowGraphView({ compiled }: { compiled: CompiledView }) {
  return (
    <div className="stack stack-5">
      <div className="stack stack-2">
        <span className="micro">In plain English</span>
        <p className="prose" data-testid="workflow-readback" style={{ margin: 0 }}>
          {compiled.readback}
        </p>
      </div>

      <div className="stack stack-2">
        <span className="micro">The steps — {compiled.graph.nodes.length}</span>
        <ol className="stack stack-3" style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
          {compiled.graph.nodes.map((node) => (
            <li
              key={node.id}
              className="row-tight"
              data-testid="workflow-node"
              style={{ paddingLeft: 'var(--s-5)', borderLeft: '1px solid var(--hairline)', alignItems: 'baseline' }}
            >
              <span className="chip">{SHAPE[node.type] ?? node.type}</span>
              <span className="small">{node.label}</span>
              {node.ref ? <span className="small muted">{node.ref}</span> : null}
            </li>
          ))}
        </ol>
      </div>

      {compiled.risks.length > 0 ? (
        <div className="stack stack-2">
          <span className="micro">What this can do that needs watching</span>
          {compiled.risks.map((risk, index) => (
            <div key={index} data-testid="workflow-risk" className={risk.severity === 'high' ? 'banner banner-critical' : 'banner'}>
              <span>
                {risk.message}
                {risk.mitigation ? ` ${risk.mitigation}` : ''}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
