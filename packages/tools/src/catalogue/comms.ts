import { z } from 'zod'
import { env } from '@superwork/config'
import { enqueue, writeActivity, type PreviewLine } from '@superwork/core'
import { register, type ToolContext } from '../registry.js'

/**
 * Communication tools. Drafting is `execute:low`; sending is `execute:high` and is
 * never auto-executed in v1 under any setting (§25.9).
 *
 * Egress control (§5.9.4): recipients must resolve to known contacts on the account.
 * Retrieved content can never introduce a recipient — an address that appears only in
 * an email body is rejected, not silently added.
 */

export const draftEmail = register({
  name: 'draft_email@v1',
  description: 'Write an email draft referencing a thread’s last exchange. Drafts are saved for approval and are never sent by this tool.',
  inputSchema: z.object({
    conversationId: z.string().uuid().nullish(),
    companyId: z.string().uuid().nullish(),
    subject: z.string().min(1).max(300),
    body: z.string().max(8000).optional(),
    referenceLastExchange: z.boolean().default(true),
    toAddresses: z.array(z.string().email()).optional(),
  }),
  outputSchema: z.object({
    id: z.string(),
    subject: z.string(),
    to: z.array(z.string()),
    preview: z.string(),
    bodyLength: z.number(),
  }),
  riskTier: 'low' as const,
  requiredPermissions: ['email:draft:org'],
  reversible: true,
  inverse: 'discard_draft@v1',
  rateLimit: { perRun: 25, perOrgPerHour: 500 },
  timeoutMs: 10_000,
  idempotent: true,
  redactions: ['body'],
  async execute(input, ctx: ToolContext) {
    const sql = ctx.tenantDb.sql
    const recipients = await resolveRecipients(ctx, input.conversationId ?? null, input.companyId ?? null, input.toAddresses)
    if (recipients.length === 0) {
      return {
        ok: false as const,
        code: 'NO_KNOWN_RECIPIENT',
        message: 'No known contact on this account to address. Add a contact first, or name the recipient explicitly.',
      }
    }

    const body = input.body ?? (await composeFollowUp(ctx, input.conversationId ?? null))
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO email_drafts (
        organization_id, conversation_id, company_id, to_addresses, subject, body_text,
        status, agent_run_id, created_by_actor_type, created_by
      ) VALUES (
        ${ctx.organizationId}, ${input.conversationId ?? null}, ${input.companyId ?? null},
        ${recipients}, ${input.subject}, ${body}, 'draft', ${ctx.agentRunId}, 'agent', ${ctx.principalUserId}
      ) RETURNING id`

    await writeActivity(ctx.tenantDb, {
      actorType: 'agent',
      actorUserId: ctx.principalUserId,
      actorLabel: ctx.policy.agent?.agentName ?? 'Superwork',
      verb: 'drafted',
      entityType: 'email_draft',
      entityId: row!.id,
      entityLabel: input.subject,
      summary: `Drafted a reply: "${input.subject}". Nothing was sent.`,
      agentRunId: ctx.agentRunId,
    })

    return {
      ok: true as const,
      value: {
        id: row!.id,
        subject: input.subject,
        to: recipients,
        preview: body.slice(0, 400),
        bodyLength: body.length,
      },
    }
  },
  async preview(input, ctx: ToolContext): Promise<PreviewLine[]> {
    const recipients = await resolveRecipients(ctx, input.conversationId ?? null, input.companyId ?? null, input.toAddresses)
    return [
      {
        operation: 'Draft email',
        entityType: 'email_draft',
        entityLabel: input.subject,
        changes: [
          { field: 'To', to: recipients.join(', ') || 'no known recipient' },
          { field: 'Sends now', to: 'no — saved to Approvals' },
        ],
        riskTier: 'low',
        reversible: true,
      },
    ]
  },
  buildUndo(_input, output) {
    return {
      tool: 'discard_draft@v1',
      input: { id: output.id },
      entityType: 'email_draft',
      entityId: output.id,
      description: `Discard the draft "${output.subject}"`,
    }
  },
})

export const discardDraft = register({
  name: 'discard_draft@v1',
  description: 'Discard an email draft. Inverse of draft_email.',
  inputSchema: z.object({ id: z.string().uuid() }),
  outputSchema: z.object({ id: z.string(), discarded: z.boolean() }),
  riskTier: 'low' as const,
  requiredPermissions: ['email:draft:org'],
  reversible: false,
  rateLimit: { perRun: 25, perOrgPerHour: 500 },
  timeoutMs: 8000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    await ctx.tenantDb.sql`
      UPDATE email_drafts SET status = 'discarded', deleted_at = now()
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.id}`
    return { ok: true as const, value: { id: input.id, discarded: true } }
  },
})

export const sendEmail = register({
  name: 'send_email@v1',
  description: 'Send an approved draft. Irreversible and externally visible: it always requires human approval and enters a recall window before dispatch.',
  inputSchema: z.object({ draftId: z.string().uuid() }),
  outputSchema: z.object({ id: z.string(), sendAfter: z.string(), recallWindowSeconds: z.number() }),
  riskTier: 'high' as const,
  requiredPermissions: ['email:send:org'],
  reversible: false,
  rateLimit: { perRun: 10, perOrgPerHour: 100 },
  timeoutMs: 15_000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    const sql = ctx.tenantDb.sql
    const [draft] = await sql<{ id: string; subject: string; to_addresses: string[]; status: string }[]>`
      SELECT id, subject, to_addresses, status FROM email_drafts
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.draftId} AND deleted_at IS NULL`
    if (!draft) return { ok: false as const, code: 'NOT_FOUND', message: 'That draft no longer exists.' }
    if (draft.status !== 'approved') {
      return {
        ok: false as const,
        code: 'NOT_APPROVED',
        message: 'This draft has not been approved. Superwork does not send anything externally without a human decision.',
      }
    }
    if (ctx.dryRun) {
      return {
        ok: true as const,
        value: { id: 'simulated', sendAfter: new Date().toISOString(), recallWindowSeconds: 0 },
      }
    }

    const delaySeconds = env().EMAIL_SEND_DELAY_SECONDS
    const sendAfter = new Date(Date.now() + delaySeconds * 1000)
    const [send] = await sql<{ id: string }[]>`
      INSERT INTO email_sends (organization_id, draft_id, provider, send_after, idempotency_key, created_by)
      VALUES (${ctx.organizationId}, ${input.draftId}, ${env().EMAIL_MODE === 'live' ? 'smtp' : 'mock'},
              ${sendAfter}, ${ctx.idempotencyKey}, ${ctx.principalUserId})
      ON CONFLICT (organization_id, idempotency_key) DO UPDATE SET updated_at = now()
      RETURNING id`

    await sql`UPDATE email_drafts SET status = 'sent' WHERE organization_id = ${ctx.organizationId} AND id = ${input.draftId}`
    // Dispatch happens through the outbox, never inline in the request (§2.4).
    await enqueue(ctx.tenantDb, {
      topic: 'email.send',
      payload: { sendId: send!.id, draftId: input.draftId },
      idempotencyKey: ctx.idempotencyKey,
      notBefore: sendAfter,
    })

    return {
      ok: true as const,
      value: { id: send!.id, sendAfter: sendAfter.toISOString(), recallWindowSeconds: delaySeconds },
    }
  },
  async preview(input, ctx: ToolContext): Promise<PreviewLine[]> {
    const [draft] = await ctx.tenantDb.sql<{ subject: string; to_addresses: string[]; body_text: string }[]>`
      SELECT subject, to_addresses, body_text FROM email_drafts
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.draftId}`
    return [
      {
        operation: 'Send email',
        entityType: 'email_draft',
        entityLabel: draft?.subject ?? 'draft',
        changes: [
          { field: 'To', to: (draft?.to_addresses ?? []).join(', ') },
          { field: 'Body', to: (draft?.body_text ?? '').slice(0, 300) },
          { field: 'Recall window', to: `${env().EMAIL_SEND_DELAY_SECONDS}s after approval` },
        ],
        riskTier: 'high',
        reversible: false,
      },
    ]
  },
})

export const createFollowUp = register({
  name: 'create_follow_up@v1',
  description: 'Record a dated follow-up on a conversation or account so it resurfaces if no reply arrives.',
  inputSchema: z.object({
    conversationId: z.string().uuid().nullish(),
    companyId: z.string().uuid().nullish(),
    ownerId: z.string().uuid().nullish(),
    dueAt: z.string(),
    reason: z.string().max(500).optional(),
  }),
  outputSchema: z.object({ id: z.string(), dueAt: z.string() }),
  riskTier: 'low' as const,
  requiredPermissions: ['conversation:read:org'],
  reversible: true,
  inverse: 'cancel_follow_up@v1',
  rateLimit: { perRun: 25, perOrgPerHour: 1000 },
  timeoutMs: 8000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    const [row] = await ctx.tenantDb.sql<{ id: string }[]>`
      INSERT INTO follow_ups (organization_id, conversation_id, company_id, owner_id, due_at, reason, agent_run_id, created_by)
      VALUES (${ctx.organizationId}, ${input.conversationId ?? null}, ${input.companyId ?? null},
              ${input.ownerId ?? ctx.principalUserId}, ${new Date(input.dueAt)}, ${input.reason ?? null},
              ${ctx.agentRunId}, ${ctx.principalUserId})
      RETURNING id`
    return { ok: true as const, value: { id: row!.id, dueAt: input.dueAt } }
  },
  buildUndo(_input, output) {
    return {
      tool: 'cancel_follow_up@v1',
      input: { id: output.id },
      entityType: 'follow_up',
      entityId: output.id,
      description: 'Cancel the follow-up reminder',
    }
  },
})

export const cancelFollowUp = register({
  name: 'cancel_follow_up@v1',
  description: 'Cancel a follow-up. Inverse of create_follow_up.',
  inputSchema: z.object({ id: z.string().uuid() }),
  outputSchema: z.object({ id: z.string(), cancelled: z.boolean() }),
  riskTier: 'low' as const,
  requiredPermissions: ['conversation:read:org'],
  reversible: false,
  rateLimit: { perRun: 25, perOrgPerHour: 1000 },
  timeoutMs: 8000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    await ctx.tenantDb.sql`
      UPDATE follow_ups SET status = 'cancelled', deleted_at = now()
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.id}`
    return { ok: true as const, value: { id: input.id, cancelled: true } }
  },
})

/**
 * Recipients are resolved from the *database*, never from message content. This is the
 * egress control that stops retrieved text from choosing who gets an email.
 */
async function resolveRecipients(
  ctx: ToolContext,
  conversationId: string | null,
  companyId: string | null,
  explicit: string[] | undefined,
): Promise<string[]> {
  const sql = ctx.tenantDb.sql
  const known = await sql<{ emails: string[] }[]>`
    SELECT emails FROM contacts
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
      AND (
        ${companyId ? sql`company_id = ${companyId}` : sql`false`}
        OR company_id = (SELECT company_id FROM conversations
                          WHERE organization_id = ${ctx.organizationId} AND id = ${conversationId})
      )`
  const allowed = new Set(known.flatMap((r) => r.emails).map((e) => e.toLowerCase()))

  if (explicit?.length) {
    // Newly-appearing addresses are blocked, not silently accepted.
    return explicit.filter((address) => allowed.has(address.toLowerCase()))
  }
  return [...allowed].slice(0, 3)
}

async function composeFollowUp(ctx: ToolContext, conversationId: string | null): Promise<string> {
  const sql = ctx.tenantDb.sql
  const [row] = await sql<{ company_name: string | null; days: number | null; excerpt: string | null; sender: string }[]>`
    SELECT c.name AS company_name,
           EXTRACT(DAY FROM (now() - conv.last_message_at))::int AS days,
           (SELECT left(body_text, 200) FROM messages
             WHERE conversation_id = conv.id AND deleted_at IS NULL ORDER BY sent_at DESC LIMIT 1) AS excerpt,
           (SELECT name FROM users WHERE id = ${ctx.principalUserId}) AS sender
    FROM conversations conv LEFT JOIN companies c ON c.id = conv.company_id
    WHERE conv.organization_id = ${ctx.organizationId} AND conv.id = ${conversationId}`

  const { MockLLMProvider } = await import('@superwork/ai')
  const provider = new MockLLMProvider()
  let body = ''
  for await (const event of provider.complete({
    taskClass: 'email.draft',
    system: 'Draft a short, plain follow-up in the organization voice.',
    blocks: [],
    userMessage: 'Draft a follow-up.',
    grounding: {
      companyName: row?.company_name ?? 'there',
      daysWaiting: row?.days ?? 0,
      lastMessageExcerpt: row?.excerpt ?? '',
      senderName: row?.sender ?? '',
    },
  })) {
    if (event.type === 'json') body = String((event.value as { body?: string }).body ?? '')
  }
  return body
}
