import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor, type Actor } from '@superwork/auth'
import { residency, setAllowedRegions, setResidency, StepUpRequiredError } from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Somewhere the data may not go (ADR 0074).
 *
 * `organizations.allowed_regions` was read by `residency()`, rendered on the settings screen,
 * enforced by `setResidency()` and enforced again by the schema — and written by nothing. Every
 * organization sat at the column's default, so the panel offered three regions, permanently
 * refused two, and the refusal named a provisioning act nobody could perform.
 *
 * The repair is two levels, not a tick-box: a ceiling somebody provisioned, and beneath it a
 * restriction the organization sets on itself.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let owner: { organizationId: string; userId: string; timezone: string }
let actor: Actor
/** The same person, holding a password proof from the last five minutes. */
let proven: Actor

async function provision(regions: string[]) {
  await adminSql()`
    UPDATE organizations SET provisioned_regions = ${regions} WHERE id = ${org.organizationId}`
}

async function reset(allowed = ['eu']) {
  await adminSql()`
    UPDATE organizations
    SET data_region = 'eu', allowed_regions = ${allowed}, allowed_regions_set_by = NULL,
        allowed_regions_set_at = NULL, allowed_regions_reason = NULL
    WHERE id = ${org.organizationId}`
}

const REASON = 'Customer contracts commit us to EU-only processing.'

beforeAll(async () => {
  org = await createTenant('data-residency')
  owner = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  actor = await withTenant(owner, async (ctx) => loadActor(ctx))
  proven = { ...actor, steppedUpAt: new Date() }
  await provision(['eu', 'uk'])
})

afterAll(async () => {
  await destroyTenant('data-residency')
  await closePools()
})

describe('what the screen could say before', () => {
  it('nothing — the column held its default and nothing could write it', async () => {
    await reset()
    const now = await withTenant(owner, async (ctx) => residency(ctx, actor))
    expect(now.allowed).toEqual(['eu'])
    expect(now.provisioned).toEqual(['eu', 'uk'])
    // Which is the interesting state: a region provisioned and not allowed.
    expect(now.setByName).toBeNull()
  })
})

describe('narrowing', () => {
  it('is the company’s own to do, and asks for nothing but a reason', async () => {
    await reset(['eu', 'uk'])
    // No `steppedUpAt` on this actor. Making a stronger promise is the direction that should
    // be easy.
    const after = await withTenant(owner, async (ctx) =>
      setAllowedRegions(ctx, actor, { regions: ['eu'], reason: REASON }),
    )
    expect(after.allowed).toEqual(['eu'])
    expect(after.reason).toBe(REASON)
    expect(after.setAt).toBeInstanceOf(Date)
  })

  it('says who, and why, because somebody will ask a year later', async () => {
    const after = await withTenant(owner, async (ctx) => residency(ctx, actor))
    expect(after.setByName).toBeTruthy()
    expect(after.reason).toBe(REASON)
  })

  it('refuses a reasonless one', async () => {
    await reset(['eu', 'uk'])
    await expect(
      withTenant(owner, async (ctx) => setAllowedRegions(ctx, actor, { regions: ['eu'], reason: '  ' })),
    ).rejects.toThrow(/Say why/i)
  })

  it('and it binds: the data cannot then be moved somewhere ruled out', async () => {
    await reset(['eu', 'uk'])
    await withTenant(owner, async (ctx) => setAllowedRegions(ctx, actor, { regions: ['eu'], reason: REASON }))
    await expect(withTenant(owner, async (ctx) => setResidency(ctx, actor, 'uk'))).rejects.toThrow(
      /ruled uk out/i,
    )
  })

  it('and the refusal names what would work, which it never did', async () => {
    // The old message said "provisioned" whether or not the region was, so the one case that is
    // a click away read like the one that is a migration.
    await expect(
      withTenant(owner, async (ctx) => setResidency(ctx, actor, 'uk')),
    ).rejects.toThrow(/Allow it again first/i)
    await expect(
      withTenant(owner, async (ctx) => setResidency(ctx, actor, 'us')),
    ).rejects.toThrow(/is a migration, not a setting/i)
  })
})

describe('widening', () => {
  it('asks for a password, because it widens', async () => {
    await reset(['eu'])
    await expect(
      withTenant(owner, async (ctx) =>
        setAllowedRegions(ctx, actor, { regions: ['eu', 'uk'], reason: 'Opening a Manchester office.' }),
      ),
    ).rejects.toThrow(StepUpRequiredError)
  })

  it('and goes through with one', async () => {
    await reset(['eu'])
    const after = await withTenant(owner, async (ctx) =>
      setAllowedRegions(ctx, proven, { regions: ['eu', 'uk'], reason: 'Opening a Manchester office.' }),
    )
    expect(after.allowed).toEqual(['eu', 'uk'])
  })

  it('but never past what somebody provisioned, whatever proof is offered', async () => {
    await reset(['eu'])
    // A settings screen cannot make a database exist in Ohio, and an organization recording that
    // it may keep data somewhere it has none would be writing down something untrue.
    await expect(
      withTenant(owner, async (ctx) =>
        setAllowedRegions(ctx, proven, { regions: ['eu', 'us'], reason: 'We would like to.' }),
      ),
    ).rejects.toThrow(/holds no database for this organization in United States/i)
  })

  it('and the refusal names what would actually work', async () => {
    await expect(
      withTenant(owner, async (ctx) =>
        setAllowedRegions(ctx, proven, { regions: ['eu', 'us'], reason: 'We would like to.' }),
      ),
    ).rejects.toThrow(/ask us to do that/i)
  })
})

describe('what cannot be said at all', () => {
  it('nowhere, because data has to live somewhere', async () => {
    await reset(['eu'])
    await expect(
      withTenant(owner, async (ctx) => setAllowedRegions(ctx, proven, { regions: [], reason: REASON })),
    ).rejects.toThrow(/at least one region/i)
  })

  it('a region Superwork does not have', async () => {
    await expect(
      withTenant(owner, async (ctx) =>
        setAllowedRegions(ctx, proven, { regions: ['eu', 'mars'], reason: REASON }),
      ),
    ).rejects.toThrow(/no region called mars/i)
  })

  it('and ruling out the region the data is actually in', async () => {
    await reset(['eu', 'uk'])
    await adminSql()`UPDATE organizations SET data_region = 'uk' WHERE id = ${org.organizationId}`
    await expect(
      withTenant(owner, async (ctx) => setAllowedRegions(ctx, actor, { regions: ['eu'], reason: REASON })),
    ).rejects.toThrow(/Move it first/i)
    await reset(['eu'])
  })
})

describe('what the database holds to, whatever writes the row', () => {
  /**
   * `adminSql()` is the owner connection — the most privileged writer there is. A rule only the
   * repository keeps is a rule anything holding a connection can break.
   */
  it('allowed regions stay within provisioned ones', async () => {
    await reset(['eu'])
    await expect(
      adminSql()`
        UPDATE organizations SET allowed_regions = ARRAY['eu', 'us']
        WHERE id = ${org.organizationId}`,
    ).rejects.toThrow(/allowed_within_provisioned/i)
  })

  it('the list is never empty', async () => {
    await expect(
      adminSql()`UPDATE organizations SET allowed_regions = ARRAY[]::text[] WHERE id = ${org.organizationId}`,
    ).rejects.toThrow(/allowed_regions_not_empty/i)
  })

  it('and a narrowing cannot be recorded with nobody’s name against it', async () => {
    await expect(
      adminSql()`
        UPDATE organizations SET allowed_regions_reason = 'Because.'
        WHERE id = ${org.organizationId}`,
    ).rejects.toThrow(/allowed_regions_attributed/i)
  })
})

describe('the ceiling is not a setting', () => {
  /**
   * `provisioned_regions` is deliberately unwritable by the product: a settings screen cannot
   * make a database exist. The column-coverage detector does not complain about it, but only
   * because 0065's backfill counts as a write — which is the instrument happening to agree
   * rather than anybody deciding, and this codebase has already written down that an instrument
   * that quietly agrees with you is worse than none.
   *
   * So the rule is asserted here, the way ADR 0070 asserts there is no per-person digest count:
   * by reading the source. If somebody adds a screen for this, they have to delete this test and
   * argue with the ADR beside it.
   */
  it('nothing in the product writes it', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const root = new URL('../../', import.meta.url).pathname
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir)) {
        if (['node_modules', '.next', 'dist', '.turbo'].includes(entry)) continue
        const full = path.join(dir, entry)
        if (fs.statSync(full).isDirectory()) walk(full)
        else if (/\.(ts|tsx)$/.test(entry) && /provisioned_regions\s*=/.test(fs.readFileSync(full, 'utf8'))) {
          offenders.push(path.relative(root, full))
        }
      }
    }
    for (const dir of ['packages/core', 'packages/agent', 'packages/tools', 'apps/web']) {
      walk(path.join(root, dir))
    }
    expect(offenders).toEqual([])
  })

  it('and the seed writes it, because provisioning is where it comes from', async () => {
    const fs = await import('node:fs')
    const seed = fs.readFileSync(new URL('../../packages/db/src/seed/index.ts', import.meta.url), 'utf8')
    expect(/provisioned_regions\s*=/.test(seed)).toBe(true)
  })
})

describe('who may change it', () => {
  it('not a member, because this is a setting', async () => {
    const member = { organizationId: org.organizationId, userId: org.memberId, timezone: TZ }
    await expect(
      withTenant(member, async (ctx) =>
        setAllowedRegions(ctx, { ...(await loadActor(ctx)), steppedUpAt: new Date() }, {
          regions: ['eu'],
          reason: REASON,
        }),
      ),
    ).rejects.toThrow()
  })

  it('and it does not leak across a tenant boundary', async () => {
    const other = await createTenant('data-residency-b')
    try {
      await adminSql()`
        UPDATE organizations SET provisioned_regions = ARRAY['eu', 'uk', 'us']
        WHERE id = ${other.organizationId}`
      const mine = await withTenant(owner, async (ctx) => residency(ctx, actor))
      // Somebody else's provisioning is not a ceiling this organization may write against.
      expect(mine.provisioned).toEqual(['eu', 'uk'])
    } finally {
      await destroyTenant('data-residency-b')
    }
  })
})
