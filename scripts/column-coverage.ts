/**
 * Which columns does the product read and never write?
 *
 * The previous version of this question was asked with a regular expression that looked for
 * `column = $n` in a SET clause. It missed `holiday_calendar = ${cond ? sql`holiday_calendar`
 * : value}` — a conditional SQL fragment — and so reported a control that had been settable
 * since ADR 0039 as one nobody could set. This one takes the whole assignment list of every
 * INSERT and UPDATE against the table and asks whether the column's name appears in it, which
 * cannot miss a fragment.
 *
 * Two other sharpenings, both learned from being wrong:
 *
 *   - Write sites are grouped by *who* writes. A column written only by the seed is not a
 *     column the product can set: it is whatever the seed said, which is the exact failure
 *     this work keeps finding. Same for one written only by a test or by a loop script.
 *   - A column whose only value comes from its DEFAULT is reported as such, because "nobody
 *     chose this number" is the shape of ADRs 0044, 0046 and 0050.
 *
 * Known blind spots, stated so the output is not read as more than it is:
 *   - Reads are matched on the bare column name, so a name used by several tables reports as
 *     read wherever any of them is read. Reads are the insensitive direction here.
 *   - A write built entirely out of interpolated identifiers would be missed.
 *   - Everything it reports is a *candidate*. It is evidence to go and read the code with.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { adminSql, closePools } from '@superwork/db'

const ROOT = '/home/user/Superwork'

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
    { table: string; column: string; nullable: string; hasDefault: boolean }[]
  >`
    SELECT c.table_name AS "table", c.column_name AS "column", c.is_nullable AS nullable,
           (c.column_default IS NOT NULL) AS "hasDefault"
    FROM information_schema.columns c
    JOIN pg_class pc ON pc.relname = c.table_name
    JOIN pg_namespace pn ON pn.oid = pc.relnamespace AND pn.nspname = 'public'
    WHERE c.table_schema = 'public' AND pc.relkind = 'r'
    ORDER BY c.table_name, c.ordinal_position`

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
    for (const file of files) {
      if (file.group !== 'migration') continue
      const assignments = [...file.body.matchAll(/\bNEW\.([a-z_]+)\s*:?=/gi)].map((m) => m[1])
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

  const findings: {
    table: string
    column: string
    hasDefault: boolean
    writtenBy: Group[]
    readInProduct: boolean
  }[] = []

  for (const row of columns) {
    if (INFRASTRUCTURE.has(row.column)) continue
    const perGroup = writesByTable.get(row.table) ?? new Map<Group, string>()
    const word = new RegExp(`\\b${row.column}\\b`)
    const writtenBy = [...perGroup.entries()]
      .filter(([, text]) => word.test(text))
      .map(([group]) => group)

    // A column a trigger maintains *is* written, and deliberately so: when two places must
    // agree, the agreement is the database's (ADRs 0028, 0030, 0032, 0036, 0040, 0042, 0047).
    if (writtenBy.includes('product') || writtenBy.includes('migration')) continue

    findings.push({
      table: row.table,
      column: row.column,
      hasDefault: row.hasDefault,
      writtenBy,
      readInProduct: word.test(productCorpus),
    })
  }

  const read = findings.filter((finding) => finding.readInProduct)
  const unread = findings.filter((finding) => !finding.readInProduct)

  console.log(`${columns.length} columns across ${tables.length} tables.`)
  console.log(
    `${findings.length} that no product write touches — ${read.length} of them read by the product.\n`,
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

  await closePools()
}

await main()
