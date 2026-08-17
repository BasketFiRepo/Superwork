import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { __setEnvForTests, envIssues, loadEnv } from '@superwork/config'
import { connectionFor } from '../../packages/db/src/client.js'

/** The smallest environment the schema accepts. Everything else has a default. */
const BASE = {
  DATABASE_URL: 'postgres://owner:s3cret@db.example.com:5432/superwork',
  SESSION_SECRET: 'a-long-enough-secret',
} as NodeJS.ProcessEnv

const variables = (source: NodeJS.ProcessEnv) => envIssues(source).map((i) => i.variable)

describe('environment validation', () => {
  it('accepts the minimum and reports nothing', () => {
    expect(envIssues(BASE)).toEqual([])
  })

  it('names every missing variable rather than only the first', () => {
    const issues = envIssues({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)
    expect(issues.map((i) => i.variable)).toContain('DATABASE_URL')
    // A deployment missing both should be told about both, in one pass.
    expect(issues.map((i) => i.variable)).toContain('SESSION_SECRET')
  })

  it('still refuses the development session secret in production', () => {
    expect(variables({ ...BASE, NODE_ENV: 'production', SESSION_SECRET: 'dev-session-secret-x' })).toContain(
      'SESSION_SECRET',
    )
  })

  it('catches a DATABASE_URL that is not a URL before a request does', () => {
    // Without an override the runtime URLs are derived from this one, so an unparseable
    // value surfaces mid-request as an opaque TypeError instead of here.
    expect(variables({ ...BASE, DATABASE_URL: 'host=db user=owner' })).toContain('DATABASE_URL')
  })

  it('does not require DATABASE_URL to parse when both runtime roles are named outright', () => {
    // It is then only the admin fallback, handed to the driver verbatim.
    expect(
      envIssues({
        ...BASE,
        DATABASE_URL: 'host=db user=owner',
        DATABASE_APP_URL: 'postgres://superwork_app:pw@db.example.com:5432/superwork',
        DATABASE_AUTH_URL: 'postgres://superwork_auth:pw@db.example.com:5432/superwork',
      }),
    ).toEqual([])
  })

  it('keeps failing fast: loadEnv throws where envIssues reports', () => {
    expect(() => loadEnv({} as NodeJS.ProcessEnv)).toThrow(/Invalid environment configuration/)
    expect(() => loadEnv(BASE)).not.toThrow()
  })
})

describe('runtime role overrides', () => {
  it('accepts an override that connects as the role it is for', () => {
    expect(
      envIssues({
        ...BASE,
        DATABASE_APP_URL: 'postgres://superwork_app:different@pooler.example.com:6543/superwork',
        DATABASE_AUTH_URL: 'postgres://superwork_auth:different@pooler.example.com:6543/superwork',
      }),
    ).toEqual([])
  })

  it('refuses an override that would connect as the owner', () => {
    // This is the whole point of the check. The owner bypasses RLS, so an override that
    // named it would silently undo layer one of the isolation model (§3.2) — and it is
    // exactly the value someone reaches for when the app role's password does not work.
    expect(variables({ ...BASE, DATABASE_APP_URL: BASE.DATABASE_URL })).toContain('DATABASE_APP_URL')
    expect(variables({ ...BASE, DATABASE_AUTH_URL: BASE.DATABASE_URL })).toContain('DATABASE_AUTH_URL')
  })

  it('refuses the two runtime roles swapped', () => {
    expect(
      variables({ ...BASE, DATABASE_APP_URL: 'postgres://superwork_auth:pw@db.example.com/superwork' }),
    ).toContain('DATABASE_APP_URL')
  })

  it('refuses an override that is not a URL', () => {
    expect(variables({ ...BASE, DATABASE_APP_URL: 'superwork_app@db' })).toContain('DATABASE_APP_URL')
  })

  it('never echoes the offending connection string', () => {
    // These messages are rendered on a page served to whoever loads a misconfigured site.
    const issues = envIssues({ ...BASE, DATABASE_APP_URL: 'postgres://owner:s3cret@db.example.com/superwork' })
    expect(issues).not.toHaveLength(0)
    for (const issue of issues) {
      expect(issue.message).not.toContain('s3cret')
      expect(issue.message).not.toContain('owner')
    }
  })
})

describe('which role each pool connects as', () => {
  const original = { ...process.env }

  const configure = (values: Record<string, string | undefined>) => {
    for (const key of ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'DATABASE_APP_URL', 'DATABASE_AUTH_URL']) {
      delete process.env[key]
    }
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) process.env[key] = value
    }
    // Drop the memoised env so the next read sees what this test set.
    __setEnvForTests(null)
  }

  beforeEach(() => configure(BASE as Record<string, string>))

  afterAll(() => {
    for (const key of ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'DATABASE_APP_URL', 'DATABASE_AUTH_URL']) {
      delete process.env[key]
      if (original[key] !== undefined) process.env[key] = original[key]
    }
    __setEnvForTests(null)
  })

  it('swaps the username when no override is set, keeping the rest of the URL', () => {
    expect(new URL(connectionFor('app')).username).toBe('superwork_app')
    expect(new URL(connectionFor('auth')).username).toBe('superwork_auth')
    // Host, port, database and password all come from DATABASE_URL.
    expect(new URL(connectionFor('app')).host).toBe('db.example.com:5432')
    expect(new URL(connectionFor('app')).password).toBe('s3cret')
  })

  it('uses an override verbatim when one is set', () => {
    const appUrl = 'postgres://superwork_app:other@pooler.example.com:6543/superwork'
    configure({ ...(BASE as Record<string, string>), DATABASE_APP_URL: appUrl })

    expect(connectionFor('app')).toBe(appUrl)
    // The role without an override still derives from DATABASE_URL.
    expect(new URL(connectionFor('auth')).host).toBe('db.example.com:5432')
  })

  it('never hands the owner URL to a runtime pool', () => {
    configure({
      ...(BASE as Record<string, string>),
      DATABASE_ADMIN_URL: 'postgres://owner:s3cret@direct.example.com:5432/superwork',
    })

    for (const role of ['app', 'auth'] as const) {
      expect(new URL(connectionFor(role)).username).not.toBe('owner')
    }
    expect(connectionFor('admin')).toContain('direct.example.com')
  })

  it('falls back to DATABASE_URL for the admin pool', () => {
    expect(connectionFor('admin')).toBe(BASE.DATABASE_URL)
  })
})
