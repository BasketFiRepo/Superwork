import { z } from 'zod'
import type { TenantContext } from '@superwork/db'
import {
  activeCustomTools,
  noteCustomToolCall,
  type CustomToolParameter,
  type CustomToolView,
  type PreviewLine,
} from '@superwork/core'
import { httpTransport } from '@superwork/integrations'
import type { Tool, ToolContext } from './registry.js'

/**
 * Building a tool from an admin's definition (§22).
 *
 * The result is an ordinary `Tool`: same shape, same registry lookup, same gate, same
 * approval card, same `tool_calls` row. Nothing here is a shortcut around the policy
 * engine — a custom tool must not be a permission bypass, so it declares its permissions
 * and risk tier from its row and the gate reads them exactly as it reads a built-in's.
 *
 * Two things a custom tool never gets: an inverse (Superwork cannot know how to undo a
 * call to somebody else's system, so it is never advertised as reversible), and a place in
 * a sub-agent's registry (the orchestrator can reach it; a researcher structurally cannot).
 */

const SECRET_REF = /^\$\{([A-Z][A-Z0-9_]{2,60})\}$/
const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g

export function buildCustomTool(definition: CustomToolView): Tool<Record<string, unknown>, unknown> {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const parameter of definition.parameters) {
    const base =
      parameter.type === 'number' ? z.number() : parameter.type === 'boolean' ? z.boolean() : z.string().max(2000)
    shape[parameter.name] = parameter.required ? base : base.optional()
  }

  return {
    name: definition.name,
    description: definition.description,
    // `strict` matters: an argument the definition did not declare never reaches the
    // request, so a model cannot smuggle a query parameter the admin never approved.
    inputSchema: z.object(shape).strict() as unknown as z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>,
    outputSchema: z.unknown(),
    riskTier: definition.riskTier,
    requiredPermissions: definition.requiredPermissions,
    reversible: false,
    rateLimit: { perRun: definition.perRunLimit, perOrgPerHour: definition.perHourLimit },
    timeoutMs: definition.timeoutMs,
    idempotent: definition.method === 'GET',
    redactions: definition.redactions,

    async execute(input, ctx: ToolContext) {
      const request = compose(definition, input)
      if (ctx.dryRun) {
        return {
          ok: true as const,
          value: { simulated: true, wouldCall: `${request.method} ${redactUrl(request.url)}` },
        }
      }
      try {
        const response = await httpTransport().send(request)
        await noteCustomToolCall(ctx.tenantDb, definition.name)
        if (!response.ok) {
          return {
            ok: false as const,
            code: `HTTP_${response.status}`,
            message: `${definition.host} answered ${response.status}. Nothing was changed on this side.`,
          }
        }
        return { ok: true as const, value: { body: response.body, simulated: response.simulated } }
      } catch (error) {
        return {
          ok: false as const,
          code: 'TRANSPORT_FAILED',
          message: `${definition.host} could not be reached: ${error instanceof Error ? error.message : 'unknown error'}.`,
        }
      }
    },

    async preview(input, _ctx: ToolContext): Promise<PreviewLine[]> {
      const request = compose(definition, input)
      return [
        {
          operation: `Call ${definition.name.replace(/@v\d+$/, '').replace(/_/g, ' ')}`,
          entityType: 'integration',
          entityLabel: definition.host,
          changes: [
            { field: 'Request', to: `${request.method} ${redactUrl(request.url)}` },
            ...(request.body === undefined
              ? []
              : [{ field: 'Body', to: JSON.stringify(request.body).slice(0, 400) }]),
            {
              field: 'Reversible',
              to: 'no — Superwork cannot undo a change in another system',
            },
          ],
          riskTier: definition.riskTier,
          reversible: false,
        },
      ]
    },
  }
}

/** Loads this tenant's active tools. Never cached across tenants — that would leak one org's tools into another's. */
export async function customToolsFor(ctx: TenantContext): Promise<Map<string, Tool<any, any>>> {
  const definitions = await activeCustomTools(ctx)
  return new Map(definitions.map((definition) => [definition.name, buildCustomTool(definition)]))
}

interface Composed {
  method: string
  url: string
  headers: Record<string, string>
  body?: unknown
  timeoutMs: number
}

/**
 * Builds the request. Path segments are URL-encoded, query values are encoded by
 * `URLSearchParams`, and body values are serialized as JSON — an argument is data at every
 * position, never syntax.
 */
export function compose(definition: CustomToolView, input: Record<string, unknown>): Composed {
  const byName = new Map(definition.parameters.map((parameter) => [parameter.name, parameter]))
  let url = definition.urlTemplate.replace(PLACEHOLDER, (_match, name: string) => {
    const parameter = byName.get(name)
    const value = input[name]
    if (!parameter || value === undefined || value === null) return ''
    return encodeURIComponent(String(value))
  })

  const query = new URLSearchParams()
  const body: Record<string, unknown> = {}
  for (const parameter of definition.parameters) {
    const value = input[parameter.name]
    if (value === undefined || value === null) continue
    if (parameter.in === 'query') query.set(parameter.name, String(value))
    else if (parameter.in === 'body') body[parameter.name] = value
  }
  if ([...query].length > 0) url += `${url.includes('?') ? '&' : '?'}${query.toString()}`

  const headers: Record<string, string> = { accept: 'application/json' }
  for (const [header, value] of Object.entries(definition.headers)) {
    const secret = SECRET_REF.exec(value)
    if (secret) {
      // The secret is resolved from the process environment at call time. An unset one is
      // sent as an empty value rather than as the literal `${NAME}`, so a misconfiguration
      // fails at the other end instead of leaking the variable's name.
      headers[header.toLowerCase()] = process.env[secret[1]!] ?? ''
    } else {
      headers[header.toLowerCase()] = value
    }
  }
  if (definition.method !== 'GET') headers['content-type'] = 'application/json'

  return {
    method: definition.method,
    url,
    headers,
    ...(definition.method === 'GET' || Object.keys(body).length === 0 ? {} : { body }),
    timeoutMs: definition.timeoutMs,
  }
}

/** What goes on an approval card and into the log — never a header, never a secret. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}
