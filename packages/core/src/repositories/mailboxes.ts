import type { TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeAudit } from '../audit.js'

/**
 * A mailbox somebody connected (ADR 0084).
 *
 * `EmailProvider.sync()` has been on the contract since Phase 2 and nothing has ever called it,
 * so nine columns on `email_accounts` — the address, the provider, the status, the cursor, the
 * last sync, the last error — sat empty while the inbox was fed by hand.
 *
 * **A person connects their own mailbox and nobody else's.** That is the whole privacy posture of
 * this file, and it is enforced the way `personalRecord` enforces its own: the owner is always the
 * caller, and there is no supported way to name somebody else. An administrator who could connect
 * a colleague's mailbox is the surveillance switch §29.5 exists to make unbuildable — it would put
 * every message that person receives into a system their manager can search, without them ever
 * agreeing to it.
 *
 * What arrives is business correspondence and it is `untrusted_external` on the way in, which is
 * ADR 0076's rule and not re-litigated here.
 */

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The states `email_accounts_status_known` allows. Anything but `connected` has to say why. */
export type MailboxStatus = 'connected' | 'expired' | 'revoked' | 'error'

export interface MailboxView {
  id: string
  address: string
  provider: string
  status: MailboxStatus
  scopes: string[]
  lastSyncAt: Date | null
  lastError: string | null
  createdAt: Date
}

const SELECT_MAILBOX = (ctx: TenantContext) => ctx.sql`
  SELECT id, address, provider, status, scopes,
         last_sync_at AS "lastSyncAt", last_error AS "lastError", created_at AS "createdAt"
  FROM email_accounts`

/**
 * Your own mailboxes. Self only — the parameter is the caller's own id and there is no supported
 * way to ask for somebody else's, the same shape `myAuditTrail` takes (ADR 0079).
 */
export async function myMailboxes(ctx: TenantContext, actor: Actor): Promise<MailboxView[]> {
  return ctx.sql<MailboxView[]>`
    ${SELECT_MAILBOX(ctx)}
    WHERE organization_id = ${ctx.organizationId} AND user_id = ${actor.userId} AND deleted_at IS NULL
    ORDER BY created_at`
}

export interface ConnectMailboxInput {
  address: string
  /** Which capability implementation this is. `mock` is the only one that needs no credential. */
  provider?: string
  scopes?: string[]
}

export async function connectMailbox(
  ctx: TenantContext,
  actor: Actor,
  input: ConnectMailboxInput,
): Promise<MailboxView> {
  const address = input.address.trim().toLowerCase()
  if (!ADDRESS.test(address)) {
    throw new ValidationError(`"${input.address}" is not an address a mailbox could be at.`)
  }

  const [existing] = await ctx.sql<{ id: string; userId: string }[]>`
    SELECT id, user_id AS "userId" FROM email_accounts
    WHERE organization_id = ${ctx.organizationId} AND lower(address) = ${address} AND deleted_at IS NULL`
  if (existing) {
    // Named rather than reported as a clash, but only when it is the caller's own — telling
    // somebody which of their colleagues has connected an address is a disclosure they did not
    // ask for, and one of them may be a personal address.
    throw new ValidationError(
      existing.userId === actor.userId
        ? 'You have already connected that mailbox.'
        : 'That address is already connected here.',
    )
  }

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO email_accounts (organization_id, user_id, address, provider, status, scopes, created_by)
    VALUES (${ctx.organizationId}, ${actor.userId}, ${address}, ${input.provider ?? 'mock'},
            'connected', ${input.scopes ?? ['read']}, ${ctx.userId})
    RETURNING id`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'mailbox.connected',
    entityType: 'email_account',
    entityId: row!.id,
    after: { address, provider: input.provider ?? 'mock' },
  })

  const [view] = await ctx.sql<MailboxView[]>`
    ${SELECT_MAILBOX(ctx)} WHERE id = ${row!.id}`
  return view!
}

/**
 * Disconnecting stops the sync. It does **not** remove what already arrived: those are business
 * records on threads colleagues have been working, and deleting them because somebody unplugged a
 * mailbox would lose the account history with it. Erasure is the route that removes a person's
 * correspondence, and it goes through the retention machinery with a reason attached.
 */
export async function disconnectMailbox(ctx: TenantContext, actor: Actor, mailboxId: string): Promise<void> {
  const [mailbox] = await ctx.sql<{ id: string; address: string; userId: string }[]>`
    SELECT id, address, user_id AS "userId" FROM email_accounts
    WHERE organization_id = ${ctx.organizationId} AND id = ${mailboxId} AND deleted_at IS NULL`
  // Somebody else's mailbox answers as though it is not here, never as forbidden (§3.2).
  if (!mailbox || mailbox.userId !== actor.userId) throw new NotFoundError()

  await ctx.sql`
    UPDATE email_accounts SET deleted_at = now(), updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${mailboxId}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'mailbox.disconnected',
    entityType: 'email_account',
    entityId: mailboxId,
    before: { address: mailbox.address },
  })
}

/**
 * Marking a connection as broken, in the words the person will read.
 *
 * The database refuses any status but `connected` without a reason
 * (`email_accounts_trouble_is_explained`), because a mailbox that stopped syncing and shows an
 * inbox quietly going stale is the classic integration lie. §5.6's failure taxonomy is what turns
 * a caught exception into one of these.
 */
export async function markMailboxTrouble(
  ctx: TenantContext,
  mailboxId: string,
  status: Exclude<MailboxStatus, 'connected'>,
  reason: string,
): Promise<void> {
  const said = reason.trim()
  if (!said) throw new ValidationError('A mailbox that has stopped has to say why.')
  await ctx.sql`
    UPDATE email_accounts
       SET status = ${status}, last_error = ${said}, updated_at = now()
     WHERE organization_id = ${ctx.organizationId} AND id = ${mailboxId}`
}

/** Clearing trouble is the only way back to `connected`, and it takes the message with it. */
export async function markMailboxHealthy(ctx: TenantContext, mailboxId: string, at: Date): Promise<void> {
  await ctx.sql`
    UPDATE email_accounts
       SET status = 'connected', last_error = NULL, last_sync_at = ${at}, updated_at = now()
     WHERE organization_id = ${ctx.organizationId} AND id = ${mailboxId}`
}

/** Reconnecting after trouble, by the person whose mailbox it is. */
export async function reconnectMailbox(ctx: TenantContext, actor: Actor, mailboxId: string): Promise<MailboxView> {
  const [mailbox] = await ctx.sql<{ id: string; userId: string; status: string }[]>`
    SELECT id, user_id AS "userId", status FROM email_accounts
    WHERE organization_id = ${ctx.organizationId} AND id = ${mailboxId} AND deleted_at IS NULL`
  if (!mailbox || mailbox.userId !== actor.userId) throw new NotFoundError()
  if (mailbox.status === 'connected') throw new ValidationError('That mailbox is already connected.')

  await ctx.sql`
    UPDATE email_accounts
       SET status = 'connected', last_error = NULL, updated_at = now()
     WHERE organization_id = ${ctx.organizationId} AND id = ${mailboxId}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'mailbox.reconnected',
    entityType: 'email_account',
    entityId: mailboxId,
    before: { status: mailbox.status },
    after: { status: 'connected' },
  })

  const [view] = await ctx.sql<MailboxView[]>`${SELECT_MAILBOX(ctx)} WHERE id = ${mailboxId}`
  return view!
}

/**
 * Who may see that a mailbox exists at all, for the settings screen's benefit.
 *
 * Deliberately not a list of everybody's. An administrator can see *how many* connections the
 * organization has and whether any are broken — which is the operational question — and not whose
 * they are or what address. §29.5 forbids the product from being pointed at an individual.
 */
export async function mailboxHealth(ctx: TenantContext, actor: Actor): Promise<{ connected: number; introuble: number }> {
  // Through `can()`, not a hand-rolled role comparison. §4.2 has one authorization function and
  // three consumers on purpose: a check written out here is one the ladder cannot be reasoned
  // about from, and one an exception granted under ADR 0055 would silently not reach.
  const decision = can(actor, 'settings:read', {
    type: 'settings',
    organizationId: ctx.organizationId,
    riskTier: 'read',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  const [row] = await ctx.sql<{ connected: number; introuble: number }[]>`
    SELECT
      count(*) FILTER (WHERE status = 'connected')::int AS connected,
      count(*) FILTER (WHERE status <> 'connected')::int AS introuble
    FROM email_accounts
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL`
  return row ?? { connected: 0, introuble: 0 }
}


// ---------------------------------------------------------------------------------------------
// The consumer that was never written

/** What a provider hands over, restated here so `@superwork/core` does not depend on integrations. */
export interface InboundMail {
  externalId: string
  threadExternalId: string
  from: { name: string | null; address: string }
  to: string[]
  subject: string
  body: string
  sentAt: Date
}

export interface MailboxSync {
  collected: number
  deduped: number
  threadsOpened: number
}

/**
 * Filing what a mailbox handed over.
 *
 * No actor: this runs in the worker, on behalf of the person whose mailbox it is. Everything it
 * writes is attributed to them, because it *is* their correspondence — and the alternative,
 * attributing it to a system user, would make "who put this here" unanswerable on a thread
 * colleagues go on to work.
 *
 * Threading is on the provider's own thread id rather than the subject line. Subject matching is
 * how two unrelated conversations called "Re: invoice" become one thread and a customer sees
 * somebody else's reply quoted back at them.
 *
 * Dedupe is on `messages.external_id`, backed by a unique index rather than a SELECT first: two
 * sync passes racing after a crash would both find nothing and both insert. The insert says
 * `ON CONFLICT DO NOTHING` and counts what it did not write.
 */
export async function fileInbound(
  ctx: TenantContext,
  ownerUserId: string,
  messages: InboundMail[],
): Promise<MailboxSync> {
  let collected = 0
  let deduped = 0
  let threadsOpened = 0

  for (const mail of messages) {
    const fromAddress = mail.from.address.trim().toLowerCase()
    const toAddresses = mail.to.map((a) => a.trim().toLowerCase()).filter(Boolean)

    let [thread] = await ctx.sql<{ id: string }[]>`
      SELECT id FROM conversations
      WHERE organization_id = ${ctx.organizationId} AND external_id = ${mail.threadExternalId}
        AND deleted_at IS NULL`

    if (!thread) {
      // The domain rule the CRM already uses. It associates to a company that exists; it never
      // creates one, because a company invented from an address is a customer nobody sold to.
      const domain = fromAddress.split('@')[1]
      const [company] = domain
        ? await ctx.sql<{ id: string }[]>`
            SELECT id FROM companies
            WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
              AND ${domain} = ANY(domains)
            LIMIT 1`
        : []

      const [opened] = await ctx.sql<{ id: string }[]>`
        INSERT INTO conversations (organization_id, channel, subject, company_id, owner_id,
                                   status, external_id, created_by)
        VALUES (${ctx.organizationId}, 'email', ${mail.subject.slice(0, 500) || '(no subject)'},
                ${company?.id ?? null}, ${ownerUserId}, 'open', ${mail.threadExternalId}, ${ownerUserId})
        ON CONFLICT (organization_id, external_id) WHERE external_id IS NOT NULL AND deleted_at IS NULL
        DO NOTHING
        RETURNING id`
      if (opened) {
        thread = opened
        threadsOpened += 1
      } else {
        // Lost the race with a concurrent pass; read what it wrote.
        ;[thread] = await ctx.sql<{ id: string }[]>`
          SELECT id FROM conversations
          WHERE organization_id = ${ctx.organizationId} AND external_id = ${mail.threadExternalId}
            AND deleted_at IS NULL`
      }
    }
    if (!thread) continue

    const [written] = await ctx.sql<{ id: string }[]>`
      INSERT INTO messages (organization_id, conversation_id, direction, from_address, from_name,
                            to_addresses, sent_at, body_text, trust_level, external_id, created_by)
      VALUES (${ctx.organizationId}, ${thread.id}, 'inbound', ${fromAddress},
              ${mail.from.name?.trim() || null}, ${toAddresses}, ${mail.sentAt},
              ${mail.body.slice(0, 100_000)}, 'untrusted_external', ${mail.externalId}, ${ownerUserId})
      ON CONFLICT (organization_id, external_id) WHERE external_id IS NOT NULL AND deleted_at IS NULL
      DO NOTHING
      RETURNING id`

    if (written) collected += 1
    else deduped += 1
  }

  return { collected, deduped, threadsOpened }
}

/** One mailbox due a sync, for the worker to hand to a provider. */
export interface DueMailbox {
  id: string
  address: string
  userId: string
  cursor: string | null
}

export async function mailboxesDueSync(ctx: TenantContext, limit = 25): Promise<DueMailbox[]> {
  return ctx.sql<DueMailbox[]>`
    SELECT id, address, user_id AS "userId", sync_cursor AS cursor
    FROM email_accounts
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL AND status = 'connected'
    ORDER BY last_sync_at NULLS FIRST
    LIMIT ${limit}`
}

/** Where the provider says it got to. Advanced only after what it handed over is filed. */
export async function advanceMailboxCursor(
  ctx: TenantContext,
  mailboxId: string,
  cursor: string | null,
  at: Date,
): Promise<void> {
  await ctx.sql`
    UPDATE email_accounts
       SET sync_cursor = ${cursor}, last_sync_at = ${at}, status = 'connected', last_error = NULL,
           updated_at = now()
     WHERE organization_id = ${ctx.organizationId} AND id = ${mailboxId}`
}
