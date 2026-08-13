import { adminSql, withTenant } from '@superwork/db'
import { startOfDay, startOfWeek } from '@superwork/core'
import { digestFacts, digestNarrative, listDigests, saveDigest, type DigestView } from './autopilot.js'
import type { RunSession } from './runtime.js'

/**
 * The weekly digest an agent owes its owner (§27.6).
 *
 * An agent that acts unattended has to report, in one place, everything it did — what it
 * touched, what a person had to approve, what was undone afterwards, and what it cost
 * against its caps. Anyone whose work appears in it gets a disclosure at the same moment.
 */

export async function generateDigest(
  session: RunSession,
  input: { agentId: string; weeksAgo?: number },
): Promise<DigestView | null> {
  const weeksAgo = input.weeksAgo ?? 1
  const thisWeek = startOfWeek(new Date(), session.timezone)
  const from = new Date(thisWeek.getTime() - weeksAgo * 7 * 86_400_000)
  const to = new Date(from.getTime() + 7 * 86_400_000)

  return withTenant(session, async (ctx) => {
    const [agent] = await ctx.sql<{ owner_user_id: string }[]>`
      SELECT owner_user_id FROM agents
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.agentId} AND deleted_at IS NULL`
    if (!agent) return null

    const facts = await digestFacts(ctx, input.agentId, from, to)
    const narrative = digestNarrative(facts, from, to, ctx.timezone)
    await saveDigest(ctx, {
      agentId: input.agentId,
      recipientUserId: agent.owner_user_id,
      from,
      to,
      facts,
      narrative,
    })
    const [latest] = await listDigests(ctx, input.agentId, 1)
    return latest ?? null
  })
}

/**
 * The worker sweep. Each agent has a day of the week it reports on; an agent that did
 * nothing still reports, because "it did nothing" is information about an agent you are
 * accountable for.
 */
export async function generateDueDigests(now = new Date()): Promise<number> {
  const organizations = await adminSql()<{ id: string; timezone: string; ownerId: string }[]>`
    SELECT o.id, o.timezone,
           (SELECT m.user_id FROM memberships m
             WHERE m.organization_id = o.id AND m.role = 'owner' AND m.deleted_at IS NULL
             ORDER BY m.created_at LIMIT 1) AS "ownerId"
    FROM organizations o WHERE o.deleted_at IS NULL`

  let written = 0
  for (const org of organizations) {
    if (!org.ownerId) continue
    const session: RunSession = { organizationId: org.id, userId: org.ownerId, timezone: org.timezone }
    const today = startOfDay(now, org.timezone)
    const weekday = new Date(today).getUTCDay()

    const due = await withTenant(session, (ctx) =>
      ctx.sql<{ id: string }[]>`
        SELECT a.id FROM agents a
        WHERE a.organization_id = ${ctx.organizationId} AND a.deleted_at IS NULL
          AND a.status IN ('active', 'paused')
          AND a.digest_day = ${weekday}
          AND NOT EXISTS (
            SELECT 1 FROM agent_digests d
            WHERE d.organization_id = a.organization_id AND d.agent_id = a.id
              AND d.deleted_at IS NULL AND d.period_to > ${new Date(today.getTime() - 7 * 86_400_000)}
          )`,
    )

    for (const agent of due) {
      const digest = await generateDigest(session, { agentId: agent.id, weeksAgo: 1 })
      if (digest) written += 1
    }
  }
  return written
}
