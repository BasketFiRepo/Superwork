import { createHash } from 'node:crypto'
import type { z } from 'zod'
import type { RiskTier, TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import type { PreviewLine } from '@superwork/core'

/**
 * Tool definition contract (§6.1).
 *
 * A tool that reaches for a global database client instead of `ctx.tenantDb` is a
 * security bug — `assertTenantScoped` below is the lint for it, and every tool receives
 * its database handle exclusively through the context.
 */

export interface ToolContext {
  organizationId: string
  principalUserId: string
  agentRunId: string
  stepId: string
  idempotencyKey: string
  traceId: string
  tenantDb: TenantContext
  /** The actor the tool authorizes against — an agent facet wrapping the principal. */
  policy: Actor
  /** True for simulated runs: reads happen, writes are described but not performed. */
  dryRun: boolean
}

export type ToolResult<O> =
  | { ok: true; value: O }
  | { ok: false; code: string; message: string; candidates?: { id: string; label: string; hint?: string }[] }

export interface Tool<I = unknown, O = unknown> {
  /** Stable, snake_case, versioned. */
  name: string
  /** Written for the model: at most two sentences, no ambiguity. */
  description: string
  inputSchema: z.ZodType<I>
  outputSchema: z.ZodType<O>
  riskTier: RiskTier
  requiredPermissions: string[]
  reversible: boolean
  inverse?: string
  rateLimit: { perRun: number; perOrgPerHour: number }
  timeoutMs: number
  idempotent: boolean
  /** Fields stripped before the call is written to tool_calls or the logs. */
  redactions: string[]
  execute(input: I, ctx: ToolContext): Promise<ToolResult<O>>
  /** Renders the human-readable diff shown on the approval card *before* anything happens. */
  preview?(input: I, ctx: ToolContext): Promise<PreviewLine[]>
  /** Builds the inverse call for undo (§5.7). Returns null when nothing needs undoing. */
  buildUndo?(input: I, output: O): { tool: string; input: Record<string, unknown>; entityType: string; entityId: string | null; description: string } | null
}

const tools = new Map<string, Tool<any, any>>()

export function register<I, O>(tool: Tool<I, O>): Tool<I, O> {
  if (tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered.`)
  if (tool.riskTier !== 'read' && tool.reversible && !tool.inverse) {
    throw new Error(`Tool "${tool.name}" claims to be reversible but declares no inverse.`)
  }
  tools.set(tool.name, tool)
  return tool
}

export function getTool(name: string): Tool<any, any> | undefined {
  return tools.get(name)
}

export function allTools(): Tool<any, any>[] {
  return [...tools.values()]
}

/**
 * Sub-agent registries (§5.4). The Researcher's registry contains no write tools, so it
 * is *structurally* incapable of writing — that guarantee is not left to prompting.
 */
export const SUBAGENT_TOOLS: Record<string, string[]> = {
  orchestrator: ['delegate_to_subagent', 'ask_user', 'request_approval', 'escalate_to_human'],
  researcher: [
    'search_knowledge', 'search_entities', 'get_entity', 'list_tasks', 'list_projects',
    'read_thread', 'read_document', 'query_aggregate', 'get_user_workload', 'cite',
  ],
  task_agent: [
    'list_tasks', 'get_entity', 'create_task', 'update_task', 'assign_task', 'complete_task',
    'set_due_date', 'comment_on_task', 'link_entities', 'query_aggregate',
  ],
  comms_agent: ['read_thread', 'draft_email', 'revise_draft', 'send_email', 'create_follow_up', 'search_entities'],
  analyst: ['query_aggregate', 'list_tasks', 'list_projects', 'get_project_health'],
  watcher: ['query_aggregate', 'list_tasks', 'search_entities', 'create_insight'],
  critic: [],
}

export function toolsForSubagent(subagent: string): Tool<any, any>[] {
  const names = SUBAGENT_TOOLS[subagent]
  if (!names) return []
  return names.map((n) => tools.get(n)).filter((t): t is Tool<any, any> => !!t)
}

/**
 * Tools are filtered by the policy engine *before the model ever sees the schema*
 * (§6.2). This prevents both wasted turns and social-engineering attempts against
 * capabilities the actor does not hold.
 */
export function visibleTools(actor: Actor, subagent: string, organizationId: string, killSwitch = false): Tool<any, any>[] {
  const candidates = subagent === 'orchestrator' ? allTools() : toolsForSubagent(subagent)
  const permitted = candidates.filter((tool) => {
    const decision = can(actor, `${primaryResource(tool)}:${primaryAction(tool)}`, {
      type: primaryResource(tool),
      organizationId,
      riskTier: tool.riskTier,
    }, { killSwitch })
    // A tool that merely requires approval stays visible; the gate handles it.
    return decision.allow
  })
  // Never expose more than 25 tool schemas in one model call (§6.2).
  return permitted.slice(0, 25)
}

function primaryResource(tool: Tool<any, any>): string {
  return tool.requiredPermissions[0]?.split(':')[0] ?? 'task'
}

function primaryAction(tool: Tool<any, any>): string {
  return tool.requiredPermissions[0]?.split(':')[1] ?? 'read'
}

export function hashArgs(toolName: string, args: unknown): string {
  return createHash('sha256').update(toolName).update(stableStringify(args)).digest('hex').slice(0, 32)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

export function redactInput(tool: Tool<any, any>, input: Record<string, unknown>): Record<string, unknown> {
  if (tool.redactions.length === 0) return input
  const copy = { ...input }
  for (const field of tool.redactions) {
    if (field in copy) copy[field] = '[redacted]'
  }
  return copy
}

/** Development guard: fails loudly if a tool tries to use a database handle it was not given. */
export function assertTenantScoped(ctx: ToolContext): void {
  if (!ctx.tenantDb || ctx.tenantDb.organizationId !== ctx.organizationId) {
    throw new Error('Tool attempted to run outside its tenant context.')
  }
}
