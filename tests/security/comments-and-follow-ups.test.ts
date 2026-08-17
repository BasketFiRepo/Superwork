import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  addTaskComment,
  createFollowUp,
  createTask,
  deleteTaskComment,
  listFollowUps,
  listNotifications,
  NotFoundError,
  PermissionError,
  resolveFollowUp,
  sweepFollowUps,
  taskComments,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, makeReachable, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Two things the agent wrote that nobody could read (§12.1, §13).
 *
 * `task_comments` is written by `comment_on_task@v1` — "attributed to the agent by name.
 * Never post as if a person wrote it" — and read by nothing, so those notes were invisible
 * and no person could add one. `follow_ups` is written by `create_follow_up@v1`, which
 * promises the follow-up "resurfaces if no reply arrives", and read by nothing: every one
 * the agent ever recorded is still open.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let memberSession: { organizationId: string; userId: string; timezone: string }
let taskId: string
let conversationId: string

beforeAll(async () => {
  org = await createTenant('comments-follow-ups')
  // These packs assert that something arrives, which now depends on the recipient not being
  // in their own quiet hours (ADR 0047). Say so rather than depending on the hour.
  for (const userId of [org.ownerId, org.memberId, org.viewerId]) {
    await makeReachable(org.organizationId, userId)
  }
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
  memberSession = { organizationId: org.organizationId, userId: org.memberId, timezone: 'Europe/London' }

  await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const task = await createTask(ctx, actor, { title: 'Chase the signed addendum', assigneeId: org.memberId })
    taskId = task.id

    const [conversation] = await ctx.sql<{ id: string }[]>`
      INSERT INTO conversations (
        organization_id, subject, channel, status, last_direction, last_message_at, is_demo, created_by
      ) VALUES (
        ${ctx.organizationId}, 'Renewal terms', 'email', 'open', 'outbound', now() - interval '5 days',
        true, ${org.ownerId}
      ) RETURNING id`
    conversationId = conversation!.id
  })
})

afterAll(async () => {
  await destroyTenant('comments-follow-ups')
  await closePools()
})

describe('what the agent said on a task, and what people say back', () => {
  it('shows the comment the agent left, marked as the agent’s', async () => {
    // The tool has been writing these since Phase 0 into a table nothing read.
    await adminSql()`
      INSERT INTO task_comments (organization_id, task_id, body, actor_type, is_demo, created_by)
      VALUES (${org.organizationId}, ${taskId}, 'Their last reply promised it by Friday.', 'agent', true, ${org.ownerId})`

    const comments = await withTenant(session, async (ctx) => taskComments(ctx, await loadActor(ctx), taskId))
    expect(comments).toHaveLength(1)
    expect(comments[0]?.byAgent).toBe(true)
    expect(comments[0]?.body).toMatch(/by Friday/)
  })

  it('lets a person add one, which nothing could do before', async () => {
    const after = await withTenant(memberSession, async (ctx) =>
      addTaskComment(ctx, await loadActor(ctx), { taskId, body: 'I have asked them twice.' }),
    )
    expect(after.some((row) => row.body === 'I have asked them twice.' && !row.byAgent)).toBe(true)
  })

  it('refuses an empty comment', async () => {
    await expect(
      withTenant(memberSession, async (ctx) =>
        addTaskComment(ctx, await loadActor(ctx), { taskId, body: '   ' }),
      ),
    ).rejects.toThrow(ValidationError)
  })

  it('tells the person who was mentioned, on their own reminders', async () => {
    // The `mentions` array has been on the row since the first migration and was never
    // populated, so naming somebody did nothing at all.
    await withTenant(session, async (ctx) =>
      addTaskComment(ctx, await loadActor(ctx), {
        taskId,
        body: 'Can you pick this up while I am away?',
        mentions: [org.memberId],
      }),
    )
    const theirs = await withTenant(memberSession, async (ctx) =>
      listNotifications(ctx, await loadActor(ctx)),
    )
    const mention = theirs.find((row) => row.type === 'mention')
    expect(mention?.title).toMatch(/mentioned you/i)
    expect(mention?.url).toBe(`/tasks/${taskId}`)
  })

  it('will not let a comment mention somebody outside the organization', async () => {
    const other = await createTenant('comments-follow-ups-other')
    await expect(
      withTenant(session, async (ctx) =>
        addTaskComment(ctx, await loadActor(ctx), {
          taskId,
          body: 'Hello over there.',
          mentions: [other.ownerId],
        }),
      ),
    ).rejects.toThrow(/only mention people in this organization/i)

    // And the database refuses it even when the check above is bypassed.
    await expect(
      adminSql()`
        INSERT INTO task_comments (organization_id, task_id, body, actor_type, mentions, is_demo, created_by)
        VALUES (${org.organizationId}, ${taskId}, 'Direct', 'user', ARRAY[${other.ownerId}]::uuid[], true, ${org.ownerId})`,
    ).rejects.toThrow(/same organization/i)

    await destroyTenant('comments-follow-ups-other')
  })

  it('lets you take back your own words and nobody else’s', async () => {
    const mine = await withTenant(memberSession, async (ctx) =>
      addTaskComment(ctx, await loadActor(ctx), { taskId, body: 'Ignore that, wrong task.' }),
    )
    const target = mine.find((row) => row.body === 'Ignore that, wrong task.')!
    expect(target.canDelete).toBe(true)

    const after = await withTenant(memberSession, async (ctx) =>
      deleteTaskComment(ctx, await loadActor(ctx), { taskId, commentId: target.id }),
    )
    expect(after.some((row) => row.id === target.id)).toBe(false)

    // The owner's comment is not the member's to remove — the member holds `task:update:own`
    // and this task is assigned to them, so this is the case that decides it.
    const asOwner = await withTenant(session, async (ctx) =>
      addTaskComment(ctx, await loadActor(ctx), { taskId, body: 'Leave this one up.' }),
    )
    const theirs = asOwner.find((row) => row.body === 'Leave this one up.')!
    const seenByViewer = await withTenant(
      { organizationId: org.organizationId, userId: org.viewerId, timezone: 'Europe/London' },
      async (ctx) => taskComments(ctx, await loadActor(ctx), taskId),
    )
    expect(seenByViewer.find((row) => row.id === theirs.id)?.canDelete).toBe(false)
    await expect(
      withTenant(
        { organizationId: org.organizationId, userId: org.viewerId, timezone: 'Europe/London' },
        async (ctx) => deleteTaskComment(ctx, await loadActor(ctx), { taskId, commentId: theirs.id }),
      ),
    ).rejects.toThrow(PermissionError)
  })

  it('reports absence for a comment on another task', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        deleteTaskComment(ctx, await loadActor(ctx), {
          taskId,
          commentId: '00000000-0000-0000-0000-000000000000',
        }),
      ),
    ).rejects.toThrow(NotFoundError)
  })
})

describe('a follow-up that actually resurfaces', () => {
  it('is visible on the thread at last', async () => {
    await withTenant(session, async (ctx) =>
      createFollowUp(ctx, await loadActor(ctx), {
        conversationId,
        dueAt: new Date(Date.now() - 86_400_000),
        reason: 'Chase the signed addendum.',
      }),
    )
    const open = await withTenant(session, async (ctx) =>
      listFollowUps(ctx, await loadActor(ctx), { conversationId }),
    )
    expect(open).toHaveLength(1)
    expect(open[0]?.due).toBe(true)
  })

  it('will not be recorded without saying what it is for', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        createFollowUp(ctx, await loadActor(ctx), {
          conversationId,
          dueAt: new Date(),
          reason: 'x',
        }),
      ),
    ).rejects.toThrow(ValidationError)
  })

  it('will not be recorded about nothing at all', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        createFollowUp(ctx, await loadActor(ctx), { dueAt: new Date(), reason: 'Something vague.' }),
      ),
    ).rejects.toThrow(/a thread, an account or a task/i)
  })

  it('keeps one open follow-up per thread rather than two people chasing', async () => {
    await withTenant(session, async (ctx) =>
      createFollowUp(ctx, await loadActor(ctx), {
        conversationId,
        dueAt: new Date(Date.now() - 3_600_000),
        reason: 'Chase it again, sooner.',
      }),
    )
    const open = await withTenant(session, async (ctx) =>
      listFollowUps(ctx, await loadActor(ctx), { conversationId }),
    )
    expect(open).toHaveLength(1)
    expect(open[0]?.reason).toBe('Chase it again, sooner.')
  })

  it('tells its owner when it comes due, once', async () => {
    const first = await withTenant(session, async (ctx) => sweepFollowUps(ctx))
    expect(first.surfaced).toBe(1)

    const mine = await withTenant(session, async (ctx) => listNotifications(ctx, await loadActor(ctx)))
    const surfaced = mine.find((row) => row.type === 'follow_up')
    expect(surfaced?.body).toMatch(/Chase it again/)
    expect(surfaced?.url).toBe(`/inbox/${conversationId}`)

    // Every tick would otherwise tell them again.
    const second = await withTenant(session, async (ctx) => sweepFollowUps(ctx))
    expect(second.surfaced).toBe(0)
  })

  it('closes itself when the customer writes back', async () => {
    // "It resurfaces if no reply arrives" is the tool's own promise. Chasing somebody about
    // a thread that has already been answered is how people learn to ignore a product.
    await adminSql()`
      UPDATE conversations SET last_direction = 'inbound', last_message_at = now()
      WHERE id = ${conversationId}`
    const sweep = await withTenant(session, async (ctx) => sweepFollowUps(ctx))
    expect(sweep.closedByReply).toBe(1)

    const all = await withTenant(session, async (ctx) =>
      listFollowUps(ctx, await loadActor(ctx), { conversationId, openOnly: false }),
    )
    expect(all[0]?.status).toBe('cancelled')
    expect(all[0]?.resolution).toBe('replied')
  })

  it('records who dealt with one, and what they said about it', async () => {
    await adminSql()`
      UPDATE conversations SET last_direction = 'outbound', last_message_at = now() - interval '9 days'
      WHERE id = ${conversationId}`
    const made = await withTenant(session, async (ctx) =>
      createFollowUp(ctx, await loadActor(ctx), {
        conversationId,
        dueAt: new Date(Date.now() + 86_400_000),
        reason: 'Check the addendum landed.',
      }),
    )
    const closed = await withTenant(session, async (ctx) =>
      resolveFollowUp(ctx, await loadActor(ctx), {
        id: made.id,
        resolution: 'done',
        note: 'They sent it this morning.',
      }),
    )
    expect(closed.status).toBe('done')
    expect(closed.resolutionNote).toMatch(/this morning/)
    expect(closed.resolvedByName).toBeTruthy()
    // The reason it existed and how it ended are two different facts, and both survive.
    expect(closed.reason).toBe('Check the addendum landed.')
  })

  it('refuses to close one twice', async () => {
    const [row] = await adminSql()<{ id: string }[]>`
      SELECT id FROM follow_ups WHERE organization_id = ${org.organizationId} AND status = 'done' LIMIT 1`
    await expect(
      withTenant(session, async (ctx) =>
        resolveFollowUp(ctx, await loadActor(ctx), { id: row!.id, resolution: 'cancelled' }),
      ),
    ).rejects.toThrow(/already closed/i)
  })

  it('reports absence for another tenant’s follow-up', async () => {
    const other = await createTenant('comments-follow-ups-absent')
    const [theirs] = await adminSql()<{ id: string }[]>`
      INSERT INTO follow_ups (organization_id, owner_id, due_at, reason, is_demo, created_by)
      VALUES (${other.organizationId}, ${other.ownerId}, now(), 'Theirs', true, ${other.ownerId})
      RETURNING id`
    await expect(
      withTenant(session, async (ctx) =>
        resolveFollowUp(ctx, await loadActor(ctx), { id: theirs!.id, resolution: 'done' }),
      ),
    ).rejects.toThrow(NotFoundError)
    await destroyTenant('comments-follow-ups-absent')
  })

  it('does not send anything outward when one comes due', async () => {
    // §25.7: nothing leaves the company on its own, under any setting. A follow-up
    // surfacing must not enqueue an email.
    const [outbox] = await adminSql()<{ count: number }[]>`
      SELECT count(*)::int FROM outbox WHERE organization_id = ${org.organizationId}`
    expect(outbox?.count ?? 0).toBe(0)
    const [sends] = await adminSql()<{ count: number }[]>`
      SELECT count(*)::int FROM email_sends WHERE organization_id = ${org.organizationId}`
    expect(sends?.count ?? 0).toBe(0)
  })
})
