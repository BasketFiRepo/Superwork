import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ANY_TABLE,
  pinnedColumns,
  readSites,
  ROOT,
  stampedByTheDatabase,
  triggerAssignments,
} from '../../scripts/column-coverage.js'

/**
 * The detector's two classifiers (ADR 0060).
 *
 * This instrument chooses what gets built, so being wrong in it does not produce a bad answer —
 * it produces a bad *question*, repeatedly. It has been wrong three times already: a regular
 * expression that could not see a conditional SQL fragment, a statement scanner that stopped at
 * the first backtick inside an interpolation, and a blind spot for columns a trigger maintains.
 * Each time the symptom was the same: a control that existed was reported as missing, or one
 * that was missing was not reported.
 *
 * These two are the newest and the most dangerous, because their failure mode is *silence* —
 * a column wrongly classified as stamped or pinned drops out of the queue and is never asked
 * about again. So they are tested against the shapes Postgres actually hands back.
 */

describe('the repository it reads', () => {
  it('is found from this file, not written down', () => {
    // It was written down, as one developer's home directory, for eleven increments — because
    // that developer's machine was the only thing that ever ran it. Putting the detector in CI
    // is what found it: the checkout is somewhere else, `walk` was handed a path that does not
    // exist, and the step failed before reading a single file.
    expect(existsSync(join(ROOT, 'package.json'))).toBe(true)
    expect(existsSync(join(ROOT, 'packages', 'db', 'migrations'))).toBe(true)
    expect(existsSync(join(ROOT, 'scripts', 'column-coverage.ts'))).toBe(true)
  })

  it('and the source names no absolute path at all', () => {
    // The behavioural check above passes on the machine where a hardcoded path happens to be
    // right, which is exactly the machine where nobody notices. This one is about the mechanism:
    // a string literal beginning with `/` is a path that will be wrong somewhere else.
    const source = readFileSync(join(ROOT, 'scripts', 'column-coverage.ts'), 'utf8')
    const literals = [...source.matchAll(/'(\/[A-Za-z0-9_./-]*)'/g)].map((match) => match[1])
    expect(literals).toEqual([])
  })
})

describe('a default that calls the clock', () => {
  it('is a writer, in every spelling Postgres returns', () => {
    for (const value of [
      'now()',
      'CURRENT_TIMESTAMP',
      'current_date',
      'LOCALTIMESTAMP',
      'clock_timestamp()',
      'statement_timestamp()',
      'transaction_timestamp()',
      '  now()  ',
    ]) {
      expect(stampedByTheDatabase(value), value).toBe(true)
    }
  })

  it('is not a constant, which is the shape of a column nobody chose a value for', () => {
    for (const value of [
      null,
      'false',
      '0.8',
      "'internal'::sw_sensitivity",
      "'{}'::text[]",
      'gen_random_uuid()',
      '1',
      // Named for a clock and not one: a column defaulting to somebody else's timestamp is
      // still a column no writer sets.
      'created_at',
    ]) {
      expect(stampedByTheDatabase(value), String(value)).toBe(false)
    }
  })
})

describe('a CHECK that pins a column to one value', () => {
  it('reads the §29.5 constraint exactly as Postgres prints it', () => {
    // Verbatim from `pg_get_constraintdef` for `monitoring_prohibited_by_design`.
    expect(
      pinnedColumns(
        'CHECK (((individual_scoring_enabled = false) AND (screen_or_keystroke_monitoring = false)' +
          ' AND (covert_monitoring = false) AND (automated_employment_decisions = false)' +
          ' AND (read_private_dms = false)))',
      ),
    ).toEqual([
      'individual_scoring_enabled',
      'screen_or_keystroke_monitoring',
      'covert_monitoring',
      'automated_employment_decisions',
      'read_private_dms',
    ])
  })

  it('reads a single pin, with or without the parentheses and NOT VALID', () => {
    expect(pinnedColumns('CHECK ((visible_to_subject = true))')).toEqual(['visible_to_subject'])
    expect(pinnedColumns('CHECK (tier = 1) NOT VALID')).toEqual(['tier'])
    expect(pinnedColumns("CHECK ((status = 'open'::text))")).toEqual(['status'])
  })

  it('pins nothing when the constraint allows more than one value', () => {
    // Every one of these mentions `column = literal` somewhere and pins nothing. Reading any of
    // them as a pin would quietly retire a column from the queue for good.
    for (const definition of [
      "CHECK ((jurisdiction_profile = ANY (ARRAY['gdpr'::text, 'strict'::text])))",
      'CHECK (((reply_sla_days >= 1) AND (reply_sla_days <= 90)))',
      "CHECK (((status = 'failed'::text) = (error IS NOT NULL)))",
      "CHECK (((status <> 'failed'::text) OR (error IS NOT NULL)))",
      'CHECK (sw_domain_list_ok(domains))',
      'CHECK (((health_status = 0) OR (health_status = 1)))',
      'FOREIGN KEY (organization_id) REFERENCES organizations(id)',
      'UNIQUE (organization_id, name)',
    ]) {
      expect(pinnedColumns(definition), definition).toEqual([])
    }
  })
})

describe('what a trigger body actually writes', () => {
  /**
   * The fourth way this detector under-reported, and the first that was self-inflicted: the
   * scan accepted `NEW.x =` as well as `NEW.x :=`. In plpgsql the first is equality, and
   * because this scan is deliberately not attributed to a table, one `WHEN (NEW.status =
   * 'completed')` in migration 0059 credited a write to `status` on all 96 tables —
   * `email_accounts.status` and `subscriptions.status` silently left the queue (ADR 0066).
   */
  it('counts an assignment', () => {
    expect(triggerAssignments('BEGIN NEW.updated_at := now(); RETURN NEW; END')).toEqual(['updated_at'])
    expect(triggerAssignments('NEW.path :=  btrim(NEW.name);')).toEqual(['path'])
  })

  it('does not count a condition that happens to name a column', () => {
    expect(triggerAssignments("FOR EACH ROW WHEN (NEW.status = 'completed')")).toEqual([])
    expect(triggerAssignments('IF NEW.parent_id = NEW.id THEN')).toEqual([])
    expect(triggerAssignments("IF NEW.sensitivity_source = 'human' THEN")).toEqual([])
  })

  it('and the migrations on disk assign nothing this test has not seen', () => {
    // The report the whole queue is built from: every `NEW.x :=` across the real migrations,
    // so a new trigger that assigns a column shows up here rather than only in the headline.
    const dir = join(ROOT, 'packages', 'db', 'migrations')
    const bodies = readdirSync(dir)
      .filter((name) => name.endsWith('.up.sql'))
      .map((name) => readFileSync(join(dir, name), 'utf8'))
    const assigned = new Set(bodies.flatMap((body) => triggerAssignments(body)))
    // These are writes no INSERT or UPDATE in the codebase performs, which is the entire
    // reason the fallback exists.
    expect(assigned.has('updated_at')).toBe(true)
    expect(assigned.has('tsv')).toBe(true)
    // And a column only ever named in a condition is not among them.
    expect(assigned.has('parent_id')).toBe(false)
  })
})

describe('which table a read belongs to', () => {
  /**
   * The fifth way this detector was wrong, and the one that cost the most: the read test was a
   * bare-name search over the whole product corpus. Twelve of seventy-three entries on the
   * queue were columns nothing reads — `citations.score`, `notifications.delivered_at`, and the
   * seven columns of `events`, a table the product never touches at all (ADR 0069).
   */
  const read = (body: string, table: string, column: string): boolean =>
    (readSites(body).get(table)?.has(column) ?? false) ||
    (readSites(body).get(ANY_TABLE)?.has(column) ?? false)

  it('follows the alias to the table it was declared for', () => {
    const body = 'const q = sql`SELECT n.delivered_at FROM nudges n WHERE n.id = ${id}`'
    expect(read(body, 'nudges', 'delivered_at')).toBe(true)
    expect(read(body, 'notifications', 'delivered_at')).toBe(false)
  })

  it('keeps a subquery’s reads inside the subquery', () => {
    // The shape in `reminderCount`: two counts added, one per table, in one statement.
    const body = [
      'const q = sql`SELECT (',
      "  (SELECT count(*) FROM nudges WHERE delivered_at IS NOT NULL)",
      '  +',
      "  (SELECT count(*) FROM notifications WHERE read_at IS NULL)",
      ')::int AS count`',
    ].join('\n')
    expect(read(body, 'nudges', 'delivered_at')).toBe(true)
    expect(read(body, 'notifications', 'delivered_at')).toBe(false)
    expect(read(body, 'notifications', 'read_at')).toBe(true)
  })

  it('does not lend one statement’s columns to another in the same file', () => {
    // The bug the first version of this fix reintroduced one level up, by analysing the file's
    // statements joined together rather than one at a time.
    const body = [
      'const a = sql`SELECT starts_on FROM projects`',
      'const b = sql`SELECT title FROM tasks`',
    ].join('\n')
    expect(read(body, 'projects', 'starts_on')).toBe(true)
    expect(read(body, 'tasks', 'starts_on')).toBe(false)
  })

  it('resolves a fragment written apart from the FROM it is spliced into', () => {
    const body = [
      'const SELECT_CONV = (ctx) => ctx.sql`SELECT conv.id FROM conversations conv`',
      'const list = sql`${SELECT_CONV(ctx)} AND conv.snoozed_until IS NULL`',
    ].join('\n')
    expect(read(body, 'conversations', 'snoozed_until')).toBe(true)
    expect(read(body, 'insights', 'snoozed_until')).toBe(false)
  })

  it('falls back to every table when the text cannot say, which is the old behaviour', () => {
    // A fragment with no FROM and no alias. Over-reporting here costs a candidate somebody
    // drops; guessing the other way costs work nobody ever sees again.
    const body = 'const frag = sql`WHERE snoozed_until IS NULL`'
    expect(readSites(body).get(ANY_TABLE)?.has('snoozed_until')).toBe(true)
    expect(read(body, 'insights', 'snoozed_until')).toBe(true)
  })

  it('does not read a property access in a component as a column', () => {
    const body = 'export function Row({ contact }) { return <span>{contact.name}</span> }'
    expect(readSites(body).size).toBe(0)
  })

  /**
   * The whole-body branch, and what it cost (ADR 0075).
   *
   * It exists so a `.sql` file — all statements, no backticks — is scanned at all. Its test was
   * `/\b(SELECT|INSERT INTO|UPDATE|CREATE TABLE)\b/i`, which matched the *word* "update" in any
   * file. A React component with a function called `update` and no SQL in it had its entire body
   * pushed as one statement; nothing in that body names a table, so every `x.y` in it landed on
   * `ANY_TABLE` and was lent to all ninety-six tables at once.
   *
   * That produced every one of the report's eight unplaceable readings. Three were taken for
   * build candidates and `document_versions.note` — a column nothing selects anywhere — was most
   * of the way to being built before a hand-patched copy of the script said which rows they were.
   */
  it('does not scan a whole component because it contains the word "update"', () => {
    const body = [
      'export function Row({ contact, onUpdate }) {',
      '  async function update() { await fetch("/api/x", { method: "POST" }) }',
      '  return <span>{contact.title}</span>',
      '}',
    ].join('\n')
    expect(readSites(body).size).toBe(0)
  })

  it('but still reads a .sql file, which is what that branch is for', () => {
    const body = 'UPDATE contacts SET last_interaction_at = now() WHERE next_step_at IS NULL;'
    expect(readSites(body, true).size).toBeGreaterThan(0)
  })

  it('and a column named in a comment is prose, not a read', () => {
    // On the real file, because a synthetic one did not reproduce it: this test passed with and
    // without the fix until it was pointed at `inbox.ts` itself, and a test that agrees with you
    // either way is worse than none.
    //
    // `-- the same argument the relationship view makes about a restricted contract's title` is
    // the last unplaceable reading the report had after the `.sql` fix above, and it put
    // `memberships.title` on the work list.
    const path = join(ROOT, 'packages', 'core', 'src', 'repositories', 'inbox.ts')
    const body = readFileSync(path, 'utf8')
    // The test is only worth anything while the comment is still there to be misread.
    expect(/--[^\n]*\btitle\b/.test(body)).toBe(true)
    expect(readSites(body).get(ANY_TABLE)?.has('title')).toBeFalsy()
    // And the statement around it still reads what it actually reads.
    expect(readSites(body).get('conversations')?.has('snoozed_until')).toBe(true)
  })

  it('and taking one out does not lose the read on the other side of it', () => {
    // A block comment sitting between the FROM and the WHERE. This does not discriminate between
    // blanking a comment and deleting it — neither does anything else, which is why the note
    // beside `withoutComments` calls the blanking caution rather than a requirement.
    const body = [
      'const q = sql`',
      '  SELECT t.id FROM tasks t /* a long block comment about starts_on */ WHERE t.starts_on IS NULL`',
    ].join('\n')
    expect(read(body, 'tasks', 'starts_on')).toBe(true)
  })

  it('and on the real thing, nothing reads the events table', () => {
    // `events` was designed in migration 0005 and wired to nothing; `activities` and
    // `audit_logs` do its job. Seven of its columns sat on the queue because their names are
    // `name`, `payload`, `entity_id`.
    const files = [
      join(ROOT, 'packages', 'core', 'src', 'reminders.ts'),
      join(ROOT, 'packages', 'core', 'src', 'audit.ts'),
    ]
    for (const file of files) {
      expect(readSites(readFileSync(file, 'utf8')).has('events')).toBe(false)
    }
  })
})
