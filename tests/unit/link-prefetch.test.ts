import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Links that do not fetch a screen nobody has opened (ADR 0058).
 *
 * `next/link` prefetches every link that scrolls into view. Every screen in Superwork is
 * `force-dynamic` and none has a loading boundary, so those prefetches answer with a marker that
 * says nothing can be prepared and cache nothing — a hundred and forty-four of them on the task
 * list alone, buying nothing at all.
 *
 * `@/components/Link` settles it once. This refuses the thirty-fourth file that imports
 * `next/link` directly, because a rule that lives in a code review is a rule until somebody is
 * in a hurry.
 */

const ROOT = new URL('../../apps/web/src/', import.meta.url).pathname
const WRAPPER = 'components/Link.tsx'

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(path))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) found.push(path)
  }
  return found
}

describe('links in the web app', () => {
  const files = sourceFiles(ROOT)

  it('reads the whole app, so this test cannot pass by finding nothing', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('all come from the one wrapper that says whether they prefetch', () => {
    const offenders = files
      .map((path) => ({ path: relative(ROOT, path), source: readFileSync(path, 'utf8') }))
      .filter(({ path, source }) => path !== WRAPPER && /from 'next\/link'/.test(source))
      .map(({ path }) => path)
    expect(offenders).toEqual([])
  })

  it('and the wrapper is the one place that decides', () => {
    const source = readFileSync(join(ROOT, WRAPPER), 'utf8')
    expect(source).toMatch(/prefetch=\{false\}/)
    // Before the spread, so a screen that one day has something worth preparing can say so.
    expect(source.indexOf('prefetch={false}')).toBeLessThan(source.indexOf('{...props}'))
  })
})
