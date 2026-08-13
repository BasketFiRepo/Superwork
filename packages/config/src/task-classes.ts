/**
 * Model routing by task class (§5.11).
 *
 * Feature code NEVER names a model. It names a task class; the class resolves to
 * a model through this table, which can be overridden per organization and plan tier.
 */

export const TASK_CLASSES = [
  'agent.plan',
  'agent.answer',
  'agent.report',
  'agent.critic',
  'inbox.classify',
  'inbox.extract_commitments',
  'email.draft',
  'meeting.summarize',
  'crm.summary',
  'briefing.narrative',
  'doc.contextual_header',
  'doc.classify',
  'retrieval.rerank',
  'memory.extract',
] as const

export type TaskClass = (typeof TASK_CLASSES)[number]

export interface ModelRoute {
  /** Model identifier, resolved at call time. Never referenced directly by feature code. */
  model: string
  maxOutputTokens: number
  temperature: number
  /** Frontier work (planning, drafting, synthesis) vs. cheap/fast work (classification, labelling). */
  tier: 'frontier' | 'fast'
}

const DEFAULT_ROUTES: Record<TaskClass, ModelRoute> = {
  'agent.plan': { model: 'claude-sonnet-5', maxOutputTokens: 4096, temperature: 0.2, tier: 'frontier' },
  'agent.answer': { model: 'claude-sonnet-5', maxOutputTokens: 2048, temperature: 0.3, tier: 'frontier' },
  'agent.report': { model: 'claude-sonnet-5', maxOutputTokens: 1536, temperature: 0.3, tier: 'frontier' },
  'agent.critic': { model: 'claude-sonnet-5', maxOutputTokens: 1024, temperature: 0, tier: 'frontier' },
  'inbox.classify': { model: 'claude-haiku-4-5-20251001', maxOutputTokens: 512, temperature: 0, tier: 'fast' },
  'inbox.extract_commitments': { model: 'claude-haiku-4-5-20251001', maxOutputTokens: 1024, temperature: 0, tier: 'fast' },
  'meeting.summarize': { model: 'claude-sonnet-5', maxOutputTokens: 3072, temperature: 0.2, tier: 'frontier' },
  'crm.summary': { model: 'claude-sonnet-5', maxOutputTokens: 1536, temperature: 0.3, tier: 'frontier' },
  // The briefing's numbers are already computed; the model only writes the prose around
  // them, so a cheap model is the right choice and a low temperature keeps it honest.
  'briefing.narrative': { model: 'claude-haiku-4-5-20251001', maxOutputTokens: 1024, temperature: 0.2, tier: 'fast' },
  'email.draft': { model: 'claude-sonnet-5', maxOutputTokens: 1536, temperature: 0.4, tier: 'frontier' },
  'doc.contextual_header': { model: 'claude-haiku-4-5-20251001', maxOutputTokens: 256, temperature: 0, tier: 'fast' },
  'doc.classify': { model: 'claude-haiku-4-5-20251001', maxOutputTokens: 256, temperature: 0, tier: 'fast' },
  'retrieval.rerank': { model: 'claude-haiku-4-5-20251001', maxOutputTokens: 512, temperature: 0, tier: 'fast' },
  'memory.extract': { model: 'claude-haiku-4-5-20251001', maxOutputTokens: 1024, temperature: 0, tier: 'fast' },
}

/** Cost per million tokens, in cents. Used for budget enforcement and usage records. */
export const MODEL_PRICING_CENTS_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-sonnet-5': { input: 300, output: 1500 },
  'claude-haiku-4-5-20251001': { input: 100, output: 500 },
  // Mock mode still meters, so cost dashboards and budgets are exercised in CI.
  'mock-frontier': { input: 300, output: 1500 },
  'mock-fast': { input: 100, output: 500 },
}

export function resolveRoute(taskClass: TaskClass, overrides?: Partial<Record<TaskClass, Partial<ModelRoute>>>): ModelRoute {
  const base = DEFAULT_ROUTES[taskClass]
  const override = overrides?.[taskClass]
  return override ? { ...base, ...override } : base
}

export function estimateCostCents(model: string, inputTokens: number, outputTokens: number): number {
  const price = MODEL_PRICING_CENTS_PER_MTOK[model] ?? { input: 0, output: 0 }
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output
}
