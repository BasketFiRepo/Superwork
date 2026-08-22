import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_RUN_BUDGET } from '@superwork/config'
import { AGENT_BUDGET_KEYS } from '@superwork/core'
import { ROOT } from '../../scripts/column-coverage.js'

/**
 * The second place `DEFAULT_RUN_BUDGET` lives (ADR 0077).
 *
 * `sw_agent_budget_within_default` carries the ceiling as SQL literals, because a rule only
 * application code keeps is one anything holding a connection can break — the argument of ADRs
 * 0072 and 0074. The cost of that is a number written down twice, and the mitigation is the
 * arrangement `schema-manifest.ts` has with the migrations directory: a test that refuses the
 * copy the moment it stops matching the original.
 */
const MIGRATION = join(
  ROOT,
  'packages',
  'db',
  'migrations',
  '0067_a_budget_this_agent_runs_under.up.sql',
)

describe('the ceiling the database enforces', () => {
  const sql = readFileSync(MIGRATION, 'utf8')
  const ceiling = JSON.parse(
    /ceiling jsonb := '(\{[^']*\})'::jsonb/s.exec(sql)?.[1] ?? '{}',
  ) as Record<string, number>

  it('is the same ceiling the product enforces', () => {
    for (const key of AGENT_BUDGET_KEYS) {
      expect(ceiling[key], `${key} in the migration`).toBe(DEFAULT_RUN_BUDGET[key])
    }
  })

  it('and covers exactly the keys the runtime reads, no more and no fewer', () => {
    // A key here that `checkBudget` does not read would be a setting that silently does
    // nothing; a key it reads that is missing here would be one the database lets past.
    expect(Object.keys(ceiling).sort()).toEqual([...AGENT_BUDGET_KEYS].sort())
  })
})
