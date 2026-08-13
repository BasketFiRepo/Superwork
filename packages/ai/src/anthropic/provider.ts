import { env, estimateCostCents, resolveRoute } from '@superwork/config'
import type { CompletionEvent, CompletionRequest, LLMProvider, ProviderCapabilities } from '../provider.js'
import { estimateTokens, renderBlocks } from '../provider.js'

/**
 * Live provider. Structured output is requested through a single forced tool, which is
 * the most reliable way to get schema-valid JSON out of a tool-using model.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic'
  readonly capabilities: ProviderCapabilities = {
    toolUse: true,
    jsonSchema: true,
    contextWindow: 200_000,
    vision: true,
    simulated: false,
  }

  countTokens(input: string): number {
    return estimateTokens(input)
  }

  async *complete(req: CompletionRequest): AsyncIterable<CompletionEvent> {
    const startedAt = Date.now()
    const route = resolveRoute(req.taskClass)
    const config = env()

    const system = [
      { type: 'text', text: req.system, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: renderBlocks(req.blocks.filter((b) => b.zone === 'org_profile')) },
    ]
    const contextText = renderBlocks(req.blocks.filter((b) => b.zone !== 'org_profile'))

    const body: Record<string, unknown> = {
      model: route.model,
      max_tokens: req.maxOutputTokens ?? route.maxOutputTokens,
      temperature: req.temperature ?? route.temperature,
      system,
      stream: true,
      messages: [{ role: 'user', content: `${contextText}\n\n${req.userMessage}` }],
    }

    if (req.outputSchema) {
      body['tools'] = [
        {
          name: 'emit',
          description: 'Return the result in the required structure. Call this exactly once.',
          input_schema: req.outputSchema,
        },
      ]
      body['tool_choice'] = { type: 'tool', name: 'emit' }
    }

    let response: Response
    try {
      response = await fetch(`${config.ANTHROPIC_BASE_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.ANTHROPIC_API_KEY ?? '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      })
    } catch (error) {
      yield { type: 'error', failureClass: 'transient', message: `Could not reach the model provider: ${String(error)}` }
      return
    }

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '')
      yield {
        type: 'error',
        failureClass: response.status === 401 ? 'auth' : response.status >= 500 || response.status === 429 ? 'transient' : 'model',
        message: `Model provider returned ${response.status}. ${detail.slice(0, 300)}`,
      }
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let toolJson = ''
    let tokensIn = 0
    let tokensOut = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let event: Record<string, any>
        try {
          event = JSON.parse(payload)
        } catch {
          continue
        }

        if (event['type'] === 'content_block_delta') {
          const delta = event['delta']
          if (delta?.type === 'text_delta') yield { type: 'text', delta: String(delta.text ?? '') }
          if (delta?.type === 'input_json_delta') toolJson += String(delta.partial_json ?? '')
        }
        if (event['type'] === 'message_start') {
          tokensIn = Number(event['message']?.usage?.input_tokens ?? 0)
        }
        if (event['type'] === 'message_delta') {
          tokensOut = Number(event['usage']?.output_tokens ?? tokensOut)
        }
      }
    }

    if (toolJson) {
      try {
        yield { type: 'json', value: JSON.parse(toolJson) }
      } catch {
        yield { type: 'error', failureClass: 'model', message: 'The model returned malformed structured output.' }
      }
    }

    yield {
      type: 'usage',
      tokensIn,
      tokensOut,
      model: route.model,
      costCents: estimateCostCents(route.model, tokensIn, tokensOut),
      latencyMs: Date.now() - startedAt,
    }
    yield { type: 'done' }
  }
}
