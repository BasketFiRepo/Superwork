import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  classifyConversation,
  getConversation,
  inboxCounts,
  listConversations,
  listMessages,
  NotFoundError,
  StepUpRequiredError,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * How far a thread of correspondence may travel (ADR 0061).
 *
 * `conversations.sensitivity` has carried `internal` since Phase 0, written by nothing and read
 * by nothing — no repository put it in the `Resource` the policy engine checks, so the column
 * decided nothing at all. Every member holds `conversation:read:org`, so every member read every
 * thread in the organization.
 *
 * These tests are about the two halves that make a classification real: that somebody can set
 * one, and that setting one changes who sees the thread — in the list, in the counts, on open,
 * and in the messages inside it.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let owner: { organizationId: string; userId: string; timezone: string }
let member: { organizationId: string; userId: string; timezone: string }
let manager: { organizationId: string; userId: string; timezone: string }
let threadId: string

async function seedThread(): Promise<string> {
  const [conv] = await adminSql()<{ id: string }[]>`
    INSERT INTO conversations (organization_id, subject, company_id, owner_id, last_message_at,
                               last_direction, created_by)
    VALUES (${org.organizationId}, 'Renewal terms nobody has agreed yet', ${org.companyId},
            ${org.ownerId}, now(), 'inbound', ${org.ownerId})
    RETURNING id`
  await adminSql()`
    INSERT INTO messages (organization_id, conversation_id, direction, from_address, from_name,
                          body_text, sent_at, created_by)
    VALUES (${org.organizationId}, ${conv!.id}, 'inbound', 'dana@fixture.example', 'Dana',
            'The number we discussed was well under the list price.', now(), ${org.ownerId})`
  return conv!.id
}

beforeAll(async () => {
  org = await createTenant('conv-class')
  owner = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  member = { organizationId: org.organizationId, userId: org.memberId, timezone: TZ }
  // The fixture builds an owner, a member and a viewer. A manager is the role whose ceiling —
  // `confidential` — is the one worth testing a classification against.
  const [managerUser] = await adminSql()<{ id: string }[]>`
    INSERT INTO users (email, name, password_hash, timezone, is_demo)
    VALUES ('manager.conv-class@fixture.example', 'Manager conv-class',
            (SELECT password_hash FROM users WHERE id = ${org.memberId}), 'Europe/London', true)
    RETURNING id`
  await adminSql()`
    INSERT INTO memberships (organization_id, user_id, role, is_demo)
    VALUES (${org.organizationId}, ${managerUser!.id}, 'manager', true)`
  manager = { organizationId: org.organizationId, userId: managerUser!.id, timezone: TZ }
  threadId = await seedThread()
})

afterAll(async () => {
  await destroyTenant('conv-class')
  await closePools()
})

describe('a thread nobody has classified', () => {
  it('says the level is a default rather than a decision', async () => {
    const thread = await withTenant(owner, async (ctx) => getConversation(ctx, await loadActor(ctx), threadId))
    expect(thread.sensitivity).toBe('internal')
    expect(thread.sensitivitySource).toBe('unset')
    expect(thread.sensitivitySetByName).toBeNull()
  })

  it('is on a member’s list, which is the behaviour being changed from', async () => {
    const rows = await withTenant(member, async (ctx) => listConversations(ctx, await loadActor(ctx), { view: 'all' }))
    expect(rows.map((row) => row.id)).toContain(threadId)
  })

  it('cannot carry a level nobody attributed, by any door', async () => {
    // The database is what makes `unset` mean the default. Setting the level without the
    // attribution would leave a thread that looks weighed and is not.
    await expect(
      adminSql()`
        UPDATE conversations SET sensitivity = 'confidential'
        WHERE organization_id = ${org.organizationId} AND id = ${threadId}`,
    ).rejects.toThrow(/conversations_unset_is_default/)
    await expect(
      adminSql()`
        UPDATE conversations SET sensitivity = 'confidential', sensitivity_source = 'human'
        WHERE organization_id = ${org.organizationId} AND id = ${threadId}`,
    ).rejects.toThrow(/conversations_classification_attributed/)
  })
})

describe('classifying it', () => {
  it('refuses a decision nobody explained', async () => {
    await withTenant(owner, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        classifyConversation(ctx, actor, { conversationId: threadId, sensitivity: 'confidential', reason: 'x' }),
      ).rejects.toThrow(ValidationError)
    })
  })

  it('is not something a member may do at all, and the refusal says what would', async () => {
    await withTenant(member, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        classifyConversation(ctx, actor, {
          conversationId: threadId,
          sensitivity: 'confidential',
          reason: 'A member trying to classify a thread.',
        }),
      ).rejects.toThrow(/need Manager access/i)
    })
  })

  it('and a manager cannot file one above their own reach', async () => {
    // The refusal comes from the policy engine measuring the row *as it will be* against the
    // manager's own ceiling — `confidential` — rather than from a second copy of the rule here.
    // Setting it to `confidential` is allowed; `restricted` is out of their own reach.
    // Its own thread, so this does not decide the level the tests below start from.
    const otherThread = await seedThread()
    await withTenant(manager, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        classifyConversation(ctx, actor, {
          conversationId: otherThread,
          sensitivity: 'restricted',
          reason: 'A manager filing it above what they can read.',
        }),
      ).rejects.toThrow(/restricted/i)
      await expect(
        classifyConversation(ctx, actor, {
          conversationId: otherThread,
          sensitivity: 'confidential',
          reason: 'A manager filing it within their own reach.',
        }),
      ).resolves.toMatchObject({ sensitivity: 'confidential' })
    })
  })

  it('raises without asking for a password, because raising only narrows', async () => {
    const after = await withTenant(owner, async (ctx) =>
      classifyConversation(ctx, await loadActor(ctx), {
        conversationId: threadId,
        sensitivity: 'confidential',
        reason: 'Renewal terms the account team has not agreed yet.',
      }),
    )
    expect(after.sensitivity).toBe('confidential')
    expect(after.sensitivitySource).toBe('human')
    expect(after.sensitivitySetByName).not.toBeNull()
    expect(after.sensitivityReason).toMatch(/not agreed yet/)
  })

  it('reaches every message already in the thread, kept by the database', async () => {
    const rows = await adminSql()<{ sensitivity: string }[]>`
      SELECT sensitivity FROM messages
      WHERE organization_id = ${org.organizationId} AND conversation_id = ${threadId}`
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.sensitivity).toBe('confidential')
  })

  it('and a message written afterwards inherits it without being told', async () => {
    // Written the way any caller that has never heard of this would write it.
    const [message] = await adminSql()<{ sensitivity: string }[]>`
      INSERT INTO messages (organization_id, conversation_id, direction, from_address, from_name,
                            body_text, sent_at, sensitivity, created_by)
      VALUES (${org.organizationId}, ${threadId}, 'outbound', 'us@fixture.example', 'Us',
              'Acknowledged.', now(), 'public', ${org.ownerId})
      RETURNING sensitivity`
    expect(message!.sensitivity).toBe('confidential')
  })

  it('writes an audit record naming both levels', async () => {
    const [entry] = await adminSql()<{ action: string; diff: unknown }[]>`
      SELECT action, diff FROM audit_logs
      WHERE organization_id = ${org.organizationId} AND action = 'conversation.classified'
        AND entity_id = ${threadId}
      ORDER BY occurred_at ASC LIMIT 1`
    expect(entry!.action).toBe('conversation.classified')
    const diff = JSON.stringify(entry!.diff)
    expect(diff).toMatch(/internal/)
    expect(diff).toMatch(/confidential/)
  })
})

describe('what the classification then does', () => {
  it('takes the thread off a member’s list', async () => {
    const rows = await withTenant(member, async (ctx) => listConversations(ctx, await loadActor(ctx), { view: 'all' }))
    expect(rows.map((row) => row.id)).not.toContain(threadId)
  })

  it('and out of the numbers on their navigation', async () => {
    // A badge that counts a thread somebody cannot open tells them it is there.
    const asMember = await withTenant(member, async (ctx) => inboxCounts(ctx, await loadActor(ctx)))
    const asOwner = await withTenant(owner, async (ctx) => inboxCounts(ctx, await loadActor(ctx)))
    expect(asOwner.queue).toBeGreaterThan(asMember.queue)
  })

  it('answers a member’s open with 404, never 403', async () => {
    // §3.2's rule, for the same reason: a refusal that distinguishes "not allowed" from "not
    // here" tells the reader the thread exists.
    await withTenant(member, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(getConversation(ctx, actor, threadId)).rejects.toThrow(NotFoundError)
      await expect(listMessages(ctx, actor, threadId)).rejects.toThrow(NotFoundError)
    })
  })

  it('still opens for somebody whose clearance reaches it', async () => {
    const thread = await withTenant(owner, async (ctx) => getConversation(ctx, await loadActor(ctx), threadId))
    expect(thread.sensitivity).toBe('confidential')
    const messages = await withTenant(owner, async (ctx) => listMessages(ctx, await loadActor(ctx), threadId))
    expect(messages.length).toBeGreaterThan(0)
  })
})

describe('lowering it again', () => {
  it('asks for the password, because it widens who can read the thread', async () => {
    await withTenant(owner, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        classifyConversation(ctx, actor, {
          conversationId: threadId,
          sensitivity: 'internal',
          reason: 'The terms were agreed and announced.',
        }),
      ).rejects.toThrow(StepUpRequiredError)
    })
  })

  it('and goes through once the identity is proven, cascading back down', async () => {
    const after = await withTenant(owner, async (ctx) => {
      const actor = await loadActor(ctx)
      return classifyConversation({ ...ctx } as never, { ...actor, steppedUpAt: new Date() }, {
        conversationId: threadId,
        sensitivity: 'internal',
        reason: 'The terms were agreed and announced.',
      })
    })
    expect(after.sensitivity).toBe('internal')
    // Still attributed: a thread that came back down is not a thread nobody weighed.
    expect(after.sensitivitySource).toBe('human')

    const rows = await adminSql()<{ sensitivity: string }[]>`
      SELECT sensitivity FROM messages
      WHERE organization_id = ${org.organizationId} AND conversation_id = ${threadId}`
    for (const row of rows) expect(row.sensitivity).toBe('internal')
  })

  it('is another tenant’s 404, never their 403', async () => {
    const other = await createTenant('conv-class-other')
    try {
      const [theirs] = await adminSql()<{ id: string }[]>`
        INSERT INTO conversations (organization_id, subject, last_message_at, last_direction, created_by)
        VALUES (${other.organizationId}, 'Somebody else’s thread', now(), 'inbound', ${other.ownerId})
        RETURNING id`
      await withTenant(owner, async (ctx) => {
        const actor = await loadActor(ctx)
        await expect(
          classifyConversation(ctx, actor, {
            conversationId: theirs!.id,
            sensitivity: 'confidential',
            reason: 'Reaching into another organization.',
          }),
        ).rejects.toThrow(NotFoundError)
      })
    } finally {
      await destroyTenant('conv-class-other')
    }
  })
})
