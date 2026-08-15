import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  getDocument,
  getSpace,
  hybridSearch,
  ingestDocument,
  listDocuments,
  listSpaces,
  NotFoundError,
  PermissionError,
  relationship360,
  share,
  shareableRelations,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Sharing a knowledge space, and sharing a company (§4.6, §8.1, §12.6).
 *
 * `knowledge_spaces` was created in migration 0004, seeded, and read by nothing, while
 * `documents.space_id` was written on every document and selected by nothing. Worse, the
 * type was declared shareable and could not be shared: the tuple names the object
 * `knowledge_space` and the permission catalogue spells the domain `knowledge`, so
 * `can(actor, 'knowledge_space:read')` matched no grant any role holds.
 *
 * The two containers are deliberately not alike. A space *contains* documents — they have
 * no other home — so sharing it lends a read of them. A company does not contain its
 * threads and documents; it is a party to them, and each lives somewhere of its own.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let memberSession: { organizationId: string; userId: string; timezone: string }
let guestSession: { organizationId: string; userId: string; timezone: string }
let guestId: string
let spaceId: string
let openDocId: string
let secretDocId: string
let looseDocId: string

beforeAll(async () => {
  org = await createTenant('space-sharing')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
  memberSession = { organizationId: org.organizationId, userId: org.memberId, timezone: 'Europe/London' }

  await adminSql()`DELETE FROM users WHERE lower(email) = 'guest.space-sharing@fixture.example'`
  const [user] = await adminSql()<{ id: string }[]>`
    INSERT INTO users (email, name, timezone, is_demo)
    VALUES ('guest.space-sharing@fixture.example', 'Guest Spaces', 'Europe/London', true) RETURNING id`
  guestId = user!.id
  await adminSql()`
    INSERT INTO memberships (organization_id, user_id, role, is_demo)
    VALUES (${org.organizationId}, ${guestId}, 'guest', true)`
  guestSession = { organizationId: org.organizationId, userId: guestId, timezone: 'Europe/London' }

  await withTenant(session, async (ctx) => {
    const [space] = await ctx.sql<{ id: string }[]>`
      INSERT INTO knowledge_spaces (organization_id, name, slug, description, is_demo, created_by)
      VALUES (${org.organizationId}, 'Operations', 'operations', 'Procedures and contracts', true, ${org.ownerId})
      RETURNING id`
    spaceId = space!.id

    const file = async (title: string, sensitivity: string, inSpace: boolean, body: string) => {
      const [row] = await ctx.sql<{ id: string }[]>`
        INSERT INTO documents (organization_id, space_id, title, doc_type, sensitivity,
                               index_status, is_demo, created_by)
        VALUES (${org.organizationId}, ${inSpace ? spaceId : null}, ${title}, 'policy',
                ${sensitivity}::sw_sensitivity, 'pending', true, ${org.ownerId})
        RETURNING id`
      await ingestDocument(ctx, {
        documentId: row!.id,
        title,
        docType: 'policy',
        body,
        sensitivityHint: sensitivity as 'public',
      })
      return row!.id
    }

    openDocId = await file('Shelf handling procedure', 'public', true,
      '# Handling\n\n## Steps\n\nThe zolvatrine handling procedure is reviewed each spring.\n')
    secretDocId = await file('Board compensation letter', 'confidential', true,
      '# Compensation\n\n## Terms\n\nThe zolvatrine board letter is filed here too.\n')
    looseDocId = await file('Unfiled note', 'public', false,
      '# Note\n\n## Body\n\nA zolvatrine note on no shelf at all.\n')
  })
})

afterAll(async () => {
  await destroyTenant('space-sharing')
  await adminSql()`DELETE FROM users WHERE id = ${guestId}`
  await closePools()
})

describe('a knowledge space could not be shared at all', () => {
  it('was declared shareable while no role held any knowledge_space permission', async () => {
    // The regression: `can(actor, 'knowledge_space:read')` matched nothing, because the
    // catalogue spells the domain `knowledge`. A member could not read or share one.
    const asMember = await withTenant(memberSession, async (ctx) =>
      shareableRelations(await loadActor(ctx), 'knowledge_space', spaceId, ctx.organizationId),
    )
    expect(asMember).toEqual(['viewer'])

    const asOwner = await withTenant(session, async (ctx) =>
      shareableRelations(await loadActor(ctx), 'knowledge_space', spaceId, ctx.organizationId),
    )
    expect(asOwner).toEqual(['viewer', 'editor', 'approver', 'owner'])
  })

  it('can be read, and says how much is on the shelf', async () => {
    const space = await withTenant(session, async (ctx) => getSpace(ctx, await loadActor(ctx), spaceId))
    expect(space.name).toBe('Operations')
    expect(space.documentCount).toBe(2)
  })

  it('keeps a document on its shelf when it is re-indexed', async () => {
    // The reason the spaces table looked disconnected from everything: `ingestDocument`
    // *assigned* company_id, project_id, space_id, owner_id and department_id from its own
    // input, so a caller that only asked for indexing unfiled the document. The seed did
    // exactly that — inserted into a space, then indexed, then the space was gone.
    await withTenant(session, async (ctx) => {
      await ingestDocument(ctx, {
        documentId: openDocId,
        title: 'Shelf handling procedure',
        docType: 'policy',
        body: '# Handling\n\n## Steps\n\nThe zolvatrine handling procedure is reviewed each spring.\n',
        sensitivityHint: 'public',
      })
    })
    const still = await withTenant(session, async (ctx) => getDocument(ctx, await loadActor(ctx), openDocId))
    expect(still.spaceId).toBe(spaceId)
  })
})

describe('a space share lends a read of what is filed in it', () => {
  it('gives a guest nothing to begin with, and says why rather than showing an empty shelf', async () => {
    // `guest` holds no `knowledge` grant at all. With nothing granted and nothing given,
    // the honest answer is the refusal with its reason — not an empty list, which would
    // read as "there are no spaces".
    await expect(
      withTenant(guestSession, async (ctx) => listSpaces(ctx, await loadActor(ctx))),
    ).rejects.toThrow(PermissionError)

    const documents = await withTenant(guestSession, async (ctx) =>
      listDocuments(ctx, await loadActor(ctx)),
    )
    expect(documents).toHaveLength(0)
  })

  it('reaches the documents on the shelf, in the list and on the page', async () => {
    await withTenant(session, async (ctx) =>
      share(ctx, await loadActor(ctx), {
        subjectType: 'user',
        subjectId: guestId,
        relation: 'viewer',
        objectType: 'knowledge_space',
        objectId: spaceId,
        reason: 'Working through the procedures with us.',
      }),
    )

    const after = await withTenant(guestSession, async (ctx) => {
      const actor = await loadActor(ctx)
      return {
        spaces: (await listSpaces(ctx, actor)).map((space) => space.id),
        documents: (await listDocuments(ctx, actor)).map((doc) => doc.id),
        opens: await getDocument(ctx, actor, openDocId).then((doc) => doc.spaceName, () => null),
      }
    })
    expect(after.spaces).toEqual([spaceId])
    expect(after.documents).toEqual([openDocId])
    expect(after.opens).toBe('Operations')
  })

  it('does not lift a document’s own classification', async () => {
    // A guest reads up to `public`. The confidential letter is on the same shelf and stays
    // shut — the space lends reach, the document keeps its own classification.
    const refusal = await withTenant(guestSession, async (ctx) =>
      getDocument(ctx, await loadActor(ctx), secretDocId).then(
        () => null,
        (error: Error) => error.message,
      ),
    )
    // The ingest classifier reads the content and may rate it higher than the column said;
    // what matters is that it is refused *on classification*, naming the reader's ceiling.
    expect(refusal).toMatch(/is classified/i)
    expect(refusal).toMatch(/covers up to public/i)
  })

  it('reaches only what is actually on the shelf', async () => {
    await expect(
      withTenant(guestSession, async (ctx) => getDocument(ctx, await loadActor(ctx), looseDocId)),
    ).rejects.toThrow(PermissionError)
  })

  it('lets the assistant cite it, so search and the page agree', async () => {
    // The other half of the same bug: a narrow role's retrieval was hard-filtered to its
    // own teams, which threw away everything it had been *given*. The page opened and the
    // assistant could not find it.
    const found = await withTenant(guestSession, async (ctx) => {
      const result = await hybridSearch(ctx, await loadActor(ctx), 'zolvatrine handling procedure')
      return result.chunks.map((chunk) => chunk.documentId)
    })
    expect(found).toContain(openDocId)
    // And still nothing it should not have.
    expect(found).not.toContain(secretDocId)
    expect(found).not.toContain(looseDocId)
  })
})

describe('a company is not a container', () => {
  it('hands over the account view and not what is filed against it', async () => {
    await withTenant(session, async (ctx) =>
      share(ctx, await loadActor(ctx), {
        subjectType: 'user',
        subjectId: guestId,
        relation: 'viewer',
        objectType: 'company',
        objectId: org.companyId,
        reason: 'Covering the account this month.',
      }),
    )

    const view = await withTenant(guestSession, async (ctx) =>
      relationship360(ctx, await loadActor(ctx), org.companyId),
    )
    expect(view.company.id).toBe(org.companyId)

    // A company share is not a document share: the fixture's confidential document is filed
    // against this company and must not appear, by title or otherwise.
    expect(view.documents.map((doc) => doc.id)).not.toContain(org.documentId)
  })

  it('does not list work the reader could not open from the task screen', async () => {
    // The aggregate gated once on the company and then trusted itself. A guest holds
    // task:read:team and belongs to no team, so its open-task list is empty here too.
    const view = await withTenant(guestSession, async (ctx) =>
      relationship360(ctx, await loadActor(ctx), org.companyId),
    )
    expect(view.openTasks).toEqual([])
  })

  it('still shows the account owner everything', async () => {
    const view = await withTenant(session, async (ctx) =>
      relationship360(ctx, await loadActor(ctx), org.companyId),
    )
    expect(view.company.name).toContain('Customer')
  })
})

describe('both belong to one organization', () => {
  it('reports absence, never denial, across tenants', async () => {
    const other = await createTenant('space-sharing-other')
    const otherSession = { organizationId: other.organizationId, userId: other.ownerId, timezone: 'Europe/London' }

    await expect(
      withTenant(otherSession, async (ctx) => getSpace(ctx, await loadActor(ctx), spaceId)),
    ).rejects.toThrow(NotFoundError)

    const listed = await withTenant(otherSession, async (ctx) => listSpaces(ctx, await loadActor(ctx)))
    expect(listed.map((space) => space.id)).not.toContain(spaceId)

    await destroyTenant('space-sharing-other')
  })
})
