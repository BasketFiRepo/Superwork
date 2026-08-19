import { cache } from 'react'

/**
 * The instant this request is being answered at — the same one, however many times React renders.
 *
 * `asOfLabel` puts a clock on a screen to the minute, because every number carries its basis
 * (§16.9). Calling `new Date()` inside a server component looks harmless and is not: a render
 * pass that straddles a minute tick produces one string in the HTML and a different one in the
 * flight payload, and React reports a hydration mismatch — error #418, on exactly the pages that
 * render a basis and no others.
 *
 * That flake cost re-runs of the browser check on three separate occasions before the pattern was
 * clear, and a red check somebody re-runs by habit is worse than no check. `cache` from React is
 * the tool for this: one call per request, whatever renders.
 */
export const requestNow = cache(() => new Date())
