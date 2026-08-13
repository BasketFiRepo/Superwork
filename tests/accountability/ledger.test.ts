import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  diffPersona,
  exportPersonalRecord,
  ledgerReport,
  ledgerRuns,
  listDisclosures,
  monthPeriod,
  personalRecord,
  recordDisclosure,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Phase 3's first and third acceptance criteria (§24):
 *
 *   "an admin can answer, from the UI alone, exactly what the AI read, proposed, executed
 *    and cost last month — per department"
 *   "every employee can open one screen showing what is tracked about them and what was
 *    reported to whom"
 *
 * A day of agent activity is constructed with known contents, and every figure the ledger
 * reports is checked against it. The personal record is checked for the two properties
 * that matter: it is self-service only, and a disclosure appears the moment one is written.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
const TZ = 'Europe/London'

const AUDIT = {
  runs: 3,
  citations: 5,
  plannedSteps: 4,
  executedActions: 2,
  failedActions: 1,
  approvals: 2,
  approvalsApproved: 1,
  undone: 1,
  costCents: 12.5,
}

beforeAll(async () => {
  org = await createTenant('ledger')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }

  await withTenant(session, async (ctx) => {
    const [department] = await ctx.sql<{ id: string }[]>`
      INSERT INTO departments (organization_id, name, path, is_demo, created_by)
      VALUES (${ctx.organizationId}, 'Operations', 'operations', true, ${org.ownerId})
      RETURNING id`
    await ctx.sql`
      UPDATE memberships SET department_id = ${department!.id}
      WHERE organization_id = ${ctx.organizationId} AND user_id = ${org.ownerId}`

    // The fixture seeds one run of its own; this test audits a day it controls entirely.
    await ctx.sql`
      DELETE FROM agent_runs WHERE organization_id = ${ctx.organizationId} AND id = ${org.runId}`

    const runIds: string[] = []
    for (let index = 0; index < AUDIT.runs; index += 1) {
      const [run] = await ctx.sql<{ id: string }[]>`
        INSERT INTO agent_runs (
          organization_id, principal_user_id, mode, status, request, trace_id,
          plan, cost_cents, contains_untrusted_content, undone_at, is_demo, created_by
        ) VALUES (
          ${ctx.organizationId}, ${org.ownerId}, 'execute', 'succeeded',
          ${`ledger run ${index}`}, ${`trace-ledger-${index}`},
          ${ctx.sql.json({
            plan: {
              steps:
                index === 0
                  ? [
                      { id: 'a', tool: 'create_task', args: {}, intent: '' },
                      { id: 'b', tool: 'create_task', args: {}, intent: '' },
                      { id: 'c', tool: 'draft_email', args: {}, intent: '' },
                    ]
                  : index === 1
                    ? [{ id: 'd', tool: 'create_task', args: {}, intent: '' }]
                    : [],
            },
          } as never)},
          ${index === 0 ? AUDIT.costCents : 0}, ${index === 2}, ${index === 2 ? new Date() : null},
          true, ${org.ownerId}
        ) RETURNING id`
      runIds.push(run!.id)
    }

    for (let index = 0; index < AUDIT.citations; index += 1) {
      await ctx.sql`
        INSERT INTO citations (organization_id, run_id, claim, source_type, document_id, is_demo, created_by)
        VALUES (${ctx.organizationId}, ${runIds[0]!}, ${`claim ${index}`}, 'document_chunk',
                ${org.documentId}, true, ${org.ownerId})`
    }

    // Two executed actions and one failure — the executed column counts successes only.
    await ctx.sql`
      INSERT INTO tool_calls (organization_id, run_id, tool_name, risk_tier, ok, idempotency_key, args_hash, is_demo, created_by)
      VALUES
        (${ctx.organizationId}, ${runIds[0]!}, 'create_task@v1', 'low', true, 'k1', 'h1', true, ${org.ownerId}),
        (${ctx.organizationId}, ${runIds[0]!}, 'create_task@v1', 'low', true, 'k2', 'h2', true, ${org.ownerId}),
        (${ctx.organizationId}, ${runIds[1]!}, 'draft_email@v1', 'low', false, 'k3', 'h3', true, ${org.ownerId}),
        (${ctx.organizationId}, ${runIds[1]!}, 'search_knowledge@v1', 'read', true, 'k4', 'h4', true, ${org.ownerId})`

    await ctx.sql`
      INSERT INTO approvals (
        organization_id, title, kind, status, risk_tier, agent_run_id, is_demo, created_by
      ) VALUES
        (${ctx.organizationId}, 'plan one', 'agent_plan', 'approved', 'low', ${runIds[0]!}, true, ${org.ownerId}),
        (${ctx.organizationId}, 'plan two', 'agent_plan', 'pending', 'low', ${runIds[1]!}, true, ${org.ownerId})`
  })
})

afterAll(async () => {
  await destroyTenant(org.organizationId)
  await closePools()
})

describe('the AI ledger', () => {
  it('counts what was read, proposed, executed and cost, per department', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx, org.ownerId)
      const report = await ledgerReport(ctx, actor, monthPeriod(new Date(), TZ))
      const operations = report.departments.find((department) => department.departmentName === 'Operations')

      expect(operations, 'the ledger must have an Operations row').toBeDefined()
      expect(operations!.runs).toBe(AUDIT.runs)
      expect(operations!.passagesRead).toBe(AUDIT.citations)
      expect(operations!.distinctDocumentsRead).toBe(1)
      expect(operations!.stepsProposed).toBe(AUDIT.plannedSteps)
      expect(operations!.actionsExecuted).toBe(AUDIT.executedActions)
      expect(operations!.approvalsRequested).toBe(AUDIT.approvals)
      expect(operations!.approvalsApproved).toBe(AUDIT.approvalsApproved)
      expect(operations!.runsUndone).toBe(AUDIT.undone)
      expect(operations!.runsWithUntrustedContent).toBe(1)
      expect(operations!.costCents).toBeCloseTo(AUDIT.costCents, 4)
    })
  })

  it('lines up proposed against executed for the same tool', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx, org.ownerId)
      const report = await ledgerReport(ctx, actor, monthPeriod(new Date(), TZ))
      const operations = report.departments.find((department) => department.departmentName === 'Operations')!
      const createTask = operations.toolsProposed.find((tool) => tool.tool === 'create_task')

      // Plans name the tool, calls name the version. The screen compares like with like.
      expect(createTask).toBeDefined()
      expect(createTask!.proposed).toBe(3)
      expect(createTask!.executed).toBe(2)

      const draft = operations.toolsProposed.find((tool) => tool.tool === 'draft_email')!
      expect(draft.failed).toBe(AUDIT.failedActions)
    })
  })

  it('offers no per-person breakdown at all', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx, org.ownerId)
      const report = await ledgerReport(ctx, actor, monthPeriod(new Date(), TZ))
      const serialised = JSON.stringify(report)
      // Ranking colleagues by AI usage is the report §29.5 prohibits. The shape of the
      // result is the enforcement: there is nowhere to put a person.
      expect(Object.keys(report.departments[0] ?? {})).not.toContain('byUser')
      expect(serialised).not.toContain(org.memberId)
    })
  })

  it('opens the runs behind a number', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx, org.ownerId)
      const report = await ledgerReport(ctx, actor, monthPeriod(new Date(), TZ))
      const operations = report.departments.find((department) => department.departmentName === 'Operations')!
      const runs = await ledgerRuns(ctx, actor, {
        departmentId: operations.departmentId,
        period: monthPeriod(new Date(), TZ),
      })
      expect(runs).toHaveLength(AUDIT.runs)
      expect(runs.every((run) => run.request.startsWith('ledger run'))).toBe(true)
    })
  })

  it('states the basis of its figures', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx, org.ownerId)
      const report = await ledgerReport(ctx, actor, monthPeriod(new Date(), TZ))
      expect(report.basis).toMatch(/agent runs, citations, tool calls/i)
      expect(report.basis).toContain(TZ)
    })
  })
})

describe('the personal record', () => {
  it('cannot be opened for anybody else, by anybody', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx, org.ownerId)
      // The owner is the most privileged role there is.
      await expect(personalRecord(ctx, actor, org.memberId)).rejects.toThrow(/what is held about you/i)
      await expect(listDisclosures(ctx, actor, org.memberId)).rejects.toThrow(/only read the disclosure record for yourself/i)
    })
  })

  it('shows a disclosure as soon as one is written', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx, org.memberId)
      const before = await personalRecord(ctx, actor, org.memberId)
      expect(before.disclosures).toHaveLength(0)

      await recordDisclosure(ctx, {
        subjectUserId: org.memberId,
        recipientUserId: org.ownerId,
        recipientLabel: 'Weekly digest for the owner',
        kind: 'weekly_digest',
        summary: '2 tasks assigned to you appeared in a digest.',
        fields: ['tasks assigned'],
      })

      const after = await personalRecord(ctx, actor, org.memberId)
      expect(after.disclosures).toHaveLength(1)
      expect(after.disclosures[0]!.recipientLabel).toContain('Weekly digest')
    })
  })

  it('refuses to record an export without a named authorization', async () => {
    await withTenant(session, async (ctx) => {
      await expect(
        recordDisclosure(ctx, {
          subjectUserId: org.memberId,
          recipientUserId: org.ownerId,
          recipientLabel: 'HR',
          kind: 'export',
          summary: 'Activity file',
        }),
      ).rejects.toThrow(/named authorization/i)
    })
  })

  it('records the subject downloading their own record', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx, org.memberId)
      const exported = await exportPersonalRecord(ctx, actor)
      expect(exported.subject.id).toBe(org.memberId)
      expect(Object.keys(exported.rows)).toContain('agentRuns')

      const disclosures = await listDisclosures(ctx, actor, org.memberId)
      expect(disclosures.some((disclosure) => disclosure.kind === 'export')).toBe(true)
    })
  })

  it('states what is never collected', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx, org.memberId)
      const record = await personalRecord(ctx, actor, org.memberId)
      const text = record.neverCollected.join(' ').toLowerCase()
      expect(text).toContain('productivity score')
      expect(text).toContain('keystrokes')
      expect(text).toContain('covert')
      expect(text).toContain('private messages')
    })
  })
})

describe('persona diffs', () => {
  const base = {
    name: 'Watcher',
    purpose: 'Watch things.',
    ownerUserId: 'u1',
    scopeDepartmentId: 'd1',
    mode: 'assist' as const,
    toolGrants: ['create_task@v1'],
    dataScopes: [],
    maxSensitivity: 'internal' as const,
    scheduleCron: null,
    escalationUserId: null,
    autopilotDailyActionCap: 5,
    autopilotWeeklyCostCapCents: 200,
    digestDay: 1,
  }

  it('flags a widened mode, clearance, grant, cap and scope', () => {
    const changes = diffPersona(base, {
      ...base,
      mode: 'autopilot',
      maxSensitivity: 'confidential',
      toolGrants: ['create_task@v1', 'send_email@v1'],
      autopilotDailyActionCap: 50,
      scopeDepartmentId: null,
    })
    const widened = changes.filter((change) => change.widens).map((change) => change.field)
    expect(widened).toEqual(
      expect.arrayContaining(['mode', 'maxSensitivity', 'toolGrants', 'autopilotDailyActionCap', 'scopeDepartmentId']),
    )
  })

  it('does not flag a narrowing as a widening', () => {
    const changes = diffPersona(base, {
      ...base,
      mode: 'ask',
      toolGrants: [],
      autopilotDailyActionCap: 1,
    })
    expect(changes.every((change) => !change.widens)).toBe(true)
  })

  it('reports nothing when nothing changed', () => {
    expect(diffPersona(base, { ...base })).toEqual([])
  })
})
