import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Prompts are versioned files in git with changelogs, reviewed as code (§20.2).
 * They are never string literals scattered through feature code.
 */

const PROMPT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts')

export interface PromptTemplate {
  id: string
  version: number
  body: string
}

const cache = new Map<string, PromptTemplate>()

/**
 * The system prompt in force.
 *
 * It lives here rather than at the call site, because a caller that names its own version can
 * disagree with the tests about which prompt the product actually sends — and a prompt is
 * exactly the kind of thing where that disagreement is invisible. One writer, as everywhere
 * else two places would otherwise have to agree (ADRs 0028, 0040, 0047, 0052).
 */
export const SYSTEM_PROMPT_VERSION = 2

export function loadSystemPrompt(): PromptTemplate {
  return loadPrompt('system', SYSTEM_PROMPT_VERSION)
}

export function loadPrompt(id: string, version = 1): PromptTemplate {
  const key = `${id}.v${version}`
  const cached = cache.get(key)
  if (cached) return cached

  const raw = readFileSync(join(PROMPT_DIR, `${key}.md`), 'utf8')
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw)
  const body = (match?.[2] ?? raw).trim()
  const template = { id, version, body }
  cache.set(key, template)
  return template
}

export interface PromptVariables {
  /**
   * `tone` is the organization's own note about how it asks to be written to (ADR 0052),
   * already phrased as a sentence by the caller, or empty when it has not said. It extends the
   * VOICE section and cannot replace it — hedging honestly and carrying a number's basis are
   * not the organization's to switch off.
   */
  org: { name: string; industry: string; tone: string }
  user: { name: string; role: string; department: string; timezone: string }
  now: string
  route_context: string
  mode: string
  effective_capabilities: string
}

export function renderPrompt(template: PromptTemplate, vars: PromptVariables): string {
  return template.body.replace(/\{\{([\w.]+)\}\}/g, (_, path: string) => {
    const value = path.split('.').reduce<unknown>((acc, key) => (acc as Record<string, unknown>)?.[key], vars)
    return value === undefined || value === null ? '' : String(value)
  })
}
