import { NextResponse } from 'next/server'
import { withTenant } from '@superwork/db'
import { checkRateLimit, loadActor, recordApiRequest, resolveApiKey } from '@superwork/auth'
import { allTools } from '@superwork/tools'
import { zodToJsonSchema } from '@/lib/json-schema'

export const dynamic = 'force-dynamic'

/**
 * The MCP server (§22.4).
 *
 * It exposes the *same* tool registry the agent uses, through the same permission checks,
 * to an outside model that holds an API key. Two rules keep that safe:
 *
 *   • only read-tier tools are listed and callable. Letting a model outside this system
 *     take an action inside it, with no plan, no gate and no approval, would undo every
 *     guarantee the runtime makes;
 *   • every call is authorized as the key's principal and logged like any API request.
 */

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

const PROTOCOL_VERSION = '2024-11-05'

export async function POST(request: Request): Promise<NextResponse> {
  const started = Date.now()
  const key = await resolveApiKey(request.headers.get('authorization'))
  const body = (await request.json().catch(() => ({}))) as JsonRpcRequest
  const id = body.id ?? null

  if (!key) {
    return NextResponse.json(rpcError(id, -32001, 'Present a valid API key as `Authorization: Bearer sw_…`.'), {
      status: 401,
    })
  }
  if (!key.scopes.includes('mcp:read')) {
    return NextResponse.json(rpcError(id, -32002, 'This key does not hold the "mcp:read" scope.'), { status: 403 })
  }

  const session = { organizationId: key.organizationId, userId: key.principalUserId, timezone: 'UTC' }

  return withTenant(session, async (ctx) => {
    const limit = await checkRateLimit(ctx, key)
    if (!limit.allow) {
      await recordApiRequest(ctx, {
        keyId: key.keyId,
        method: 'POST',
        path: '/api/mcp',
        status: 429,
        durationMs: Date.now() - started,
        scopeUsed: 'mcp:read',
        errorCode: 'rate_limited',
      })
      return NextResponse.json(rpcError(id, -32003, `Rate limit of ${limit.limit}/minute reached.`), { status: 429 })
    }

    const actor = await loadActor(ctx, key.principalUserId)
    let payload: unknown
    let status = 200
    let errorCode: string | null = null

    switch (body.method) {
      case 'initialize':
        payload = {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'superwork', version: '0.1.0' },
          instructions:
            'Read-only access to this organization’s work. Figures come from the database; ' +
            'anything that would change something is deliberately not exposed here.',
        }
        break

      case 'tools/list':
        payload = {
          tools: readableTools().map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: zodToJsonSchema(tool.inputSchema),
          })),
        }
        break

      case 'tools/call': {
        const name = String(body.params?.['name'] ?? '')
        const args = (body.params?.['arguments'] ?? {}) as Record<string, unknown>
        const tool = readableTools().find((candidate) => candidate.name === name)
        if (!tool) {
          status = 404
          errorCode = 'unknown_tool'
          payload = rpcError(id, -32601, `No read-only tool named "${name}" is exposed over MCP.`)
          break
        }
        const parsed = tool.inputSchema.safeParse(args)
        if (!parsed.success) {
          status = 400
          errorCode = 'bad_arguments'
          payload = rpcError(
            id,
            -32602,
            parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; '),
          )
          break
        }
        const result = await tool.execute(parsed.data, {
          organizationId: ctx.organizationId,
          principalUserId: key.principalUserId,
          // MCP calls are not agent runs: there is no plan, no gate and no undo, which is
          // exactly why only read-tier tools are reachable here.
          agentRunId: '',
          stepId: '',
          idempotencyKey: `mcp-${key.keyId}-${Date.now()}`,
          traceId: ctx.traceId,
          tenantDb: ctx,
          policy: actor,
          dryRun: false,
        })
        payload = {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: false,
        }
        break
      }

      default:
        status = 400
        errorCode = 'unknown_method'
        payload = rpcError(id, -32601, `Unsupported method "${body.method ?? ''}".`)
    }

    await recordApiRequest(ctx, {
      keyId: key.keyId,
      method: 'POST',
      path: `/api/mcp:${body.method ?? 'unknown'}`,
      status,
      durationMs: Date.now() - started,
      scopeUsed: 'mcp:read',
      errorCode,
    })

    const isError = typeof payload === 'object' && payload !== null && 'error' in (payload as object)
    return NextResponse.json(isError ? payload : { jsonrpc: '2.0', id, result: payload }, { status })
  })
}

function readableTools() {
  return allTools().filter((tool) => tool.riskTier === 'read')
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}
