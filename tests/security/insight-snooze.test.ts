import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  MAX_SNOOZE_DAYS,
  recordInsightFeedback,
  snoozeInsight,
  sweepSnoozedInsights,
  unsnoozeInsight,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * An insight you can put off, and one you can finish (ADR 0083).
 *
 * `insights.snoozed_until` has existed since migration 0006 and nothing has ever written it,
 * `'snoozed'` had no control, and nothing would have brought one back if it did. Meanwhile
 * `'resolved'` was in `FeedbackInput`'s union and on no button — so the only way to close an
 * insight the watcher got *right* was to dismiss it, and dismissal is a verdict on the watcher:
 * it feeds `watcherQuality` and can auto-mute one.
 *
 * The rule this file exists to hold: **a snooze that never ends is a dismissal that lies about
 * itself**, and the lie runs in the direction that damages the watcher.
 */

const TZ = 'Europe/London'
const DAY = 86_400_000
let org: TenantFixture
let owner: { organizationId: string; userId: string; timezone: string }
let viewer: { organizationId: string; userId: string; timezone: string }

async function anInsight(dedupe: string): Promise<string> {
  const [row] = await adminSql()<{ id: string }[]>`
    INSERT INTO insights (organization_id, watcher, type, severity, title, body,
                          evidence, recommended_actions, dedupe_key, is_demo, created_by)
    VALUES (${org.organizationId}, 'stale_thread', 'stale', 'medium',
            'Halden has not replied in nine days', 'The last message was outbound.',
            ${adminSql().json([{ claim: 'Last outbound 9 days ago' }])},
            ${adminSql().json([{ label: 'Draft a chase', tool: 'draft_email@v1', args: {} }])},
            ${dedupe}, true, ${org.ownerId})
    RETURNING id`
  return row!.id
}

const statusOf = async (id: string): Promise<{ status: string; until: Date | null; by: string | null }> => {
  const [row] = await adminSql()<{ status: string; until: Date | null; by: string | null }[]>`
    SELECT status, snoozed_until AS until, snoozed_by AS by FROM insights WHERE id = ${id}`
  return row!
}

beforeAll(async () => {
  org = await createTenant('insight-snooze')
  owner = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  viewer = { organizationId: org.organizationId, userId: org.viewerId, timezone: TZ }
})

afterAll(async () => {
  await destroyTenant('insight-snooze')
  await closePools()
})

describe('putting one off', () => {
  it('records when it comes back and who said so', async () => {
    const id = await anInsight('snooze-1')
    await withTenant(owner, async (ctx) =>
      snoozeInsight(ctx, await loadActor(ctx), { insightId: id, until: new Date(Date.now() + 7 * DAY) }),
    )
    const row = await statusOf(id)
    expect(row.status).toBe('snoozed')
    expect(row.until).toBeInstanceOf(Date)
    expect(row.by).toBe(org.ownerId)
  })

  it('and a viewer cannot, because it takes the card off everybody’s screen', async () => {
    const id = await anInsight('snooze-2')
    await expect(
      withTenant(viewer, async (ctx) =>
        snoozeInsight(ctx, await loadActor(ctx), { insightId: id, until: new Date(Date.now() + DAY) }),
      ),
    ).rejects.toThrow()
  })

  it('and never across a tenant boundary', async () => {
    const id = await anInsight('snooze-3')
    const other = await createTenant('insight-snooze-b')
    try {
      await expect(
        withTenant(
          { organizationId: other.organizationId, userId: other.ownerId, timezone: TZ },
          async (ctx) =>
            snoozeInsight(ctx, await loadActor(ctx), { insightId: id, until: new Date(Date.now() + DAY) }),
        ),
      ).rejects.toThrow(/not found/i)
    } finally {
      await destroyTenant('insight-snooze-b')
    }
  })

  it('and not work somebody has already started', async () => {
    const id = await anInsight('snooze-4')
    await withTenant(owner, async (ctx) =>
      recordInsightFeedback(ctx, await loadActor(ctx), { insightId: id, helpful: true, status: 'in_progress' }),
    )
    await expect(
      withTenant(owner, async (ctx) =>
        snoozeInsight(ctx, await loadActor(ctx), { insightId: id, until: new Date(Date.now() + DAY) }),
      ),
    ).rejects.toThrow(/nobody has started/i)
  })

  it('and not for longer than a month, because that is a dismissal wearing a date', async () => {
    const id = await anInsight('snooze-5')
    await expect(
      withTenant(owner, async (ctx) =>
        snoozeInsight(ctx, await loadActor(ctx), {
          insightId: id,
          until: new Date(Date.now() + (MAX_SNOOZE_DAYS + 1) * DAY),
        }),
      ),
    ).rejects.toThrow(new RegExp(`${MAX_SNOOZE_DAYS} days`))
  })

  it('and not until a moment that has already gone', async () => {
    const id = await anInsight('snooze-6')
    await expect(
      withTenant(owner, async (ctx) =>
        snoozeInsight(ctx, await loadActor(ctx), { insightId: id, until: new Date(Date.now() - DAY) }),
      ),
    ).rejects.toThrow(/future/i)
  })
})

describe('what the database will not let come apart', () => {
  it('a status that says snoozed with no date is refused', async () => {
    const id = await anInsight('snooze-7')
    await expect(
      adminSql()`UPDATE insights SET status = 'snoozed' WHERE id = ${id}`,
    ).rejects.toThrow(/snooze_has_an_end/i)
  })

  it('and a date on one that is not snoozed is refused too', async () => {
    const id = await anInsight('snooze-8')
    await expect(
      adminSql()`
        UPDATE insights SET snoozed_until = now() + interval '1 day', snoozed_by = ${org.ownerId}
        WHERE id = ${id}`,
    ).rejects.toThrow(/snooze_has_an_end/i)
  })

  it('and a snooze with nobody behind it is refused', async () => {
    const id = await anInsight('snooze-9')
    await expect(
      adminSql()`
        UPDATE insights SET status = 'snoozed', snoozed_until = now() + interval '1 day'
        WHERE id = ${id}`,
    ).rejects.toThrow(/snooze_attributed/i)
  })

  it('and a date already past is refused whatever asks', async () => {
    const id = await anInsight('snooze-10')
    await expect(
      adminSql()`
        UPDATE insights SET status = 'snoozed', snoozed_until = now() - interval '1 hour',
                            snoozed_by = ${org.ownerId}
        WHERE id = ${id}`,
    ).rejects.toThrow(/has already passed/i)
  })

  it('and the name on it has to be somebody here', async () => {
    const id = await anInsight('snooze-11')
    const other = await createTenant('insight-snooze-c')
    try {
      await expect(
        adminSql()`
          UPDATE insights SET status = 'snoozed', snoozed_until = now() + interval '1 day',
                              snoozed_by = ${other.ownerId}
          WHERE id = ${id}`,
      ).rejects.toThrow(/active member of this organization/i)
    } finally {
      await destroyTenant('insight-snooze-c')
    }
  })
})

describe('bringing it back', () => {
  it('a snooze that is up returns to acknowledged, not to new', async () => {
    /**
     * Somebody saw this one and decided when to look again. Sending it back to `new` would say
     * nobody had ever read it — the sort of small lie a badge count is built on.
     */
    const id = await anInsight('snooze-12')
    await withTenant(owner, async (ctx) =>
      snoozeInsight(ctx, await loadActor(ctx), { insightId: id, until: new Date(Date.now() + DAY) }),
    )
    const sweep = await withTenant(owner, async (ctx) =>
      sweepSnoozedInsights(ctx, { now: new Date(Date.now() + 2 * DAY) }),
    )
    expect(sweep.returned).toBeGreaterThan(0)
    const row = await statusOf(id)
    expect(row.status).toBe('acknowledged')
    expect(row.until).toBeNull()
  })

  it('and one that is not up yet stays where it is', async () => {
    const id = await anInsight('snooze-13')
    await withTenant(owner, async (ctx) =>
      snoozeInsight(ctx, await loadActor(ctx), { insightId: id, until: new Date(Date.now() + 7 * DAY) }),
    )
    await withTenant(owner, async (ctx) => sweepSnoozedInsights(ctx, { now: new Date() }))
    expect((await statusOf(id)).status).toBe('snoozed')
  })

  it('and whoever put it off is told, because coming back silently is a dismissal', async () => {
    const id = await anInsight('snooze-14')
    await withTenant(owner, async (ctx) =>
      snoozeInsight(ctx, await loadActor(ctx), { insightId: id, until: new Date(Date.now() + DAY) }),
    )
    await withTenant(owner, async (ctx) =>
      sweepSnoozedInsights(ctx, { now: new Date(Date.now() + 2 * DAY) }),
    )
    const [note] = await adminSql()<{ id: string }[]>`
      SELECT id FROM notifications
      WHERE organization_id = ${org.organizationId} AND entity_type = 'insight' AND entity_id = ${id}
        AND type = 'insight_returned'`
    expect(note).toBeTruthy()
  })

  it('and somebody can bring one back before its date', async () => {
    /**
     * The other half, and it was missing from the first draft. The browser check's second run
     * found it: the beat put the demo's only insight off and the next run had nothing to act on,
     * because the watchers dedupe against the one that is still sitting there.
     */
    const id = await anInsight('snooze-16')
    await withTenant(owner, async (ctx) =>
      snoozeInsight(ctx, await loadActor(ctx), { insightId: id, until: new Date(Date.now() + 20 * DAY) }),
    )
    await withTenant(owner, async (ctx) => unsnoozeInsight(ctx, await loadActor(ctx), id))
    const row = await statusOf(id)
    expect(row.status).toBe('acknowledged')
    expect(row.until).toBeNull()
  })

  it('and a viewer cannot bring one back either', async () => {
    const id = await anInsight('snooze-17')
    await withTenant(owner, async (ctx) =>
      snoozeInsight(ctx, await loadActor(ctx), { insightId: id, until: new Date(Date.now() + DAY) }),
    )
    await expect(
      withTenant(viewer, async (ctx) => unsnoozeInsight(ctx, await loadActor(ctx), id)),
    ).rejects.toThrow()
  })

  it('and one that was never put off cannot be brought back', async () => {
    const id = await anInsight('snooze-18')
    await expect(
      withTenant(owner, async (ctx) => unsnoozeInsight(ctx, await loadActor(ctx), id)),
    ).rejects.toThrow(/has not been put off/i)
  })

  it('and the sweep is idempotent — running it twice returns nothing the second time', async () => {
    const id = await anInsight('snooze-15')
    await withTenant(owner, async (ctx) =>
      snoozeInsight(ctx, await loadActor(ctx), { insightId: id, until: new Date(Date.now() + DAY) }),
    )
    const later = new Date(Date.now() + 2 * DAY)
    const first = await withTenant(owner, async (ctx) => sweepSnoozedInsights(ctx, { now: later }))
    const second = await withTenant(owner, async (ctx) => sweepSnoozedInsights(ctx, { now: later }))
    expect(first.returned).toBeGreaterThan(0)
    expect(second.returned).toBe(0)
  })
})

describe('finishing one the watcher got right', () => {
  it('resolving closes it without saying anything against the watcher', async () => {
    const id = await anInsight('resolve-1')
    await withTenant(owner, async (ctx) =>
      recordInsightFeedback(ctx, await loadActor(ctx), { insightId: id, helpful: true, status: 'resolved' }),
    )
    const [row] = await adminSql()<{ status: string; resolved_at: Date | null }[]>`
      SELECT status, resolved_at FROM insights WHERE id = ${id}`
    expect(row!.status).toBe('resolved')
    expect(row!.resolved_at).toBeInstanceOf(Date)

    const [feedback] = await adminSql()<{ helpful: boolean }[]>`
      SELECT helpful FROM insight_feedback WHERE insight_id = ${id}`
    expect(feedback!.helpful).toBe(true)
  })

  it('and the card offers it, which is the whole point', async () => {
    /**
     * Before this, the only control that closed an insight was Dismiss — a verdict on the
     * watcher. Asserted against the component rather than a comment, because "there is a button"
     * is exactly the kind of claim that rots.
     */
    const card = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../apps/web/src/components/InsightCard.tsx', import.meta.url), 'utf8'),
    )
    expect(card).toMatch(/data-testid="insight-resolve"/)
    expect(card).toMatch(/status: 'resolved'/)
  })
})

describe('the number that went', () => {
  it('an insight no longer carries a confidence nothing set', async () => {
    const [column] = await adminSql()<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'insights' AND column_name = 'confidence'`
    expect(column).toBeUndefined()
  })

  it('and the measured answer is still there, which is why it went', async () => {
    // `watcherQuality` reads what people did with a watcher's output. A self-reported score
    // beside a measured one is the same fact kept twice.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../packages/core/src/insight-quality.ts', import.meta.url), 'utf8'),
    )
    expect(source).toMatch(/export async function watcherQuality/)
  })
})
