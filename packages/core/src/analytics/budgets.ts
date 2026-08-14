/**
 * The enterprise scale budgets (§26.9).
 *
 * They live in code so the load harness, the tests and the operations screen all quote
 * the same numbers, and so a regression is a failing assertion rather than a memory of
 * what the table used to say.
 *
 * `referenceScale` is the size the target is stated at. A measurement taken at a smaller
 * scale is still useful — it catches a missing index, an accidental sequential scan or an
 * N+1 — but it is not the same claim, and the harness prints both so nobody confuses them.
 */

export interface Budget {
  key: string
  label: string
  /** Milliseconds unless stated otherwise. */
  targetMs: number
  percentile: 'p50' | 'p95' | 'total'
  referenceScale: string
  note: string
}

export const SCALE_BUDGETS: Budget[] = [
  {
    key: 'list_view',
    label: 'List view, scoped',
    targetMs: 400,
    percentile: 'p95',
    referenceScale: '100k users, 50M-row table',
    note: 'Keyset pagination with the ordering columns in the index. Never OFFSET.',
  },
  {
    key: 'permission_check',
    label: 'Permission check',
    targetMs: 10,
    percentile: 'p95',
    referenceScale: '100k users',
    note: 'Role evaluation is in memory; relation tuples are a point lookup on an index.',
  },
  {
    key: 'hybrid_search',
    label: 'Scoped hybrid search',
    targetMs: 500,
    percentile: 'p95',
    referenceScale: '100k users',
    note: 'The ACL predicate is inside both arms of the query, not applied afterwards.',
  },
  {
    key: 'queue_wait',
    label: 'Interactive agent run queue wait',
    targetMs: 2_000,
    percentile: 'p95',
    referenceScale: '100k users',
    note: 'Fair-share scheduling: interactive work is not queued behind a bulk job.',
  },
  {
    key: 'notification_fanout',
    label: 'Notification fan-out, 5,000 recipients',
    targetMs: 60_000,
    percentile: 'total',
    referenceScale: '5,000 recipients',
    note: 'One statement per batch, not one per recipient.',
  },
  {
    key: 'scim_sync',
    label: 'SCIM incremental sync, 100k users',
    targetMs: 15 * 60_000,
    percentile: 'total',
    referenceScale: '100k users',
    note: 'Cursor-paged, bulk-upserted, and idempotent so a retry is free.',
  },
  {
    key: 'briefing_sweep',
    label: 'Daily briefing generation, whole tenant',
    targetMs: 60 * 60_000,
    percentile: 'total',
    referenceScale: '100k users',
    note: 'Spread across timezone windows rather than fired at one instant.',
  },
]

export function budget(key: string): Budget {
  const found = SCALE_BUDGETS.find((entry) => entry.key === key)
  if (!found) throw new Error(`Unknown scale budget "${key}"`)
  return found
}

export interface Measurement {
  key: string
  samples: number
  p50Ms: number
  p95Ms: number
  totalMs: number
  /** What was actually measured, which is rarely the reference scale. */
  measuredScale: string
}

export interface BudgetVerdict extends Measurement {
  label: string
  targetMs: number
  percentile: Budget['percentile']
  observedMs: number
  withinBudget: boolean
  referenceScale: string
  /** True when the measurement was taken below the scale the target is stated at. */
  extrapolated: boolean
}

export function judge(measurement: Measurement): BudgetVerdict {
  const target = budget(measurement.key)
  const observedMs =
    target.percentile === 'p50'
      ? measurement.p50Ms
      : target.percentile === 'p95'
        ? measurement.p95Ms
        : measurement.totalMs

  return {
    ...measurement,
    label: target.label,
    targetMs: target.targetMs,
    percentile: target.percentile,
    observedMs,
    withinBudget: observedMs <= target.targetMs,
    referenceScale: target.referenceScale,
    extrapolated: measurement.measuredScale !== target.referenceScale,
  }
}

/** p50/p95 from a set of samples, without pulling in a stats dependency. */
export function percentiles(samplesMs: number[]): { p50Ms: number; p95Ms: number; totalMs: number } {
  if (samplesMs.length === 0) return { p50Ms: 0, p95Ms: 0, totalMs: 0 }
  const sorted = [...samplesMs].sort((a, b) => a - b)
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!
  return {
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    totalMs: sorted.reduce((sum, value) => sum + value, 0),
  }
}
