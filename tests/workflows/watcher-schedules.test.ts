import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePools, withTenant } from '@superwork/db'
import { claimDueSchedules, describeCron, listSchedules, scheduleForKey, ValidationError } from '@superwork/core'
import {
  ensureWatcherSchedules,
  runDueWatchers,
  setWatcherSchedule,
  watcherSchedules,
  WATCHERS,
} from '@superwork/agent'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Watchers on their declared cadence (§9.1).
 *
 * Every watcher has always carried a `cadence` and nothing read it. The properties worth
 * asserting are that the declaration is now the behaviour, that a re-timing survives the
 * next sweep rather than being reset from the source, that a muted watcher keeps its row
 * and says so, and that a watcher not due does not run.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }

beforeAll(async () => {
  org = await createTenant('watchsched')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
})

afterAll(async () => {
  await destroyTenant('watchsched')
  await closePools()
})

describe('the cadence in the source is the schedule', () => {
  it('gives every watcher a row from what it declares', async () => {
    const created = await withTenant(session, (ctx) => ensureWatcherSchedules(ctx))
    expect(created).toBe(WATCHERS.length)

    const rows = await withTenant(session, (ctx) => listSchedules(ctx, 'watcher'))
    expect(rows).toHaveLength(WATCHERS.length)
    for (const watcher of WATCHERS) {
      const row = rows.find((entry) => entry.targetKey === watcher.key)
      expect(row?.cron).toBe(watcher.cadence)
      expect(row?.timezone).toBe('Europe/London')
      expect(row?.enabled).toBe(true)
      // A missed read is not worth replaying: the next firing sees the same world.
      expect(row?.catchUpPolicy).toBe('skip_missed')
    }
  })

  it('is idempotent — a second call creates nothing', async () => {
    expect(await withTenant(session, (ctx) => ensureWatcherSchedules(ctx))).toBe(0)
  })

  it('keeps the different cadences different', async () => {
    const rows = await withTenant(session, (ctx) => watcherSchedules(ctx))
    const approvals = rows.find((row) => row.key === 'approval_aging')!
    const knowledge = rows.find((row) => row.key === 'knowledge_gap')!
    expect(approvals.cron).toBe('0 */4 * * *')
    expect(approvals.description).toBe('every day, every 4 hours on the hour Europe/London')
    expect(knowledge.cron).toBe('0 9 * * 1')
    expect(describeCron(knowledge.cron, 'UTC')).toBe('every Monday at 09:00 UTC')
    expect(approvals.nextRunAt!.getTime()).toBeLessThan(knowledge.nextRunAt!.getTime())
  })
})

describe('re-timing one', () => {
  it('accepts an alias and is not reset by the next sweep', async () => {
    const changed = await withTenant(session, (ctx) =>
      setWatcherSchedule(ctx, { key: 'silent_customer', cron: '@daily' }),
    )
    expect(changed?.cron).toBe('0 0 * * *')

    // ensureWatcherSchedules runs on every sweep; the declared cadence is a default, not
    // an override, so an admin's decision must survive it.
    await withTenant(session, (ctx) => ensureWatcherSchedules(ctx))
    const after = await withTenant(session, (ctx) => scheduleForKey(ctx, 'watcher', 'silent_customer'))
    expect(after?.cron).toBe('0 0 * * *')

    const view = (await withTenant(session, (ctx) => watcherSchedules(ctx))).find(
      (row) => row.key === 'silent_customer',
    )!
    // The screen can say it was changed, because it knows what the source declares.
    expect(view.declaredCron).toBe('0 9 * * 1')
    expect(view.cron).not.toBe(view.declaredCron)
  })

  it('refuses a cadence it cannot honour', async () => {
    await expect(
      withTenant(session, (ctx) => setWatcherSchedule(ctx, { key: 'silent_customer', cron: '@reboot' })),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses a watcher that does not exist', async () => {
    await expect(
      withTenant(session, (ctx) => setWatcherSchedule(ctx, { key: 'not_a_watcher', cron: '@daily' })),
    ).rejects.toThrow(/no watcher named/i)
  })

  it('stops and starts one without forgetting it', async () => {
    await withTenant(session, (ctx) => setWatcherSchedule(ctx, { key: 'knowledge_gap', enabled: false }))
    expect((await withTenant(session, (ctx) => scheduleForKey(ctx, 'watcher', 'knowledge_gap')))?.enabled).toBe(false)

    await withTenant(session, (ctx) => setWatcherSchedule(ctx, { key: 'knowledge_gap', enabled: true }))
    const back = await withTenant(session, (ctx) => scheduleForKey(ctx, 'watcher', 'knowledge_gap'))
    expect(back?.enabled).toBe(true)
    expect(back?.cron).toBe('0 9 * * 1')
  })
})

describe('the sweep', () => {
  it('runs only what is due, not everything', async () => {
    await withTenant(session, (ctx) => ensureWatcherSchedules(ctx))
    // Nothing has come due since the rows were created a moment ago.
    const quiet = await runDueWatchers(session)
    expect(quiet.claimed).toBe(0)
    expect(quiet.ran).toEqual([])

    await withTenant(session, async (ctx) => {
      await ctx.sql`
        UPDATE schedules SET next_run_at = now() - interval '1 minute'
        WHERE organization_id = ${ctx.organizationId} AND kind = 'watcher' AND target_key = 'overdue_slipping'`
    })

    const sweep = await runDueWatchers(session)
    expect(sweep.claimed).toBe(1)
    expect(sweep.ran).toEqual(['overdue_slipping'])
  })

  it('advances the schedule, so the same watcher does not run twice', async () => {
    await withTenant(session, async (ctx) => {
      await ctx.sql`
        UPDATE schedules SET next_run_at = now() - interval '1 minute'
        WHERE organization_id = ${ctx.organizationId} AND kind = 'watcher' AND target_key = 'stale_thread'`
    })
    const first = await runDueWatchers(session)
    expect(first.ran).toContain('stale_thread')

    const second = await runDueWatchers(session)
    expect(second.ran).not.toContain('stale_thread')
  })

  it('does not run a watcher that has been stopped', async () => {
    await withTenant(session, (ctx) => setWatcherSchedule(ctx, { key: 'commitment_tracker', enabled: false }))
    await withTenant(session, async (ctx) => {
      await ctx.sql`
        UPDATE schedules SET next_run_at = now() - interval '1 minute'
        WHERE organization_id = ${ctx.organizationId} AND kind = 'watcher' AND target_key = 'commitment_tracker'`
    })
    const sweep = await runDueWatchers(session)
    expect(sweep.ran).not.toContain('commitment_tracker')
  })

  it('keeps a muted watcher on the clock, and says why it did not run', async () => {
    // Twenty insights, eighteen dismissed: past the 70% auto-mute threshold (§9.2).
    await withTenant(session, async (ctx) => {
      for (let index = 0; index < 20; index += 1) {
        await ctx.sql`
          INSERT INTO insights (
            organization_id, watcher, type, severity, title, body, evidence, entities,
            recommended_actions, dedupe_key, status, created_by
          ) VALUES (
            ${ctx.organizationId}, 'silent_customer', 'account_gone_quiet', 'low',
            ${`noise ${index}`}, 'body', '[{"claim":"x","sourceType":"company"}]'::jsonb, '[]'::jsonb,
            '[{"label":"Look","tool":"navigate","args":{}}]'::jsonb, ${`mute-${index}-${Date.now()}`},
            ${index < 18 ? 'dismissed' : 'new'}, ${org.ownerId}
          )`
      }
      await ctx.sql`
        UPDATE schedules SET next_run_at = now() - interval '1 minute', enabled = true
        WHERE organization_id = ${ctx.organizationId} AND kind = 'watcher' AND target_key = 'silent_customer'`
    })

    const sweep = await runDueWatchers(session)
    expect(sweep.ran).not.toContain('silent_customer')
    expect(sweep.skipped.some((note) => /silent_customer: muted/i.test(note))).toBe(true)

    // Muting is a statement about noise, not an instruction to forget the watcher.
    const row = await withTenant(session, (ctx) => scheduleForKey(ctx, 'watcher', 'silent_customer'))
    expect(row?.enabled).toBe(true)
    expect(row?.nextRunAt?.getTime()).toBeGreaterThan(Date.now())
  })

  it('reports a late firing rather than replaying a lost night of reads', async () => {
    await withTenant(session, async (ctx) => {
      await ctx.sql`
        UPDATE schedules SET next_run_at = now() - interval '2 days'
        WHERE organization_id = ${ctx.organizationId} AND kind = 'watcher' AND target_key = 'approval_aging'`
    })
    const claimed = (await withTenant(session, (ctx) => claimDueSchedules(ctx, 'watcher'))).find(
      (entry) => entry.targetKey === 'approval_aging',
    )
    expect(claimed?.runs).toBe(0)
    expect(claimed?.skippedReason).toMatch(/skip missed/i)
  })
})
