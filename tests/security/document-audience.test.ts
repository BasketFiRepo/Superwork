import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  confirmMemory,
  documentAudience,
  grantDocumentAccess,
  hybridSearch,
  ingestDocument,
  openDocumentToEveryone,
  proposeMemories,
  recallMemories,
  revokeDocumentAccess,
  share,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Document circulation lists (§4.6, §17).
 *
 * `document_permissions` was created in migration 0004 and never written to, while being
 * read by the ACL predicate in both arms of `hybridSearch` and by memory recall. The
 * properties asserted here are the ones that decide whether restricting a document is a
 * real control or a label on a screen: that the restriction bites in both retrieval arms
 * rather than only the one the test happens to trigger, that it applies to administrators
 * too, that it can never widen anything past the classification ceiling, that memory cannot
 * route around it, and that sharing a restricted document no longer leaves "I shared it with
 * you" and "the assistant cannot find it" both true.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let memberSession: { organizationId: string; userId: string; timezone: string }
let secretId: string

/** The distinctive term is in the body, so the keyword arm has something to match on. */
const BODY = '# Cold chain\n\n## Pre-cooling\n\nReefer units are pre-cooled for 90 minutes before quinoxaline loading.\n'

async function findsIt(who: typeof session, query = 'quinoxaline pre-cooling reefer'): Promise<boolean> {
  return withTenant(who, async (ctx) => {
    const result = await hybridSearch(ctx, await loadActor(ctx), query)
    return result.chunks.some((chunk) => chunk.documentId === secretId)
  })
}

/**
 * A query with no lexical overlap with the document at all. The keyword arm cannot match
 * it, so anything it returns came from the vector arm — which is how the two can be told
 * apart from outside.
 */
const VECTOR_ONLY = 'unrelated phrasing about warehouse temperature discipline'

beforeAll(async () => {
  org = await createTenant('audience')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
  memberSession = { organizationId: org.organizationId, userId: org.memberId, timezone: 'Europe/London' }

  await withTenant(session, async (ctx) => {
    const [doc] = await ctx.sql<{ id: string }[]>`
      INSERT INTO documents (organization_id, title, doc_type, sensitivity, index_status, is_demo, created_by)
      VALUES (${ctx.organizationId}, 'Quinoxaline handling', 'policy', 'internal', 'pending', true, ${org.ownerId})
      RETURNING id`
    secretId = doc!.id
    await ingestDocument(ctx, {
      documentId: secretId,
      title: 'Quinoxaline handling',
      docType: 'policy',
      body: BODY,
      sensitivityHint: 'internal',
    })
  })
})

afterAll(async () => {
  await destroyTenant('audience')
  await closePools()
})

describe('an open document', () => {
  it('is findable by anybody whose classification allows it', async () => {
    expect(await findsIt(session)).toBe(true)
    expect(await findsIt(memberSession)).toBe(true)
    // Establishes that the vector arm reaches this document on a query the keyword arm
    // cannot match, so the restriction test below has something to close off.
    expect(await findsIt(memberSession, VECTOR_ONLY)).toBe(true)

    const audience = await withTenant(session, async (ctx) =>
      documentAudience(ctx, await loadActor(ctx), secretId),
    )
    expect(audience.restricted).toBe(false)
    expect(audience.entries).toHaveLength(0)
  })
})

describe('restricting it', () => {
  it('will not add anybody without a reason', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        grantDocumentAccess(ctx, await loadActor(ctx), {
          documentId: secretId,
          subjectType: 'user',
          subjectId: org.memberId,
          reason: 'x',
        }),
      ),
    ).rejects.toThrow(ValidationError)
  })

  it('takes it away from everybody not named, in both retrieval arms', async () => {
    const audience = await withTenant(session, async (ctx) =>
      grantDocumentAccess(ctx, await loadActor(ctx), {
        documentId: secretId,
        subjectType: 'user',
        subjectId: org.viewerId,
        reason: 'Running the quinoxaline audit.',
      }),
    )
    expect(audience.restricted).toBe(true)

    // Closed on a query only the keyword arm can serve…
    expect(await findsIt(memberSession)).toBe(false)
    // …and on one only the vector arm can. The ACL is one fragment interpolated into both,
    // and this is what would catch it being interpolated into only one.
    expect(await findsIt(memberSession, VECTOR_ONLY)).toBe(false)

    // Still open for the person named, on both, so this is a filter and not an outage.
    const viewerSession = { organizationId: org.organizationId, userId: org.viewerId, timezone: 'Europe/London' }
    expect(await findsIt(viewerSession)).toBe(true)
    expect(await findsIt(viewerSession, VECTOR_ONLY)).toBe(true)
  })

  it('applies to the person who restricted it, and to administrators', async () => {
    // Deliberate: an owner is not exempt. Restricting an HR file to three people means
    // three people, and an administrator who wants it can put themselves on the list —
    // which leaves a row saying they did.
    expect(await findsIt(session)).toBe(false)

    await withTenant(session, async (ctx) =>
      grantDocumentAccess(ctx, await loadActor(ctx), {
        documentId: secretId,
        subjectType: 'user',
        subjectId: org.ownerId,
        reason: 'Signing off the audit.',
      }),
    )
    expect(await findsIt(session)).toBe(true)
  })

  it('records who was added and why', async () => {
    const audience = await withTenant(session, async (ctx) =>
      documentAudience(ctx, await loadActor(ctx), secretId),
    )
    expect(audience.entries).toHaveLength(2)
    expect(audience.entries.every((entry) => (entry.reason ?? '').length > 4)).toBe(true)
    expect(audience.entries.every((entry) => entry.grantedByName)).toBe(true)

    const actions = await adminSql()<{ action: string }[]>`
      SELECT DISTINCT action FROM audit_logs
      WHERE organization_id = ${org.organizationId} AND action LIKE 'document.%'`
    // The first grant is a different event from the ones after it, because it is the one
    // that took the document away from everybody.
    expect(actions.map((row) => row.action)).toContain('document.restricted')
    expect(actions.map((row) => row.action)).toContain('document.audience_added')
  })

  it('grants to a department, and refuses a subject that is not here', async () => {
    const [department] = await adminSql()<{ id: string }[]>`
      INSERT INTO departments (organization_id, name, path, is_demo)
      VALUES (${org.organizationId}, 'Quality', 'quality', true) RETURNING id`

    const audience = await withTenant(session, async (ctx) =>
      grantDocumentAccess(ctx, await loadActor(ctx), {
        documentId: secretId,
        subjectType: 'department',
        subjectId: department!.id,
        reason: 'Quality owns the audit.',
      }),
    )
    expect(audience.entries.some((entry) => entry.subjectName === 'Quality')).toBe(true)

    await expect(
      withTenant(session, async (ctx) =>
        grantDocumentAccess(ctx, await loadActor(ctx), {
          documentId: secretId,
          subjectType: 'user',
          subjectId: '00000000-0000-0000-0000-000000000000',
          reason: 'Should not be possible.',
        }),
      ),
    ).rejects.toThrow(/No such person/i)
  })

  it('cannot be used to widen anything past the classification ceiling', async () => {
    const restrictedId = await withTenant(session, async (ctx) => {
      const [doc] = await ctx.sql<{ id: string }[]>`
        INSERT INTO documents (organization_id, title, doc_type, sensitivity, index_status, is_demo, created_by)
        VALUES (${ctx.organizationId}, 'Board pay', 'policy', 'restricted', 'pending', true, ${org.ownerId})
        RETURNING id`
      await ingestDocument(ctx, {
        documentId: doc!.id,
        title: 'Board pay',
        docType: 'policy',
        body: '# Pay\n\n## Fees\n\nThe quinoxaline board fee is ninety thousand pounds.\n',
        sensitivityHint: 'restricted',
      })
      return doc!.id
    })

    // Naming a role that cannot read the classification is refused outright rather than
    // stored as a grant that does nothing.
    await expect(
      withTenant(session, async (ctx) =>
        grantDocumentAccess(ctx, await loadActor(ctx), {
          documentId: restrictedId,
          subjectType: 'role',
          subjectRole: 'member',
          reason: 'They asked nicely.',
        }),
      ),
    ).rejects.toThrow(/above what the member role may read/i)

    // And naming the person directly stores a row that still cannot widen the ceiling: the
    // two conditions are ANDed, so the list is a narrowing device only.
    await withTenant(session, async (ctx) =>
      grantDocumentAccess(ctx, await loadActor(ctx), {
        documentId: restrictedId,
        subjectType: 'user',
        subjectId: org.memberId,
        reason: 'Explicitly named, and still not enough.',
      }),
    )
    const found = await withTenant(memberSession, async (ctx) => {
      const result = await hybridSearch(ctx, await loadActor(ctx), 'quinoxaline board fee')
      return result.chunks.some((chunk) => chunk.documentId === restrictedId)
    })
    expect(found).toBe(false)
  })
})

describe('memory cannot route around it', () => {
  it('stops recalling a fact once its source is restricted away', async () => {
    // The member could read this document before it was restricted, so a fact drawn from
    // it is the shortest possible way to leak it afterwards.
    await withTenant(session, async (ctx) => {
      await proposeMemories(ctx, {
        runId: org.runId,
        knowledge: [
          {
            documentId: secretId,
            documentTitle: 'Quinoxaline handling',
            anchor: '#pre-cooling',
            content: 'Reefer units are pre-cooled for 90 minutes before quinoxaline loading.',
          },
        ],
        candidates: [
          {
            scope: 'organization',
            subject: 'Reefer units',
            predicate: 'are pre-cooled for',
            object: '90 minutes',
            knowledgeIndex: 0,
          },
        ],
      })
      const [row] = await ctx.sql<{ id: string }[]>`
        SELECT id FROM memory_facts WHERE organization_id = ${ctx.organizationId}
          AND subject = 'Reefer units' AND state = 'candidate'`
      return confirmMemory(ctx, await loadActor(ctx), row!.id)
    })

    const forOwner = await withTenant(session, async (ctx) => recallMemories(ctx, await loadActor(ctx)))
    expect(forOwner.some((fact) => fact.citation?.documentId === secretId)).toBe(true)

    const forMember = await withTenant(memberSession, async (ctx) => recallMemories(ctx, await loadActor(ctx)))
    expect(forMember.some((fact) => fact.citation?.documentId === secretId)).toBe(false)
  })
})

describe('sharing and restricting agree', () => {
  it('puts the recipient of a share on the circulation list', async () => {
    // Before this existed, the tuple granted `document:read` through can() while retrieval
    // consulted the list and never saw it: shared, and still unfindable.
    expect(await findsIt(memberSession)).toBe(false)

    await withTenant(session, async (ctx) =>
      share(ctx, await loadActor(ctx), {
        subjectType: 'user',
        subjectId: org.memberId,
        relation: 'viewer',
        objectType: 'document',
        objectId: secretId,
        reason: 'Covering the audit next week.',
      }),
    )

    expect(await findsIt(memberSession)).toBe(true)
    const audience = await withTenant(session, async (ctx) =>
      documentAudience(ctx, await loadActor(ctx), secretId),
    )
    expect(audience.entries.some((entry) => entry.subjectId === org.memberId)).toBe(true)
  })
})

describe('reopening it', () => {
  it('refuses to reopen by removing the last name, and does it deliberately instead', async () => {
    const audience = await withTenant(session, async (ctx) =>
      documentAudience(ctx, await loadActor(ctx), secretId),
    )
    // Remove everybody but one, one at a time.
    let remaining = audience.entries
    for (const entry of audience.entries.slice(0, -1)) {
      remaining = (
        await withTenant(session, async (ctx) =>
          revokeDocumentAccess(ctx, await loadActor(ctx), {
            documentId: secretId,
            entryId: entry.id,
            reason: 'Audit finished for them.',
          }),
        )
      ).entries
    }
    expect(remaining).toHaveLength(1)

    // Removing the last one would silently reopen the document, so it is refused.
    await expect(
      withTenant(session, async (ctx) =>
        revokeDocumentAccess(ctx, await loadActor(ctx), {
          documentId: secretId,
          entryId: remaining[0]!.id,
          reason: 'Tidying up.',
        }),
      ),
    ).rejects.toThrow(/reopen the document/i)

    const opened = await withTenant(session, async (ctx) =>
      openDocumentToEveryone(ctx, await loadActor(ctx), {
        documentId: secretId,
        reason: 'Audit closed; the standard is public now.',
      }),
    )
    expect(opened.restricted).toBe(false)
    expect(await findsIt(memberSession)).toBe(true)

    await expect(
      withTenant(session, async (ctx) =>
        openDocumentToEveryone(ctx, await loadActor(ctx), { documentId: secretId, reason: 'Again, somehow.' }),
      ),
    ).rejects.toThrow(/not restricted/i)
  })
})

describe('a circulation list belongs to one organization', () => {
  it('does not restrict another tenant’s documents, and cannot be read across', async () => {
    const other = await createTenant('audience-other')
    const otherSession = { organizationId: other.organizationId, userId: other.ownerId, timezone: 'Europe/London' }

    await expect(
      withTenant(otherSession, async (ctx) => documentAudience(ctx, await loadActor(ctx), secretId)),
    ).rejects.toThrow()

    const [leaked] = await adminSql()<{ count: string }[]>`
      SELECT count(*)::text AS count FROM document_permissions
      WHERE organization_id = ${other.organizationId}`
    expect(Number(leaked?.count ?? 0)).toBe(0)

    await destroyTenant('audience-other')
  })
})
