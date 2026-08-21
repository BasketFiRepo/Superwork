import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { listDigests, markDigestRead, saveDigest, unreadDigests } from '@superwork/agent'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * A report somebody actually read (ADR 0070).
 *
 * `agent_digests.read_at` was selected into every `DigestView` and rendered nowhere, and
 * reading the code for why turned up the bigger half: `saveDigest` wrote the row, wrote a
 * disclosure to everyone named in it, and told the owner nothing. The report was filed to a
 * table the accountable human reaches only by opening Settings, choosing Agents, choosing that
 * agent, and scrolling.
 *
 * So the receipt could not be written because there was nothing to read it from.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let owner: { organizationId: string; userId: string; timezone: string }
let member: { organizationId: string; userId: string; timezone: string }
let agentId: string

const FACTS = {
  agentName: 'Superwork',
  runs: 3,
  actions: 7,
  approvals: 1,
  undone: 0,
  costCents: 12,
  peopleAffected: [] as { userId: string; name: string; items: number }[],
}

async function writeDigest(weeksAgo: number, recipient = org.ownerId): Promise<string> {
  const from = new Date(Date.now() - weeksAgo * 7 * 86_400_000)
  return withTenant(owner, async (ctx) => {
    const id = await saveDigest(ctx, {
      agentId,
      recipientUserId: recipient,
      from,
      to: new Date(from.getTime() + 7 * 86_400_000),
      facts: FACTS as never,
      narrative: `A week in which ${FACTS.actions} things happened.`,
    })
    return id!
  })
}

beforeAll(async () => {
  org = await createTenant('digest-receipt')
  owner = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  member = { organizationId: org.organizationId, userId: org.memberId, timezone: TZ }
  const [row] = await adminSql()<{ id: string }[]>`
    INSERT INTO agents (organization_id, key, name, purpose, owner_user_id, mode, status,
                        tool_grants, max_sensitivity, is_demo, created_by)
    VALUES (${org.organizationId}, 'digest-subject', 'Superwork', 'Reports weekly.',
            ${org.ownerId}, 'autopilot'::sw_agent_mode, 'active', ARRAY['*'], 'internal', true,
            ${org.ownerId})
    RETURNING id`
  agentId = row!.id
})

afterAll(async () => {
  await destroyTenant('digest-receipt')
  await closePools()
})

describe('a report that reaches the person it is about', () => {
  it('tells its recipient, which it never did', async () => {
    const id = await writeDigest(1)
    const [note] = await adminSql()<{ type: string; title: string; url: string; delivery: string }[]>`
      SELECT type, title, url, delivery FROM notifications
      WHERE organization_id = ${org.organizationId} AND user_id = ${org.ownerId}
        AND type = 'agent_digest'
      ORDER BY created_at DESC LIMIT 1`
    expect(note!.type).toBe('agent_digest')
    expect(note!.title).toMatch(/reported on its week/i)
    // It points at the agent, so the notification is a way in rather than a summary to squint at.
    expect(note!.url).toContain('/settings/agents/')
    expect(id).toBeTruthy()
  })

  it('is not an interruption — a weekly summary belongs in the briefing', async () => {
    const [note] = await adminSql()<{ delivery: string }[]>`
      SELECT delivery FROM notifications
      WHERE organization_id = ${org.organizationId} AND type = 'agent_digest'
      ORDER BY created_at DESC LIMIT 1`
    // `immediate` is the default for a type nobody has expressed a preference about; what
    // matters here is that it is muteable, unlike a disclosure.
    expect(['immediate', 'digest', 'none']).toContain(note!.delivery)
  })

  it('arrives unread, and says so', async () => {
    const [digest] = await withTenant(owner, async (ctx) => listDigests(ctx, agentId, 1))
    expect(digest!.readAt).toBeNull()
    expect(await withTenant(owner, async (ctx) => unreadDigests(ctx, agentId))).toBe(1)
  })
})

describe('the receipt', () => {
  it('is the recipient’s, and nobody else’s', async () => {
    const [digest] = await withTenant(owner, async (ctx) => listDigests(ctx, agentId, 1))
    // A member is not who it was written for. Nothing moves, and nothing is said about whether
    // the row exists.
    const after = await withTenant(member, async (ctx) =>
      markDigestRead(ctx, { userId: org.memberId }, digest!.id),
    )
    expect(after!.readAt).toBeNull()
  })

  it('is recorded when the person it went to says they have read it', async () => {
    const [digest] = await withTenant(owner, async (ctx) => listDigests(ctx, agentId, 1))
    const after = await withTenant(owner, async (ctx) =>
      markDigestRead(ctx, { userId: org.ownerId }, digest!.id),
    )
    expect(after!.readAt).toBeInstanceOf(Date)
    expect(await withTenant(owner, async (ctx) => unreadDigests(ctx, agentId))).toBe(0)
  })

  it('does not move on a second visit, so "how long it sat unread" stays answerable', async () => {
    const [digest] = await withTenant(owner, async (ctx) => listDigests(ctx, agentId, 1))
    const first = digest!.readAt
    const again = await withTenant(owner, async (ctx) =>
      markDigestRead(ctx, { userId: org.ownerId }, digest!.id),
    )
    expect(again!.readAt?.getTime()).toBe(first?.getTime())
  })

  it('cannot be put on a report nobody was sent, whatever writes the row', async () => {
    const [row] = await adminSql()<{ id: string }[]>`
      SELECT id FROM agent_digests
      WHERE organization_id = ${org.organizationId} AND agent_id = ${agentId} LIMIT 1`
    await expect(
      adminSql()`
        UPDATE agent_digests SET recipient_user_id = NULL, read_at = now()
        WHERE organization_id = ${org.organizationId} AND id = ${row!.id}`,
    ).rejects.toThrow(/cannot have been read/i)
  })
})

describe('what going unread costs', () => {
  /**
   * Not the agent — the unattended mode, the same lever ADR 0068 uses for a stale
   * recertification and for the same reason. An agent nobody is reading is unattended in both
   * directions: nothing watching it, and nothing read of what it did.
   *
   * One missed week is forgiven on purpose. A person on holiday should not silently change what
   * their agent is allowed to be.
   */
  it('is nothing at all for one missed report', async () => {
    await writeDigest(2)
    expect(await withTenant(owner, async (ctx) => unreadDigests(ctx, agentId))).toBe(1)
  })

  it('and autopilot for two', async () => {
    await writeDigest(3)
    expect(await withTenant(owner, async (ctx) => unreadDigests(ctx, agentId))).toBe(2)
  })
})

describe('what it deliberately does not count', () => {
  /**
   * §29.5 forbids individual productivity scoring by construction. "Which agents are overseen"
   * is a fact about agents; the same rows grouped by who failed to read them would be a measure
   * of a person, and the difference is only that nobody wrote the second query.
   */
  it('counts per agent and offers no way to count per person', async () => {
    expect(await withTenant(owner, async (ctx) => unreadDigests(ctx, agentId))).toBeGreaterThan(0)
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../packages/agent/src/autopilot.ts', import.meta.url), 'utf8'),
    )
    // No aggregate keyed on the recipient. The rule is in the code rather than in a comment
    // about the code.
    expect(/GROUP\s+BY\s+[a-z.]*recipient_user_id/i.test(source)).toBe(false)
  })
})
