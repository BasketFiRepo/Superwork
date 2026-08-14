import { asJson, type RiskTier, type TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'

/**
 * Admin-authored HTTP tools (§22).
 *
 * A custom tool is a tool. It is resolved through the same registry, checked by the same
 * policy engine, previewed and approved through the same approval flow, and written to
 * the same audit trail. No exceptions — a custom tool must not be a permission bypass.
 *
 * What this module owns is everything that has to be true *before* the registry will build
 * one: an https URL whose host a named person reviewed, a declared risk tier and permission
 * set, a parameter contract, and headers that name secrets rather than carry them.
 */

export type CustomToolStatus = 'draft' | 'active' | 'disabled'
export type ParameterType = 'string' | 'number' | 'boolean'
export type ParameterPlace = 'path' | 'query' | 'body'

export interface CustomToolParameter {
  name: string
  type: ParameterType
  in: ParameterPlace
  required: boolean
  description: string
}

export interface CustomToolView {
  id: string
  name: string
  description: string
  method: string
  urlTemplate: string
  host: string
  parameters: CustomToolParameter[]
  headers: Record<string, string>
  riskTier: RiskTier
  requiredPermissions: string[]
  timeoutMs: number
  perRunLimit: number
  perHourLimit: number
  redactions: string[]
  status: CustomToolStatus
  approvedByName: string | null
  approvedAt: Date | null
  hostReviewed: boolean
  lastCalledAt: Date | null
}

export interface CustomToolHost {
  id: string
  host: string
  reason: string
  reviewedByName: string | null
  reviewedAt: Date | null
}

/** Only these may be declared. A tool cannot invent a permission the roles do not grant. */
export const CUSTOM_TOOL_PERMISSIONS = [
  'integration:read:org',
  'integration:update:org',
  'company:read:org',
  'task:read:org',
] as const

const NAME = /^[a-z][a-z0-9_]{2,48}@v[0-9]+$/
const PARAM_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/
const SECRET_REF = /^\$\{[A-Z][A-Z0-9_]{2,60}\}$/
const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g

function admin(ctx: TenantContext, actor: Actor, action: string): void {
  const decision = can(actor, action, {
    type: 'integration',
    organizationId: ctx.organizationId,
    riskTier: 'high',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
}

const SELECT_TOOL = (ctx: TenantContext) => ctx.sql`
  SELECT t.id, t.name, t.description, t.method, t.url_template AS "urlTemplate", t.host,
         t.parameters, t.headers, t.risk_tier AS "riskTier",
         t.required_permissions AS "requiredPermissions", t.timeout_ms AS "timeoutMs",
         t.per_run_limit AS "perRunLimit", t.per_hour_limit AS "perHourLimit",
         t.redactions, t.status, u.name AS "approvedByName", t.approved_at AS "approvedAt",
         (h.id IS NOT NULL AND h.reviewed_at IS NOT NULL) AS "hostReviewed",
         t.last_called_at AS "lastCalledAt"
  FROM custom_tools t
  LEFT JOIN users u ON u.id = t.approved_by
  LEFT JOIN custom_tool_hosts h
    ON h.organization_id = t.organization_id AND h.host = t.host AND h.deleted_at IS NULL`

export async function listCustomTools(ctx: TenantContext, actor: Actor): Promise<CustomToolView[]> {
  admin(ctx, actor, 'integration:read')
  return ctx.sql<CustomToolView[]>`
    ${SELECT_TOOL(ctx)}
    WHERE t.organization_id = ${ctx.organizationId} AND t.deleted_at IS NULL
    ORDER BY t.status, t.name`
}

/**
 * The tools the registry may build for this tenant right now. Read without a permission
 * check on purpose: the *caller's* right to use each one is decided by the policy engine
 * against the tool's declared permissions, which is the same check a built-in gets.
 */
export async function activeCustomTools(ctx: TenantContext): Promise<CustomToolView[]> {
  return ctx.sql<CustomToolView[]>`
    ${SELECT_TOOL(ctx)}
    WHERE t.organization_id = ${ctx.organizationId} AND t.deleted_at IS NULL
      AND t.status = 'active' AND h.id IS NOT NULL AND h.reviewed_at IS NOT NULL
    ORDER BY t.name`
}

export async function getCustomTool(ctx: TenantContext, actor: Actor, id: string): Promise<CustomToolView> {
  admin(ctx, actor, 'integration:read')
  const [row] = await ctx.sql<CustomToolView[]>`
    ${SELECT_TOOL(ctx)}
    WHERE t.organization_id = ${ctx.organizationId} AND t.id = ${id} AND t.deleted_at IS NULL`
  if (!row) throw new NotFoundError()
  return row
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

export async function listHosts(ctx: TenantContext, actor: Actor): Promise<CustomToolHost[]> {
  admin(ctx, actor, 'integration:read')
  return ctx.sql<CustomToolHost[]>`
    SELECT h.id, h.host, h.reason, u.name AS "reviewedByName", h.reviewed_at AS "reviewedAt"
    FROM custom_tool_hosts h
    LEFT JOIN users u ON u.id = h.reviewed_by
    WHERE h.organization_id = ${ctx.organizationId} AND h.deleted_at IS NULL
    ORDER BY h.host`
}

/**
 * Reviewing a host is the decision that lets tools reach it. It is recorded with who and
 * when, because "which systems can this thing call, and who said so" is a question an
 * auditor asks and an allow-list in a config file cannot answer.
 */
export async function reviewHost(
  ctx: TenantContext,
  actor: Actor,
  input: { host: string; reason: string },
): Promise<CustomToolHost> {
  admin(ctx, actor, 'integration:update')
  const host = input.host.trim().toLowerCase()
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes('*')) {
    throw new ValidationError(
      'That is not a hostname. Give one host — "erp.example.com" — with no scheme, path or wildcard.',
    )
  }
  if (!input.reason.trim()) {
    throw new ValidationError('Say what this host is and why Superwork may call it. The reason is the review.')
  }
  if (isPrivateHost(host)) {
    throw new ValidationError(
      `"${host}" resolves inside a private network. Superwork will not call internal addresses from a tool ` +
        'definition — expose the system on a name you would give a partner, or keep it out.',
    )
  }

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO custom_tool_hosts (organization_id, host, reason, reviewed_by, reviewed_at, created_by)
    VALUES (${ctx.organizationId}, ${host}, ${input.reason}, ${actor.userId}, now(), ${ctx.userId})
    ON CONFLICT (organization_id, host) WHERE deleted_at IS NULL
    DO UPDATE SET reason = EXCLUDED.reason, reviewed_by = EXCLUDED.reviewed_by, reviewed_at = now()
    RETURNING id`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'custom_tool_host.reviewed',
    entityType: 'integration',
    entityId: row!.id,
    after: { host, reason: input.reason },
  })

  const [view] = await ctx.sql<CustomToolHost[]>`
    SELECT h.id, h.host, h.reason, u.name AS "reviewedByName", h.reviewed_at AS "reviewedAt"
    FROM custom_tool_hosts h LEFT JOIN users u ON u.id = h.reviewed_by
    WHERE h.organization_id = ${ctx.organizationId} AND h.id = ${row!.id}`
  return view!
}

export async function revokeHost(ctx: TenantContext, actor: Actor, host: string): Promise<number> {
  admin(ctx, actor, 'integration:update')
  // Revoking a host disables every tool that used it in the same transaction. A tool left
  // active against a host nobody trusts any more is the gap this closes.
  const disabled = await ctx.sql<{ id: string }[]>`
    UPDATE custom_tools SET status = 'disabled'
    WHERE organization_id = ${ctx.organizationId} AND host = ${host} AND status = 'active'
    RETURNING id`
  await ctx.sql`
    UPDATE custom_tool_hosts SET deleted_at = now()
    WHERE organization_id = ${ctx.organizationId} AND host = ${host} AND deleted_at IS NULL`
  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'custom_tool_host.revoked',
    entityType: 'integration',
    entityId: null,
    after: { host, disabledTools: disabled.length },
  })
  return disabled.length
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface SaveCustomToolInput {
  id?: string
  name: string
  description: string
  method: string
  urlTemplate: string
  parameters: CustomToolParameter[]
  headers: Record<string, string>
  riskTier: RiskTier
  requiredPermissions: string[]
  timeoutMs?: number
  redactions?: string[]
}

export async function saveCustomTool(
  ctx: TenantContext,
  actor: Actor,
  input: SaveCustomToolInput,
): Promise<CustomToolView> {
  admin(ctx, actor, 'integration:update')
  const host = validate(input)

  const columns = {
    name: input.name,
    description: input.description,
    method: input.method.toUpperCase(),
    url_template: input.urlTemplate,
    host,
    parameters: ctx.sql.json(asJson(input.parameters)),
    headers: ctx.sql.json(asJson(input.headers)),
    risk_tier: input.riskTier,
    required_permissions: input.requiredPermissions,
    timeout_ms: input.timeoutMs ?? 8000,
    redactions: input.redactions ?? [],
  }

  let id = input.id
  if (id) {
    // Any edit returns the tool to draft. A tool that can be re-pointed at another host
    // while it is live is not a reviewed tool.
    await ctx.sql`
      UPDATE custom_tools SET
        name = ${columns.name}, description = ${columns.description}, method = ${columns.method},
        url_template = ${columns.url_template}, host = ${columns.host},
        parameters = ${columns.parameters}, headers = ${columns.headers},
        risk_tier = ${columns.risk_tier}, required_permissions = ${columns.required_permissions},
        timeout_ms = ${columns.timeout_ms}, redactions = ${columns.redactions},
        status = 'draft', approved_by = NULL, approved_at = NULL
      WHERE organization_id = ${ctx.organizationId} AND id = ${id}`
  } else {
    const [row] = await ctx.sql<{ id: string }[]>`
      INSERT INTO custom_tools (
        organization_id, name, description, method, url_template, host, parameters, headers,
        risk_tier, required_permissions, timeout_ms, redactions, status, created_by
      ) VALUES (
        ${ctx.organizationId}, ${columns.name}, ${columns.description}, ${columns.method},
        ${columns.url_template}, ${columns.host}, ${columns.parameters}, ${columns.headers},
        ${columns.risk_tier}, ${columns.required_permissions}, ${columns.timeout_ms},
        ${columns.redactions}, 'draft', ${ctx.userId}
      ) RETURNING id`
    id = row!.id
  }

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'custom_tool.saved',
    entityType: 'integration',
    entityId: id,
    after: { name: input.name, host, riskTier: input.riskTier, method: columns.method },
  })
  return getCustomTool(ctx, actor, id)
}

/** Activation. Needs a reviewed host and a named approver; the schema enforces the second. */
export async function activateCustomTool(ctx: TenantContext, actor: Actor, id: string): Promise<CustomToolView> {
  admin(ctx, actor, 'integration:update')
  const tool = await getCustomTool(ctx, actor, id)
  if (!tool.hostReviewed) {
    throw new ValidationError(
      `Nobody has reviewed ${tool.host}. Add it to the reviewed hosts with a reason first — a tool that reaches ` +
        'a system on nobody’s decision is exactly what this list prevents.',
    )
  }

  await ctx.sql`
    UPDATE custom_tools SET status = 'active', approved_by = ${actor.userId}, approved_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${id}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'custom_tool.activated',
    entityType: 'integration',
    entityId: id,
    after: { name: tool.name, host: tool.host, riskTier: tool.riskTier },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'activated a custom tool',
    entityType: 'integration',
    entityId: id,
    entityLabel: tool.name,
    summary: `${tool.name} may now call ${tool.host}. ${tool.riskTier === 'read' ? 'It only reads.' : 'Every call is held for approval.'}`,
  })
  return getCustomTool(ctx, actor, id)
}

export async function setCustomToolStatus(
  ctx: TenantContext,
  actor: Actor,
  id: string,
  status: 'disabled' | 'draft',
): Promise<CustomToolView> {
  admin(ctx, actor, 'integration:update')
  await ctx.sql`
    UPDATE custom_tools SET status = ${status}
    WHERE organization_id = ${ctx.organizationId} AND id = ${id}`
  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: `custom_tool.${status}`,
    entityType: 'integration',
    entityId: id,
    after: { status },
  })
  return getCustomTool(ctx, actor, id)
}

export async function noteCustomToolCall(ctx: TenantContext, name: string): Promise<void> {
  await ctx.sql`
    UPDATE custom_tools SET last_called_at = now()
    WHERE organization_id = ${ctx.organizationId} AND name = ${name}`
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Returns the host. Everything that could make a tool unsafe is refused here. */
export function validate(input: SaveCustomToolInput): string {
  if (!NAME.test(input.name)) {
    throw new ValidationError(
      'A tool name is snake_case and versioned, like "lookup_order@v1". The model is never told which tools ' +
        'are custom, so they are named like the rest.',
    )
  }
  if (input.description.trim().length < 10) {
    throw new ValidationError('Describe what the tool does in a sentence. The description is what the model reads.')
  }

  let url: URL
  try {
    url = new URL(input.urlTemplate.replace(PLACEHOLDER, 'x'))
  } catch {
    throw new ValidationError('That is not a URL.')
  }
  if (url.protocol !== 'https:') throw new ValidationError('Only https URLs. Superwork will not call a plaintext endpoint.')
  if (url.username || url.password) {
    throw new ValidationError('Credentials in a URL end up in logs. Put them in a header naming a secret instead.')
  }
  const host = url.hostname.toLowerCase()
  if (isPrivateHost(host)) {
    throw new ValidationError(`Superwork will not call ${host} — it is a private or link-local address.`)
  }

  const declared = new Set(input.parameters.map((parameter) => parameter.name))
  for (const parameter of input.parameters) {
    if (!PARAM_NAME.test(parameter.name)) throw new ValidationError(`"${parameter.name}" is not a usable parameter name.`)
    if (!parameter.description.trim()) {
      throw new ValidationError(`Parameter "${parameter.name}" needs a description — the model chooses by it.`)
    }
  }
  for (const match of input.urlTemplate.matchAll(PLACEHOLDER)) {
    const placeholder = match[1]!
    if (!declared.has(placeholder)) {
      throw new ValidationError(`The URL uses {${placeholder}} but no parameter of that name is declared.`)
    }
  }

  for (const [header, value] of Object.entries(input.headers)) {
    if (/^(authorization|cookie|proxy-authorization)$/i.test(header) && !SECRET_REF.test(value)) {
      throw new ValidationError(
        `Put the value of "${header}" in a secret and reference it as \${NAME}. A credential typed into a form ` +
          'is a credential in the database, the audit log and somebody’s screenshot.',
      )
    }
    if (/[\r\n]/.test(value)) throw new ValidationError('A header value cannot contain a line break.')
  }

  for (const permission of input.requiredPermissions) {
    if (!(CUSTOM_TOOL_PERMISSIONS as readonly string[]).includes(permission)) {
      throw new ValidationError(
        `"${permission}" is not one a custom tool may require. Pick from: ${CUSTOM_TOOL_PERMISSIONS.join(', ')}.`,
      )
    }
  }
  if (input.requiredPermissions.length === 0) {
    throw new ValidationError('A tool declares what a caller must be allowed to do. Pick at least one permission.')
  }
  if (input.riskTier === 'read' && input.method !== 'GET') {
    throw new ValidationError(`A ${input.method} is not a read. Declare this tool as low or high risk.`)
  }
  return host
}

/**
 * Blocks the addresses a server-side request forgery aims at. Names are checked as typed;
 * a name that resolves to a private address at call time is caught by the transport, but
 * the obvious cases are refused before anybody can save them.
 */
export function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true
  }
  if (host === '::1' || host === '0.0.0.0') return true
  const octets = host.split('.')
  if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part))) {
    const [a, b] = octets.map(Number) as [number, number, number, number]
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a === 100 && b >= 64 && b <= 127) return true
  }
  return false
}
