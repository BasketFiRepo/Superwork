import type { ZodTypeAny } from 'zod'

/**
 * A JSON Schema for an MCP client, derived from the tool's own Zod schema (§22.4).
 *
 * Deliberately small: it describes the shape well enough for a model to call the tool,
 * and the real validation still happens against the Zod schema on the way in. A schema
 * that drifts from the validator would be worse than a coarse one.
 */
export function zodToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const def = (schema as { _def?: Record<string, unknown> })._def ?? {}
  const typeName = String(def['typeName'] ?? '')

  switch (typeName) {
    case 'ZodObject': {
      const shape = (def['shape'] as () => Record<string, ZodTypeAny>)()
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value)
        if (!value.isOptional()) required.push(key)
      }
      return { type: 'object', properties, ...(required.length ? { required } : {}) }
    }
    case 'ZodString':
      return { type: 'string' }
    case 'ZodNumber':
      return { type: 'number' }
    case 'ZodBoolean':
      return { type: 'boolean' }
    case 'ZodDate':
      return { type: 'string', format: 'date-time' }
    case 'ZodArray':
      return { type: 'array', items: zodToJsonSchema(def['type'] as ZodTypeAny) }
    case 'ZodEnum':
      return { type: 'string', enum: def['values'] as string[] }
    case 'ZodNativeEnum':
      return { type: 'string' }
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return zodToJsonSchema(def['innerType'] as ZodTypeAny)
    case 'ZodUnion':
      return { anyOf: (def['options'] as ZodTypeAny[]).map(zodToJsonSchema) }
    case 'ZodLiteral':
      return { const: def['value'] }
    case 'ZodRecord':
      return { type: 'object' }
    default:
      return {}
  }
}
