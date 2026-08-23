/**
 * Which permissions does the ladder grant that nothing ever checks?
 *
 * The column detector asks what live code reads that nothing writes. This asks the same
 * question one layer up, and it exists because that layer turned out to be worse.
 *
 * ADR 0079 is why. `audit:read:org` had been in the administrator's grant list since the ladder
 * was built, and nothing in the product had ever called `can(actor, 'audit:read', …)`. That was
 * not merely a feature nobody had written. Because the check had never run, nobody had ever seen
 * its answer — and its answer was wrong: a manager's `*:read:org` matched it, so every manager
 * could read the whole organization's audit trail while the grant list implied only an
 * administrator could. The control read correctly in the ladder, in the role documentation and
 * in every review of either, for the entire build.
 *
 * **A permission that is never checked is never wrong.** It is also never right. It is a
 * sentence in a list, and this is the instrument that finds the sentences.
 *
 * ## What counts as granted
 *
 * Only grants that name **both** halves. `task:complete:own` is a claim about a specific verb on
 * a specific resource, and a claim is a thing that can go unchecked. `task:*:department` and
 * `*:read:org` are not claims about any one verb — they are a shape, and asking whether "the
 * wildcard" is checked has no answer. Narrow and occasionally silent, for the same reason the
 * column detector's CHECK parser is: an instrument that chooses work must not invent it.
 *
 * The consequence is worth stating plainly, because it is this detector's largest blind spot:
 * **a wildcard cannot be reported as unchecked, and a wildcard is what caused ADR 0079's
 * defect.** What this would have caught is the *other* half of that finding — `audit:read:org`
 * named, never checked — which is the thread that led to the wildcard. That is the honest claim:
 * it finds the loose end, not the knot.
 *
 * ## What counts as checked
 *
 * The first version of this file asserted, in a comment, that every `can()` call in the
 * repository passes a string literal. Running it found fourteen that do not, and had it skipped
 * them it would have reported `workflow:simulate` and four others as unchecked while the check
 * sat two lines away in a ternary. That is the failure mode this whole family of instruments
 * exists to avoid, arriving in the instrument itself on its first run.
 *
 * So the scan reads four shapes, and reports what it could not:
 *
 *   1. **A literal** — `can(actor, 'task:read', …)`. Exact.
 *   2. **A ternary of two literals** — `entity === 'task' ? 'task:read' : 'conversation:read'`.
 *      Both count, exactly.
 *   3. **A template with a literal resource** — `` `knowledge:${action}` ``. The resource is
 *      known and the verb is not, so every permission on that resource is *possibly* checked.
 *      Reported apart rather than counted, because "somewhere in this file a knowledge verb is
 *      checked" is not the same claim as "this one is".
 *   4. **A bare identifier**, where the resource is still legible from the `type:` of the
 *      resource argument beside it. Same treatment as 3.
 *
 * What is left after that is a call where neither half can be read — the agent tool gate, which
 * builds the action out of a tool's declared permissions. That is named loudly at the bottom,
 * because it is the one place this instrument is blind by construction.
 *
 * ## Both directions
 *
 * A check for something no role grants is the mirror failure and just as real: a feature that is
 * refused for everybody, permanently, which is the shape of a screen nobody can reach. So it
 * reports that too.
 *
 * Everything here is a candidate. It is evidence to go and read the code with.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { NEVER_BY_WILDCARD, parsePermission, ROLE_PERMISSIONS } from '@superwork/auth'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.git', '.next', 'dist', 'coverage', '.turbo'].includes(entry)) continue
    const path = join(dir, entry)
    const stats = statSync(path)
    if (stats.isDirectory()) walk(path, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path)
  }
  return out
}

/**
 * Comments blanked, length preserved.
 *
 * The first run reported `knowledge_space:read` as checked in `sharing.ts`. It is not: the only
 * occurrence there is inside a comment *explaining that the bug it describes was fixed* — the
 * detector read the ADR note about a defect and recorded it as the defect's absence. The column
 * detector learned the same lesson and has its own stripper; this is not shared with it because
 * that one blanks SQL's `--` to end of line, which in TypeScript would eat everything after a
 * decrement.
 *
 * `://` is left alone so a URL in a string does not swallow the rest of its line.
 */
export function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix: string) => prefix + ' '.repeat(match.length - prefix.length))
}

/** Where a check found in this file counts from. Tests do not grant a permission a purpose. */
function isProduct(path: string): boolean {
  const rel = relative(ROOT, path)
  return (rel.startsWith('packages/') || rel.startsWith('apps/')) && !rel.startsWith('tests/')
}

// ---------------------------------------------------------------------------------------------
// What the ladder grants

interface Grant {
  /** `task:complete` — both halves named. */
  action: string
  roles: string[]
  scopes: Set<string>
}

const granted = new Map<string, Grant>()
/** Roles in ladder order where possible, so the report reads bottom-up like the ladder does. */
for (const [role, list] of Object.entries(ROLE_PERMISSIONS)) {
  for (const raw of list) {
    let parsed
    try {
      parsed = parsePermission(raw)
    } catch {
      continue
    }
    if (parsed.resource === '*' || parsed.action === '*') continue
    const action = `${parsed.resource}:${parsed.action}`
    const existing = granted.get(action)
    if (existing) {
      if (!existing.roles.includes(role)) existing.roles.push(role)
      existing.scopes.add(parsed.scope)
    } else {
      granted.set(action, { action, roles: [role], scopes: new Set([parsed.scope]) })
    }
  }
}

// ---------------------------------------------------------------------------------------------
// What the product checks

/** `resource:verb` → the files that check it, exactly. */
const checked = new Map<string, Set<string>>()
/** `resource` → the files that check *some* verb on it, computed. */
const computedVerb = new Map<string, Set<string>>()
/** Calls where neither half can be read. */
const unreadable: string[] = []

const note = (map: Map<string, Set<string>>, key: string, rel: string): void => {
  const where = map.get(key) ?? new Set<string>()
  where.add(rel)
  map.set(key, where)
}

/**
 * The extent of the `can(` call starting at `open`, and the offset of its first top-level comma.
 *
 * The actor argument can be a call of its own — `can(await loadActor(ctx), 'task:read', …)` —
 * so the comma cannot simply be the first one found; depth is tracked instead.
 */
function callShape(source: string, open: number): { comma: number; close: number } | null {
  let index = open
  let depth = 1
  let comma = -1
  while (index < source.length && depth > 0) {
    const char = source[index]
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') depth -= 1
    else if (char === ',' && depth === 1 && comma === -1) comma = index
    if (depth === 0) return comma === -1 ? null : { comma, close: index }
    index += 1
  }
  return null
}

function scanChecks(source: string, path: string): void {
  if (!isProduct(path)) return
  const rel = relative(ROOT, path)
  // `function can(actor, action, …)` is the declaration, not a call of it.
  for (const match of source.matchAll(/(?<!function\s)\bcan\s*\(/g)) {
    const shape = callShape(source, match.index + match[0].length)
    if (!shape) continue
    const args = source.slice(shape.comma + 1, shape.close)
    const action = args.trimStart()

    // 1 & 2 — every literal in the action expression, which covers a bare literal and a ternary
    // of two of them with the same code. A ternary is two answers, not an unreadable one.
    const upToNextArg = action.slice(0, Math.max(0, findTopLevelComma(action)))
    const literals = [...upToNextArg.matchAll(/'([a-z_]+:[a-z_]+)'/g)].map((m) => m[1]!)
    if (literals.length > 0) {
      for (const literal of literals) note(checked, literal, rel)
      continue
    }

    // 3 — a template whose resource half is written out: `knowledge:${verb}`.
    const templated = /^`([a-z_]+):\$\{/.exec(upToNextArg)
    if (templated) {
      note(computedVerb, templated[1]!, rel)
      continue
    }

    // 4 — an opaque action, with the resource still legible from the resource argument beside it.
    const resourceType = /\btype:\s*'([a-z_]+)'/.exec(args)
    if (resourceType && !/^`/.test(upToNextArg)) {
      note(computedVerb, resourceType[1]!, rel)
      continue
    }

    unreadable.push(`${rel} — ${action.slice(0, 46).replace(/\s+/g, ' ')}`)
  }
}

/** The end of the action argument: the first comma not nested inside anything. */
function findTopLevelComma(text: string): number {
  let depth = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') depth -= 1
    else if (char === ',' && depth === 0) return index
  }
  return text.length
}

/**
 * The second place a permission is named, and it took a false positive to notice it.
 *
 * `email:draft` was reported as granted-but-unchecked. It is checked — by every agent tool that
 * declares `requiredPermissions: ['email:draft:org']`, which the registry and the gate both turn
 * into a `can()` call. Both build the action out of the array, so the text scan sees a template
 * and not the permission.
 *
 * A declaration that becomes a check is a check. But only the **first** element becomes one:
 * `requiredPermissions[0]` is what both call sites read, and everything after it is silently
 * dropped. So only the first is recorded as covering a permission, and a tool that declares more
 * than one is reported — because a plural field whose tail is ignored is a claim the product does
 * not honour, which is the same defect this instrument is for.
 */
const toolTail: string[] = []
function scanToolDeclarations(source: string, path: string): void {
  if (!isProduct(path)) return
  const rel = relative(ROOT, path)
  for (const match of withoutComments(source).matchAll(/requiredPermissions:\s*\[([^\]]*)\]/g)) {
    const listed = [...match[1]!.matchAll(/'([a-z_]+):([a-z_]+):[a-z]+'/g)]
    if (listed.length === 0) continue
    note(checked, `${listed[0]![1]}:${listed[0]![2]}`, rel)
    if (listed.length > 1) {
      toolTail.push(`${rel} — declares ${listed.length}, only ${listed[0]![1]}:${listed[0]![2]} is ever checked`)
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The report

function main(): void {
  for (const path of [...walk(join(ROOT, 'packages')), ...walk(join(ROOT, 'apps'))]) {
    const source = readFileSync(path, 'utf8')
    scanChecks(withoutComments(source), path)
    scanToolDeclarations(source, path)
  }

  const resourceOf = (action: string): string => action.split(':')[0]!

  const outstanding = [...granted.values()]
    .filter((grant) => !checked.has(grant.action))
    .sort((a, b) => a.action.localeCompare(b.action))

  /** Nothing names it, but something on its resource checks a verb the detector cannot read. */
  const maybe = outstanding.filter((grant) => computedVerb.has(resourceOf(grant.action)))
  const unchecked = outstanding.filter((grant) => !computedVerb.has(resourceOf(grant.action)))

  const ungranted = [...checked.keys()]
    .filter((action) => !granted.has(action))
    .sort()

  console.log(
    `\n${granted.size} permissions named in full by the ladder; ${checked.size} distinct actions checked by name in product code.\n`,
  )

  const describe = (grant: Grant): string =>
    `  ${grant.action.padEnd(28)} ${[...grant.scopes].sort().join(', ').padEnd(22)} granted to: ${grant.roles.join(', ')}`

  console.log('GRANTED BY NAME, CHECKED BY NOTHING')
  console.log('(the role list says who may do this; no code has ever asked)\n')
  if (unchecked.length === 0) console.log('  (none)')
  for (const grant of unchecked) console.log(describe(grant))

  if (maybe.length > 0) {
    console.log('\nTHE DETECTOR COULD NOT TELL (a verb on this resource is checked, computed)')
    console.log('(so this may be work or may be nothing — open the file named beside it and see')
    console.log(' which verbs that call can actually receive, before building anything)\n')
    for (const grant of maybe) {
      const where = [...computedVerb.get(resourceOf(grant.action))!].sort().slice(0, 2).join(', ')
      console.log(`${describe(grant)}\n      ${where}`)
    }
  }

  console.log('\nCHECKED, GRANTED TO NOBODY BY NAME')
  console.log('(refused for everyone unless a wildcard covers it — read the wildcard and be sure)\n')
  if (ungranted.length === 0) console.log('  (none)')
  for (const action of ungranted) {
    const [resource] = action.split(':')
    const wildcardReaches = !NEVER_BY_WILDCARD.has(resource!)
    console.log(
      `  ${action.padEnd(28)} ${wildcardReaches ? 'a wildcard may reach it' : 'NO WILDCARD REACHES THIS — nobody can do it'}` +
        `  · ${[...checked.get(action)!].sort().slice(0, 2).join(', ')}`,
    )
  }

  if (unreadable.length > 0) {
    console.log('\nNEITHER HALF LEGIBLE')
    console.log('(the action and its resource are both computed — this instrument is blind here)\n')
    for (const line of unreadable) console.log(`  ${line}`)
  }

  if (toolTail.length > 0) {
    console.log('\nA TOOL THAT DECLARES MORE PERMISSIONS THAN ARE CHECKED')
    console.log('(the gate and the registry both read requiredPermissions[0] and drop the rest)\n')
    for (const line of toolTail) console.log(`  ${line}`)
  }

  console.log()

  /**
   * Always zero.
   *
   * An unchecked permission is work to schedule, not a broken build — the same stance the column
   * detector takes on its queue. The blind spots are printed rather than failed on for the reason
   * ADR 0058 gives about hydration recoveries: a number somebody reads every run is a better guard
   * than a red build somebody learns to re-run.
   */
  process.exitCode = 0
}

// Importable, so the comment stripper can be tested without walking the repository.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
