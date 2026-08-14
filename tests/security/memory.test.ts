import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  applyRetention,
  confirmMemory,
  correctMemory,
  deleteDocument,
  forgetMemory,
  ingestDocument,
  listMemories,
  previewErasure,
  proposeMemories,
  recallMemories,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Agent memory (§9.3).
 *
 * `memory_facts` was designed in migration 0006 and never written to. The properties
 * asserted here are the ones that decide whether a remembering assistant is an asset or a
 * liability: that nothing is remembered without a source the run actually read, that
 * nothing is recalled until a person agreed with it, that recall cannot reach past the
 * permissions of the document a fact came from, that the database cannot hold two
 * confirmed answers to one question, and that deleting the source really does take the
 * memory with it — which is the claim §25.13 has been making about an empty table.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let restrictedDocId: string

/** The grounding shape a run hands to `proposeMemories`. */
const knowledge = (documentId: string, title = 'Freight policy') => [
  {
    documentId,
    documentTitle: title,
    anchor: '#cold-chain',
    content: 'Reefer units are pre-cooled for 90 minutes before loading.',
  },
]

async function propose(documentId: string, object: string, extra: Record<string, unknown> = {}) {
  return withTenant(session, (ctx) =>
    proposeMemories(ctx, {
      runId: org.runId,
      knowledge: knowledge(documentId),
      candidates: [
        {
          scope: 'organization',
          subject: 'Reefer units',
          predicate: 'are pre-cooled for',
          object,
          knowledgeIndex: 0,
          ...extra,
        },
      ],
    }),
  )
}

async function candidateId(): Promise<string> {
  const listing = await withTenant(session, async (ctx) => listMemories(ctx, await loadActor(ctx)))
  return listing.candidates[0]!.id
}

beforeAll(async () => {
  org = await createTenant('memory')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }

  // An indexed document is what a memory has to point at, and a restricted one is what
  // recall must refuse to leak through.
  await withTenant(session, async (ctx) => {
    await ingestDocument(ctx, {
      documentId: org.documentId,
      title: 'Freight policy',
      docType: 'policy',
      body: '# Cold chain\n\n## Pre-cooling\n\nReefer units are pre-cooled for 90 minutes before loading.\n',
    })
    const [restricted] = await ctx.sql<{ id: string }[]>`
      INSERT INTO documents (organization_id, title, doc_type, sensitivity, index_status, is_demo, created_by)
      VALUES (${ctx.organizationId}, 'Board compensation', 'policy', 'restricted', 'indexed', true, ${org.ownerId})
      RETURNING id`
    restrictedDocId = restricted!.id
  })
})

afterAll(async () => {
  await destroyTenant('memory')
  await closePools()
})

describe('what may be remembered at all', () => {
  it('refuses a fact citing a passage the run never retrieved', async () => {
    const result = await withTenant(session, (ctx) =>
      proposeMemories(ctx, {
        runId: org.runId,
        knowledge: knowledge(org.documentId),
        candidates: [
          {
            scope: 'organization',
            subject: 'Reefer units',
            predicate: 'are pre-cooled for',
            object: '20 minutes',
            // The model cannot reach outside what the run actually read.
            knowledgeIndex: 7,
          },
        ],
      }),
    )
    expect(result.stored).toBe(0)
    expect(result.refused[0]?.reason).toMatch(/never retrieved/i)
  })

  it('refuses an incomplete statement, and a passage masquerading as a fact', async () => {
    const result = await withTenant(session, (ctx) =>
      proposeMemories(ctx, {
        runId: org.runId,
        knowledge: knowledge(org.documentId),
        candidates: [
          { scope: 'organization', subject: 'Reefer units', predicate: '', object: 'x', knowledgeIndex: 0 },
          {
            scope: 'organization',
            subject: 'Reefer units',
            predicate: 'are described by',
            object: 'x'.repeat(600),
            knowledgeIndex: 0,
          },
          // A narrower scope has to say what it is scoped to.
          { scope: 'company', subject: 'Halden', predicate: 'pays in', object: 'EUR', knowledgeIndex: 0 },
        ],
      }),
    )
    expect(result.stored).toBe(0)
    expect(result.refused).toHaveLength(3)
    expect(result.refused.map((r) => r.reason).join(' ')).toMatch(/complete statement/i)
    expect(result.refused.map((r) => r.reason).join(' ')).toMatch(/which company/i)
  })

  it('stores a sourced candidate, and will not store the same one twice', async () => {
    const first = await propose(org.documentId, '90 minutes')
    expect(first.stored).toBe(1)

    const again = await propose(org.documentId, '90 minutes')
    expect(again.stored).toBe(0)
    expect(again.refused[0]?.reason).toMatch(/already waiting/i)
  })

  it('is not recalled while it is only a candidate', async () => {
    const recalled = await withTenant(session, async (ctx) => recallMemories(ctx, await loadActor(ctx)))
    expect(recalled).toHaveLength(0)
  })
})

describe('agreeing, and changing your mind', () => {
  it('needs a person, and records who it was', async () => {
    const id = await candidateId()
    const fact = await withTenant(session, async (ctx) => confirmMemory(ctx, await loadActor(ctx), id))
    expect(fact.state).toBe('confirmed')
    expect(fact.confirmedByName).toBeTruthy()

    // The constraint behind it: nothing can be confirmed without naming who agreed.
    await expect(
      adminSql()`
        UPDATE memory_facts SET state = 'confirmed', confirmed_by = NULL
        WHERE organization_id = ${org.organizationId} AND id = ${id}`,
    ).rejects.toThrow(/memory_confirmed_by_a_person/)
  })

  it('is recalled once agreed, with the source it came from', async () => {
    const recalled = await withTenant(session, async (ctx) => recallMemories(ctx, await loadActor(ctx)))
    expect(recalled).toHaveLength(1)
    expect(recalled[0]?.object).toBe('90 minutes')
    expect(recalled[0]?.citation?.documentId).toBe(org.documentId)
    // A figure is volatile only if it was proposed as one; this one was not.
    expect(recalled[0]?.stale).toBe(false)
  })

  it('cannot hold two confirmed answers to the same question', async () => {
    const [confirmed] = await adminSql()<{ id: string }[]>`
      SELECT id FROM memory_facts WHERE organization_id = ${org.organizationId} AND state = 'confirmed'`

    // Not a conflict to be reconciled later — a row the database refuses to accept.
    await expect(
      adminSql()`
        INSERT INTO memory_facts (
          organization_id, scope, subject, predicate, object, state, confirmed_by, source_citation, created_by
        ) VALUES (
          ${org.organizationId}, 'organization', 'Reefer units', 'are pre-cooled for', '20 minutes',
          'confirmed', ${org.ownerId},
          ${adminSql().json({ documentId: org.documentId, anchor: '#cold-chain' })}, ${org.ownerId}
        )`,
    ).rejects.toThrow(/memory_one_confirmed_answer/)
    expect(confirmed).toBeDefined()
  })

  it('marks a contradicting candidate rather than storing it quietly', async () => {
    const result = await propose(org.documentId, '20 minutes')
    expect(result.stored).toBe(1)

    const listing = await withTenant(session, async (ctx) => listMemories(ctx, await loadActor(ctx)))
    expect(listing.conflicts).toHaveLength(1)
    expect(listing.conflicts[0]?.confirmed.object).toBe('90 minutes')
    expect(listing.conflicts[0]?.candidate.object).toBe('20 minutes')

    // Confirming it directly would need two confirmed answers to exist at once, so the
    // path is closed and the reason names the one that is open.
    await expect(
      withTenant(session, async (ctx) =>
        confirmMemory(ctx, await loadActor(ctx), listing.conflicts[0]!.candidate.id),
      ),
    ).rejects.toThrow(/Correcting the existing fact/i)
  })

  it('supersedes rather than overwrites, and keeps who changed their mind', async () => {
    const listing = await withTenant(session, async (ctx) => listMemories(ctx, await loadActor(ctx)))
    const current = listing.confirmed.find((fact) => fact.object === '90 minutes')!

    const corrected = await withTenant(session, async (ctx) =>
      correctMemory(ctx, await loadActor(ctx), {
        id: current.id,
        object: '20 minutes',
        reason: 'Renegotiated in the 2026 contract.',
      }),
    )
    expect(corrected.object).toBe('20 minutes')
    expect(corrected.supersedesId).toBe(current.id)

    const [old] = await adminSql()<{ state: string; valid_to: Date | null }[]>`
      SELECT state, valid_to FROM memory_facts WHERE id = ${current.id}`
    // The old answer is closed off, not deleted: "what did we think last quarter" survives.
    expect(old?.state).toBe('superseded')
    expect(old?.valid_to).not.toBeNull()

    // And the candidate that raised the question is answered, so the conflict is gone.
    const after = await withTenant(session, async (ctx) => listMemories(ctx, await loadActor(ctx)))
    expect(after.conflicts).toHaveLength(0)

    // The candidate is closed as part of the correction rather than audited separately —
    // one decision, one row, with the old answer and the new one both on it.
    const audit = await adminSql()<{ action: string }[]>`
      SELECT DISTINCT action FROM audit_logs
      WHERE organization_id = ${org.organizationId} AND action LIKE 'memory.%'`
    expect(audit.map((row) => row.action).sort()).toEqual(['memory.confirmed', 'memory.corrected'])
  })

  it('will not correct or forget without a reason', async () => {
    // Its own fact, because forgetting is destructive and a test that consumes the
    // fixture the next one needs is a test that passes for the wrong reason.
    const fact = await withTenant(session, async (ctx) => {
      await proposeMemories(ctx, {
        runId: org.runId,
        knowledge: knowledge(org.documentId),
        candidates: [
          { scope: 'organization', subject: 'The depot', predicate: 'opens at', object: '06:00', knowledgeIndex: 0 },
        ],
      })
      const [row] = await ctx.sql<{ id: string }[]>`
        SELECT id FROM memory_facts WHERE organization_id = ${ctx.organizationId}
          AND subject = 'The depot' AND state = 'candidate'`
      return confirmMemory(ctx, await loadActor(ctx), row!.id)
    })

    await expect(
      withTenant(session, async (ctx) =>
        correctMemory(ctx, await loadActor(ctx), { id: fact.id, object: '30 minutes', reason: 'x' }),
      ),
    ).rejects.toThrow(ValidationError)
    await expect(
      withTenant(session, async (ctx) => forgetMemory(ctx, await loadActor(ctx), { id: fact.id, reason: '' })),
    ).rejects.toThrow(ValidationError)

    // With one, it works, stops being recalled, and says so in the audit trail.
    await withTenant(session, async (ctx) =>
      forgetMemory(ctx, await loadActor(ctx), { id: fact.id, reason: 'It was never true of this company.' }),
    )
    const recalled = await withTenant(session, async (ctx) => recallMemories(ctx, await loadActor(ctx)))
    expect(recalled.some((entry) => entry.id === fact.id)).toBe(false)

    const [forgotten] = await adminSql()<{ count: string }[]>`
      SELECT count(*)::text AS count FROM audit_logs
      WHERE organization_id = ${org.organizationId} AND action = 'memory.forgotten'`
    expect(Number(forgotten?.count ?? 0)).toBe(1)
  })
})

describe('recall cannot reach past the source', () => {
  it('does not recall a fact whose document the reader may not open', async () => {
    await withTenant(session, async (ctx) => {
      await proposeMemories(ctx, {
        runId: org.runId,
        knowledge: knowledge(restrictedDocId, 'Board compensation'),
        candidates: [
          {
            scope: 'organization',
            subject: 'The board fee',
            predicate: 'is',
            object: '£90,000',
            knowledgeIndex: 0,
          },
        ],
      })
      const [row] = await ctx.sql<{ id: string }[]>`
        SELECT id FROM memory_facts WHERE organization_id = ${ctx.organizationId}
          AND subject = 'The board fee' AND state = 'candidate'`
      return confirmMemory(ctx, await loadActor(ctx), row!.id)
    })

    // The owner may read a restricted document, so the fact is theirs to recall.
    const forOwner = await withTenant(session, async (ctx) => recallMemories(ctx, await loadActor(ctx)))
    expect(forOwner.some((fact) => fact.subject === 'The board fee')).toBe(true)

    // A member's ceiling is `internal`. A memory is a shorter way of quoting its source,
    // so it must not become the way a restricted document reaches them.
    const memberSession = { organizationId: org.organizationId, userId: org.memberId, timezone: 'Europe/London' }
    const forMember = await withTenant(memberSession, async (ctx) => recallMemories(ctx, await loadActor(ctx)))
    expect(forMember.some((fact) => fact.subject === 'The board fee')).toBe(false)
    // And they still get the ones they are entitled to, so this is a filter and not an outage.
    expect(forMember.some((fact) => fact.subject === 'Reefer units')).toBe(true)

    // The review screen obeys the same rule as recall.
    const listing = await withTenant(memberSession, async (ctx) => listMemories(ctx, await loadActor(ctx)))
    expect(listing.confirmed.some((fact) => fact.subject === 'The board fee')).toBe(false)
  })
})

describe('a memory does not outlive its source', () => {
  it('is forgotten when the document it came from is deleted (§25.13)', async () => {
    const before = await withTenant(session, async (ctx) => recallMemories(ctx, await loadActor(ctx)))
    expect(before.some((fact) => fact.citation?.documentId === org.documentId)).toBe(true)

    const removed = await withTenant(session, async (ctx) =>
      deleteDocument(ctx, await loadActor(ctx), {
        documentId: org.documentId,
        reason: 'Superseded by the 2026 policy.',
      }),
    )
    // The count the delete reports is the evidence — and until now it has always been zero.
    expect(removed.memories).toBeGreaterThanOrEqual(1)

    const after = await withTenant(session, async (ctx) => recallMemories(ctx, await loadActor(ctx)))
    expect(after.some((fact) => fact.citation?.documentId === org.documentId)).toBe(false)

    const [state] = await adminSql()<{ state: string }[]>`
      SELECT state FROM memory_facts
      WHERE organization_id = ${org.organizationId} AND source_citation->>'documentId' = ${org.documentId}
      LIMIT 1`
    expect(state?.state).toBe('forgotten')
  })

  it('purges what is forgotten and superseded, and never what is agreed', async () => {
    // valid_from moves too: the constraint requires a period that ends after it starts,
    // so ageing a row means ageing the whole period rather than only its close.
    await adminSql()`
      UPDATE memory_facts
      SET valid_from = now() - interval '1000 days',
          valid_to = now() - interval '900 days',
          created_at = now() - interval '900 days'
      WHERE organization_id = ${org.organizationId} AND state IN ('forgotten', 'superseded')`

    const outcomes = await withTenant(session, (ctx) => applyRetention(ctx))
    expect(outcomes.find((outcome) => outcome.dataClass === 'memories')?.purged).toBeGreaterThanOrEqual(1)

    const [left] = await adminSql()<{ gone: number; agreed: number }[]>`
      SELECT
        (SELECT count(*)::int FROM memory_facts
          WHERE organization_id = ${org.organizationId} AND state IN ('forgotten', 'superseded')) AS gone,
        (SELECT count(*)::int FROM memory_facts
          WHERE organization_id = ${org.organizationId} AND state = 'confirmed') AS agreed`
    expect(left?.gone).toBe(0)
    // Current knowledge is not history. Ageing it out would make the assistant quietly
    // know less, on a schedule nobody would connect to the symptom.
    expect(left?.agreed).toBeGreaterThan(0)
  })

  it('is listed on an erasure, and goes with the person', async () => {
    await adminSql()`
      INSERT INTO memory_facts (
        organization_id, scope, scope_id, subject, predicate, object, state, confirmed_by,
        source_citation, created_by
      ) VALUES (
        ${org.organizationId}, 'user', ${org.memberId}, 'Their notice period', 'is', 'three months',
        'confirmed', ${org.ownerId},
        ${adminSql().json({ documentId: restrictedDocId, anchor: '#terms' })}, ${org.ownerId}
      )`

    const preview = await withTenant(session, async (ctx) =>
      previewErasure(ctx, await loadActor(ctx), org.memberId),
    )
    const line = preview.lines.find((entry) => entry.table === 'memory_facts')
    expect(line).toBeDefined()
    expect(line!.disposition).toBe('delete')
    expect(line!.count).toBe(1)
  })
})
