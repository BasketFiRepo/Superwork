import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  approvalPolicies,
  createApproval,
  decideApproval,
  evaluateApprovalPolicies,
  getApproval,
  listApprovals,
  NotFoundError,
  PermissionError,
  savePolicy,
  setPolicyEnabled,
  StepUpRequiredError,
  ValidationError,
  type PolicyRow,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Approval policies (§11.1).
 *
 * Three rules have been seeded since migration 0005 and read by nothing, while the gate
 * carried its own copy of one of them — `writes.length > 20`, the same twenty the seeded
 * "Bulk changes" row states. The row and the constant agreed, so nothing looked broken;
 * an admin simply could not see or change the rule that was governing them, and
 * `approvals.policy_id` and `policy_reason` were columns nothing filled, so a card could
 * not say why it was being asked.
 *
 * The property that matters most is the one that is not configurable: **a policy can only
 * tighten**. There is no effect that removes an approval the product would otherwise
 * require, which is what keeps §25.7 true in the presence of a rule engine.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let memberSession: { organizationId: string; userId: string; timezone: string }
let viewerSession: { organizationId: string; userId: string; timezone: string }
let managerSession: { organizationId: string; userId: string; timezone: string }
let managerId: string

const PREVIEW = [
  {
    operation: 'Send email',
    entityType: 'email',
    entityLabel: 'Halden Foods renewal',
    changes: [{ field: 'Body', to: 'The renewal terms are attached.' }],
    riskTier: 'high' as const,
    reversible: false,
  },
]

const policy = (over: Partial<PolicyRow> & { rule: PolicyRow['rule'] }): PolicyRow => ({
  id: over.id ?? '00000000-0000-0000-0000-000000000001',
  name: over.name ?? 'A rule',
  description: over.description ?? null,
  priority: over.priority ?? 100,
  enabled: over.enabled ?? true,
  rule: over.rule,
})

beforeAll(async () => {
  org = await createTenant('approval-policies')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
  memberSession = { organizationId: org.organizationId, userId: org.memberId, timezone: 'Europe/London' }
  viewerSession = { organizationId: org.organizationId, userId: org.viewerId, timezone: 'Europe/London' }

  // A manager: the role that *can* decide approvals, which is what makes it the right
  // subject for "the policy named a role above yours". A member is refused earlier, by the
  // permission check, and would not exercise this at all.
  await adminSql()`DELETE FROM users WHERE lower(email) = 'manager.approval-policies@fixture.example'`
  const [user] = await adminSql()<{ id: string }[]>`
    INSERT INTO users (email, name, timezone, is_demo)
    VALUES ('manager.approval-policies@fixture.example', 'Manager Policies', 'Europe/London', true) RETURNING id`
  managerId = user!.id
  await adminSql()`
    INSERT INTO memberships (organization_id, user_id, role, is_demo)
    VALUES (${org.organizationId}, ${managerId}, 'manager', true)`
  managerSession = { organizationId: org.organizationId, userId: managerId, timezone: 'Europe/London' }
})

afterAll(async () => {
  await destroyTenant('approval-policies')
  await adminSql()`DELETE FROM users WHERE id = ${managerId}`
  await closePools()
})

describe('a policy can only tighten', () => {
  it('never removes the approval the product already required', async () => {
    // There is no `allow` effect, and this is the assertion that says so: with a rule set
    // that matches and asks for nothing stricter, a plan with writes is still held.
    const outcome = evaluateApprovalPolicies(
      [policy({ rule: { match: { minRisk: 'low' }, require: { slaHours: 168 }, effect: 'require' } })],
      { tools: ['create_task@v1'], writes: 3, riskTier: 'low', actorType: 'agent' },
    )
    expect(outcome.requiresApproval).toBe(true)
    // And a rule cannot lengthen a deadline past the default either.
    expect(outcome.slaHours).toBe(4)
  })

  it('holds a write even when no rule matches at all', async () => {
    const outcome = evaluateApprovalPolicies([], {
      tools: ['create_task@v1'],
      writes: 1,
      riskTier: 'low',
      actorType: 'agent',
    })
    expect(outcome.requiresApproval).toBe(true)
    expect(outcome.policyId).toBeNull()
  })

  it('takes the strictest of each requirement when several match', async () => {
    const outcome = evaluateApprovalPolicies(
      [
        policy({ id: 'a', name: 'Managers', priority: 10, rule: { match: { minWrites: 1 }, require: { approverRole: 'manager', slaHours: 8 }, effect: 'require' } }),
        policy({ id: 'b', name: 'Owners for bulk', priority: 20, rule: { match: { minWrites: 20 }, require: { approverRole: 'owner' }, effect: 'require' } }),
        policy({ id: 'c', name: 'Fast', priority: 30, rule: { match: { minRisk: 'low' }, require: { slaHours: 2 }, effect: 'require' } }),
      ],
      { tools: ['create_task@v1'], writes: 25, riskTier: 'low', actorType: 'agent' },
    )
    expect(outcome.approverRole).toBe('owner')
    expect(outcome.slaHours).toBe(2)
    expect(outcome.matched.map((m) => m.name)).toEqual(['Managers', 'Owners for bulk', 'Fast'])
  })

  it('lets a deny win, and a deny is not a card somebody can approve', async () => {
    const outcome = evaluateApprovalPolicies(
      [
        policy({ id: 'd', name: 'No autopilot', priority: 5, rule: { match: { mode: 'autopilot', minRisk: 'high' }, effect: 'deny' } }),
        policy({ id: 'e', name: 'Managers', priority: 10, rule: { match: { minWrites: 1 }, require: { approverRole: 'manager' }, effect: 'require' } }),
      ],
      { tools: ['send_email@v1'], writes: 1, riskTier: 'high', actorType: 'agent', mode: 'autopilot' },
    )
    expect(outcome.denied).toBe(true)
    expect(outcome.requiresApproval).toBe(false)
    expect(outcome.reason).toMatch(/No autopilot/)
  })

  it('treats a rule that matches on nothing as inert rather than universal', async () => {
    // A rule with an empty match would otherwise catch every plan, including read-only ones.
    const outcome = evaluateApprovalPolicies(
      [policy({ name: 'Oops', rule: { match: {}, effect: 'deny' } })],
      { tools: [], writes: 0, riskTier: 'read', actorType: 'user' },
    )
    expect(outcome.denied).toBe(false)
    expect(outcome.matched).toHaveLength(0)
  })

  it('ignores a rule that is switched off', async () => {
    const outcome = evaluateApprovalPolicies(
      [policy({ name: 'Off', enabled: false, rule: { match: { minWrites: 1 }, require: { approverRole: 'owner' }, effect: 'require' } })],
      { tools: ['create_task@v1'], writes: 5, riskTier: 'low', actorType: 'agent' },
    )
    expect(outcome.approverRole).toBeNull()
    // Still held: switching a rule off returns to the default, it does not let things through.
    expect(outcome.requiresApproval).toBe(true)
  })
})

describe('an approval says why it is being asked, and routes by it', () => {
  it('records the deciding policy and the role it named', async () => {
    const id = await withTenant(memberSession, async (ctx) =>
      createApproval(ctx, await loadActor(ctx), {
        title: 'Send the renewal note',
        riskTier: 'high',
        preview: PREVIEW,
        evidence: [],
        requestedByLabel: 'A member',
        approverRole: 'manager',
        policyReason: 'The “External communication” policy requires a manager to decide this.',
        slaHours: 4,
      }),
    )
    const view = await withTenant(session, async (ctx) => getApproval(ctx, await loadActor(ctx), id))
    expect(view.approverRole).toBe('manager')
    expect(view.policyReason).toMatch(/requires a manager/)
    // Routed by role rather than to the member who asked: `approver_user_id` was defaulting
    // to the requester, which is how "external mail needs a manager" became "the member who
    // asked may approve it".
    expect(view.approverUserId).toBeNull()
  })

  it('keeps the requester as approver when they already hold the role', async () => {
    const id = await withTenant(session, async (ctx) =>
      createApproval(ctx, await loadActor(ctx), {
        title: 'Owner proposes something',
        riskTier: 'low',
        preview: PREVIEW,
        evidence: [],
        requestedByLabel: 'The owner',
        approverRole: 'manager',
      }),
    )
    const view = await withTenant(session, async (ctx) => getApproval(ctx, await loadActor(ctx), id))
    expect(view.approverUserId).toBe(org.ownerId)
  })

  it('expires at its deadline rather than six times it', async () => {
    const id = await withTenant(session, async (ctx) =>
      createApproval(ctx, await loadActor(ctx), {
        title: 'Something with a deadline',
        riskTier: 'low',
        preview: PREVIEW,
        evidence: [],
        requestedByLabel: 'The owner',
        slaHours: 4,
      }),
    )
    const [row] = await adminSql()<{ hours: number }[]>`
      SELECT EXTRACT(EPOCH FROM (expires_at - created_at)) / 3600 AS hours
      FROM approvals WHERE id = ${id}`
    expect(Math.round(row!.hours)).toBe(4)
  })
})

describe('who may decide', () => {
  it('refuses somebody whose role is below what the policy named', async () => {
    const id = await withTenant(memberSession, async (ctx) =>
      createApproval(ctx, await loadActor(ctx), {
        title: 'Needs an owner',
        riskTier: 'low',
        preview: PREVIEW,
        evidence: [],
        requestedByLabel: 'A member',
        approverRole: 'owner',
      }),
    )
    // A manager can decide approvals in general, so this is the check that bites: the
    // column was written and never consulted, so a card saying "an owner decides" could be
    // cleared by any manager who could reach it.
    await expect(
      withTenant(managerSession, async (ctx) =>
        decideApproval(ctx, await loadActor(ctx), { approvalId: id, decision: 'approve' }),
      ),
    ).rejects.toThrow(/requires a owner to decide|requires an owner to decide/i)

    const decided = await withTenant(session, async (ctx) =>
      decideApproval(ctx, await loadActor(ctx), { approvalId: id, decision: 'approve' }),
    )
    expect(decided.status).toBe('approved')
  })

  it('will not let a person clear their own high-risk request, whatever their role', async () => {
    // This used to bind `member` alone, so an owner could self-approve an irreversible
    // action they had proposed themselves.
    const id = await withTenant(session, async (ctx) =>
      createApproval(ctx, await loadActor(ctx), {
        title: 'The owner proposes something irreversible',
        riskTier: 'high',
        preview: PREVIEW,
        evidence: [],
        requestedByLabel: 'The owner',
      }),
    )
    await expect(
      withTenant(session, async (ctx) =>
        decideApproval(ctx, await loadActor(ctx), { approvalId: id, decision: 'approve' }),
      ),
    ).rejects.toThrow(/proposed this yourself/i)
  })

  it('still lets a person decide what their own agent proposed', async () => {
    // Not self-approval: the person did not propose it, their agent did, and a human
    // deciding what their agent suggested is the entire design (§5.1).
    const id = await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      return createApproval(ctx, { ...actor, type: 'agent' }, {
        title: 'The agent proposes something irreversible',
        riskTier: 'high',
        preview: PREVIEW,
        evidence: [],
        requestedByLabel: 'Superwork',
      })
    })
    const decided = await withTenant(session, async (ctx) =>
      decideApproval(ctx, await loadActor(ctx), { approvalId: id, decision: 'approve' }),
    )
    expect(decided.status).toBe('approved')
  })
})

describe('who may read one at all', () => {
  it('does not show an approval to somebody with no part in it', async () => {
    // `listApprovals` and `getApproval` accepted an actor and never used it, so anybody
    // signed in could read every approval — and a preview is the draft itself: recipients,
    // subject lines, bodies, amounts.
    const id = await withTenant(memberSession, async (ctx) =>
      createApproval(ctx, await loadActor(ctx), {
        title: 'A member’s private draft',
        riskTier: 'low',
        preview: PREVIEW,
        evidence: [],
        requestedByLabel: 'A member',
      }),
    )

    const seen = await withTenant(viewerSession, async (ctx) =>
      (await listApprovals(ctx, await loadActor(ctx))).map((a) => a.id),
    )
    expect(seen).not.toContain(id)

    // Absence, not denial (§3.2).
    await expect(
      withTenant(viewerSession, async (ctx) => getApproval(ctx, await loadActor(ctx), id)),
    ).rejects.toThrow(NotFoundError)

    // The person who asked still sees their own.
    const mine = await withTenant(memberSession, async (ctx) =>
      (await listApprovals(ctx, await loadActor(ctx))).map((a) => a.id),
    )
    expect(mine).toContain(id)
  })

  it('shows one routed to a role to everybody who holds it', async () => {
    const id = await withTenant(memberSession, async (ctx) =>
      createApproval(ctx, await loadActor(ctx), {
        title: 'Waiting for any manager',
        riskTier: 'low',
        preview: PREVIEW,
        evidence: [],
        requestedByLabel: 'A member',
        approverRole: 'manager',
      }),
    )
    const asOwner = await withTenant(session, async (ctx) =>
      (await listApprovals(ctx, await loadActor(ctx))).map((a) => a.id),
    )
    expect(asOwner).toContain(id)

    const asViewer = await withTenant(viewerSession, async (ctx) =>
      (await listApprovals(ctx, await loadActor(ctx))).map((a) => a.id),
    )
    expect(asViewer).not.toContain(id)
  })
})

describe('writing a rule', () => {
  it('needs a password at the keyboard', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        savePolicy(
          ctx,
          await loadActor(ctx),
          { name: 'Something', rule: { match: { minWrites: 5 }, require: { approverRole: 'manager' }, effect: 'require' } },
          ['create_task@v1'],
        ),
      ),
    ).rejects.toThrow(StepUpRequiredError)
  })

  it('refuses a rule naming a tool that does not exist', async () => {
    // A rule that silently matches nothing is worse than no rule: it reads as protection.
    await expect(
      withTenant(session, async (ctx) => {
        const actor = await loadActor(ctx)
        return savePolicy(
          ctx,
          { ...actor, steppedUpAt: new Date() },
          { name: 'Guard the invented tool', rule: { match: { tools: ['wire_transfer@v9'] }, require: { approverRole: 'owner' }, effect: 'require' } },
          ['create_task@v1', 'send_email@v1'],
        )
      }),
    ).rejects.toThrow(/No tool called "wire_transfer@v9"/)
  })

  it('refuses a rule that would match everything', async () => {
    await expect(
      withTenant(session, async (ctx) => {
        const actor = await loadActor(ctx)
        return savePolicy(
          ctx,
          { ...actor, steppedUpAt: new Date() },
          { name: 'Catch all', rule: { match: {}, effect: 'deny' } },
          ['create_task@v1'],
        )
      }),
    ).rejects.toThrow(ValidationError)
  })

  it('saves a real one, and the evaluator picks it up', async () => {
    const saved = await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      return savePolicy(
        ctx,
        { ...actor, steppedUpAt: new Date() },
        {
          name: 'Contract changes need an owner',
          description: 'Anything touching a signed contract gets a second pair of eyes.',
          rule: { match: { tools: ['send_email@v1'] }, require: { approverRole: 'owner', slaHours: 2 }, effect: 'require' },
          priority: 15,
        },
        ['create_task@v1', 'send_email@v1'],
      )
    })
    expect(saved.enabled).toBe(true)

    const outcome = evaluateApprovalPolicies(
      await withTenant(session, async (ctx) => approvalPolicies(ctx)),
      { tools: ['send_email@v1'], writes: 1, riskTier: 'high', actorType: 'agent' },
    )
    expect(outcome.approverRole).toBe('owner')
    expect(outcome.slaHours).toBe(2)
  })

  it('will not switch one off without a reason, and records who did', async () => {
    const [target] = await withTenant(session, async (ctx) => approvalPolicies(ctx))

    await expect(
      withTenant(session, async (ctx) => {
        const actor = await loadActor(ctx)
        return setPolicyEnabled(ctx, { ...actor, steppedUpAt: new Date() }, {
          policyId: target!.id,
          enabled: false,
          reason: '   ',
        })
      }),
    ).rejects.toThrow(ValidationError)

    const off = await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      return setPolicyEnabled(ctx, { ...actor, steppedUpAt: new Date() }, {
        policyId: target!.id,
        enabled: false,
        reason: 'Superseded by the new delegation matrix.',
      })
    })
    expect(off.enabled).toBe(false)

    // The audit diff is per field — { reason: { from, to } } — not a before/after pair.
    const [entry] = await adminSql()<{ action: string; diff: { reason: { to: string } } }[]>`
      SELECT action, diff FROM audit_logs
      WHERE organization_id = ${org.organizationId} AND action = 'approval_policy.disabled'
      ORDER BY occurred_at DESC LIMIT 1`
    expect(entry?.diff.reason.to).toMatch(/delegation matrix/)
  })

  it('is refused to somebody who does not administer the organization', async () => {
    await expect(
      withTenant(memberSession, async (ctx) => {
        const actor = await loadActor(ctx)
        return savePolicy(
          ctx,
          { ...actor, steppedUpAt: new Date() },
          { name: 'A member tries', rule: { match: { minWrites: 2 }, require: { approverRole: 'manager' }, effect: 'require' } },
          ['create_task@v1'],
        )
      }),
    ).rejects.toThrow(PermissionError)
  })
})

describe('policies belong to one organization', () => {
  it('does not evaluate another tenant’s rules', async () => {
    const other = await createTenant('approval-policies-other')
    const otherSession = { organizationId: other.organizationId, userId: other.ownerId, timezone: 'Europe/London' }
    const theirs = await withTenant(otherSession, async (ctx) => approvalPolicies(ctx))
    expect(theirs).toHaveLength(0)
    await destroyTenant('approval-policies-other')
  })
})
