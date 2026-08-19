import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { asAgent, can, loadActor } from '@superwork/auth'
import {
  agentGrants,
  createTask,
  monitoringPolicy,
  nudgeBudget,
  PermissionError,
  removeAgentGrant,
  scheduleLadder,
  setAgentGrant,
  setMonitoringPolicy,
  StepUpRequiredError,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * The two ceilings an admin could see and not set (§4.4, §29.5).
 *
 * `monitoring_policies` decides how hard the system may chase people; nothing but the seed
 * had ever written it, and the no-surprises window was displayed from the row while being
 * enforced from the jurisdiction profile constant. `agent_permissions` is the ceiling on
 * every agent, with two hollow columns: `effect = 'deny'` rows were filtered out by the
 * actor loader and had never denied anything, and `max_sensitivity` was never read.
 *
 * And the agent's own refusal says "An admin can add it in Settings → AI governance" — a
 * screen that listed the grants and had no control on it.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string; steppedUpAt?: Date }
let stepped: { organizationId: string; userId: string; timezone: string; steppedUpAt: Date }

beforeAll(async () => {
  org = await createTenant('governance-controls')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
  stepped = { ...session, steppedUpAt: new Date() }

  // A legal entity, so the jurisdiction profile is a real answer rather than the default.
  await adminSql()`
    INSERT INTO legal_entities (organization_id, name, country, jurisdiction_profile, is_demo, created_by)
    VALUES (${org.organizationId}, 'Fixture GmbH', 'DE', 'gdpr', true, ${org.ownerId})`
})

afterAll(async () => {
  await destroyTenant('governance-controls')
  await closePools()
})

describe('how hard this system may chase people', () => {
  it('answers with the jurisdiction’s own numbers before anybody sets anything', async () => {
    const policy = await withTenant(session, async (ctx) => monitoringPolicy(ctx, await loadActor(ctx)))
    expect(policy.jurisdictionProfile).toBe('gdpr')
    expect(policy.nudgeBudgetPerPersonPerDay).toBe(policy.ceiling.nudgeBudgetPerPersonPerDay)
    expect(policy.noSurprisesReviewHours).toBe(policy.ceiling.noSurprisesReviewHours)
  })

  it('lets an organization ask for fewer contacts, and records who and why', async () => {
    const after = await withTenant(session, async (ctx) =>
      setMonitoringPolicy(ctx, await loadActor(ctx), {
        nudgeBudgetPerPersonPerDay: 1,
        reason: 'Works council asked for a quieter cadence.',
      }),
    )
    expect(after.nudgeBudgetPerPersonPerDay).toBe(1)
    expect(after.setByName).toBeTruthy()
    expect(after.reason).toMatch(/quieter cadence/i)

    // The number the ladder actually spends.
    const budget = await withTenant(session, async (ctx) => nudgeBudget(ctx, org.memberId))
    expect(budget.perDay).toBe(1)
  })

  it('refuses more contacts than the jurisdiction allows, and says the number', async () => {
    const refused = await withTenant(session, async (ctx) =>
      setMonitoringPolicy(ctx, await loadActor(ctx), {
        nudgeBudgetPerPersonPerDay: 19,
        reason: 'Trying to chase harder.',
      }).then(() => null, (error: Error) => error.message),
    )
    expect(refused).toMatch(/allows at most \d+ contacts/i)
    expect(refused).toMatch(/never more/i)
  })

  it('refuses a shorter review window than the jurisdiction requires', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        setMonitoringPolicy(ctx, await loadActor(ctx), {
          noSurprisesReviewHours: 1,
          reason: 'Trying to escalate sooner.',
        }),
      ),
    ).rejects.toThrow(/can give longer, never less/i)
  })

  it('enforces a longer window than the profile, which was displayed and ignored', async () => {
    // The wait read `PROFILES[...].noSurprisesReviewHours` and never this row, so an
    // organization that gave its people longer saw its own number and had the shorter one
    // applied.
    const policy = await withTenant(session, async (ctx) =>
      setMonitoringPolicy(ctx, await loadActor(ctx), {
        noSurprisesReviewHours: 96,
        reason: 'People get four days to answer before anything goes past them.',
      }),
    )
    expect(policy.noSurprisesReviewHours).toBe(96)

    const outcome = await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      // Four days late, so the rung that fits is the one that tells whoever is waiting.
      // At six the ladder reaches for the manager rung, which this fixture has nobody for.
      const task = await createTask(ctx, actor, {
        title: 'Something late',
        assigneeId: org.memberId,
        dueAt: new Date(Date.now() - 4 * 86_400_000),
      })
      // The owner was contacted an hour ago: inside the organization's window, outside the
      // profile's shorter one.
      await ctx.sql`
        INSERT INTO nudges (
          organization_id, recipient_user_id, subject_type, subject_id, stage, channel, message,
          scheduled_for, delivered_at, created_by
        ) VALUES (
          ${ctx.organizationId}, ${org.memberId}, 'task', ${task.id}, 2, 'in_app', 'Still open',
          now() - interval '1 hour', now() - interval '1 hour', ${org.ownerId}
        )`
      // A dependant, so the waiter rung has somebody to address.
      const waiting = await createTask(ctx, actor, { title: 'Waiting on it', assigneeId: org.viewerId })
      await ctx.sql`
        INSERT INTO task_dependencies (organization_id, task_id, depends_on_task_id, created_by)
        VALUES (${ctx.organizationId}, ${waiting.id}, ${task.id}, ${org.ownerId})`
      return scheduleLadder(ctx, {
        recipientUserId: org.memberId,
        subjectType: 'task',
        subjectId: task.id,
        subjectLabel: 'Something late',
        dueAt: new Date(Date.now() - 4 * 86_400_000),
      })
    })
    expect(outcome.scheduled).toBe(0)
    expect(outcome.skipped).toMatch(/96h to answer first/i)
    expect(outcome.skipped).toMatch(/longer than its profile requires/i)
  })

  it('will not be changed without a reason, or by somebody who is not an admin', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        setMonitoringPolicy(ctx, await loadActor(ctx), { nudgeBudgetPerPersonPerDay: 2, reason: ' ' }),
      ),
    ).rejects.toThrow(ValidationError)

    await expect(
      withTenant({ ...session, userId: org.memberId }, async (ctx) =>
        setMonitoringPolicy(ctx, await loadActor(ctx), {
          nudgeBudgetPerPersonPerDay: 2,
          reason: 'A member trying to change it.',
        }),
      ),
    ).rejects.toThrow(PermissionError)
  })

  it('states the five things no setting can turn on, and refuses all five', async () => {
    const policy = await withTenant(session, async (ctx) => monitoringPolicy(ctx, await loadActor(ctx)))
    expect(policy.prohibited).toHaveLength(5)

    // And the database refuses them, which is what makes the sentence true. This tried exactly
    // one of the five until the column detector pointed out that the other four were a claim
    // nothing checked — a guarantee asserted for a fifth of itself is a guarantee by adjacency.
    //
    // Each column is named in full rather than interpolated, so the detector can see that
    // something tries to defeat the pin. A test written the other way is a test the instrument
    // cannot count, which is how the gap got here in the first place.
    const org_ = org.organizationId
    const attempts: [string, () => Promise<unknown>][] = [
      ['individual_scoring_enabled', () =>
        adminSql()`UPDATE monitoring_policies SET individual_scoring_enabled = true WHERE organization_id = ${org_}`],
      ['screen_or_keystroke_monitoring', () =>
        adminSql()`UPDATE monitoring_policies SET screen_or_keystroke_monitoring = true WHERE organization_id = ${org_}`],
      ['covert_monitoring', () =>
        adminSql()`UPDATE monitoring_policies SET covert_monitoring = true WHERE organization_id = ${org_}`],
      ['automated_employment_decisions', () =>
        adminSql()`UPDATE monitoring_policies SET automated_employment_decisions = true WHERE organization_id = ${org_}`],
      ['read_private_dms', () =>
        adminSql()`UPDATE monitoring_policies SET read_private_dms = true WHERE organization_id = ${org_}`],
    ]
    for (const [column, attempt] of attempts) {
      await expect(attempt(), `${column} can be turned on`).rejects.toThrow(
        /monitoring_prohibited_by_design/i,
      )
    }
  })

  it('cannot hide a disclosure from the person it is about', async () => {
    // §29.3, pinned the same way: `disclosures.visible_to_subject` can only be true, so nothing
    // about somebody can reach their manager by a route the person cannot see.
    const [disclosure] = await adminSql()<{ id: string }[]>`
      INSERT INTO disclosures (organization_id, subject_user_id, recipient_label, kind, summary)
      VALUES (${org.organizationId}, ${org.memberId}, 'Their manager', 'summary',
              'What was passed on, and to whom.')
      RETURNING id`
    await expect(
      adminSql()`
        UPDATE disclosures SET visible_to_subject = false WHERE id = ${disclosure!.id}`,
    ).rejects.toThrow(/disclosure_never_covert/i)
    // And it cannot be written that way in the first place, which is the half a later UPDATE
    // would not have caught.
    await expect(
      adminSql()`
        INSERT INTO disclosures (organization_id, subject_user_id, recipient_label, kind, summary,
                                 visible_to_subject)
        VALUES (${org.organizationId}, ${org.memberId}, 'Their manager', 'summary', 'Quietly.',
                false)`,
    ).rejects.toThrow(/disclosure_never_covert/i)
  })
})

describe('what agents may do here', () => {
  it('asks for the password again before widening anything', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        setAgentGrant(ctx, await loadActor(ctx), {
          capability: 'email',
          toolPattern: 'email:draft',
          effect: 'allow',
          reason: 'Support may draft replies.',
        }),
      ),
    ).rejects.toThrow(StepUpRequiredError)
  })

  it('records a line, with who granted it and why', async () => {
    const grants = await withTenant(stepped, async (ctx) =>
      setAgentGrant(ctx, await loadActor(ctx), {
        capability: 'email',
        toolPattern: 'email:draft',
        effect: 'allow',
        reason: 'Support may draft replies; nothing sends without a person.',
      }),
    )
    const line = grants.find((row) => row.toolPattern === 'email:draft')
    expect(line?.effect).toBe('allow')
    expect(line?.grantedByName).toBeTruthy()
    expect(line?.reason).toMatch(/nothing sends/i)
  })

  it('keeps one line per capability, pattern and scope', async () => {
    await withTenant(stepped, async (ctx) =>
      setAgentGrant(ctx, await loadActor(ctx), {
        capability: 'email',
        toolPattern: 'email:draft',
        effect: 'allow',
        reason: 'Restated with a clearer reason.',
      }),
    )
    const grants = await withTenant(session, async (ctx) => agentGrants(ctx, await loadActor(ctx)))
    expect(grants.filter((row) => row.toolPattern === 'email:draft')).toHaveLength(1)
  })

  it('makes a deny actually deny, which it never did', async () => {
    // `asAgent` filtered for effect = 'allow' and dropped the rest, so a deny row had never
    // refused anything.
    await withTenant(stepped, async (ctx) =>
      setAgentGrant(ctx, await loadActor(ctx), {
        capability: 'email',
        toolPattern: 'email:send',
        effect: 'deny',
        reason: 'Nothing leaves this company without a person pressing send.',
      }),
    )

    const decision = await withTenant(session, async (ctx) => {
      const actor = await asAgent(ctx, await loadActor(ctx), {
        agentId: '00000000-0000-0000-0000-0000000000aa',
        agentName: 'Fixture agent',
        mode: 'execute',
        toolGrants: ['send_email@v1'],
        maxSensitivity: 'confidential',
      })
      return can(actor, 'email:send', {
        type: 'email',
        organizationId: ctx.organizationId,
        riskTier: 'high',
      })
    })
    expect(decision.allow).toBe(false)
    expect(decision.reason).toMatch(/does not let agents do email:send/i)
  })

  it('caps what an agent may read at the lowest grant, not at its own setting', async () => {
    await withTenant(stepped, async (ctx) =>
      setAgentGrant(ctx, await loadActor(ctx), {
        capability: 'knowledge',
        toolPattern: 'knowledge:read',
        effect: 'allow',
        maxSensitivity: 'public',
        reason: 'Agents read public material only while we trial this.',
      }),
    )
    const capability = await withTenant(session, async (ctx) => {
      const actor = await asAgent(ctx, await loadActor(ctx), {
        agentId: '00000000-0000-0000-0000-0000000000aa',
        agentName: 'Fixture agent',
        mode: 'ask',
        toolGrants: ['search_knowledge@v1'],
        // The agent asks for confidential; the organization's lowest line says public.
        maxSensitivity: 'confidential',
      })
      return actor.agent!.maxSensitivity
    })
    expect(capability).toBe('public')
  })

  it('refuses a grant naming another organization’s department', async () => {
    const other = await createTenant('governance-controls-other')
    const [theirs] = await adminSql()<{ id: string }[]>`
      INSERT INTO departments (organization_id, name, path, depth, timezone, is_demo)
      VALUES (${other.organizationId}, 'Theirs', 'Theirs', 0, 'Europe/London', true) RETURNING id`
    await expect(
      withTenant(stepped, async (ctx) =>
        setAgentGrant(ctx, await loadActor(ctx), {
          capability: 'crm',
          toolPattern: 'crm:*',
          effect: 'allow',
          departmentId: theirs!.id,
          reason: 'Pointing at somebody else’s department.',
        }),
      ),
    ).rejects.toThrow(/same organization/i)
    await destroyTenant('governance-controls-other')
  })

  it('refuses a capability or pattern that is not one', async () => {
    await expect(
      withTenant(stepped, async (ctx) =>
        setAgentGrant(ctx, await loadActor(ctx), {
          capability: 'Email Things!',
          toolPattern: '*',
          effect: 'allow',
          reason: 'Nonsense capability.',
        }),
      ),
    ).rejects.toThrow(ValidationError)
  })

  it('takes a line away again, and still asks who is at the keyboard', async () => {
    const grants = await withTenant(session, async (ctx) => agentGrants(ctx, await loadActor(ctx)))
    const target = grants.find((row) => row.toolPattern === 'email:send')!

    await expect(
      withTenant(session, async (ctx) =>
        removeAgentGrant(ctx, await loadActor(ctx), { id: target.id, reason: 'No longer needed.' }),
      ),
    ).rejects.toThrow(StepUpRequiredError)

    const after = await withTenant(stepped, async (ctx) =>
      removeAgentGrant(ctx, await loadActor(ctx), { id: target.id, reason: 'No longer needed.' }),
    )
    expect(after.some((row) => row.id === target.id)).toBe(false)
  })

  it('is refused outright to somebody who is not an admin', async () => {
    await expect(
      withTenant({ ...stepped, userId: org.memberId }, async (ctx) =>
        setAgentGrant(ctx, await loadActor(ctx), {
          capability: 'crm',
          toolPattern: 'crm:*',
          effect: 'allow',
          reason: 'A member trying to widen the agents.',
        }),
      ),
    ).rejects.toThrow(PermissionError)
  })
})
