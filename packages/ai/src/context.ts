import type { ContextBlock } from './provider.js'
import { estimateTokens } from './provider.js'

/**
 * Context assembly (§7.5). Blocks are emitted in a fixed, cache-friendly order so the
 * stable prefix (system rules + organization profile) can be prompt-cached:
 *
 *   1 system rules · 2 org profile · 3 actor · 4 task context · 5 retrieved knowledge
 *   6 untrusted external · 7 history · 8 tools · 9 output contract
 *
 * When over budget the assembly degrades in a defined order. Safety rules and the tool
 * contract are never truncated.
 */

export interface ContextBudget {
  maxTokens: number
  /** Per-zone ceilings; the knowledge zone yields first when the total is exceeded. */
  zoneLimits: Partial<Record<ContextBlock['zone'], number>>
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxTokens: 60_000,
  zoneLimits: { knowledge: 24_000, external: 8_000, history: 6_000, task_context: 8_000 },
}

const ZONE_ORDER: ContextBlock['zone'][] = [
  'org_profile',
  'actor',
  'task_context',
  'knowledge',
  'external',
  'history',
  'tools',
  'output_contract',
]

export interface AssemblyReport {
  blocks: ContextBlock[]
  totalTokens: number
  composition: { zone: string; blocks: number; tokens: number }[]
  degradations: string[]
}

function blockTokens(block: ContextBlock): number {
  return estimateTokens(block.text ?? JSON.stringify(block.data ?? ''))
}

export function assembleContext(blocks: ContextBlock[], budget = DEFAULT_CONTEXT_BUDGET): AssemblyReport {
  const ordered = [...blocks].sort((a, b) => ZONE_ORDER.indexOf(a.zone) - ZONE_ORDER.indexOf(b.zone))
  const degradations: string[] = []

  // Zone caps first.
  const kept: ContextBlock[] = []
  const zoneUsage = new Map<string, number>()
  for (const block of ordered) {
    const tokens = blockTokens(block)
    const limit = budget.zoneLimits[block.zone]
    const used = zoneUsage.get(block.zone) ?? 0
    if (limit !== undefined && used + tokens > limit) {
      degradations.push(`Dropped "${block.label}" — ${block.zone} zone is at its ${limit} token ceiling.`)
      continue
    }
    zoneUsage.set(block.zone, used + tokens)
    kept.push(block)
  }

  // Global budget: compress history, then drop lowest-ranked knowledge, then summarize context.
  let total = kept.reduce((sum, b) => sum + blockTokens(b), 0)
  const degradeOrder: ContextBlock['zone'][] = ['history', 'knowledge', 'external', 'task_context']

  for (const zone of degradeOrder) {
    while (total > budget.maxTokens) {
      const index = kept.map((b, i) => ({ b, i })).filter((x) => x.b.zone === zone).pop()
      if (!index) break
      total -= blockTokens(index.b)
      kept.splice(index.i, 1)
      degradations.push(`Dropped "${index.b.label}" to stay inside the ${budget.maxTokens} token context budget.`)
    }
    if (total <= budget.maxTokens) break
  }

  const composition = ZONE_ORDER.map((zone) => {
    const zoneBlocks = kept.filter((b) => b.zone === zone)
    return {
      zone,
      blocks: zoneBlocks.length,
      tokens: zoneBlocks.reduce((sum, b) => sum + blockTokens(b), 0),
    }
  }).filter((c) => c.blocks > 0)

  return { blocks: kept, totalTokens: total, composition, degradations }
}
