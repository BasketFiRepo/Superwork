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
    /**
     * Connection strings for the two runtime roles. Both are optional: by default they are
     * DATABASE_URL with the username swapped, which assumes all three roles share one
     * password. A hosted database where the owner's password is issued by the provider
     * cannot satisfy that, so it sets these instead. Each must still connect as the role it
     * names — see the check below.
     */
    DATABASE_APP_URL: z.string().optional(),
    DATABASE_AUTH_URL: z.string().optional(),

    APP_URL: z.string().default('http://localhost:3000'),
    SESSION_SECRET: z.string().min(16).default('dev-session-secret-change-me-please'),

    AI_MODE: RuntimeMode.default('mock'),
    EMAIL_MODE: RuntimeMode.default('mock'),
    CALENDAR_MODE: RuntimeMode.default('mock'),
    STORAGE_MODE: RuntimeMode.default('mock'),
    BILLING_MODE: RuntimeMode.default('mock'),
    /** Outbound HTTP for admin-authored tools (§22). Mock by default: no credentials, no egress. */
    HTTP_TOOLS_MODE: RuntimeMode.default('mock'),

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
    // The runtime never connects as the table owner: an owner would bypass RLS, which is
    // layer one of the three the isolation model rests on (§3.2). An override may move a
    // role onto its own credentials, host or pooler; it may not change *which* role
    // connects. That is a guarantee, not a setting, so a mismatch fails the boot rather
    // than quietly handing the request path a role that can read every tenant.
    for (const [key, role] of [
      ['DATABASE_APP_URL', 'superwork_app'],
      ['DATABASE_AUTH_URL', 'superwork_auth'],
    ] as const) {
      const value = env[key]
      if (!value) continue
      let username: string
      try {
        username = new URL(value).username
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is not a valid connection URL.`,
        })
        continue
      }
      if (username !== role) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          // The offending username is deliberately not echoed: this message reaches a page
          // served to whoever loads the site while it is misconfigured.
          message: `${key} must connect as the ${role} role — the runtime never connects as a role that could bypass row level security.`,
        })
      }
    }

    // Without an override the app and auth URLs are derived from this one, so a value that
    // is not a URL fails later, inside a request, as an opaque TypeError.
    if (!env.DATABASE_APP_URL || !env.DATABASE_AUTH_URL) {
      try {
        new URL(env.DATABASE_URL)
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DATABASE_URL'],
          message:
            'DATABASE_URL is not a valid connection URL — expected postgres://user:password@host:port/database.',
        })
      }
    }

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

/** One thing wrong with the environment, named so a person can go and fix it. */
export interface EnvIssue {
  /** The variable at fault, or `(root)` for a rule that spans several. */
  variable: string
  message: string
}

function toIssues(error: z.ZodError): EnvIssue[] {
  return error.issues.map((i) => ({ variable: i.path.join('.') || '(root)', message: i.message }))
}

/**
 * Everything wrong with the environment, without throwing.
 *
 * `loadEnv` is the fail-fast path and stays the rule: nothing starts on a bad
 * configuration. This is for the one caller that has to render something a person can act
 * on instead of stopping — an unhandled throw during a render reaches the browser as a
 * digest and nothing else, which is the least useful thing a misconfigured deployment can
 * say. Returns an empty array when the configuration is good.
 */
export function envIssues(source: NodeJS.ProcessEnv = process.env): EnvIssue[] {
  const parsed = EnvSchema.safeParse(source)
  if (parsed.success) return []
  const issues = toIssues(parsed.error)

  // Zod stops before the cross-field rules as soon as any one variable fails, so a
  // deployment being configured for the first time would be told about DATABASE_URL,
  // redeploy, and only then hear that SESSION_SECRET is still the development default —
  // one round trip per problem, which is the thing this is meant to spare someone. Parse
  // again with the broken variables stood down so their defaults apply, and report
  // whatever was queued up behind them.
  const probe: NodeJS.ProcessEnv = { ...source }
  for (const issue of issues) delete probe[issue.variable]
  probe.DATABASE_URL ??= 'postgres://placeholder:placeholder@localhost:5432/placeholder'

  const behind = EnvSchema.safeParse(probe)
  if (!behind.success) {
    const named = new Set(issues.map((i) => i.variable))
    for (const extra of toIssues(behind.error)) {
      if (!named.has(extra.variable)) issues.push(extra)
    }
  }
  return issues
}

let cached: Env | null = null

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source)
  if (!parsed.success) {
    // The same full list the page shows: a process that dies on startup should name every
    // variable it needs, not the first one it happened to check.
    const issues = envIssues(source)
      .map((i) => `  • ${i.variable}: ${i.message}`)
      .join('\n')
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
