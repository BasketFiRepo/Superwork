import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  assertEditsAreOffered,
  createApproval,
  decideApproval,
  editableArgs,
  trustLedger,
  ValidationError,
  type PreviewLine,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Approve with edits (§11.2).
 *
 * Correcting a proposal is not the same as widening it. The rules asserted here are the
 * two that keep them apart: an edit may only touch an argument the card actually offered,
 * and the correction is recorded as a distinct signal in the trust ledger, because
 * "approved after a tweak" tells you something "approved" does not.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }

const PREVIEW: PreviewLine[] = [
  {
    operation: 'Draft email',
    entityType: 'email_draft',
    entityLabel: 'Re: renewal',
    changes: [
      { field: 'To', to: 'someone@customer.example' },
      { field: 'Subject', to: 'Re: renewal', editable: { arg: 'subject' } },
      { field: 'Body', to: 'Just following up.', editable: { arg: 'body', multiline: true } },
    ],
    riskTier: 'low',
    reversible: true,
    stepId: 'step-1',
  },
]

beforeAll(async () => {
  org = await createTenant('apedits')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
})

afterAll(async () => {
  await destroyTenant('apedits')
  await closePools()
})

describe('what an approver may change', () => {
  it('offers exactly the arguments the tool marked editable', () => {
    expect(editableArgs(PREVIEW)).toEqual({ 'step-1': ['subject', 'body'] })
  })

  it('refuses an edit to a field that was not offered', () => {
    expect(() => assertEditsAreOffered(PREVIEW, { steps: { 'step-1': { toAddresses: ['x@y.example'] } } })).toThrow(
      /not editable/i,
    )
  })

  it('refuses an edit to a step that was not previewed', () => {
    expect(() => assertEditsAreOffered(PREVIEW, { steps: { 'step-9': { subject: 'hello' } } })).toThrow(
      /nothing editable/i,
    )
  })

  it('refuses an "edit" with no edits in it', () => {
    expect(() => assertEditsAreOffered(PREVIEW, { steps: {} })).toThrow(/needs an edit/i)
  })

  it('accepts an edit to an offered argument', () => {
    expect(() => assertEditsAreOffered(PREVIEW, { steps: { 'step-1': { body: 'Softer.' } } })).not.toThrow()
  })
})

describe('deciding with edits', () => {
  it('records the edit as its own signal, not as a plain approval', async () => {
    const { status, ledger } = await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const approvalId = await createApproval(ctx, actor, {
        title: 'Draft a reply',
        kind: 'edit_test',
        riskTier: 'low',
        preview: PREVIEW,
        evidence: [{ claim: 'The thread has been quiet for six days.', sourceType: 'aggregate' }],
        requestedByLabel: 'Superwork',
      })
      const decided = await decideApproval(ctx, actor, {
        approvalId,
        decision: 'approve_with_edits',
        reason: 'Softer close — this account prefers it.',
        edits: { steps: { 'step-1': { body: 'Hope the rollout went well — anything you need from us?' } } },
      })
      return { status: decided.status, ledger: await trustLedger(ctx) }
    })

    expect(status).toBe('approved_with_edits')
    const row = ledger.find((entry) => entry.actionType === 'edit_test')
    expect(row?.edited).toBe(1)
    expect(row?.approved).toBe(0)
    expect(row?.editRate).toBe(1)
  })

  it('rejects an edit that reaches past the card', async () => {
    await expect(
      withTenant(session, async (ctx) => {
        const actor = await loadActor(ctx)
        const approvalId = await createApproval(ctx, actor, {
          title: 'Draft a reply',
          kind: 'edit_test',
          riskTier: 'low',
          preview: PREVIEW,
          evidence: [{ claim: 'Quiet thread.', sourceType: 'aggregate' }],
          requestedByLabel: 'Superwork',
        })
        return decideApproval(ctx, actor, {
          approvalId,
          decision: 'approve_with_edits',
          edits: { steps: { 'step-1': { conversationId: '00000000-0000-0000-0000-000000000001' } } },
        })
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})
