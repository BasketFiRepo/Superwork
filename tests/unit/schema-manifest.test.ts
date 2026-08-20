import { describe, expect, it } from 'vitest'
import { comparePending, listMigrations, MIGRATIONS, migrationId } from '@superwork/db'

/**
 * The list of migrations this build was compiled against (ADR 0062).
 *
 * The application cannot read the migrations directory at runtime — a serverless bundle contains
 * the code the tracer found, not a directory of SQL files nothing imports — so the list is a
 * constant. A constant is a second place a fact lives, and two places drift, which is how the
 * outage this exists to prevent happened in the first place. This is the thing that makes the
 * drift a red build instead of a surprise: add a migration without a line in the manifest and it
 * fails here, naming the file.
 */

describe('the migration manifest', () => {
  it('is exactly the migrations directory, in order', async () => {
    const onDisk = (await listMigrations()).map((migration) => migration.name).sort()
    expect([...MIGRATIONS]).toEqual(onDisk)
  })

  it('is sorted, because the difference is what gets shown to somebody', () => {
    expect([...MIGRATIONS]).toEqual([...MIGRATIONS].sort())
  })

  it('reads an id off a name the way the ledger stores it', () => {
    expect(migrationId('0055_a_database_that_says_where_it_is')).toBe('0055')
    expect(migrationId('0001_foundation')).toBe('0001')
    // A name with no underscore is its own id rather than an exception to handle elsewhere.
    expect(migrationId('nounderscore')).toBe('nounderscore')
  })
})

describe('comparing what is applied against what is expected', () => {
  it('finds nothing pending when the database has everything', () => {
    expect(comparePending(MIGRATIONS.map(migrationId))).toEqual([])
  })

  it('names every migration the database is missing, not just the newest', () => {
    // The failure that started this was a database missing 0047 *and* 0051: the first screen to
    // fail named one of them, and the log said nothing about the other.
    const applied = MIGRATIONS.map(migrationId).filter((id) => id !== '0047' && id !== '0051')
    const pending = comparePending(applied)
    expect(pending).toHaveLength(2)
    expect(pending.map(migrationId)).toEqual(['0047', '0051'])
  })

  it('treats an empty database as every migration pending', () => {
    expect(comparePending([])).toEqual([...MIGRATIONS])
  })

  it('is not confused by a database that is ahead of this build', () => {
    // A rollback of the *application* leaves a database with migrations this build has never
    // heard of. That is not this page's problem, and reporting it as pending would be a lie.
    expect(comparePending([...MIGRATIONS.map(migrationId), '9999'])).toEqual([])
  })
})
