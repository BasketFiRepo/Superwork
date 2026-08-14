import { env } from '@superwork/config'
import type { CompletionEvent, CompletionRequest, LLMProvider } from './provider.js'
import { MockLLMProvider } from './mock/provider.js'
import { AnthropicProvider } from './anthropic/provider.js'

export * from './provider.js'
export * from './context.js'
export * from './prompts.js'
export type { Grounding, PlanDraft, AnswerDraft, CriticVerdict } from './mock/brain.js'
export {
  triageFor,
  extractCommitments,
  resolveDueHint,
  summarizeMeeting,
  narrate360,
  briefingNarrative,
  type TriageResult,
  type DetectedCommitment,
  type MeetingSummary,
  type MeetingGrounding,
  type BriefingGrounding,
  type CrmGrounding,
} from './mock/nervous-system.js'
export {
  compileWorkflow,
  readbackFor,
  type CompiledWorkflow,
  type DetectedRisk,
  type WorkflowGraph,
  type WorkflowNode,
} from './mock/workflow-compiler.js'
export { MockLLMProvider } from './mock/provider.js'
export { AnthropicProvider } from './anthropic/provider.js'

let override: LLMProvider | null = null

export function llmProvider(): LLMProvider {
  if (override) return override
  return env().AI_MODE === 'live' ? new AnthropicProvider() : new MockLLMProvider()
}

export function setLLMProvider(provider: LLMProvider | null): void {
  override = provider
}

/**
 * Runs a completion with a fallback chain (§5.11). A live-provider failure degrades to
 * the deterministic mock and reports the degradation, rather than failing the run —
 * but the degradation is always visible, never silent.
 */
export async function completeWithFallback(
  req: CompletionRequest,
): Promise<{ json: unknown; text: string; usage: Extract<CompletionEvent, { type: 'usage' }> | null; degraded: string | null; simulated: boolean }> {
  const primary = llmProvider()
  const attempt = await run(primary, req)
  if (!attempt.error) {
    return { ...attempt, degraded: null, simulated: primary.capabilities.simulated }
  }

  if (primary.name === 'mock') {
    throw new Error(attempt.error.message)
  }

  const fallback = new MockLLMProvider()
  const second = await run(fallback, req)
  if (second.error) throw new Error(second.error.message)
  return {
    ...second,
    degraded: `The model provider failed (${attempt.error.failureClass}): ${attempt.error.message} Superwork fell back to simulated output.`,
    simulated: true,
  }
}

async function run(provider: LLMProvider, req: CompletionRequest) {
  let json: unknown = null
  let text = ''
  let usage: Extract<CompletionEvent, { type: 'usage' }> | null = null
  let error: Extract<CompletionEvent, { type: 'error' }> | null = null

  for await (const event of provider.complete(req)) {
    if (event.type === 'text') text += event.delta
    else if (event.type === 'json') json = event.value
    else if (event.type === 'usage') usage = event
    else if (event.type === 'error') error = event
  }
  return { json, text, usage, error }
}
