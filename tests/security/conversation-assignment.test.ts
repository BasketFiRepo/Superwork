import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  assignableTo,
  assignConversation,
  classifyConversation,
  getConversation,
  grantPermission,
  listConversations,
  NotFoundError,
  PermissionError,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * A thread somebody is answering (ADR 0063).
 *
 * `conversations.assigned_to` has existed since migration 0010 and nothing has ever written it,
 * while three things read it: the inbox's "My work" view, the personal record's count of what is
 * held about you, and `scopeSatisfied('own')`. A column, a filter and a policy branch with no way
 * to put a value in.
 *
 * The tests that matter are the ones about what an assignment *does* — it has to reach the view
 * that reads it and the scope that accepts it, or it is a value in a column.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let owner: { organizationId: string; userId: string; timezone: string }
let member: { organizationId: string; userId: string; timezone: string }
let threadId: string

async function seedThread(subject: string): Promise<string> {
  const [conv] = await adminSql()<{ id: string }[]>`
    INSERT INTO conversations (organization_id, subject, company_id, owner_id, last_message_at,
                               last_direction, created_by)
    VALUES (${org.organizationId}, ${subject}, ${org.companyId}, ${org.ownerId}, now(), 'inbound',
            ${org.ownerId})
    RETURNING id`
  return conv!.id
}

beforeAll(async () => {
  org = await createTenant('conv-assign')
  owner = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  member = { organizationId: org.organizationId, userId: org.memberId, timezone: TZ }
  threadId = await seedThread('Who is picking up the Halden reroute')
})

afterAll(async () => {
  await destroyTenant('conv-assign')
  await closePools()
})

describe('a thread nobody has been handed', () => {
  it('says so, and is on nobody’s list of their own work', async () => {
    const thread = await withTenant(owner, async (ctx) => getConversation(ctx, await loadActor(ctx), threadId))
    expect(thread.assignedToId).toBeNull()
    expect(thread.assignedByName).toBeNull()

    const mine = await withTenant(member, async (ctx) =>
      listConversations(ctx, await loadActor(ctx), { view: 'mine' }),
    )
    expect(mine.map((row) => row.id)).not.toContain(threadId)
  })
})

describe('handing it over', () => {
  it('records who was given it, by whom, and when', async () => {
    const after = await withTenant(owner, async (ctx) =>
      assignConversation(ctx, await loadActor(ctx), { conversationId: threadId, assigneeId: org.memberId }),
    )
    expect(after.assignedToId).toBe(org.memberId)
    expect(after.assignedToName).not.toBeNull()
    expect(after.assignedByName).not.toBeNull()
    expect(after.assignedAt).toBeInstanceOf(Date)
  })

  it('puts it on their own list, which is the filter that could never match', async () => {
    const mine = await withTenant(member, async (ctx) =>
      listConversations(ctx, await loadActor(ctx), { view: 'mine' }),
    )
    expect(mine.map((row) => row.id)).toContain(threadId)
  })

  it('and it goes on the feed, because being given work is news to the person given it', async () => {
    const [activity] = await adminSql()<{ verb: string; summary: string }[]>`
      SELECT verb, summary FROM activities
      WHERE organization_id = ${org.organizationId} AND entity_type = 'conversation'
        AND entity_id = ${threadId}
      ORDER BY created_at DESC LIMIT 1`
    expect(activity!.verb).toBe('assigned')
    expect(activity!.summary).toMatch(/Halden reroute/)
  })

  it('cannot name somebody who is not here, in the repository or by another door', async () => {
    const other = await createTenant('conv-assign-other')
    try {
      await withTenant(owner, async (ctx) => {
        const actor = await loadActor(ctx)
        await expect(
          assignConversation(ctx, actor, { conversationId: threadId, assigneeId: other.memberId }),
        ).rejects.toThrow(NotFoundError)
      })
      // A foreign key to `users` says the person exists and nothing about which organization
      // they are in, so the trigger is what makes this true of every writer.
      await expect(
        adminSql()`
          UPDATE conversations
          SET assigned_to = ${other.memberId}, assigned_by = ${org.ownerId}, assigned_at = now()
          WHERE organization_id = ${org.organizationId} AND id = ${threadId}`,
      ).rejects.toThrow(/member of the same organization/i)
    } finally {
      await destroyTenant('conv-assign-other')
    }
  })

  it('cannot be recorded without saying who did it', async () => {
    await expect(
      adminSql()`
        UPDATE conversations SET assigned_to = ${org.memberId}, assigned_by = NULL, assigned_at = NULL
        WHERE organization_id = ${org.organizationId} AND id = ${threadId}`,
    ).rejects.toThrow(/conversations_assignment_attributed/)
  })

  it('is not something a reader may do', async () => {
    const second = await seedThread('A thread a member should not be able to hand over')
    await withTenant(member, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        assignConversation(ctx, actor, { conversationId: second, assigneeId: org.memberId }),
      ).rejects.toThrow(PermissionError)
    })
  })
})

describe('what being handed one is worth', () => {
  /**
   * No role carries an `own`-scoped conversation grant — every one of them reads at `org` — so
   * passing the assignee into the resource changes no answer that a *role* decides, and claiming
   * otherwise would be the sort of thing this codebase writes ADRs about. What it does is stop
   * the resource being a lie, and it is exactly what an exception granted to one person reads
   * (ADR 0055). That is provable, so it is proved here rather than asserted in a comment.
   */
  it('is what an exception scoped to a person’s own work reads', async () => {
    const third = await seedThread('A thread the member does not own')

    await withTenant(owner, async (ctx) => {
      const actor = await loadActor(ctx)
      await grantPermission({ ...ctx } as never, { ...actor, steppedUpAt: new Date() }, {
        userId: org.memberId,
        permission: 'conversation:update:own',
        reason: 'They are covering the desk this week and need to hand threads on.',
      })
    })

    // The exception alone is not enough: nothing about this thread is theirs yet.
    await withTenant(member, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        assignConversation(ctx, actor, { conversationId: third, assigneeId: org.ownerId }),
      ).rejects.toThrow(PermissionError)
    })

    await withTenant(owner, async (ctx) =>
      assignConversation(ctx, await loadActor(ctx), { conversationId: third, assigneeId: org.memberId }),
    )

    // Now it is theirs, the same exception is satisfied, and the same call goes through.
    const handedOn = await withTenant(member, async (ctx) =>
      assignConversation(ctx, await loadActor(ctx), { conversationId: third, assigneeId: org.ownerId }),
    )
    expect(handedOn.assignedToId).toBe(org.ownerId)
  })
})

describe('a thread classified above the person', () => {
  it('is refused, and the refusal names the classification rather than the person', async () => {
    const secret = await seedThread('Terms the member may not read')
    await withTenant(owner, async (ctx) =>
      classifyConversation(ctx, await loadActor(ctx), {
        conversationId: secret,
        sensitivity: 'confidential',
        reason: 'Commercial terms that are not settled.',
      }),
    )
    await withTenant(owner, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        assignConversation(ctx, actor, { conversationId: secret, assigneeId: org.memberId }),
      ).rejects.toThrow(ValidationError)
      await expect(
        assignConversation(ctx, actor, { conversationId: secret, assigneeId: org.memberId }),
      ).rejects.toThrow(/classified confidential.*cannot open/is)
    })
  })

  it('and is not offered in the first place', async () => {
    const secret = await withTenant(owner, async (ctx) =>
      listConversations(ctx, await loadActor(ctx), { view: 'all' }),
    ).then((rows) => rows.find((row) => row.subject === 'Terms the member may not read')!)

    const offered = await withTenant(owner, async (ctx) =>
      assignableTo(ctx, await loadActor(ctx), secret.id),
    )
    expect(offered.map((person) => person.id)).not.toContain(org.memberId)
    // The owner reads everything, so they are still on their own list.
    expect(offered.map((person) => person.id)).toContain(org.ownerId)
  })
})

describe('taking it back', () => {
  it('clears the assignment and everything recorded about it', async () => {
    const after = await withTenant(owner, async (ctx) =>
      assignConversation(ctx, await loadActor(ctx), { conversationId: threadId, assigneeId: null }),
    )
    expect(after.assignedToId).toBeNull()
    expect(after.assignedByName).toBeNull()
    expect(after.assignedAt).toBeNull()

    const mine = await withTenant(member, async (ctx) =>
      listConversations(ctx, await loadActor(ctx), { view: 'mine' }),
    )
    expect(mine.map((row) => row.id)).not.toContain(threadId)
  })

  it('is another tenant’s 404, never their 403', async () => {
    const other = await createTenant('conv-assign-other-2')
    try {
      const [theirs] = await adminSql()<{ id: string }[]>`
        INSERT INTO conversations (organization_id, subject, last_message_at, last_direction, created_by)
        VALUES (${other.organizationId}, 'Somebody else’s thread', now(), 'inbound', ${other.ownerId})
        RETURNING id`
      await withTenant(owner, async (ctx) => {
        const actor = await loadActor(ctx)
        await expect(
          assignConversation(ctx, actor, { conversationId: theirs!.id, assigneeId: org.ownerId }),
        ).rejects.toThrow(NotFoundError)
      })
    } finally {
      await destroyTenant('conv-assign-other-2')
    }
  })
})
