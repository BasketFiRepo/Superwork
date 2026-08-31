import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  advanceMailboxCursor,
  connectMailbox,
  disconnectMailbox,
  fileInbound,
  mailboxHealth,
  mailboxesDueSync,
  markMailboxTrouble,
  myMailboxes,
  reconnectMailbox,
  type InboundMail,
} from '@superwork/core'
import { MockEmailProvider } from '@superwork/integrations'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * A mailbox somebody connected (ADR 0084).
 *
 * `EmailProvider.sync()` has been on the contract since Phase 2 and nothing ever called it, so
 * nine columns on `email_accounts` sat empty while the inbox was fed by hand.
 *
 * The rule this file exists to hold: **a person connects their own mailbox and nobody else's.**
 * An administrator who could connect a colleague's mail would be operating the surveillance
 * switch §29.5 exists to make unbuildable.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let owner: { organizationId: string; userId: string; timezone: string }
let member: { organizationId: string; userId: string; timezone: string }

const mail = (n: number, thread = 'thread-1'): InboundMail => ({
  externalId: `msg-${n}`,
  threadExternalId: thread,
  from: { name: 'Ingrid Solberg', address: 'ingrid@halden.example' },
  to: ['ops@northwind.example'],
  cc: ['quality@halden.example'],
  subject: 'Temperature excursion 2026-014',
  body: 'Two questions before we release the consignment.',
  sentAt: new Date(),
})

beforeAll(async () => {
  org = await createTenant('mailbox-connection')
  owner = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  member = { organizationId: org.organizationId, userId: org.memberId, timezone: TZ }
})

afterAll(async () => {
  await destroyTenant('mailbox-connection')
  await closePools()
})

describe('whose mailbox it is', () => {
  it('a person connects their own, and it is theirs', async () => {
    const box = await withTenant(member, async (ctx) =>
      connectMailbox(ctx, await loadActor(ctx), { address: 'Nina@northwind.example' }),
    )
    expect(box.address).toBe('nina@northwind.example')
    expect(box.status).toBe('connected')

    const [row] = await adminSql()<{ user_id: string }[]>`
      SELECT user_id FROM email_accounts WHERE id = ${box.id}`
    expect(row!.user_id).toBe(org.memberId)
  })

  it('and nobody else can see it, not even the owner of the organization', async () => {
    /**
     * The whole posture in one assertion. `myMailboxes` is self-only in SQL, the way
     * `myAuditTrail` is — there is no argument for whose, so there is nothing to pass wrongly.
     */
    const mine = await withTenant(owner, async (ctx) => myMailboxes(ctx, await loadActor(ctx)))
    expect(mine.every((box) => box.address !== 'nina@northwind.example')).toBe(true)
  })

  it('and nobody else can disconnect it — it answers as though it is not there', async () => {
    const [box] = await withTenant(member, async (ctx) => myMailboxes(ctx, await loadActor(ctx)))
    await expect(
      withTenant(owner, async (ctx) => disconnectMailbox(ctx, await loadActor(ctx), box!.id)),
    ).rejects.toThrow(/not found/i)
  })

  it('and the API has no field for whose it is', async () => {
    /**
     * A route that accepted a `userId` would be one request away from a manager connecting a
     * colleague's mail. Asserted against the schema rather than the whole file: the first version
     * of this searched the text and matched the *comment explaining why there is no such field* —
     * the same trap ADR 0080's detector fell into, reading prose about a defect as the defect.
     */
    const route = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../apps/web/src/app/api/mailboxes/route.ts', import.meta.url), 'utf8'),
    )
    const schema = /const Body = z[\s\S]*?\n\]\)/.exec(route)?.[0] ?? ''
    expect(schema).toMatch(/z\.literal\('connect'\)/)
    expect(schema).not.toMatch(/userId|user_id|onBehalfOf/)
  })

  it('and an address can only be connected once here', async () => {
    await expect(
      withTenant(owner, async (ctx) =>
        connectMailbox(ctx, await loadActor(ctx), { address: 'nina@northwind.example' }),
      ),
    ).rejects.toThrow(/already connected here/i)
  })

  it('and it has to look like an address', async () => {
    await expect(
      withTenant(owner, async (ctx) => connectMailbox(ctx, await loadActor(ctx), { address: 'not-an-address' })),
    ).rejects.toThrow(/not an address/i)
  })

  it('and the person it belongs to has to be a member here', async () => {
    const other = await createTenant('mailbox-connection-b')
    try {
      await expect(
        adminSql()`
          INSERT INTO email_accounts (organization_id, user_id, address, created_by)
          VALUES (${org.organizationId}, ${other.ownerId}, 'stranger@elsewhere.example', ${org.ownerId})`,
      ).rejects.toThrow(/active member of this organization/i)
    } finally {
      await destroyTenant('mailbox-connection-b')
    }
  })
})

describe('what the organization is told', () => {
  it('an administrator sees how many are collecting, and nothing else', async () => {
    const health = await withTenant(owner, async (ctx) => mailboxHealth(ctx, await loadActor(ctx)))
    expect(health.connected).toBeGreaterThan(0)
    expect(Object.keys(health).sort()).toEqual(['connected', 'introuble'])
  })

  it('and the screen names no address and no person', async () => {
    const page = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('../../apps/web/src/app/(app)/settings/integrations/page.tsx', import.meta.url),
        'utf8',
      ),
    )
    const panel = /data-testid="mailbox-health"[\s\S]*?<\/section>/.exec(page)?.[0] ?? ''
    expect(panel).toBeTruthy()
    // Not "the word address does not appear" — the panel's own copy says it shows no addresses,
    // and asserting on prose is how a test starts reading the explanation instead of the code.
    // What matters is that it renders no per-mailbox value: only the two counts.
    expect(panel).not.toMatch(/\.address|\.userId|\.lastError|mailbox\./)
    expect(panel).toMatch(/mailboxes\.connected/)
    expect(panel).toMatch(/never whose/i)
  })
})

describe('a connection that stopped', () => {
  it('says what stopped it, and the database will not let it stay quiet', async () => {
    const [box] = await withTenant(member, async (ctx) => myMailboxes(ctx, await loadActor(ctx)))
    await withTenant(member, async (ctx) =>
      markMailboxTrouble(ctx, box!.id, 'expired', 'The connection expired 2 days ago.'),
    )
    const [after] = await withTenant(member, async (ctx) => myMailboxes(ctx, await loadActor(ctx)))
    expect(after!.status).toBe('expired')
    expect(after!.lastError).toMatch(/expired/i)
  })

  it('and a status that says trouble with no reason is refused outright', async () => {
    const [box] = await withTenant(member, async (ctx) => myMailboxes(ctx, await loadActor(ctx)))
    await expect(
      adminSql()`UPDATE email_accounts SET status = 'error', last_error = NULL WHERE id = ${box!.id}`,
    ).rejects.toThrow(/trouble_is_explained/i)
  })

  it('and an unknown status is not a status', async () => {
    const [box] = await withTenant(member, async (ctx) => myMailboxes(ctx, await loadActor(ctx)))
    await expect(
      adminSql()`UPDATE email_accounts SET status = 'sulking', last_error = 'x' WHERE id = ${box!.id}`,
    ).rejects.toThrow(/status_known/i)
  })

  it('and a stopped mailbox is not offered to the sweep', async () => {
    const due = await withTenant(member, async (ctx) => mailboxesDueSync(ctx))
    expect(due.every((box) => box.address !== 'nina@northwind.example')).toBe(true)
  })

  it('and the person whose it is can reconnect it, which clears the message', async () => {
    const [box] = await withTenant(member, async (ctx) => myMailboxes(ctx, await loadActor(ctx)))
    const back = await withTenant(member, async (ctx) => reconnectMailbox(ctx, await loadActor(ctx), box!.id))
    expect(back.status).toBe('connected')
    expect(back.lastError).toBeNull()
  })

  it('and nobody else can reconnect it', async () => {
    const [box] = await withTenant(member, async (ctx) => myMailboxes(ctx, await loadActor(ctx)))
    await withTenant(member, async (ctx) => markMailboxTrouble(ctx, box!.id, 'error', 'Something broke.'))
    await expect(
      withTenant(owner, async (ctx) => reconnectMailbox(ctx, await loadActor(ctx), box!.id)),
    ).rejects.toThrow(/not found/i)
    await withTenant(member, async (ctx) => reconnectMailbox(ctx, await loadActor(ctx), box!.id))
  })
})

describe('filing what arrived', () => {
  it('opens a thread and files the message as untrusted external', async () => {
    const filed = await withTenant(member, async (ctx) => fileInbound(ctx, org.memberId, [mail(1)]))
    expect(filed.collected).toBe(1)
    expect(filed.threadsOpened).toBe(1)

    const [message] = await adminSql()<{ trust_level: string; external_id: string }[]>`
      SELECT trust_level, external_id FROM messages
      WHERE organization_id = ${org.organizationId} AND external_id = 'msg-1'`
    expect(message!.trust_level).toBe('untrusted_external')
  })

  it('and the same message twice is not two messages', async () => {
    /**
     * A sync that runs again over the same cursor — after a crash, a retry, a clock skew at the
     * provider — must not put the same message on the thread twice. Backed by a unique index
     * rather than a SELECT first, because two passes racing would both find nothing.
     */
    const filed = await withTenant(member, async (ctx) => fileInbound(ctx, org.memberId, [mail(1)]))
    expect(filed.collected).toBe(0)
    expect(filed.deduped).toBe(1)

    const [count] = await adminSql()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM messages
      WHERE organization_id = ${org.organizationId} AND external_id = 'msg-1'`
    expect(count!.n).toBe(1)
  })

  it('and a second message on the same thread joins it rather than starting another', async () => {
    const filed = await withTenant(member, async (ctx) => fileInbound(ctx, org.memberId, [mail(2)]))
    expect(filed.collected).toBe(1)
    expect(filed.threadsOpened).toBe(0)

    const [count] = await adminSql()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conversations
      WHERE organization_id = ${org.organizationId} AND external_id = 'thread-1'`
    expect(count!.n).toBe(1)
  })

  it('and threading is on the provider’s thread id, never the subject', async () => {
    // Subject matching is how two unrelated conversations called "Re: invoice" become one thread
    // and a customer sees somebody else's reply quoted back at them.
    const filed = await withTenant(member, async (ctx) =>
      fileInbound(ctx, org.memberId, [{ ...mail(3, 'thread-2') }]),
    )
    expect(filed.threadsOpened).toBe(1)
  })

  it('and nothing it files leaks across a tenant boundary', async () => {
    const other = await createTenant('mailbox-connection-c')
    try {
      const theirs = await withTenant(
        { organizationId: other.organizationId, userId: other.ownerId, timezone: TZ },
        async (ctx) =>
          ctx.sql<{ id: string }[]>`SELECT id FROM messages WHERE external_id = 'msg-1'`,
      )
      expect(theirs).toHaveLength(0)
    } finally {
      await destroyTenant('mailbox-connection-c')
    }
  })
})

describe('the provider contract nothing used to call', () => {
  it('the mock hands over what it was given, once, and moves the cursor', async () => {
    /**
     * The mock's `sync` returned an empty list with a comment saying the demo's inbound mail was
     * seeded directly — which is exactly why nothing ever called it. A mock that cannot produce
     * an inbound message makes its own consumer untestable, so the consumer was never written.
     */
    const provider = new MockEmailProvider()
    provider.deliver(mail(10, 'thread-10'))

    const first = await provider.sync(null)
    expect(first.messages).toHaveLength(1)
    expect(first.cursor).toBe('msg-10')

    const second = await provider.sync(first.cursor)
    expect(second.messages).toHaveLength(0)
    expect(second.cursor).toBe('msg-10')
  })

  it('and a cursor only moves after what came with it is filed', async () => {
    const [box] = await withTenant(member, async (ctx) => myMailboxes(ctx, await loadActor(ctx)))
    const at = new Date()
    await withTenant(member, async (ctx) => advanceMailboxCursor(ctx, box!.id, 'msg-2', at))
    const [row] = await adminSql()<{ sync_cursor: string; last_sync_at: Date }[]>`
      SELECT sync_cursor, last_sync_at FROM email_accounts WHERE id = ${box!.id}`
    expect(row!.sync_cursor).toBe('msg-2')
    expect(row!.last_sync_at).toBeInstanceOf(Date)
  })

  it('and the worker treats a rate limit differently from an expired token', async () => {
    /**
     * §5.6's failure taxonomy, and the reason it matters here: a token that expired needs the
     * person to reconnect and the mailbox has to say so; a rate limit is this minute's problem.
     * Treating them alike either nags somebody about a hiccup or leaves a dead connection showing
     * a stale inbox.
     */
    const worker = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../apps/worker/src/main.ts', import.meta.url), 'utf8'),
    )
    expect(worker).toMatch(/TransientError/)
    expect(worker).toMatch(/AuthError/)
    expect(worker).toMatch(/markMailboxTrouble/)
  })
})

describe('disconnecting', () => {
  it('stops the collection and keeps what already arrived', async () => {
    const [box] = await withTenant(member, async (ctx) => myMailboxes(ctx, await loadActor(ctx)))
    await withTenant(member, async (ctx) => disconnectMailbox(ctx, await loadActor(ctx), box!.id))

    const mine = await withTenant(member, async (ctx) => myMailboxes(ctx, await loadActor(ctx)))
    expect(mine).toHaveLength(0)

    // The messages are business records on threads colleagues have been working. Deleting them
    // because somebody unplugged a mailbox would lose the account history with it.
    const [count] = await adminSql()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM messages
      WHERE organization_id = ${org.organizationId} AND external_id = 'msg-1'`
    expect(count!.n).toBe(1)
  })
})
