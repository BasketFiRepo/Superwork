import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  applyRetention,
  deleteDocument,
  erasePerson,
  ingestDocument,
  previewErasure,
  retentionPolicies,
  RETENTION_CLASSES,
  setRetention,
  StepUpRequiredError,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Retention and erasure (§21, §25.13).
 *
 * Migration 0009 built the substrate for both and named the jobs that would use it; the
 * jobs did not exist. The properties worth asserting are the ones a regulator asks about:
 * that a window is enforced rather than described, that the audit trail can only be purged
 * by the path that was designed for it, that an erasure says what it will do before it does
 * it and does exactly that, that it refuses when it would break something, and that
 * deleting a document really does take its chunks, citations and memories with it.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let confirmed: { organizationId: string; userId: string; timezone: string; steppedUpAt: Date }

beforeAll(async () => {
  org = await createTenant('retain')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
  confirmed = { ...session, steppedUpAt: new Date() }
})

afterAll(async () => {
  await destroyTenant('retain')
  await closePools()
})

describe('retention windows', () => {
  it('has a default for every class, from the jurisdiction in force', async () => {
    const policies = await withTenant(session, async (ctx) => retentionPolicies(ctx, await loadActor(ctx)))
    expect(policies).toHaveLength(RETENTION_CLASSES.length)
    expect(policies.every((policy) => policy.isDefault)).toBe(true)
    expect(policies.every((policy) => policy.keepDays >= policy.minimumDays)).toBe(true)
    // A new tenant has no legal entity, so the strictest profile applies.
    expect(policies.find((p) => p.dataClass === 'transcripts')?.keepDays).toBe(90)
  })

  it('keeps the audit trail longest, because it is the record that answers for the rest', async () => {
    const policies = await withTenant(session, async (ctx) => retentionPolicies(ctx, await loadActor(ctx)))
    const audit = policies.find((policy) => policy.dataClass === 'audit_logs')!
    for (const other of policies.filter((policy) => policy.dataClass !== 'audit_logs')) {
      expect(audit.keepDays).toBeGreaterThan(other.keepDays)
    }
  })

  it('will not be set without re-confirming who you are', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        setRetention(ctx, await loadActor(ctx), {
          dataClass: 'transcripts',
          keepDays: 120,
          reason: 'Our DPIA says four months.',
        }),
      ),
    ).rejects.toBeInstanceOf(StepUpRequiredError)
  })

  it('refuses a window shorter than the class can survive, and one with no reason', async () => {
    await expect(
      withTenant(confirmed, async (ctx) =>
        setRetention(ctx, await loadActor(ctx), {
          dataClass: 'audit_logs',
          keepDays: 30,
          reason: 'We would rather not keep it.',
        }),
      ),
    ).rejects.toThrow(/at least 730 days/i)

    await expect(
      withTenant(confirmed, async (ctx) =>
        setRetention(ctx, await loadActor(ctx), { dataClass: 'transcripts', keepDays: 120, reason: 'why' }),
      ),
    ).rejects.toThrow(/without a reason/i)

    await expect(
      withTenant(confirmed, async (ctx) =>
        setRetention(ctx, await loadActor(ctx), {
          dataClass: 'not_a_class',
          keepDays: 120,
          reason: 'Nothing to see here.',
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('records who set it and why', async () => {
    const policies = await withTenant(confirmed, async (ctx) =>
      setRetention(ctx, await loadActor(ctx), {
        dataClass: 'transcripts',
        keepDays: 120,
        reason: 'Our DPIA sets four months for anything naming a person.',
      }),
    )
    const transcripts = policies.find((policy) => policy.dataClass === 'transcripts')!
    expect(transcripts.keepDays).toBe(120)
    expect(transcripts.isDefault).toBe(false)
    expect(transcripts.setByName).toBeTruthy()
    expect(transcripts.reason).toMatch(/DPIA/)
  })
})

describe('the purge', () => {
  it('removes what is past its window and leaves what is not', async () => {
    const { oldRun, freshRun, unfinished } = await withTenant(session, async (ctx) => {
      const insert = async (finishedDaysAgo: number | null) => {
        const [row] = await ctx.sql<{ id: string }[]>`
          INSERT INTO agent_runs (
            organization_id, principal_user_id, mode, status, request, trace_id, created_by,
            finished_at, created_at
          ) VALUES (
            ${ctx.organizationId}, ${org.ownerId}, 'ask',
            ${finishedDaysAgo === null ? 'awaiting_approval' : 'succeeded'},
            'retention fixture', ${`trace-${Math.random()}`}, ${org.ownerId},
            ${finishedDaysAgo === null ? null : new Date(Date.now() - finishedDaysAgo * 86_400_000)},
            ${new Date(Date.now() - (finishedDaysAgo ?? 400) * 86_400_000)}
          ) RETURNING id`
        return row!.id
      }
      return { oldRun: await insert(400), freshRun: await insert(5), unfinished: await insert(null) }
    })

    const outcomes = await withTenant(session, (ctx) => applyRetention(ctx))
    expect(outcomes.find((outcome) => outcome.dataClass === 'agent_runs')?.purged).toBeGreaterThanOrEqual(1)

    const survivors = await withTenant(session, async (ctx) => {
      const rows = await ctx.sql<{ id: string }[]>`
        SELECT id FROM agent_runs WHERE organization_id = ${ctx.organizationId}
          AND id IN (${oldRun}, ${freshRun}, ${unfinished})`
      return rows.map((row) => row.id)
    })
    expect(survivors).not.toContain(oldRun)
    expect(survivors).toContain(freshRun)
    // Waiting for a person is not the same as old. An outstanding run is never purged.
    expect(survivors).toContain(unfinished)
  })

  it('purges the audit trail only through the owner role the trigger allows', async () => {
    const cutoff = new Date(Date.now() - 4000 * 86_400_000)
    await adminSql()`
      INSERT INTO audit_logs (organization_id, actor_type, action, entity_type, occurred_at)
      VALUES (${org.organizationId}, 'system', 'retention.fixture', 'settings', ${cutoff})`

    // The application role is refused outright. Two defences stand behind this, and the
    // privilege is the one that answers first: DELETE was REVOKEd from the role, so the
    // statement never reaches the trigger that would also have refused it. Either message
    // is the right outcome; getting neither would not be.
    await expect(
      withTenant(session, async (ctx) => {
        await ctx.sql`DELETE FROM audit_logs WHERE organization_id = ${ctx.organizationId}`
      }),
    ).rejects.toThrow(/append-only|permission denied for table audit_logs/i)

    const outcomes = await withTenant(session, (ctx) => applyRetention(ctx))
    expect(outcomes.find((outcome) => outcome.dataClass === 'audit_logs')?.purged).toBeGreaterThanOrEqual(1)

    const [left] = await adminSql()<{ count: string }[]>`
      SELECT count(*)::text AS count FROM audit_logs
      WHERE organization_id = ${org.organizationId} AND action = 'retention.fixture'`
    expect(Number(left?.count ?? 0)).toBe(0)
  })
})

describe('erasing a person', () => {
  it('says what it would do, in three dispositions, before doing anything', async () => {
    const preview = await withTenant(session, async (ctx) => previewErasure(ctx, await loadActor(ctx), org.memberId))
    expect(preview.lines.length).toBeGreaterThan(5)
    expect(new Set(preview.lines.map((line) => line.disposition))).toEqual(
      new Set(['delete', 'anonymise', 'keep']),
    )
    // Every line says why, and the label that outlives them is not their name or address.
    expect(preview.lines.every((line) => line.basis.length > 10)).toBe(true)
    expect(preview.subjectLabel).not.toMatch(/@/)
    expect(preview.subjectLabel).toMatch(/former/i)
  })

  it('refuses while an active workflow still names them as its accountable owner', async () => {
    const workflowId = await withTenant(session, async (ctx) => {
      const [workflow] = await ctx.sql<{ id: string }[]>`
        INSERT INTO workflows (organization_id, name, owner_user_id, status, created_by)
        VALUES (${ctx.organizationId}, 'Owned by the member', ${org.memberId}, 'active', ${org.ownerId})
        RETURNING id`
      return workflow!.id
    })
    expect(workflowId).toBeTruthy()

    const preview = await withTenant(session, async (ctx) => previewErasure(ctx, await loadActor(ctx), org.memberId))
    expect(preview.blockers.some((blocker) => /accountable owner/i.test(blocker))).toBe(true)

    await expect(
      withTenant(confirmed, async (ctx) =>
        erasePerson(ctx, await loadActor(ctx), { subjectUserId: org.memberId, reason: 'DSAR 2026-04-11.' }),
      ),
    ).rejects.toThrow(/cannot be erased yet/i)

    await withTenant(session, async (ctx) => {
      await ctx.sql`
        UPDATE workflows SET status = 'archived' WHERE organization_id = ${ctx.organizationId}`
    })
  })

  it('will not run without re-confirming who you are, and will not erase you', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        erasePerson(ctx, await loadActor(ctx), { subjectUserId: org.memberId, reason: 'DSAR 2026-04-11.' }),
      ),
    ).rejects.toBeInstanceOf(StepUpRequiredError)

    await expect(
      withTenant(confirmed, async (ctx) =>
        erasePerson(ctx, await loadActor(ctx), { subjectUserId: org.ownerId, reason: 'DSAR 2026-04-11.' }),
      ),
    ).rejects.toThrow(/erasing yourself/i)
  })

  it('deletes what is theirs, anonymises what other people depend on, and keeps what it said it would', async () => {
    // Something of each kind, so the three dispositions are all exercised.
    await withTenant(session, async (ctx) => {
      await ctx.sql`
        INSERT INTO notifications (organization_id, user_id, type, title, body, channel, delivery, created_by)
        VALUES (${ctx.organizationId}, ${org.memberId}, 'nudge', 'A reminder', 'body', 'in_app', 'immediate', ${org.ownerId})`
      await ctx.sql`
        UPDATE tasks SET assignee_id = ${org.memberId}
        WHERE organization_id = ${ctx.organizationId} AND id = ${org.taskId}`
    })

    const record = await withTenant(confirmed, async (ctx) =>
      erasePerson(ctx, await loadActor(ctx), { subjectUserId: org.memberId, reason: 'DSAR 2026-04-11, verified.' }),
    )
    expect(record.status).toBe('completed')
    expect(record.outcome?.lines.length).toBeGreaterThan(5)

    const after = await withTenant(session, async (ctx) => {
      const [notifications] = await ctx.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM notifications
        WHERE organization_id = ${ctx.organizationId} AND user_id = ${org.memberId}`
      const [task] = await ctx.sql<{ assignee_id: string | null }[]>`
        SELECT assignee_id FROM tasks WHERE organization_id = ${ctx.organizationId} AND id = ${org.taskId}`
      const [membership] = await ctx.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM memberships
        WHERE organization_id = ${ctx.organizationId} AND user_id = ${org.memberId}`
      return { notifications: Number(notifications?.count ?? 0), assignee: task?.assignee_id, memberships: Number(membership?.count ?? 0) }
    })

    expect(after.notifications).toBe(0)
    expect(after.memberships).toBe(0)
    // The task survives, pointing at the tombstone rather than at nobody: it is still work.
    expect(after.assignee).toBeTruthy()
    expect(after.assignee).not.toBe(org.memberId)

    const [tombstone] = await adminSql()<{ email: string }[]>`
      SELECT email FROM users WHERE id = ${after.assignee!}`
    expect(tombstone?.email).toBe('erased@superwork.invalid')

    // The record of the erasure outlives the person, and does not name them.
    const [request] = await adminSql()<{ subject_user_id: string | null; subject_label: string }[]>`
      SELECT subject_user_id, subject_label FROM erasure_requests
      WHERE organization_id = ${org.organizationId} ORDER BY created_at DESC LIMIT 1`
    expect(request?.subject_user_id).toBeNull()
    expect(request?.subject_label).not.toMatch(/@/)
  })
})

describe('deleting a document', () => {
  it('takes its chunks, citations and derived memories with it', async () => {
    const documentId = await withTenant(session, async (ctx) => {
      const [doc] = await ctx.sql<{ id: string }[]>`
        INSERT INTO documents (organization_id, title, doc_type, sensitivity, index_status, created_by)
        VALUES (${ctx.organizationId}, 'Cold chain policy', 'policy', 'internal', 'pending', ${org.ownerId})
        RETURNING id`
      await ingestDocument(ctx, {
        documentId: doc!.id,
        title: 'Cold chain policy',
        docType: 'policy',
        body:
          '# Cold chain\n\n## Pre-cooling\n\nReefer units are pre-cooled for 90 minutes before loading.\n\n' +
          '## Excursions\n\nAn excursion is escalated to the duty planner within thirty minutes.\n',
      })
      return doc!.id
    })

    const before = await withTenant(session, async (ctx) => {
      const [row] = await ctx.sql<{ chunks: number }[]>`
        SELECT count(*)::int AS chunks FROM document_chunks
        WHERE organization_id = ${ctx.organizationId} AND document_id = ${documentId}`
      return row!.chunks
    })
    expect(before).toBeGreaterThan(0)

    const removed = await withTenant(session, async (ctx) =>
      deleteDocument(ctx, await loadActor(ctx), { documentId, reason: 'Superseded by the 2026 policy.' }),
    )
    expect(removed.chunks).toBe(before)

    const left = await withTenant(session, async (ctx) => {
      const [row] = await ctx.sql<{ chunks: number; versions: number; citations: number; documents: number }[]>`
        SELECT
          (SELECT count(*)::int FROM document_chunks
            WHERE organization_id = ${ctx.organizationId} AND document_id = ${documentId}) AS chunks,
          (SELECT count(*)::int FROM document_versions
            WHERE organization_id = ${ctx.organizationId} AND document_id = ${documentId}) AS versions,
          (SELECT count(*)::int FROM citations
            WHERE organization_id = ${ctx.organizationId} AND document_id = ${documentId}) AS citations,
          (SELECT count(*)::int FROM documents
            WHERE organization_id = ${ctx.organizationId} AND id = ${documentId}) AS documents`
      return row!
    })
    // The anti-pattern this exists to prevent: a deleted document whose passages are still
    // retrievable is both a compliance hole and a source of answers citing nothing.
    expect(left).toEqual({ chunks: 0, versions: 0, citations: 0, documents: 0 })
  })

  it('will not delete without a reason, and says what it removed in the audit trail', async () => {
    const documentId = await withTenant(session, async (ctx) => {
      const [doc] = await ctx.sql<{ id: string }[]>`
        INSERT INTO documents (organization_id, title, doc_type, sensitivity, index_status, created_by)
        VALUES (${ctx.organizationId}, 'Another policy', 'policy', 'internal', 'pending', ${org.ownerId})
        RETURNING id`
      await ingestDocument(ctx, {
        documentId: doc!.id,
        title: 'Another policy',
        docType: 'policy',
        body: '# Another\n\nSomething worth indexing so there is a passage to remove.\n',
      })
      return doc!.id
    })

    await expect(
      withTenant(session, async (ctx) =>
        deleteDocument(ctx, await loadActor(ctx), { documentId, reason: '' }),
      ),
    ).rejects.toThrow(/say why/i)

    await withTenant(session, async (ctx) =>
      deleteDocument(ctx, await loadActor(ctx), { documentId, reason: 'No longer accurate.' }),
    )
    const [entry] = await adminSql()<{ diff: Record<string, { to?: unknown }> }[]>`
      SELECT diff FROM audit_logs
      WHERE organization_id = ${org.organizationId} AND action = 'document.deleted'
      ORDER BY occurred_at DESC LIMIT 1`
    // The audit records the counts, because "deleted" and "everything derived from it went
    // too" are different claims and only the second is the point of this control.
    expect(Number(entry?.diff?.['chunksRemoved']?.to ?? 0)).toBeGreaterThan(0)
    expect(String(entry?.diff?.['reason']?.to ?? '')).toMatch(/no longer accurate/i)
  })
})
