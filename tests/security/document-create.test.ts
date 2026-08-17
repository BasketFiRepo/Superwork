import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor, ROLE_PERMISSIONS } from '@superwork/auth'
import {
  getDocument,
  listDocuments,
  PermissionError,
  reclassifyDocument,
  setEffectiveDates,
  uploadDocument,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Adding to company memory (§7.1, ADR 0045).
 *
 * `ROLE_PERMISSIONS` has granted members `document:create:own` since Phase 0, and no member
 * could ever add a document: `uploadDocument` asked the policy engine about a resource with no
 * owner on it, and `own` is satisfied by owning the thing. So the check refused every member
 * with the sentence "You need Member access to create this document" — said to a member.
 *
 * The screen offered the button to everybody, including viewers, so the refusal arrived after
 * somebody had typed a whole document.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let owner: { organizationId: string; userId: string; timezone: string }
let member: { organizationId: string; userId: string; timezone: string }
let viewer: { organizationId: string; userId: string; timezone: string }

const ORDINARY = [
  '# How we run the Monday planning session',
  '',
  'Everybody brings the one thing they most want moved this week, and we sort them together.',
].join('\n')

/** Trips the classifier at `restricted`, which is above a member's reach. */
const COMPENSATION = [
  '# Reviewing this year’s bands',
  '',
  'The salary bands are reviewed each spring, alongside the bonus scheme.',
].join('\n')

beforeAll(async () => {
  org = await createTenant('document-create')
  owner = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  member = { organizationId: org.organizationId, userId: org.memberId, timezone: TZ }
  viewer = { organizationId: org.organizationId, userId: org.viewerId, timezone: TZ }
})

afterAll(async () => {
  await destroyTenant('document-create')
  await closePools()
})

describe('the grant the role table always claimed', () => {
  it('still says a member may add one', () => {
    // If this line ever goes, the tests below are asserting a permission nobody has.
    expect(ROLE_PERMISSIONS.member).toContain('document:create:own')
  })

  it('lets a member add a document, and it is theirs', async () => {
    const created = await withTenant(member, async (ctx) => {
      const actor = await loadActor(ctx)
      return uploadDocument(ctx, actor, {
        title: 'How we run the Monday planning session',
        body: ORDINARY,
        docType: 'policy',
      })
    })

    expect(created.ingest.status).toBe('indexed')
    expect(created.ingest.chunks).toBeGreaterThan(0)
    expect(created.document.ownerId).toBe(org.memberId)
    expect(created.document.sensitivity).toBe('internal')

    // And it is in their library rather than only in the database.
    await withTenant(member, async (ctx) => {
      const actor = await loadActor(ctx)
      const documents = await listDocuments(ctx, actor, {})
      expect(documents.some((row) => row.id === created.document.id)).toBe(true)
    })
  })

  it('gives them a say over what they added, because they own it', async () => {
    // `document:update:own` was as unreachable as the create: nobody could own a document they
    // had added, so nothing was ever theirs to correct.
    const created = await withTenant(member, async (ctx) => {
      const actor = await loadActor(ctx)
      return uploadDocument(ctx, actor, { title: 'A note of my own', body: ORDINARY, docType: 'note' })
    })

    await withTenant({ ...member, steppedUpAt: new Date() }, async (ctx) => {
      const actor = await loadActor(ctx)
      const reclassified = await reclassifyDocument(ctx, actor, {
        documentId: created.document.id,
        sensitivity: 'public',
        reason: 'There is nothing internal about how we run a planning session.',
      })
      expect(reclassified.sensitivity).toBe('public')
      expect(reclassified.sensitivitySetByName).toBeTruthy()

      const termed = await setEffectiveDates(ctx, actor, {
        documentId: created.document.id,
        effectiveTo: '2030-12-31',
      })
      expect(termed.effectiveTo).toBe('2030-12-31')
    })
  })

  it('refuses a viewer, and names what they would need', async () => {
    await withTenant(viewer, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        uploadDocument(ctx, actor, { title: 'Not mine to add', body: ORDINARY }),
      ).rejects.toThrow(PermissionError)
      await expect(
        uploadDocument(ctx, actor, { title: 'Not mine to add', body: ORDINARY }),
      ).rejects.toThrow(/Member access/i)
    })
  })
})

describe('a document you could not open afterwards', () => {
  it('is refused before anything is stored, and says what it read', async () => {
    await withTenant(member, async (ctx) => {
      const actor = await loadActor(ctx)
      // A member reads up to `internal`; the classifier reads compensation as `restricted`.
      // Filing it would have indexed it, thrown on the read-back, and left the member with an
      // error and a document they could neither see nor delete.
      const refusal = uploadDocument(ctx, actor, {
        title: 'Reviewing this year’s bands',
        body: COMPENSATION,
      })
      await expect(refusal).rejects.toThrow(ValidationError)
      await expect(refusal).rejects.toThrow(/out of your own reach/i)
      await expect(refusal).rejects.toThrow(/compensation/i)
    })

    // Nothing stored: not the row, not a version, not a passage.
    const rows = await adminSql()<{ count: string }[]>`
      SELECT count(*)::text AS count FROM documents
      WHERE organization_id = ${org.organizationId} AND title = 'Reviewing this year’s bands'`
    expect(rows[0]!.count).toBe('0')
    const chunks = await adminSql()<{ count: string }[]>`
      SELECT count(*)::text AS count FROM document_chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE d.organization_id = ${org.organizationId} AND d.title = 'Reviewing this year’s bands'`
    expect(chunks[0]!.count).toBe('0')
  })

  it('is filed by somebody who can read it, which is the whole of the refusal', async () => {
    const created = await withTenant(owner, async (ctx) => {
      const actor = await loadActor(ctx)
      return uploadDocument(ctx, actor, {
        title: 'Reviewing this year’s bands',
        body: COMPENSATION,
      })
    })
    expect(created.document.sensitivity).toBe('restricted')

    // And the member cannot see it, which is the classification working rather than a bug.
    await withTenant(member, async (ctx) => {
      const actor = await loadActor(ctx)
      const documents = await listDocuments(ctx, actor, {})
      expect(documents.some((row) => row.id === created.document.id)).toBe(false)
      await expect(getDocument(ctx, actor, created.document.id)).rejects.toThrow(PermissionError)
    })
  })

  it('does not stop an owner adding what an owner can read', async () => {
    const created = await withTenant(owner, async (ctx) => {
      const actor = await loadActor(ctx)
      return uploadDocument(ctx, actor, { title: 'An owner’s note', body: ORDINARY })
    })
    expect(created.document.ownerId).toBe(org.ownerId)
  })
})
