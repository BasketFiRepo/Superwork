import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pinnedColumns, ROOT, stampedByTheDatabase } from '../../scripts/column-coverage.js'

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
