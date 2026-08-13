import { z } from 'zod'

/**
 * Runtime mode for every external capability (spec §2.3).
 * The product must run end-to-end with every capability in `mock`.
 */
export const RuntimeMode = z.enum(['mock', 'sandbox', 'live'])
export type RuntimeMode = z.infer<typeof RuntimeMode>

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())))

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required — Superwork will not start without a database'),
    /** Connection string for the migration/owner role. Falls back to DATABASE_URL. */
    DATABASE_ADMIN_URL: z.string().optional(),

    APP_URL: z.string().default('http://localhost:3000'),
    SESSION_SECRET: z.string().min(16).default('dev-session-secret-change-me-please'),

    AI_MODE: RuntimeMode.default('mock'),
    EMAIL_MODE: RuntimeMode.default('mock'),
    CALENDAR_MODE: RuntimeMode.default('mock'),
    STORAGE_MODE: RuntimeMode.default('mock'),
    BILLING_MODE: RuntimeMode.default('mock'),

    AUTOPILOT_ENABLED: boolish.default(false),
    AGENT_KILL_SWITCH: boolish.default(false),

    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_BASE_URL: z.string().default('https://api.anthropic.com'),

    /** Seconds an outbound email waits in the recall window before dispatch (§5.7). */
    EMAIL_SEND_DELAY_SECONDS: z.coerce.number().int().min(0).default(60),

    /**
     * How many agent runs one process drives at once. The fair-share scheduler decides
     * *which* department goes next; this decides how many go at all (§26.6).
     */
    AGENT_MAX_CONCURRENT: z.coerce.number().int().min(1).max(256).default(8),

    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    OTEL_ENABLED: boolish.default(false),
    OTEL_SERVICE_NAME: z.string().default('superwork'),
  })
  .superRefine((env, ctx) => {
    // Fail fast and loudly. Never silently default a secret (§2.3).
    if (env.AI_MODE === 'live' && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ANTHROPIC_API_KEY'],
        message: 'AI_MODE=live requires ANTHROPIC_API_KEY. Set the key or run with AI_MODE=mock.',
      })
    }
    if (env.NODE_ENV === 'production' && env.SESSION_SECRET.startsWith('dev-session-secret')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SESSION_SECRET'],
        message: 'SESSION_SECRET must be set explicitly in production.',
      })
    }
    if (env.AUTOPILOT_ENABLED && env.AI_MODE === 'mock') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTOPILOT_ENABLED'],
        message: 'Autopilot cannot be enabled while AI_MODE=mock — simulated output must never act unattended.',
      })
    }
  })

export type Env = z.infer<typeof EnvSchema>

let cached: Env | null = null

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}\n`)
  }
  return parsed.data
}

export function env(): Env {
  if (!cached) cached = loadEnv()
  return cached
}

/** Test helper — replaces the cached env. Never used by application code. */
export function __setEnvForTests(next: Partial<Env> | null): void {
  cached = next ? ({ ...env(), ...next } as Env) : null
}
