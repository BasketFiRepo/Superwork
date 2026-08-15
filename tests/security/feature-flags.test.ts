import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import { DEFAULT_FLAGS, FEATURE_FLAGS } from '@superwork/config'
import { clearFlag, flagStates, PermissionError, setFlag, ValidationError } from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Feature flags (§2.3).
 *
 * `feature_flag_overrides` is the odd one out among the tables nothing wrote to, because the
 * read path was already finished: the session loads this table on every request, splits the
 * organization-wide rows from the per-user ones, and layers them over `DEFAULT_FLAGS`. It
 * has run on every page load since Phase 0 and has never found a row — so every organization
 * had identical features and no administrator could change one.
 *
 * What is worth asserting is the resolution order, since that is the part that will surprise
 * somebody: a person's own choice sits on top of the organization's, so an organization
 * turning something off does not stop somebody turning it back on for themselves.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let memberSession: { organizationId: string; userId: string; timezone: string }

beforeAll(async () => {
  org = await createTenant('flags')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
  memberSession = { organizationId: org.organizationId, userId: org.memberId, timezone: 'Europe/London' }
})

afterAll(async () => {
  await destroyTenant('flags')
  await closePools()
})

describe('the names themselves', () => {
  it('are the same list in the database as in code', async () => {
    // The CHECK in 0023 duplicates the TypeScript list on purpose — the database is where a
    // typo has to be stopped. This is what keeps the two from drifting.
    const [row] = await adminSql()<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conname = 'feature_flag_known'`
    for (const flag of FEATURE_FLAGS) {
      expect(row?.definition).toContain(`'${flag}'`)
    }
    const named = (row?.definition.match(/'[a-z_]+'/g) ?? []).length
    expect(named).toBe(FEATURE_FLAGS.length)
  })

  it('refuses an override for a name nothing reads', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        setFlag(ctx, await loadActor(ctx), {
          flag: 'teleportation',
          enabled: true,
          scope: 'organization',
          reason: 'Would be nice.',
        }),
      ),
    ).rejects.toThrow(/is not a feature/i)

    // And the database refuses it too, so a bulk import cannot leave one lying about.
    await expect(
      withTenant(session, async (ctx) => {
        await ctx.sql`
          INSERT INTO feature_flag_overrides (organization_id, flag, enabled, created_by)
          VALUES (${ctx.organizationId}, 'teleportation', true, ${org.ownerId})`
      }),
    ).rejects.toThrow(/feature_flag_known/)
  })
})

describe('resolution order', () => {
  it('starts at the product default', async () => {
    const states = await withTenant(session, async (ctx) => flagStates(ctx, await loadActor(ctx)))
    expect(states).toHaveLength(FEATURE_FLAGS.length)
    for (const state of states) {
      expect(state.source).toBe('default')
      expect(state.effective).toBe(DEFAULT_FLAGS[state.flag])
    }
  })

  it('lets the organization override it, with a reason on the row', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        setFlag(ctx, await loadActor(ctx), { flag: 'meetings', enabled: false, scope: 'organization' }),
      ),
    ).rejects.toThrow(ValidationError)

    const states = await withTenant(session, async (ctx) =>
      setFlag(ctx, await loadActor(ctx), {
        flag: 'meetings',
        enabled: false,
        scope: 'organization',
        reason: 'Works council has not signed off on transcription.',
      }),
    )
    const meetings = states.find((state) => state.flag === 'meetings')!
    expect(meetings.effective).toBe(false)
    expect(meetings.source).toBe('organization')
    expect(meetings.reason).toMatch(/Works council/)
    expect(meetings.setByName).toBeTruthy()

    // Everybody in the organization sees it, not just the person who set it.
    const forMember = await withTenant(memberSession, async (ctx) => flagStates(ctx, await loadActor(ctx)))
    expect(forMember.find((state) => state.flag === 'meetings')?.effective).toBe(false)
  })

  it('puts a person’s own choice on top of the organization’s', async () => {
    // The surprising half, and the reason capabilities do not belong here: an organization
    // turning something off does not stop somebody turning it back on for themselves.
    const states = await withTenant(memberSession, async (ctx) =>
      setFlag(ctx, await loadActor(ctx), { flag: 'meetings', enabled: true, scope: 'user' }),
    )
    const meetings = states.find((state) => state.flag === 'meetings')!
    expect(meetings.effective).toBe(true)
    expect(meetings.source).toBe('you')
    expect(meetings.organizationValue).toBe(false)

    // And it is theirs alone.
    const forOwner = await withTenant(session, async (ctx) => flagStates(ctx, await loadActor(ctx)))
    expect(forOwner.find((state) => state.flag === 'meetings')?.effective).toBe(false)
  })

  it('falls back a layer at a time when an override is cleared', async () => {
    const afterUser = await withTenant(memberSession, async (ctx) =>
      clearFlag(ctx, await loadActor(ctx), { flag: 'meetings', scope: 'user' }),
    )
    expect(afterUser.find((state) => state.flag === 'meetings')?.source).toBe('organization')
    expect(afterUser.find((state) => state.flag === 'meetings')?.effective).toBe(false)

    const afterOrg = await withTenant(session, async (ctx) =>
      clearFlag(ctx, await loadActor(ctx), { flag: 'meetings', scope: 'organization' }),
    )
    expect(afterOrg.find((state) => state.flag === 'meetings')?.source).toBe('default')
    expect(afterOrg.find((state) => state.flag === 'meetings')?.effective).toBe(DEFAULT_FLAGS.meetings)
  })
})

describe('who may change what', () => {
  it('lets anybody set their own, and only an admin set everybody’s', async () => {
    // A personal preference needs no permission — it is a row height, not a policy.
    const mine = await withTenant(memberSession, async (ctx) =>
      setFlag(ctx, await loadActor(ctx), { flag: 'compact_density', enabled: false, scope: 'user' }),
    )
    expect(mine.find((state) => state.flag === 'compact_density')?.effective).toBe(false)

    await expect(
      withTenant(memberSession, async (ctx) =>
        setFlag(ctx, await loadActor(ctx), {
          flag: 'crm',
          enabled: false,
          scope: 'organization',
          reason: 'A member should not be able to do this.',
        }),
      ),
    ).rejects.toThrow(PermissionError)
  })

  it('audits the organization-wide changes and not the personal ones', async () => {
    const actions = await adminSql()<{ action: string; count: string }[]>`
      SELECT action, count(*)::text AS count FROM audit_logs
      WHERE organization_id = ${org.organizationId} AND action LIKE 'feature_flag.%'
      GROUP BY action ORDER BY action`
    expect(actions.map((row) => row.action)).toEqual(['feature_flag.cleared', 'feature_flag.set'])
    // Two personal changes happened above and neither is here: a chosen row height is not a
    // governance event, and filling the trail with those would bury the ones that are.
    expect(Number(actions.find((row) => row.action === 'feature_flag.set')?.count ?? 0)).toBe(1)
  })
})

describe('a flag belongs to one organization', () => {
  it('does not leak an override across tenants', async () => {
    const other = await createTenant('flags-other')
    const otherSession = { organizationId: other.organizationId, userId: other.ownerId, timezone: 'Europe/London' }

    await withTenant(session, async (ctx) =>
      setFlag(ctx, await loadActor(ctx), {
        flag: 'workflows',
        enabled: false,
        scope: 'organization',
        reason: 'Ours alone, and nobody else’s.',
      }),
    )

    const theirs = await withTenant(otherSession, async (ctx) => flagStates(ctx, await loadActor(ctx)))
    expect(theirs.find((state) => state.flag === 'workflows')?.effective).toBe(DEFAULT_FLAGS.workflows)
    expect(theirs.find((state) => state.flag === 'workflows')?.source).toBe('default')

    await destroyTenant('flags-other')
  })
})
