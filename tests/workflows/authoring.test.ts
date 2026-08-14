import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import { compileWorkflow } from '@superwork/ai'
import {
  activateWorkflow,
  decideApproval,
  getApproval,
  getWorkflow,
  listWorkflowRuns,
  saveCompiled,
  ValidationError,
} from '@superwork/core'
import { continueWorkflowAfterApproval, countFirings, runWorkflow, simulateWorkflow } from '@superwork/agent'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Natural-language workflow authoring (§10.3).
 *
 * The properties worth asserting are the ones that make an automation trustworthy: the
 * compiler refuses what it cannot build rather than guessing, an approval step appears
 * whether or not the sentence asked for one, the dry run reports a counted number, and
 * activation is impossible without a passing dry run *of the version being activated*.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }

beforeAll(async () => {
  org = await createTenant('wfauthor')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
})

afterAll(async () => {
  await destroyTenant('wfauthor')
  await closePools()
})

describe('the compiler', () => {
  it('turns a sentence into a schedule, a query and an action', () => {
    const compiled = compileWorkflow(
      'Every weekday at 9, find customer threads with no reply for 5 days and create a task.',
    )
    expect(compiled.unsupported).toBeNull()
    expect(compiled.graph.trigger.spec).toBe('0 9 * * 1-5')
    expect(compiled.graph.nodes.find((node) => node.type === 'query')?.ref).toBe('stale_customer_threads')
    expect(compiled.graph.nodes.some((node) => node.ref === 'create_task@v1')).toBe(true)
  })

  it('says what it cannot build instead of guessing', () => {
    const compiled = compileWorkflow('Every morning, do the needful about the renewals.')
    expect(compiled.unsupported).toMatch(/no named query|could not tell/i)
    expect(compiled.readback).toBe('')
  })

  it('adds an approval step even when the sentence said to send', () => {
    const compiled = compileWorkflow(
      'Every weekday, find customer threads that have gone quiet and send them a follow-up.',
    )
    expect(compiled.graph.nodes.some((node) => node.type === 'approval')).toBe(true)
    expect(compiled.risks.some((risk) => /never sends externally|Sending is a decision/i.test(risk.mitigation ?? ''))).toBe(
      true,
    )
    expect(compiled.readback).toMatch(/approve/i)
  })

  it('counts firings rather than estimating them', () => {
    const from = new Date('2026-01-01T00:00:00Z') // a Thursday
    const to = new Date('2026-01-31T23:59:59Z')
    // 22 weekdays in January 2026.
    expect(countFirings('0 9 * * 1-5', from, to)).toBe(22)
    expect(countFirings('0 9 * * *', from, to)).toBe(31)
  })
})

describe('the activation gate', () => {
  it('refuses to activate a workflow that has never been dry-run', async () => {
    const workflowId = await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const saved = await saveCompiled(ctx, actor, {
        description: 'Every weekday at 9, find overdue tasks and create a task.',
        compiled: compileWorkflow('Every weekday at 9, find overdue tasks and create a task.'),
      })
      return saved.id
    })

    await expect(
      withTenant(session, async (ctx) => activateWorkflow(ctx, await loadActor(ctx), { workflowId })),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('opens after a dry run, and the dry run changes nothing', async () => {
    const workflowId = await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const saved = await saveCompiled(ctx, actor, {
        description: 'Each morning, find overdue tasks and create a follow-up task.',
        compiled: compileWorkflow('Each morning, find overdue tasks and create a follow-up task.'),
      })
      return saved.id
    })

    const before = await withTenant(session, async (ctx) => {
      const [row] = await ctx.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM tasks WHERE organization_id = ${ctx.organizationId}`
      return row!.count
    })

    const outcome = await simulateWorkflow(session, { workflowId, windowDays: 30 })
    expect(outcome.simulated).toBe(true)
    expect(outcome.status).toBe('succeeded')
    expect(outcome.note).toMatch(/would have fired \d+ times/i)
    expect(outcome.agentRunId).toBeNull()

    const after = await withTenant(session, async (ctx) => {
      const [row] = await ctx.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM tasks WHERE organization_id = ${ctx.organizationId}`
      return row!.count
    })
    expect(after).toBe(before)

    const activated = await withTenant(session, async (ctx) =>
      activateWorkflow(ctx, await loadActor(ctx), { workflowId, ownerUserId: org.ownerId }),
    )
    expect(activated.status).toBe('active')
  })

  it('closes again when the workflow is edited', async () => {
    const first = compileWorkflow('Every weekday at 8, find overdue tasks and create a task.')
    const workflowId = await withTenant(session, async (ctx) => {
      const saved = await saveCompiled(ctx, await loadActor(ctx), {
        description: 'Every weekday at 8, find overdue tasks and create a task.',
        compiled: first,
      })
      return saved.id
    })
    await simulateWorkflow(session, { workflowId, windowDays: 7 })

    const edited = await withTenant(session, async (ctx) =>
      saveCompiled(ctx, await loadActor(ctx), {
        workflowId,
        description: 'Every weekday at 10, find overdue tasks and create a task.',
        compiled: compileWorkflow('Every weekday at 10, find overdue tasks and create a task.'),
      }),
    )
    expect(edited.simulatedOk).toBe(false)

    await expect(
      withTenant(session, async (ctx) => activateWorkflow(ctx, await loadActor(ctx), { workflowId })),
    ).rejects.toThrow(/dry-run this version/i)
  })

  it('records every step of the dry run, with what it would have done', async () => {
    const workflowId = await withTenant(session, async (ctx) => {
      const saved = await saveCompiled(ctx, await loadActor(ctx), {
        description: 'Each morning, find overdue tasks and create a task for the owner.',
        compiled: compileWorkflow('Each morning, find overdue tasks and create a task for the owner.'),
      })
      return saved.id
    })
    await simulateWorkflow(session, { workflowId, windowDays: 14 })

    const runs = await withTenant(session, async (ctx) =>
      listWorkflowRuns(ctx, await loadActor(ctx), { workflowId }),
    )
    expect(runs).toHaveLength(1)
    expect(runs[0]!.simulated).toBe(true)
    expect(runs[0]!.status).toBe('simulated')
    expect(runs[0]!.steps.length).toBeGreaterThanOrEqual(3)
    expect(runs[0]!.steps.some((step) => step.nodeType === 'query')).toBe(true)

    const workflow = await withTenant(session, async (ctx) => getWorkflow(ctx, await loadActor(ctx), workflowId))
    expect(workflow.simulatedOk).toBe(true)
  })
})

describe('a real run', () => {
  it('prepares work, stops for a person, and writes what the person approved', async () => {
    // A thread that has been quiet for longer than the account's SLA, so the workflow's
    // query has something real to match.
    await withTenant(session, async (ctx) => {
      const [conversation] = await ctx.sql<{ id: string }[]>`
        INSERT INTO conversations (
          organization_id, subject, company_id, status, last_message_at, last_direction, is_demo, created_by
        ) VALUES (
          ${ctx.organizationId}, 'Renewal terms', ${org.companyId}, 'open',
          now() - interval '20 days', 'inbound', true, ${org.ownerId}
        ) RETURNING id`
      await ctx.sql`
        INSERT INTO contacts (organization_id, company_id, name, emails, is_demo, created_by)
        VALUES (${ctx.organizationId}, ${org.companyId}, 'Sam Buyer', ARRAY['sam@customer.example'], true, ${org.ownerId})`
      await ctx.sql`
        INSERT INTO messages (
          organization_id, conversation_id, direction, from_name, from_address, body_text, sent_at, is_demo, created_by
        ) VALUES (
          ${ctx.organizationId}, ${conversation!.id}, 'inbound', 'Sam Buyer', 'sam@customer.example',
          'Can you confirm the renewal terms?', now() - interval '20 days', true, ${org.ownerId}
        )`
    })

    const sentence = 'Every weekday at 9, find customer threads that have gone quiet and draft a follow-up.'
    const workflowId = await withTenant(session, async (ctx) => {
      const saved = await saveCompiled(ctx, await loadActor(ctx), {
        description: sentence,
        compiled: compileWorkflow(sentence),
      })
      return saved.id
    })

    await simulateWorkflow(session, { workflowId, windowDays: 30 })
    await withTenant(session, async (ctx) =>
      activateWorkflow(ctx, await loadActor(ctx), { workflowId, ownerUserId: org.ownerId }),
    )

    const live = await runWorkflow(session, { workflowId, trigger: 'manual' })
    expect(live.status).toBe('awaiting_approval')
    expect(live.approvalId).toBeTruthy()

    // Nothing has been written yet: the approval is the point of the pause.
    const draftedBefore = await withTenant(session, async (ctx) => {
      const [row] = await ctx.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM email_drafts WHERE organization_id = ${ctx.organizationId}`
      return row!.count
    })
    expect(draftedBefore).toBe(0)

    const edited = 'Following up on the renewal terms — anything you need from us?'
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const approval = await getApproval(ctx, actor, live.approvalId!)
      const line = approval.preview.find((entry) =>
        entry.changes.some((change) => change.editable?.arg === 'body'),
      )!
      await decideApproval(ctx, actor, {
        approvalId: live.approvalId!,
        decision: 'approve_with_edits',
        reason: 'Softer close.',
        edits: { steps: { [line.stepId!]: { body: edited } } },
      })
    })

    const resumed = await continueWorkflowAfterApproval(session, live.runId)
    expect(resumed.status).toBe('succeeded')

    const drafts = await withTenant(session, async (ctx) =>
      ctx.sql<{ body_text: string; status: string }[]>`
        SELECT body_text, status FROM email_drafts WHERE organization_id = ${ctx.organizationId}`,
    )
    expect(drafts.length).toBeGreaterThan(0)
    expect(drafts.some((draft) => draft.body_text === edited)).toBe(true)
    // Nothing is ever sent by a workflow, whatever the sentence asked for.
    expect(drafts.every((draft) => draft.status === 'draft')).toBe(true)
  })
})
