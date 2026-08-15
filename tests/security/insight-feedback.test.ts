import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  NotFoundError,
  PermissionError,
  recordInsightFeedback,
  ValidationError,
  watcherQuality,
  mutedWatcherReasons,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * What people think of what the watchers found (§9.2).
 *
 * `insight_feedback` has been written since Phase 3 and read by nothing, under a comment on
 * the route saying *"Dismissal reasons tune future thresholds per organization and per
 * user"*. Nothing tuned. The card asks why an insight was dismissed and the answer went
 * nowhere — worse than not asking, because being asked implies it matters.
 *
 * The decision under test: **a watcher that is right and unwelcome is not the same as a
 * watcher that is wrong.** Muting on raw dismissal treats "you were wrong" and "you were
 * right and I had already dealt with it" identically, which switches off something that
 * works.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let guestSession: { organizationId: string; userId: string; timezone: string }
let guestId: string

async function makeInsight(watcher: string, key: string, assignedTo: string | null): Promise<string> {
  return withTenant(session, async (ctx) => {
    const [row] = await ctx.sql<{ id: string }[]>`
      INSERT INTO insights (
        organization_id, watcher, type, severity, title, body, evidence, entities,
        recommended_actions, dedupe_key, assigned_to, created_by
      ) VALUES (
        ${ctx.organizationId}, ${watcher}, 'test', 'medium', ${`insight ${key}`}, 'body',
        '[{"claim":"x","sourceType":"company"}]'::jsonb, '[]'::jsonb,
        '[{"label":"Look","tool":"navigate","args":{}}]'::jsonb, ${key}, ${assignedTo}, ${org.ownerId}
      ) RETURNING id`
    return row!.id
  })
}

/** A rater per vote: one vote per person per insight is the point of the unique index. */
async function rater(index: number): Promise<string> {
  const email = `rater${index}.insight-feedback@fixture.example`
  const [user] = await adminSql()<{ id: string }[]>`
    INSERT INTO users (email, name, timezone, is_demo)
    VALUES (${email}, ${`Rater ${index}`}, 'Europe/London', true)
    ON CONFLICT (lower(email)) WHERE deleted_at IS NULL DO UPDATE SET name = users.name
    RETURNING id`
  await adminSql()`
    INSERT INTO memberships (organization_id, user_id, role, is_demo)
    VALUES (${org.organizationId}, ${user!.id}, 'member', true)
    ON CONFLICT DO NOTHING`
  return user!.id
}

beforeAll(async () => {
  org = await createTenant('insight-feedback')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }

  await adminSql()`DELETE FROM users WHERE lower(email) = 'guest.insight-feedback@fixture.example'`
  const [user] = await adminSql()<{ id: string }[]>`
    INSERT INTO users (email, name, timezone, is_demo)
    VALUES ('guest.insight-feedback@fixture.example', 'Guest Feedback', 'Europe/London', true) RETURNING id`
  guestId = user!.id
  await adminSql()`
    INSERT INTO memberships (organization_id, user_id, role, is_demo)
    VALUES (${org.organizationId}, ${guestId}, 'guest', true)`
  guestSession = { organizationId: org.organizationId, userId: guestId, timezone: 'Europe/London' }
})

afterAll(async () => {
  await destroyTenant('insight-feedback')
  await adminSql()`DELETE FROM users WHERE id = ${guestId}`
  await closePools()
})

describe('who may rate, and who may dismiss', () => {
  it('refuses somebody with no insight permission at all', async () => {
    // The route took an actor and never used it: a `guest`, who holds no insight permission
    // whatsoever, could rate any insight and dismiss it for the whole organization.
    const id = await makeInsight('silent_customer', 'guest-check', org.ownerId)
    await expect(
      withTenant(guestSession, async (ctx) =>
        recordInsightFeedback(ctx, await loadActor(ctx), { insightId: id, helpful: false, reason: 'wrong' }),
      ),
    ).rejects.toThrow(PermissionError)
  })

  it('lets somebody rate what they were shown without letting them dismiss it for everybody', async () => {
    // Two permissions, deliberately. A rating is a comment on something you were shown;
    // dismissing takes it off everybody's screen. A viewer holds `insight:read:own` and no
    // update at all, which is exactly that shape.
    const id = await makeInsight('silent_customer', 'split-permission', org.viewerId)
    const viewerSession = { organizationId: org.organizationId, userId: org.viewerId, timezone: 'Europe/London' }

    await withTenant(viewerSession, async (ctx) =>
      recordInsightFeedback(ctx, await loadActor(ctx), { insightId: id, helpful: true }),
    )

    await expect(
      withTenant(viewerSession, async (ctx) =>
        recordInsightFeedback(ctx, await loadActor(ctx), {
          insightId: id,
          helpful: false,
          reason: 'wrong',
          status: 'dismissed',
        }),
      ),
    ).rejects.toThrow(/off everybody/i)

    // The refusal leaves nothing behind: the earlier rating stands, the refused one is not
    // half-applied, and the insight has not moved.
    const [row] = await adminSql()<{ helpful: boolean }[]>`
      SELECT helpful FROM insight_feedback WHERE insight_id = ${id} AND user_id = ${org.viewerId}`
    expect(row?.helpful).toBe(true)
    const [insight] = await adminSql()<{ status: string }[]>`SELECT status FROM insights WHERE id = ${id}`
    expect(insight?.status).not.toBe('dismissed')
  })

  it('will not accept "not helpful" with nothing said about why', async () => {
    const id = await makeInsight('silent_customer', 'no-reason', org.ownerId)
    await expect(
      withTenant(session, async (ctx) =>
        recordInsightFeedback(ctx, await loadActor(ctx), { insightId: id, helpful: false }),
      ),
    ).rejects.toThrow(ValidationError)
  })

  it('reports absence for an insight that is not there', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        recordInsightFeedback(ctx, await loadActor(ctx), {
          insightId: '00000000-0000-0000-0000-000000000000',
          helpful: true,
        }),
      ),
    ).rejects.toThrow(NotFoundError)
  })

  it('counts one vote per person, however many times they press it', async () => {
    const id = await makeInsight('silent_customer', 'one-vote', org.ownerId)
    for (const helpful of [true, false, false]) {
      await withTenant(session, async (ctx) =>
        recordInsightFeedback(ctx, await loadActor(ctx), {
          insightId: id,
          helpful,
          reason: helpful ? null : 'wrong',
        }),
      )
    }
    const [row] = await adminSql()<{ count: number; helpful: boolean }[]>`
      SELECT count(*)::int, bool_and(helpful) AS helpful FROM insight_feedback WHERE insight_id = ${id}`
    // Once feedback decides whether a watcher runs, unlimited votes is one person muting it.
    expect(row?.count).toBe(1)
    expect(row?.helpful).toBe(false)
  })
})

describe('a watcher that is right and unwelcome is not one that is wrong', () => {
  it('does not mute a watcher everybody says they had already handled', async () => {
    // The old rule counted dismissals and muted at 70%. Every one of these is the watcher
    // being *correct* — it found a real thing somebody had got to first.
    for (let index = 0; index < 22; index += 1) {
      // Routed to the person who rates it: a member holds `insight:read:own`, which is the
      // real shape — you rate what was put in front of you.
      const who = await rater(index)
      const id = await makeInsight('commitment_tracker', `handled-${index}`, who)
      await withTenant({ ...session, userId: who }, async (ctx) =>
        recordInsightFeedback(ctx, await loadActor(ctx), {
          insightId: id,
          helpful: false,
          reason: 'already_handled',
        }),
      )
      await adminSql()`UPDATE insights SET status = 'dismissed' WHERE id = ${id}`
    }

    const quality = await withTenant(session, async (ctx) => watcherQuality(ctx))
    const tracker = quality.find((row) => row.watcher === 'commitment_tracker')
    expect(tracker?.alreadyHandled).toBe(22)
    expect(tracker?.verdict).toBe('late')
    expect(tracker?.reason).toMatch(/run it earlier rather than switching it off/i)

    const muted = await withTenant(session, async (ctx) => mutedWatcherReasons(ctx))
    expect([...muted.keys()]).not.toContain('commitment_tracker')
  })

  it('mutes one people say is wrong, and says so in full', async () => {
    for (let index = 0; index < 22; index += 1) {
      const who = await rater(100 + index)
      const id = await makeInsight('meeting_followup', `wrong-${index}`, who)
      await withTenant({ ...session, userId: who }, async (ctx) =>
        recordInsightFeedback(ctx, await loadActor(ctx), {
          insightId: id,
          helpful: false,
          reason: index < 18 ? 'wrong' : 'not_useful',
        }),
      )
    }

    const muted = await withTenant(session, async (ctx) => mutedWatcherReasons(ctx))
    expect([...muted.keys()]).toContain('meeting_followup')
    // A watcher being switched off has to be explainable.
    expect(muted.get('meeting_followup')).toMatch(/wrong or not worth surfacing/i)
  })

  it('calls out one that is right and reaching the wrong people', async () => {
    for (let index = 0; index < 22; index += 1) {
      const who = await rater(200 + index)
      const id = await makeInsight('stalled_deal', `routing-${index}`, who)
      await withTenant({ ...session, userId: who }, async (ctx) =>
        recordInsightFeedback(ctx, await loadActor(ctx), {
          insightId: id,
          helpful: false,
          reason: 'not_my_job',
        }),
      )
    }
    const quality = await withTenant(session, async (ctx) => watcherQuality(ctx))
    const stalled = quality.find((row) => row.watcher === 'stalled_deal')
    expect(stalled?.verdict).toBe('misrouted')
    expect(stalled?.reason).toMatch(/reaching the wrong people/i)
  })

  it('says so plainly when too few people have rated it', async () => {
    for (let index = 0; index < 3; index += 1) {
      const who = await rater(300 + index)
      const id = await makeInsight('overdue_cluster', `thin-${index}`, who)
      await withTenant({ ...session, userId: who }, async (ctx) =>
        recordInsightFeedback(ctx, await loadActor(ctx), { insightId: id, helpful: false, reason: 'wrong' }),
      )
    }
    const quality = await withTenant(session, async (ctx) => watcherQuality(ctx))
    const thin = quality.find((row) => row.watcher === 'overdue_cluster')
    // Three votes at 100% "wrong" is not a rate, it is three people.
    expect(thin?.verdict).toBe('quiet')
    expect(thin?.reason).toMatch(/guess with a percentage sign/i)
  })

  it('still mutes one thrown away repeatedly with nothing said', async () => {
    // The rule this replaced read exactly this signal. It is kept as the fallback rather
    // than dropped: removing a control while replacing it is how a refinement becomes a
    // regression.
    for (let index = 0; index < 22; index += 1) {
      const id = await makeInsight('silent_customer', `silent-${index}`, org.ownerId)
      if (index < 20) await adminSql()`UPDATE insights SET status = 'dismissed' WHERE id = ${id}`
    }
    const muted = await withTenant(session, async (ctx) => mutedWatcherReasons(ctx))
    expect([...muted.keys()]).toContain('silent_customer')
    expect(muted.get('silent_customer')).toMatch(/no reason given/i)
  })
})

describe('feedback belongs to one organization', () => {
  it('does not read another tenant’s ratings', async () => {
    const other = await createTenant('insight-feedback-other')
    const theirs = await withTenant(
      { organizationId: other.organizationId, userId: other.ownerId, timezone: 'Europe/London' },
      async (ctx) => watcherQuality(ctx),
    )
    expect(theirs).toHaveLength(0)
    await destroyTenant('insight-feedback-other')
  })
})
