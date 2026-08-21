/**
 * Which columns does the product read and never write?
 *
 * This is the instrument that chooses the work, so being wrong here is more expensive than
 * being wrong anywhere else: it does not produce a bad answer, it produces a bad *question*,
 * eleven increments in a row. Every sharpening below was learned by it being wrong.
 *
 * The first version asked with a regular expression that looked for `column = $n` in a SET
 * clause. It missed `holiday_calendar = ${cond ? sql`holiday_calendar` : value}` — a
 * conditional SQL fragment — and so reported a control that had been settable since ADR 0039
 * as one nobody could set. This one takes the whole assignment list of every INSERT and UPDATE
 * against the table and asks whether the column's name appears in it, which cannot miss a
 * fragment.
 *
 *   - Write sites are grouped by *who* writes. A column written only by the seed is not a
 *     column the product can set: it is whatever the seed said, which is the exact failure
 *     this work keeps finding. Same for one written only by a test or by a loop script.
 *   - A column whose only value comes from its DEFAULT is reported as such, because "nobody
 *     chose this number" is the shape of ADRs 0044, 0046 and 0050.
 *
 * Two kinds of column are *supposed* to have no writer, and counting them as work is how a
 * detector cries wolf on a fifth of its own output. Neither is a list kept here — both are
 * read out of the database, because a hand-written exception list is the second place a fact
 * lives, and the two places drift (ADR 0059):
 *
 *   - **Stamped by the database.** A default that calls the clock — `now()`, `current_date`,
 *     `clock_timestamp()` — is a writer, and naming the column in application code would be
 *     the bug rather than the fix. That is right when the moment being recorded *is* the
 *     insert, and wrong when it is not, which is a judgement no detector can make; so they
 *     are listed apart with that said, rather than counted or hidden.
 *   - **Pinned by a constraint.** A CHECK that is nothing but `column = <literal>` conjunctions
 *     means the column can never hold anything else. §29.5's prohibited monitoring settings are
 *     five of these: covert monitoring, keystroke and screen capture, automated employment
 *     decisions, reading private messages, and scoring individuals. Having no writer is the
 *     guarantee working, not a feature waiting — so for these the detector inverts, and a
 *     *product* write is the alarm. It exits non-zero if it finds one, and CI runs it.
 *
 * Known blind spots, stated so the output is not read as more than it is:
 *   - Reads are matched on the bare column name, so a name used by several tables reports as
 *     read wherever any of them is read. Reads are the insensitive direction here.
 *   - A write built entirely out of interpolated identifiers would be missed.
 *   - Everything it reports is a *candidate*. It is evidence to go and read the code with.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { adminSql, closePools } from '@superwork/db'

/**
 * The repository, found from this file rather than written down.
 *
 * It was written down — as one developer's home directory — for eleven increments, because the
 * only thing that ever ran this was that developer. Wiring it into CI is what found it: the
 * checkout lives at `/home/runner/work/Superwork/Superwork`, `walk` was handed a path that does
 * not exist, and the step failed before it had read a single file. A detector that only works
 * on one machine is a detector nobody else can be held to.
 */
export const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

/** Columns the database or the base row shape owns; not controls anybody sets. */
const INFRASTRUCTURE = new Set([
  'id',
  'organization_id',
  'created_at',
  'updated_at',
  'created_by',
  'version',
  // Every tenant row carries these and no screen sets them: `is_demo` marks seeded rows and
  // `deleted_at` is the soft delete, written where a thing can actually be deleted.
  'is_demo',
  'deleted_at',
])

/**
 * A default that calls the clock. The database stamps the row and there is nothing for the
 * product to name — `now()`, and the spellings Postgres will hand back for the same idea.
 */
const CLOCK_DEFAULT =
  /^(now\(\)|current_timestamp|current_date|current_time|localtimestamp|localtime|clock_timestamp\(\)|statement_timestamp\(\)|transaction_timestamp\(\))/i

export function stampedByTheDatabase(columnDefault: string | null): boolean {
  return columnDefault !== null && CLOCK_DEFAULT.test(columnDefault.trim())
}

/**
 * The columns a CHECK pins to one value.
 *
 * Only a constraint that is *nothing but* `column = <literal>` joined by AND counts. That is
 * deliberately narrow: `CHECK ((status = 'failed') = (error IS NOT NULL))` also contains the
 * text `status = 'failed'` and pins nothing at all, and a detector that mistook the second for
 * the first would quietly stop asking about a column that is genuinely empty. Narrow and
 * occasionally silent beats wide and occasionally wrong, for an instrument that chooses work.
 */
export function pinnedColumns(constraintDefinition: string): string[] {
  const body = constraintDefinition.replace(/\s+NOT\s+VALID\s*$/i, '').trim()
  const inner = /^CHECK\s*\((.*)\)$/is.exec(body)?.[1]
  if (inner === undefined) return []
  const terms = stripOuterParens(inner).split(/\s+AND\s+/i)
  const pinned: string[] = []
  for (const term of terms) {
    const match = /^\(?\s*([a-z_][a-z0-9_]*)\s*=\s*(?:true|false|-?\d+(?:\.\d+)?|'[^']*'(?:::[\w ."]+)?)\s*\)?$/i.exec(
      term.trim(),
    )
    if (!match) return []
    pinned.push(match[1]!)
  }
  return pinned
}

/** `((a) AND (b))` → `(a) AND (b)`, one balanced layer at a time. */
function stripOuterParens(text: string): string {
  let value = text.trim()
  while (value.startsWith('(') && matchingParen(value, 0) === value.length - 1) {
    value = value.slice(1, -1).trim()
  }
  return value
}

type Group = 'product' | 'seed' | 'script' | 'test' | 'migration' | 'other'

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.git', '.next', 'dist', 'coverage', '.turbo'].includes(entry)) continue
    const path = join(dir, entry)
    const stats = statSync(path)
    if (stats.isDirectory()) walk(path, out)
    else if (/\.(ts|tsx|sql)$/.test(entry)) out.push(path)
  }
  return out
}

function groupOf(path: string): Group {
  const rel = relative(ROOT, path)
  if (rel.startsWith('packages/db/migrations/')) return 'migration'
  if (rel.startsWith('packages/db/src/seed/')) return 'seed'
  if (rel.startsWith('tests/')) return 'test'
  if (rel.startsWith('scripts/')) return 'script'
  if (rel.startsWith('packages/') || rel.startsWith('apps/')) return 'product'
  return 'other'
}

/**
 * The end of the statement that starts at `from`: the backtick that closes the template
 * literal, or a semicolon in a `.sql` file.
 *
 * The interpolations have to be stepped over rather than scanned through. A conditional
 * fragment — `${cond ? sql`column` : value}` — contains backticks of its own, and taking the
 * first of them as the end of the statement truncates every assignment after it. That is
 * precisely how the first version of this detector concluded that nothing writes
 * `departments.holiday_calendar`: the `timezone` fragment on the line above ended the
 * statement early. A detector with the bug it is looking for is worse than none.
 */
function statementEnd(text: string, from: number): number {
  let braces = 0
  for (let i = from; i < text.length; i++) {
    if (text[i] === '$' && text[i + 1] === '{') {
      braces += 1
      i += 1
    } else if (text[i] === '}' && braces > 0) {
      braces -= 1
    } else if (braces === 0 && (text[i] === '`' || text[i] === ';')) {
      return i
    }
  }
  return text.length
}

/** The index of `needle` at parenthesis depth zero, so a sub-select cannot truncate a clause. */
function indexAtDepthZero(text: string, needle: RegExp, from: number, to: number): number {
  let depth = 0
  for (let i = from; i < to; i++) {
    const ch = text[i]
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    else if (depth === 0) {
      needle.lastIndex = i
      const match = needle.exec(text)
      if (match && match.index === i) return i
    }
  }
  return -1
}

function matchingParen(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth += 1
    else if (text[i] === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * The columns a trigger body assigns: `NEW.column := …`, and nothing else.
 *
 * `:=` is plpgsql's assignment and `=` is its equality, so `IF NEW.parent_id = NEW.id` and
 * `WHEN (NEW.status = 'completed')` are reads. This scan is deliberately not attributed to a
 * table — a trigger body cannot be tied to one by text alone — which makes accepting a read
 * here far worse than coarse: one condition in one migration credits a write to that column
 * name on every table that has it. See the call site.
 */
export function triggerAssignments(body: string): string[] {
  return [...body.matchAll(/\bNEW\.([a-z_]+)\s*:=/gi)].map((match) => match[1]!)
}

/**
 * Every stretch of text in `body` that decides what a row of `table` will hold: the column
 * list of an INSERT, the assignment list of an UPDATE, and any ON CONFLICT DO UPDATE SET.
 */
function writeSegments(body: string, table: string): string[] {
  const segments: string[] = []

  const insertRe = new RegExp(`INSERT\\s+INTO\\s+(?:public\\.)?${table}\\b`, 'gi')
  for (const match of body.matchAll(insertRe)) {
    const from = match.index + match[0].length
    const end = statementEnd(body, from)
    const open = body.indexOf('(', from)
    if (open >= 0 && open < end) {
      const close = matchingParen(body, open)
      if (close > open) segments.push(body.slice(open, close + 1))
    }
    // `INSERT ... ON CONFLICT DO UPDATE SET x = ...` writes just as much as the list does.
    const conflict = body.slice(from, end).search(/DO\s+UPDATE\s+SET/i)
    if (conflict >= 0) segments.push(body.slice(from + conflict, end))
  }

  const updateRe = new RegExp(`UPDATE\\s+(?:public\\.)?${table}\\b`, 'gi')
  for (const match of body.matchAll(updateRe)) {
    const from = match.index + match[0].length
    const end = statementEnd(body, from)
    const set = indexAtDepthZero(body, /SET\b/gi, from, end)
    if (set < 0) continue
    const where = indexAtDepthZero(body, /WHERE\b/gi, set, end)
    const returning = indexAtDepthZero(body, /RETURNING\b/gi, set, end)
    const stop = Math.min(...[where, returning, end].filter((index) => index >= 0))
    segments.push(body.slice(set, stop))
  }

  return segments
}

async function main(): Promise<void> {
  const sql = adminSql()
  const columns = await sql<
    { table: string; column: string; nullable: string; columnDefault: string | null }[]
  >`
    SELECT c.table_name AS "table", c.column_name AS "column", c.is_nullable AS nullable,
           c.column_default AS "columnDefault"
    FROM information_schema.columns c
    JOIN pg_class pc ON pc.relname = c.table_name
    JOIN pg_namespace pn ON pn.oid = pc.relnamespace AND pn.nspname = 'public'
    WHERE c.table_schema = 'public' AND pc.relkind = 'r'
    ORDER BY c.table_name, c.ordinal_position`

  // Which columns a CHECK pins to one value, and which constraint does the pinning — the name
  // is what makes the report actionable rather than an assertion the reader has to trust.
  const constraints = await sql<{ table: string; name: string; definition: string }[]>`
    SELECT pc.relname AS "table", con.conname AS name, pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    JOIN pg_class pc ON pc.oid = con.conrelid
    JOIN pg_namespace pn ON pn.oid = pc.relnamespace AND pn.nspname = 'public'
    WHERE con.contype = 'c'`

  const pinnedBy = new Map<string, string>()
  for (const constraint of constraints) {
    for (const column of pinnedColumns(constraint.definition)) {
      pinnedBy.set(`${constraint.table}.${column}`, constraint.name)
    }
  }

  const tables = [...new Set(columns.map((row) => row.table))]

  const files = walk(ROOT).map((path) => ({
    path,
    group: groupOf(path),
    body: readFileSync(path, 'utf8'),
  }))

  // Per table, the write segments found in each group of files, and the whole product corpus
  // for the read test.
  const writesByTable = new Map<string, Map<Group, string>>()
  for (const table of tables) {
    const perGroup = new Map<Group, string>()
    for (const file of files) {
      // A table's name has to appear at all before the scan is worth doing.
      if (!file.body.includes(table)) continue
      const segments = writeSegments(file.body, table)
      if (segments.length === 0) continue
      perGroup.set(file.group, (perGroup.get(file.group) ?? '') + '\n' + segments.join('\n'))
    }
    // A trigger writes with `NEW.column := …`, which is not an INSERT or an UPDATE and was the
    // third way this detector managed to under-report writes: `document_chunks.tsv` is
    // maintained by `sw_document_chunks_tsv()` and looked untouched. Trigger bodies are not
    // attributable to one table by text alone, so every `NEW.x :=` in the migrations counts
    // for the column named x — coarse, and in the safe direction for a report about absence.
    //
    // `:=` and nothing else. This pattern used to accept `NEW.x =` as well, which is not an
    // assignment in plpgsql but is exactly how a trigger *reads* one: `IF NEW.parent_id =
    // NEW.id`, `WHEN (NEW.status = 'completed')`. Because the fallback is deliberately
    // unattributed to a table, one condition in one migration credited a write to that column
    // name on all 96 of them — `email_accounts.status` and `subscriptions.status` left the
    // queue the day migration 0059 added a WHEN clause about a task's status (ADR 0066). The
    // coarseness is the price of seeing trigger writes at all; accepting reads as well as
    // writes was not part of that bargain.
    for (const file of files) {
      if (file.group !== 'migration') continue
      const assignments = triggerAssignments(file.body)
      if (assignments.length === 0) continue
      perGroup.set(
        'migration',
        (perGroup.get('migration') ?? '') + '\n' + assignments.join(' '),
      )
    }
    writesByTable.set(table, perGroup)
  }
  for (const table of tables) {
    const perGroup = writesByTable.get(table)!
    writesByTable.set(table, perGroup)
  }

  const productCorpus = files
    .filter((file) => file.group === 'product')
    .map((file) => file.body)
    .join('\n')

  interface Finding {
    table: string
    column: string
    hasDefault: boolean
    writtenBy: Group[]
    readInProduct: boolean
  }
  const findings: Finding[] = []
  const stamped: Finding[] = []
  /** A pin a product write would defeat: reported whether or not anything writes it. */
  const pins: { key: string; constraint: string; writtenBy: Group[] }[] = []

  for (const row of columns) {
    const perGroup = writesByTable.get(row.table) ?? new Map<Group, string>()
    const word = new RegExp(`\\b${row.column}\\b`)
    const writtenBy = [...perGroup.entries()]
      .filter(([, text]) => word.test(text))
      .map(([group]) => group)

    const key = `${row.table}.${row.column}`
    const constraint = pinnedBy.get(key)
    if (constraint !== undefined) {
      pins.push({ key, constraint, writtenBy })
      continue
    }

    if (INFRASTRUCTURE.has(row.column)) continue

    // A column a trigger maintains *is* written, and deliberately so: when two places must
    // agree, the agreement is the database's (ADRs 0028, 0030, 0032, 0036, 0040, 0042, 0047).
    if (writtenBy.includes('product') || writtenBy.includes('migration')) continue

    const finding: Finding = {
      table: row.table,
      column: row.column,
      hasDefault: row.columnDefault !== null,
      writtenBy,
      readInProduct: word.test(productCorpus),
    }
    // Only when *nothing* writes it. A clock default on a column the seed also fills is still
    // a column whose value is whatever the seed said — `messages.sent_at` is when a message was
    // sent, which is not when the row was inserted, and hiding it behind its default would lose
    // exactly the signal this detector exists for.
    if (writtenBy.length === 0 && stampedByTheDatabase(row.columnDefault)) stamped.push(finding)
    else findings.push(finding)
  }

  const read = findings.filter((finding) => finding.readInProduct)
  const unread = findings.filter((finding) => !finding.readInProduct)

  console.log(`${columns.length} columns across ${tables.length} tables.`)
  console.log(
    `${findings.length} that no product write touches — ${read.length} of them read by the product.`,
  )
  console.log(
    `${stamped.length} more are stamped by the database and ${pins.length} are pinned by a constraint; both are listed below and neither is counted above.\n`,
  )

  console.log('READ BY THE PRODUCT, WRITTEN BY NOTHING IN IT')
  console.log('(the interface shows or enforces it; nothing in the product can set it)\n')
  let lastTable = ''
  for (const finding of read) {
    if (finding.table !== lastTable) {
      console.log(`  ${finding.table}`)
      lastTable = finding.table
    }
    const by = finding.writtenBy.length ? `written by: ${finding.writtenBy.join(', ')}` : 'written by nothing at all'
    console.log(`    ${finding.column.padEnd(28)} ${finding.hasDefault ? '[has default] ' : ''}${by}`)
  }

  console.log('\nNOT READ BY THE PRODUCT EITHER (dead, or waiting for its feature)\n')
  lastTable = ''
  for (const finding of unread) {
    if (finding.table !== lastTable) {
      console.log(`  ${finding.table}`)
      lastTable = finding.table
    }
    const by = finding.writtenBy.length ? `written by: ${finding.writtenBy.join(', ')}` : 'written by nothing at all'
    console.log(`    ${finding.column.padEnd(28)} ${finding.hasDefault ? '[has default] ' : ''}${by}`)
  }

  console.log('\nSTAMPED BY THE DATABASE (the default calls the clock, so there is nothing to set)')
  console.log('(right where the moment recorded is the insert; read one of these as work only')
  console.log(' if the moment it names could ever be a different one)\n')
  lastTable = ''
  for (const finding of stamped) {
    if (finding.table !== lastTable) {
      console.log(`  ${finding.table}`)
      lastTable = finding.table
    }
    console.log(`    ${finding.column.padEnd(28)} ${finding.readInProduct ? 'read by the product' : 'not read either'}`)
  }

  // The inversion. For these, a product write is the finding.
  console.log('\nPINNED BY A CONSTRAINT (can hold one value, so having no writer is the guarantee)\n')
  const defeated: string[] = []
  for (const pin of pins) {
    // A test may write a pinned column — that is how the refusal gets proved. Anything else
    // means the product has grown a code path that sets it, which the CHECK will refuse today
    // and which is a thing somebody built on purpose and should be asked about.
    const offenders = pin.writtenBy.filter((group) => group !== 'test' && group !== 'migration')
    if (offenders.length > 0) defeated.push(`${pin.key} — written by: ${offenders.join(', ')}`)
    const proved = pin.writtenBy.includes('test')
    console.log(
      `  ${pin.key.padEnd(56)} ${pin.constraint}${proved ? '' : '  — no test tries to defeat it'}`,
    )
  }

  if (defeated.length > 0) {
    console.log('\nA PIN THE PRODUCT NOW WRITES\n')
    for (const line of defeated) console.log(`  ${line}`)
    console.log(
      '\nThe constraint still refuses the value, so nothing is stored — but a code path that',
    )
    console.log('sets one of these was written on purpose and needs a person to look at it.')
  }

  await closePools()
  if (defeated.length > 0) process.exitCode = 1
}

// Importable, so the two parsers can be tested without a database.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
