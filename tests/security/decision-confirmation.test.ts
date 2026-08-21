import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  createMeeting,
  createProject,
  getDecision,
  listDecisions,
  NotFoundError,
  PermissionError,
  recordDecision,
  setDecisionConfirmation,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * A decision somebody stood behind (ADR 0065).
 *
 * `decisions.confirmed_at` and `confirmed_by` have existed since migration 0010 and nothing
 * has ever written either, while the decision log renders a "Confirmed" column and the meeting
 * page tells people to "confirm anything that reads wrong". Every decision in the log was
 * extracted from a transcript by the assistant — `recordDecision` is called from exactly one
 * place, the meeting summarizer — so the log is a list of the model's readings presented as
 * the record of what was decided.
 *
 * And `listDecisions` took no actor and made no permission check at all: RLS kept it inside
 * the organization and that was the whole gate.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let owner: { organizationId: string; userId: string; timezone: string }
let member: { organizationId: string; userId: string; timezone: string }
let viewer: { organizationId: string; userId: string; timezone: string }
let meetingId: string
let decisionId: string
let secretProjectId: string
let secretDecisionId: string

beforeAll(async () => {
  org = await createTenant('decision-confirm')
  owner = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  member = { organizationId: org.organizationId, userId: org.memberId, timezone: TZ }
  viewer = { organizationId: org.organizationId, userId: org.viewerId, timezone: TZ }

  await withTenant(owner, async (ctx) => {
    const actor = await loadActor(ctx)
    // The member is in the room; the viewer is not.
    const meeting = await createMeeting(ctx, actor, {
      title: 'Halden renewal — commercial terms',
      startsAt: new Date(Date.now() - 3_600_000),
      endsAt: new Date(Date.now() - 1_800_000),
      participants: [{ userId: org.memberId, displayName: 'Member', role: 'attendee' }],
    })
    meetingId = meeting.id

    decisionId = (
      await recordDecision(ctx, actor, {
        summary: 'Hold the 2026 rate at last year’s level and revisit in March.',
        meetingId,
        confidence: 0.82,
        agentRunId: org.runId,
      })
    ).id

    // A decision filed against a project nobody below `confidential` may read.
    const project = await createProject(ctx, actor, {
      name: 'Halden confidential commercials',
      sensitivity: 'confidential',
    })
    secretProjectId = project.id
    secretDecisionId = (
      await recordDecision(ctx, actor, {
        summary: 'The floor price is not to be shared outside the commercial team.',
        projectId: secretProjectId,
        confidence: 0.91,
        agentRunId: org.runId,
      })
    ).id
  })
})

afterAll(async () => {
  await destroyTenant('decision-confirm')
  await closePools()
})

describe('a decision the assistant read out of a transcript', () => {
  it('says so, and says nobody has stood behind it', async () => {
    const decision = await withTenant(owner, async (ctx) =>
      getDecision(ctx, await loadActor(ctx), decisionId),
    )
    expect(decision.fromAgentRun).toBe(true)
    expect(decision.confidence).not.toBeNull()
    expect(decision.confirmedAt).toBeNull()
    expect(decision.confirmedByName).toBeNull()
  })

  it('is confirmed by somebody who was in the meeting, whatever their role', async () => {
    // A member holds no `project:update` at all — being there is what qualifies them.
    const after = await withTenant(member, async (ctx) =>
      setDecisionConfirmation(ctx, await loadActor(ctx), { decisionId, confirmed: true }),
    )
    expect(after.confirmedAt).toBeInstanceOf(Date)
    expect(after.confirmedBy).toBe(org.memberId)
    expect(after.confirmedByName).not.toBeNull()
  })

  it('records what was being agreed with, not only that somebody agreed', async () => {
    const [entry] = await adminSql()<{ action: string; diff: Record<string, { from: unknown; to: unknown }> }[]>`
      SELECT action, diff FROM audit_logs
      WHERE organization_id = ${org.organizationId} AND entity_id = ${decisionId}
        AND action = 'decision.confirmed'
      ORDER BY occurred_at DESC LIMIT 1`
    expect(entry!.action).toBe('decision.confirmed')
    expect(entry!.diff.extractedByAssistant!.to).toBe(true)
    expect(Number(entry!.diff.confidence!.to)).toBeCloseTo(0.82, 2)
  })

  it('cannot be confirmed twice, and says who holds the signature', async () => {
    await withTenant(owner, async (ctx) => {
      await expect(
        setDecisionConfirmation(ctx, await loadActor(ctx), { decisionId, confirmed: true }),
      ).rejects.toThrow(/has already confirmed this/i)
    })
  })
})

describe('who may stand behind one', () => {
  it('is never the assistant that read it', async () => {
    await withTenant(owner, async (ctx) => {
      const actor = await loadActor(ctx)
      const asAgent = {
        ...actor,
        type: 'agent' as const,
        agent: {
          agentId: org.runId,
          agentName: 'Summarizer',
          mode: 'assist' as const,
          orgGrant: [],
          denied: [],
          toolGrants: ['*'],
          maxSensitivity: 'restricted' as const,
          capabilityDowngraded: false,
        },
      }
      await expect(
        setDecisionConfirmation(ctx, asAgent, { decisionId: secretDecisionId, confirmed: true }),
      ).rejects.toThrow(/cannot also be the one who agrees/i)
    })
  })

  it('is not somebody who was neither there nor has a say, and the refusal says what would', async () => {
    // The viewer was not at the meeting and holds no `project:update`.
    const second = await withTenant(owner, async (ctx) =>
      recordDecision(ctx, await loadActor(ctx), {
        summary: 'Move the review to the following Tuesday.',
        meetingId,
        confidence: 0.7,
        agentRunId: org.runId,
      }),
    )
    await withTenant(viewer, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        setDecisionConfirmation(ctx, actor, { decisionId: second.id, confirmed: true }),
      ).rejects.toThrow(PermissionError)
      await expect(
        setDecisionConfirmation(ctx, actor, { decisionId: second.id, confirmed: true }),
      ).rejects.toThrow(/in the meeting it came from, or who has a say over the project/i)
    })
  })
})

describe('taking it back', () => {
  it('will not happen without a reason, because the decision stays either way', async () => {
    await withTenant(member, async (ctx) => {
      await expect(
        setDecisionConfirmation(ctx, await loadActor(ctx), { decisionId, confirmed: false, reason: 'x' }),
      ).rejects.toThrow(ValidationError)
    })
  })

  it('clears the signature and says why on the feed', async () => {
    const after = await withTenant(member, async (ctx) =>
      setDecisionConfirmation(ctx, await loadActor(ctx), {
        decisionId,
        confirmed: false,
        reason: 'Rereading the transcript, the rate was discussed but not settled.',
      }),
    )
    expect(after.confirmedAt).toBeNull()
    expect(after.confirmedBy).toBeNull()

    const [activity] = await adminSql()<{ verb: string; summary: string }[]>`
      SELECT verb, summary FROM activities
      WHERE organization_id = ${org.organizationId} AND entity_type = 'decision'
        AND entity_id = ${decisionId}
      ORDER BY created_at DESC LIMIT 1`
    expect(activity!.verb).toMatch(/withdrew/i)
    expect(activity!.summary).toMatch(/not settled/i)
  })

  it('is refused when there is nothing to withdraw', async () => {
    await withTenant(member, async (ctx) => {
      await expect(
        setDecisionConfirmation(ctx, await loadActor(ctx), {
          decisionId,
          confirmed: false,
          reason: 'There is no signature on this.',
        }),
      ).rejects.toThrow(/nothing to withdraw/i)
    })
  })
})

describe('the record the database keeps', () => {
  it('will not hold half a signature, whatever writes the row', async () => {
    await expect(
      adminSql()`
        UPDATE decisions SET confirmed_at = now(), confirmed_by = NULL
        WHERE organization_id = ${org.organizationId} AND id = ${decisionId}`,
    ).rejects.toThrow(/decisions_confirmation_attributed/)
    await expect(
      adminSql()`
        UPDATE decisions SET confirmed_at = NULL, confirmed_by = ${org.ownerId}
        WHERE organization_id = ${org.organizationId} AND id = ${decisionId}`,
    ).rejects.toThrow(/decisions_confirmation_attributed/)
  })

  it('will not take a signature from another organization', async () => {
    const other = await createTenant('decision-confirm-other')
    try {
      await expect(
        adminSql()`
          UPDATE decisions SET confirmed_at = now(), confirmed_by = ${other.ownerId}
          WHERE organization_id = ${org.organizationId} AND id = ${decisionId}`,
      ).rejects.toThrow(/member of the same organization/i)
    } finally {
      await destroyTenant('decision-confirm-other')
    }
  })
})

describe('the list that asked nobody anything', () => {
  it('drops a decision whose project is above the reader’s clearance', async () => {
    const asOwner = await withTenant(owner, async (ctx) =>
      listDecisions(ctx, await loadActor(ctx), { limit: 100 }),
    )
    expect(asOwner.map((row) => row.id)).toContain(secretDecisionId)

    // A member reads up to `internal`; the project is confidential.
    const asMember = await withTenant(member, async (ctx) =>
      listDecisions(ctx, await loadActor(ctx), { limit: 100 }),
    )
    expect(asMember.map((row) => row.id)).not.toContain(secretDecisionId)
    // The rest of the log is still theirs — this is a filter, not a wall.
    expect(asMember.map((row) => row.id)).toContain(decisionId)
  })

  it('answers as though it is not here, never as forbidden', async () => {
    await withTenant(member, async (ctx) => {
      await expect(
        getDecision(ctx, await loadActor(ctx), secretDecisionId),
      ).rejects.toThrow(NotFoundError)
    })
  })

  it('is another tenant’s 404, never their rows', async () => {
    const other = await createTenant('decision-confirm-other-2')
    try {
      const theirs = await withTenant(
        { organizationId: other.organizationId, userId: other.ownerId, timezone: TZ },
        async (ctx) =>
          recordDecision(ctx, await loadActor(ctx), { summary: 'Somebody else’s decision.' }),
      )
      await withTenant(owner, async (ctx) => {
        const actor = await loadActor(ctx)
        await expect(getDecision(ctx, actor, theirs.id)).rejects.toThrow(NotFoundError)
        const mine = await listDecisions(ctx, actor, { limit: 200 })
        expect(mine.map((row) => row.id)).not.toContain(theirs.id)
      })
    } finally {
      await destroyTenant('decision-confirm-other-2')
    }
  })

  it('can be asked for only what nobody has confirmed, which is what the assistant should doubt', async () => {
    const unconfirmed = await withTenant(owner, async (ctx) =>
      listDecisions(ctx, await loadActor(ctx), { unconfirmedOnly: true, limit: 100 }),
    )
    expect(unconfirmed.length).toBeGreaterThan(0)
    expect(unconfirmed.every((row) => row.confirmedAt === null)).toBe(true)
  })
})
