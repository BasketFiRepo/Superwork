import { createHash } from 'node:crypto'
import type { Provider, ProviderHealth, RuntimeMode } from './contracts.js'

/**
 * The outbound HTTP capability (§22, §2.3).
 *
 * Admin-authored tools call systems Superwork knows nothing about, so the transport is a
 * provider like every other external dependency: an interface with a deterministic mock
 * behind it. The whole product — including a tenant's own custom tools — runs with zero
 * external credentials, and what the mock returns is badged `Simulated` wherever it is
 * shown.
 */

export interface HttpRequest {
  method: string
  url: string
  headers: Record<string, string>
  body?: unknown
  timeoutMs: number
}

export interface HttpResponse {
  status: number
  ok: boolean
  headers: Record<string, string>
  body: unknown
  /** True when nothing left this process. */
  simulated: boolean
  durationMs: number
}

export interface HttpTransport extends Provider {
  send(request: HttpRequest): Promise<HttpResponse>
}

/**
 * The mock transport. Deterministic by (method, url, body): the same call always returns
 * the same response, so a preview, a screenshot and a test agree with each other, and a
 * demo does not drift between two people looking at it.
 */
export class MockHttpTransport implements HttpTransport {
  readonly mode: RuntimeMode = 'mock'
  readonly name = 'Simulated HTTP'
  readonly capabilities = { outbound: false, deterministic: true }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      ok: true,
      lastSuccessfulSyncAt: null,
      errorRate: 0,
      tokenExpiresAt: null,
      message: 'Simulated. Nothing leaves this process.',
    }
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    const seed = createHash('sha256')
      .update(request.method)
      .update(request.url)
      .update(JSON.stringify(request.body ?? null))
      .digest()
    const first = seed[0] ?? 0
    const url = new URL(request.url)

    // A handful of shapes an integration actually returns, chosen by the seed. Nothing
    // here pretends to be the customer's real system; the response says so.
    const body: Record<string, unknown> = {
      simulated: true,
      note: 'Superwork has no credentials for this host, so this response was generated locally.',
      requestedPath: url.pathname,
      id: seed.subarray(0, 8).toString('hex'),
      status: first % 3 === 0 ? 'open' : first % 3 === 1 ? 'in_progress' : 'closed',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    return {
      status: 200,
      ok: true,
      headers: { 'content-type': 'application/json' },
      body,
      simulated: true,
      durationMs: 4,
    }
  }
}

/** The live transport. Used only when a deployment sets HTTP_TOOLS_MODE=live. */
export class FetchHttpTransport implements HttpTransport {
  readonly mode: RuntimeMode = 'live'
  readonly name = 'HTTP'
  readonly capabilities = { outbound: true, deterministic: false }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      ok: true,
      lastSuccessfulSyncAt: null,
      errorRate: 0,
      tokenExpiresAt: null,
      message: 'Outbound HTTP is enabled for reviewed hosts.',
    }
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), request.timeoutMs)
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: controller.signal,
        redirect: 'error',
      })
      const text = await response.text()
      let parsed: unknown = text
      try {
        parsed = JSON.parse(text)
      } catch {
        // A non-JSON body is returned as text rather than discarded.
      }
      return {
        status: response.status,
        ok: response.ok,
        headers: Object.fromEntries(response.headers.entries()),
        body: parsed,
        simulated: false,
        durationMs: Date.now() - started,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
