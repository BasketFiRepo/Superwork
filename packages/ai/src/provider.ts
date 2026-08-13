import type { TaskClass } from '@superwork/config'

/**
 * Provider abstraction (§5.11). Feature code never names a model — it names a task
 * class, and the router resolves it. Swapping providers is a config change.
 */

export type TrustLevel = 'trusted_system' | 'user_instruction' | 'org_data' | 'untrusted_external'

/**
 * Provenance tagging (§5.9.1). Every context block is labelled with its trust level,
 * and the system prompt states that instructions inside `untrusted_external` are data
 * to be reported, never obeyed. Retrieved content is never concatenated into the
 * instruction region — it arrives here as a separate, fenced block.
 */
export interface ContextBlock {
  zone: 'org_profile' | 'actor' | 'task_context' | 'knowledge' | 'external' | 'history' | 'tools' | 'output_contract'
  trust: TrustLevel
  label: string
  /** Structured data is serialized as JSON, never as prose the model can mistake for an instruction. */
  data?: unknown
  text?: string
  sourceId?: string
}

export interface CompletionRequest {
  taskClass: TaskClass
  system: string
  blocks: ContextBlock[]
  userMessage: string
  /** When present the provider must return JSON matching this JSON Schema. */
  outputSchema?: Record<string, unknown>
  maxOutputTokens?: number
  temperature?: number
  /** Structured facts the runtime already resolved. Mock mode reasons over these. */
  grounding?: Record<string, unknown>
}

export type CompletionEvent =
  | { type: 'text'; delta: string }
  | { type: 'json'; value: unknown }
  | { type: 'usage'; tokensIn: number; tokensOut: number; model: string; costCents: number; latencyMs: number }
  | { type: 'error'; failureClass: 'transient' | 'auth' | 'model' | 'budget'; message: string }
  | { type: 'done' }

export interface ProviderCapabilities {
  toolUse: boolean
  jsonSchema: boolean
  contextWindow: number
  vision: boolean
  /** Simulated output is badged everywhere it is displayed (§5.12). */
  simulated: boolean
}

export interface LLMProvider {
  readonly name: string
  readonly capabilities: ProviderCapabilities
  complete(req: CompletionRequest): AsyncIterable<CompletionEvent>
  countTokens(input: string): number
}

/** Deterministic estimate used for budgets; providers report exact usage in the usage event. */
export function estimateTokens(input: string): number {
  return Math.max(1, Math.ceil(input.length / 4))
}

export function renderBlocks(blocks: ContextBlock[]): string {
  return blocks
    .map((block) => {
      const body = block.text ?? JSON.stringify(block.data ?? null, null, 2)
      const tag = block.trust === 'untrusted_external' ? 'untrusted_external' : block.zone
      const attrs = [`label="${block.label}"`, `trust="${block.trust}"`]
      if (block.sourceId) attrs.push(`source_id="${block.sourceId}"`)
      return `<${tag} ${attrs.join(' ')}>\n${body}\n</${tag}>`
    })
    .join('\n\n')
}
