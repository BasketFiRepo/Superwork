/**
 * How things are written on a screen.
 *
 * This lives in the web app rather than in `@superwork/core` because a client component that
 * imports from core pulls `node:crypto` and `node:fs` into the browser bundle — the build says
 * so, loudly. Formatting is a UI concern and belongs on this side of that line.
 *
 * One writer all the same: the run detail and the trace rail both say how long a step took, and
 * a duration written two ways on two screens is one a reader has to translate.
 */

/** An absent or zero duration renders as nothing: a step too fast to measure is not news. */
export function formatDuration(ms?: number | null): string {
  if (!ms) return ''
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}
