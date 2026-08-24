import { createHash } from 'node:crypto'
import type { MockBehaviour, ProviderHealth, StorageProvider } from '../contracts.js'

/**
 * Mock providers are first class (§13.2) — and ADR 0084 sharpened what that has to mean: a mock
 * you cannot build the consumer against is why the consumer never gets built.
 *
 * `StorageProvider` had been declared since Phase 2 with **no implementation at all** — no mock,
 * no resolver, no caller — while `documents.storage_key` and `documents.mime_type` sat empty and
 * `ingest.ts` carried a comment saying "binary parsing lives behind the StorageProvider". You
 * could not attach a file to anything in Superwork.
 *
 * This one keeps the bytes in memory. Nothing touches a disk and nothing leaves the machine,
 * which is what lets CI and the demo exercise attachment end to end with no credential.
 */
export class MockStorageProvider implements StorageProvider {
  readonly name = 'mock-storage'
  readonly mode = 'mock' as const
  readonly capabilities = { put: true, get: true, remove: true }

  private readonly objects = new Map<string, { body: Buffer; contentType: string }>()

  constructor(private readonly behaviour: MockBehaviour = {}) {}

  async healthCheck(): Promise<ProviderHealth> {
    return {
      ok: true,
      lastSuccessfulSyncAt: new Date(),
      errorRate: this.behaviour.failureRate ?? 0,
      tokenExpiresAt: null,
      message: 'Simulated storage — the bytes stay in this process.',
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<{ key: string; bytes: number }> {
    await this.simulate()
    this.objects.set(key, { body, contentType })
    return { key, bytes: body.byteLength }
  }

  async get(key: string): Promise<Buffer> {
    await this.simulate()
    const object = this.objects.get(key)
    if (!object) {
      const error = new Error('That file is not in storage.')
      error.name = 'NotFoundError'
      throw error
    }
    return object.body
  }

  async remove(key: string): Promise<void> {
    await this.simulate()
    this.objects.delete(key)
  }

  /** Test hook: whether the bytes are really gone, which §25.13 turns on. */
  has(key: string): boolean {
    return this.objects.has(key)
  }

  private async simulate(): Promise<void> {
    if (this.behaviour.rateLimited) {
      const error = new Error('Storage is rate limited. Retry after backoff.')
      error.name = 'TransientError'
      throw error
    }
    if (this.behaviour.latencyMs) await new Promise((r) => setTimeout(r, this.behaviour.latencyMs))
  }
}

/**
 * Where a file lives, derived rather than chosen.
 *
 * Keyed by content hash under the organization, so the same bytes uploaded twice occupy one
 * object — and, more to the point, so a key cannot be guessed from a document id and cannot be
 * walked. It is not a secret and is not treated as one: the permission check is the gate.
 */
export function storageKeyFor(organizationId: string, body: Buffer): string {
  const hash = createHash('sha256').update(body).digest('hex')
  return `${organizationId}/${hash}`
}
