import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  getDocument,
  hybridSearch,
  PermissionError,
  reclassifyAutomatically,
  reclassifyDocument,
  requestReindex,
  runIngestionJobs,
  StepUpRequiredError,
  uploadDocument,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Who decided this was confidential (ADR 0044).
 *
 * `documents.sensitivity_source` has existed since migration 0004 with a default of 'auto' and
 * nothing ever wrote another value — it could not, because there was no way for a person to
 * change a classification at all. So every level was a regex's opinion recorded as though nobody
 * had one, a misclassification had no fix, and `classifyContent` can only ever *raise*, so even
 * a hand-edited row would be put straight back by the next re-index.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let steppedSession: { organizationId: string; userId: string; timezone: string; steppedUpAt: Date }
let viewerSession: { organizationId: string; userId: string; timezone: string }
let documentId: string
/** An ordinary document the member owns, for the tests about a person's own reach. */
let plainId: string

/** Trips the classifier: a rate card reads as confidential, and here it is an invented one. */
const BODY = [
  '# Example pricing note template',
  '',
  '## Terms',
  'This rate card is a worked example, showing the margin on a single made-up line item.',
  '',
  '## Notes',
  'The figures here are illustrative and belong to no real customer.',
].join('\n')

const PLAIN_BODY = [
  '# How we run the Monday planning session',
  '',
  'Everybody brings the one thing they most want moved this week, and we sort them together.',
].join('\n')

beforeAll(async () => {
  org = await createTenant('classification-source')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  steppedSession = { ...session, steppedUpAt: new Date() }
  viewerSession = { organizationId: org.organizationId, userId: org.viewerId, timezone: TZ }

  await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const uploaded = await uploadDocument(ctx, actor, {
      title: 'Example pricing note template',
      body: BODY,
      docType: 'policy',
    })
    documentId = uploaded.document.id

    const plain = await uploadDocument(ctx, actor, {
      title: 'How we run the Monday planning session',
      body: PLAIN_BODY,
      docType: 'policy',
    })
    plainId = plain.document.id
  })
  // Handed to the member so they have a say over it: a member's `document:update` is scoped to
  // their own, which is exactly the actor the ceiling test needs.
  await adminSql()`UPDATE documents SET owner_id = ${org.memberId} WHERE id = ${plainId}`
})

afterAll(async () => {
  await destroyTenant('classification-source')
  await closePools()
})

describe('a classification nobody weighed says so', () => {
  it('records what the classifier read, and that nobody has decided', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const document = await getDocument(ctx, actor, documentId)
      expect(document.sensitivitySource).toBe('auto')
      // The classifier's own reading, kept whether or not it ends up winning.
      expect(document.sensitivityAuto).toBe(document.sensitivity)
      expect(document.sensitivitySetByName).toBeNull()
    })
  })
})

describe('a person can correct it, and is named for it', () => {
  it('needs a say over the document, not a read of it', async () => {
    await withTenant(viewerSession, async (ctx) => {
      const actor = await loadActor(ctx)
      // A viewer can read this one perfectly well. Reading it is not deciding about it.
      expect((await getDocument(ctx, actor, plainId)).id).toBe(plainId)
      await expect(
        reclassifyDocument(ctx, actor, {
          documentId: plainId,
          sensitivity: 'public',
          reason: 'Nothing sensitive in here.',
        }),
      ).rejects.toThrow(PermissionError)
    })
  })

  it('refuses a decision nobody explained', async () => {
    await withTenant(steppedSession, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        reclassifyDocument(ctx, actor, { documentId, sensitivity: 'internal', reason: 'x' }),
      ).rejects.toThrow(ValidationError)
    })
  })

  it('asks for a fresh proof when the level goes down, because that widens who can read it', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        reclassifyDocument(ctx, actor, {
          documentId,
          sensitivity: 'internal',
          reason: 'The rate card is an invented example, not a real one.',
        }),
      ).rejects.toThrow(StepUpRequiredError)
    })
  })

  it('does not ask when the level goes up, because raising only ever narrows', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const raised = await reclassifyDocument(ctx, actor, {
        documentId,
        sensitivity: 'restricted',
        reason: 'Treat the whole template as restricted while it is being reviewed.',
      })
      expect(raised.sensitivity).toBe('restricted')
      expect(raised.sensitivitySource).toBe('human')
      expect(raised.sensitivitySetByName).toBeTruthy()
      expect(raised.sensitivityReason).toContain('being reviewed')
    })
  })

  it('reaches every passage, which is what retrieval actually filters on', async () => {
    const chunks = await adminSql()<{ sensitivity: string }[]>`
      SELECT sensitivity::text AS sensitivity FROM document_chunks WHERE document_id = ${documentId}`
    expect(chunks.length).toBeGreaterThan(0)
    for (const chunk of chunks) expect(chunk.sensitivity).toBe('restricted')
  })

  it('does not let a person’s decision be read back as the classifier’s', async () => {
    // The re-index passes the document's level to `classifyContent` as the floor. Passing the
    // level *a person set* would record their decision as though the pattern had read it, and
    // the disagreement — the whole point of keeping both — would quietly disappear.
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await requestReindex(ctx, actor, { documentId, reason: 'Checking whose reading is recorded.' })
    })
    expect((await runIngestionJobs(session)).indexed).toBe(1)

    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const after = await getDocument(ctx, actor, documentId)
      expect(after.sensitivity).toBe('restricted')
      expect(after.sensitivityAuto).toBe('confidential')
    })
  })

  it('will not let somebody file a document above their own ceiling', async () => {
    // A member reads up to `internal`, so `confidential` would put their own document out of
    // their own reach — a classification whose author cannot open it afterwards.
    await withTenant(
      { organizationId: org.organizationId, userId: org.memberId, timezone: TZ, steppedUpAt: new Date() },
      async (ctx) => {
        const actor = await loadActor(ctx)
        await expect(
          reclassifyDocument(ctx, actor, {
            documentId: plainId,
            sensitivity: 'confidential',
            reason: 'Trying to file it out of my own reach.',
          }),
        ).rejects.toThrow(/out of your own reach/i)
      },
    )
  })

  it('cannot be recorded as a human decision without a name and a reason, whatever writes it', async () => {
    await expect(
      adminSql()`
        UPDATE documents SET sensitivity_source = 'human', sensitivity_set_by = NULL
        WHERE id = ${documentId}`,
    ).rejects.toThrow(/documents_human_classification_is_attributed/)
  })
})

describe('the classifier does not argue with the person afterwards', () => {
  it('leaves a human decision alone across a re-index', async () => {
    await withTenant(steppedSession, async (ctx) => {
      const actor = await loadActor(ctx)
      await reclassifyDocument(ctx, actor, {
        documentId,
        sensitivity: 'internal',
        reason: 'The rate card is an invented example, not a real one.',
      })
      await requestReindex(ctx, actor, { documentId, reason: 'Checking the classifier stays out of it.' })
    })

    const outcome = await runIngestionJobs(session)
    expect(outcome.indexed).toBe(1)

    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const after = await getDocument(ctx, actor, documentId)
      // `classifyContent` can only raise, so without the guard the re-index would put the
      // classifier's reading straight back and the correction would look like a bug.
      expect(after.sensitivity).toBe('internal')
      expect(after.sensitivitySource).toBe('human')
      // And what the classifier reads is still recorded, so the disagreement is visible.
      expect(after.sensitivityAuto).toBe('confidential')
    })

    const chunks = await adminSql()<{ sensitivity: string }[]>`
      SELECT sensitivity::text AS sensitivity FROM document_chunks WHERE document_id = ${documentId}`
    for (const chunk of chunks) expect(chunk.sensitivity).toBe('internal')
  })

  it('so the correction is what decides who can retrieve it', async () => {
    // A member reads up to `internal`. Before the correction this document was confidential,
    // which is the whole cost of a false positive.
    await withTenant({ organizationId: org.organizationId, userId: org.memberId, timezone: TZ }, async (ctx) => {
      const actor = await loadActor(ctx)
      const result = await hybridSearch(ctx, actor, 'rate card margin worked example line item', { topK: 10 })
      expect(result.chunks.some((chunk) => chunk.documentId === documentId)).toBe(true)
    })
  })
})

describe('handing it back', () => {
  it('returns the classifier’s reading and forgets the person', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const back = await reclassifyAutomatically(ctx, actor, {
        documentId,
        reason: 'Letting the classifier decide again.',
      })
      expect(back.sensitivitySource).toBe('auto')
      expect(back.sensitivity).toBe('confidential')
      expect(back.sensitivitySetByName).toBeNull()
      expect(back.sensitivityReason).toBeNull()
    })

    const chunks = await adminSql()<{ sensitivity: string }[]>`
      SELECT sensitivity::text AS sensitivity FROM document_chunks WHERE document_id = ${documentId}`
    for (const chunk of chunks) expect(chunk.sensitivity).toBe('confidential')
  })
})
