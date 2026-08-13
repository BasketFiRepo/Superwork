import { estimateCostCents, resolveRoute } from '@superwork/config'
import type { CompletionEvent, CompletionRequest, LLMProvider, ProviderCapabilities } from '../provider.js'
import { estimateTokens, renderBlocks } from '../provider.js'
import { answerFor, criticFor, planFor, reportFor, type Grounding } from './brain.js'

/**
 * The `mock` LLMProvider. Deterministic and seeded: the same request against the same
 * database state always produces the same output, which is what makes agent evals a
 * regression test rather than a coin flip.
 */
export class MockLLMProvider implements LLMProvider {
  readonly name = 'mock'
  readonly capabilities: ProviderCapabilities = {
    toolUse: true,
    jsonSchema: true,
    contextWindow: 200_000,
    vision: false,
    simulated: true,
  }

  countTokens(input: string): number {
    return estimateTokens(input)
  }

  async *complete(req: CompletionRequest): AsyncIterable<CompletionEvent> {
    const startedAt = Date.now()
    const route = resolveRoute(req.taskClass)
    const model = route.tier === 'frontier' ? 'mock-frontier' : 'mock-fast'
    const rendered = `${req.system}\n${renderBlocks(req.blocks)}\n${req.userMessage}`
    const tokensIn = estimateTokens(rendered)

    const grounding = (req.grounding ?? {}) as unknown as Grounding
    let value: unknown

    switch (req.taskClass) {
      case 'agent.plan':
        value = planFor(req.userMessage, grounding)
        break
      case 'agent.answer':
        value = answerFor(req.userMessage, grounding)
        break
      case 'agent.report':
        value = {
          text: reportFor(
            (req.grounding?.['outcome'] as never) ?? emptyOutcome(),
            (req.grounding?.['needsAttention'] as never) ?? [],
            (req.grounding?.['injectionWarnings'] as never) ?? [],
          ),
        }
        break
      case 'agent.critic':
        value = criticFor((req.grounding?.['draft'] as never) ?? {})
        break
      case 'inbox.classify':
        value = classify(req.userMessage)
        break
      case 'email.draft':
        value = { body: draftBody(req.grounding ?? {}) }
        break
      default:
        value = { text: '' }
    }

    const serialized = JSON.stringify(value)
    const tokensOut = estimateTokens(serialized)

    // Stream narrative output so the UI exercises real backpressure handling.
    if (req.taskClass === 'agent.answer' || req.taskClass === 'agent.report') {
      const text = String((value as { text?: string }).text ?? '')
      for (const word of text.split(/(\s+)/)) {
        yield { type: 'text', delta: word }
      }
    }

    yield { type: 'json', value }
    yield {
      type: 'usage',
      tokensIn,
      tokensOut,
      model,
      costCents: estimateCostCents(model, tokensIn, tokensOut),
      latencyMs: Date.now() - startedAt,
    }
    yield { type: 'done' }
  }
}

function emptyOutcome() {
  return { created: 0, updated: 0, drafted: 0, sent: 0, skipped: [], failed: [] }
}

function classify(text: string): Record<string, unknown> {
  const lower = text.toLowerCase()
  const category = /\?|could you|can you|please/.test(lower)
    ? 'needs_reply'
    : /invoice|payment|overdue/.test(lower)
      ? 'needs_action'
      : /fyi|for your information|no action/.test(lower)
        ? 'fyi'
        : 'needs_reply'
  const urgent = /urgent|asap|immediately|today/.test(lower)
  return { category, priority: urgent ? 'urgent' : 'medium', sentiment: /sorry|delay|unhappy/.test(lower) ? 'negative' : 'neutral' }
}

function draftBody(grounding: Record<string, unknown>): string {
  const company = String(grounding['companyName'] ?? 'there')
  const days = Number(grounding['daysWaiting'] ?? 0)
  const lastMessage = String(grounding['lastMessageExcerpt'] ?? '').split('\n')[0]?.slice(0, 160) ?? ''
  const senderName = String(grounding['senderName'] ?? '')

  return [
    `Hi ${company},`,
    '',
    days > 0
      ? `Following up on my last note${days ? ` from ${days} days ago` : ''}${lastMessage ? ` about "${lastMessage.trim()}"` : ''}.`
      : 'Following up on our last exchange.',
    '',
    'Is this still something you would like us to move forward? If it is easier, I am happy to jump on a short call this week.',
    '',
    'Best regards,',
    senderName,
  ].join('\n')
}
