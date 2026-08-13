import { withTenant } from '@superwork/db'
import { asAgent, can, loadActor } from '@superwork/auth'
import { writeActivity, writeAudit } from '@superwork/core'
import { getTool } from '@superwork/tools'
import type { RunSession } from './runtime.js'

/**
 * Undo (§5.7).
 *
 * Every reversible write recorded an inverse operation as it happened. Undoing a run
 * replays those inverses in reverse order. Irreversible actions were never executable
 * without a human approval in the first place, so there is nothing here that cannot be
 * walked back — and anything that fails to reverse is reported, not swallowed.
 */

export interface UndoResult {
  runId: string
  reversed: number
  failed: { description: string; error: string }[]
  alreadyUndone: number
  narrative: string
}

export async function undoRun(session: RunSession, runId: string): Promise<UndoResult> {
  return withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const [run] = await ctx.sql<{ id: string; principal_user_id: string; status: string; undone_at: Date | null }[]>`
      SELECT id, principal_user_id, status, undone_at FROM agent_runs
      WHERE organization_id = ${ctx.organizationId} AND id = ${runId} AND deleted_at IS NULL`
    if (!run) throw new Error('Not found.')

    const decision = can(actor, 'agent_run:undo', {
      type: 'agent_run',
      id: runId,
      organizationId: ctx.organizationId,
      ownerId: run.principal_user_id,
      createdBy: run.principal_user_id,
      riskTier: 'low',
    })
    if (!decision.allow) throw new Error(decision.reason)

    const operations = await ctx.sql<
      {
        id: string
        ordinal: number
        forward_tool: string
        inverse_tool: string
        inverse_input: Record<string, unknown>
        entity_type: string
        entity_id: string | null
        description: string
        undone_at: Date | null
        expires_at: Date | null
      }[]
    >`
      SELECT id, ordinal, forward_tool, inverse_tool, inverse_input, entity_type, entity_id,
             description, undone_at, expires_at
      FROM undo_operations
      WHERE organization_id = ${ctx.organizationId} AND run_id = ${runId}
      ORDER BY ordinal DESC`

    const agentActor = await asAgent(ctx, actor, {
      agentId: runId,
      agentName: 'Superwork',
      mode: 'execute',
      toolGrants: ['*'],
      maxSensitivity: 'confidential',
    })

    let reversed = 0
    let alreadyUndone = 0
    const failed: UndoResult['failed'] = []

    for (const operation of operations) {
      if (operation.undone_at) {
        alreadyUndone += 1
        continue
      }
      if (operation.expires_at && operation.expires_at.getTime() < Date.now()) {
        failed.push({ description: operation.description, error: 'The 30-day undo window for this change has passed.' })
        continue
      }

      const tool = getTool(operation.inverse_tool)
      if (!tool) {
        failed.push({ description: operation.description, error: `No inverse tool "${operation.inverse_tool}" is registered.` })
        continue
      }

      const parsed = tool.inputSchema.safeParse(operation.inverse_input)
      if (!parsed.success) {
        failed.push({ description: operation.description, error: 'The stored inverse arguments no longer match the tool contract.' })
        continue
      }

      try {
        const result = await tool.execute(parsed.data, {
          organizationId: ctx.organizationId,
          principalUserId: actor.userId,
          agentRunId: runId,
          stepId: `undo-${operation.ordinal}`,
          idempotencyKey: `undo:${runId}:${operation.id}`,
          traceId: ctx.traceId,
          tenantDb: ctx,
          policy: agentActor,
          dryRun: false,
        })
        if (result.ok) {
          await ctx.sql`
            UPDATE undo_operations SET undone_at = now(), undone_by = ${actor.userId}
            WHERE organization_id = ${ctx.organizationId} AND id = ${operation.id}`
          reversed += 1
        } else {
          await ctx.sql`
            UPDATE undo_operations SET undo_error = ${result.message}
            WHERE organization_id = ${ctx.organizationId} AND id = ${operation.id}`
          failed.push({ description: operation.description, error: result.message })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await ctx.sql`
          UPDATE undo_operations SET undo_error = ${message}
          WHERE organization_id = ${ctx.organizationId} AND id = ${operation.id}`
        failed.push({ description: operation.description, error: message })
      }
    }

    if (reversed > 0 && failed.length === 0) {
      await ctx.sql`
        UPDATE agent_runs SET status = 'undone', undone_at = now(), undone_by = ${actor.userId}
        WHERE organization_id = ${ctx.organizationId} AND id = ${runId}`
    }

    const narrative =
      failed.length === 0
        ? `Reversed ${reversed} ${reversed === 1 ? 'change' : 'changes'} from this run.`
        : `Reversed ${reversed} of ${reversed + failed.length} changes. ${failed.length} could not be undone: ${failed
            .map((f) => `${f.description} (${f.error})`)
            .join('; ')}`

    await writeActivity(ctx, {
      actorType: 'user',
      actorUserId: actor.userId,
      actorLabel: actor.displayName,
      verb: 'undid',
      entityType: 'agent_run',
      entityId: runId,
      entityLabel: `run ${runId.slice(0, 8)}`,
      summary: narrative,
      agentRunId: runId,
    })
    await writeAudit(ctx, {
      actorType: 'user',
      actorId: actor.userId,
      action: 'agent_run.undo',
      entityType: 'agent_run',
      entityId: runId,
      before: { status: run.status },
      after: { status: failed.length === 0 ? 'undone' : run.status, reversed, failed: failed.length },
      agentRunId: runId,
    })
    await ctx.sql`
      INSERT INTO trust_ledger_entries (organization_id, action_type, outcome, agent_run_id, created_by)
      VALUES (${ctx.organizationId}, 'agent_plan', 'undone', ${runId}, ${actor.userId})`

    return { runId, reversed, failed, alreadyUndone, narrative }
  })
}
