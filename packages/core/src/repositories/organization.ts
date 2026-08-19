import type { TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { PermissionError, ValidationError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'

/**
 * What the organization says about itself (§4.1, ADR 0052).
 *
 * `organizations` has been written by the seed and by almost nothing else since Phase 0. Two
 * columns picked up a control along the way — `data_region` (ADR 0025) and the kill switch —
 * and the rest of the row stayed whatever the seed said, so every organization is Northwind
 * Logistics, in Europe/London, that thinks a reefer is a temperature-controlled trailer.
 *
 * The columns here are not decorative:
 *
 *   - `timezone` is what "today" and "overdue" mean for everybody who has no timezone of their
 *     own, the fallback for a department that sets none (ADR 0039), and the clock a recurring
 *     task is rolled on. Changing it changes which work is late, which is why the screen says
 *     so and the audit record keeps the before and the after.
 *   - `glossary` is expanded into every search query before it is embedded, so the acronyms a
 *     company says out loud find the documents that spell them out.
 *   - `name` and `industry` are the grounding the model is given, and the name is on the
 *     transparency report a person can ask for about themselves.
 *   - `currency` is how money is written everywhere it is written.
 *
 * `slug` is deliberately not settable. It is an address, and changing an address silently
 * breaks every link anybody kept.
 */

export interface OrganizationProfileView {
  name: string
  /** Shown, and not settable: it is the address, not the name. */
  slug: string
  industry: string | null
  timezone: string
  currency: string
  /** How the organization asks to be written to, given to the model as grounding. */
  tone: string | null
  glossary: { term: string; meaning: string }[]
  /** Everybody governed by the organization's clock because they have none of their own. */
  peopleOnTheOrgClock: number
  /** Departments that fall back to it, so the screen can say what changing it reaches. */
  departmentsOnTheOrgClock: number
}

const MAX_GLOSSARY = 200

export async function organizationProfile(
  ctx: TenantContext,
  actor: Actor,
): Promise<OrganizationProfileView> {
  const decision = can(actor, 'settings:read', { type: 'settings', organizationId: ctx.organizationId })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const [row] = await ctx.sql<OrganizationProfileView[]>`
    SELECT o.name, o.slug, o.industry, o.timezone, o.currency::text AS currency,
           o.profile->>'tone' AS tone,
           o.glossary,
           (SELECT count(*)::int FROM memberships m
             JOIN users u ON u.id = m.user_id
             WHERE m.organization_id = o.id AND m.deleted_at IS NULL AND m.status = 'active'
               AND (u.timezone IS NULL OR u.timezone = o.timezone)) AS "peopleOnTheOrgClock",
           (SELECT count(*)::int FROM departments d
             WHERE d.organization_id = o.id AND d.deleted_at IS NULL
               AND d.timezone IS NULL) AS "departmentsOnTheOrgClock"
    FROM organizations o
    WHERE o.id = ${ctx.organizationId}`

  return row!
}

/** Whether this machine can work in that timezone at all — the only authority worth asking. */
export function knownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone }).format(new Date())
    return true
  } catch {
    return false
  }
}

/** Whether money can be written in it. `Intl` throws on a code it does not know. */
export function knownCurrency(currency: string): boolean {
  if (!/^[A-Z]{3}$/.test(currency)) return false
  try {
    new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(1)
    return true
  } catch {
    return false
  }
}

export async function updateOrganizationProfile(
  ctx: TenantContext,
  actor: Actor,
  input: {
    name?: string
    industry?: string | null
    timezone?: string
    currency?: string
    /** `null` takes it away, so the model is given no instruction rather than an empty one. */
    tone?: string | null
  },
): Promise<OrganizationProfileView> {
  const decision = can(actor, 'settings:update', {
    type: 'settings',
    organizationId: ctx.organizationId,
    // The clock is in here, and it decides what "overdue" means for everybody who has no
    // timezone of their own. That is a higher tier than renaming the company.
    riskTier: 'high',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const before = await organizationProfile(ctx, actor)

  const name = input.name === undefined ? before.name : input.name.trim()
  if (name.length < 2) {
    throw new ValidationError('An organization needs a name the people in it would recognise.')
  }
  if (name.length > 200) throw new ValidationError('That is longer than a name needs to be.')

  const industry =
    input.industry === undefined ? before.industry : input.industry?.trim() || null
  if (industry !== null && industry.length > 120) {
    throw new ValidationError('Say what the company does in a phrase, not a paragraph.')
  }

  const timezone = input.timezone === undefined ? before.timezone : input.timezone.trim()
  if (!knownTimezone(timezone)) {
    throw new ValidationError(
      `“${timezone}” is not a timezone this product can work in. It takes IANA names, like ` +
        'Europe/London or America/New_York — the kind with a slash in.',
    )
  }

  const currency = input.currency === undefined ? before.currency : input.currency.trim().toUpperCase()
  if (!knownCurrency(currency)) {
    throw new ValidationError(
      `“${currency}” is not a currency this product can write money in. It takes three-letter ` +
        'ISO codes, like GBP, USD or EUR.',
    )
  }

  const tone = input.tone === undefined ? before.tone : input.tone?.trim() || null
  if (tone !== null && tone.length > 400) {
    throw new ValidationError('A note about tone should be shorter than the things written in it.')
  }

  await ctx.sql`
    UPDATE organizations
    SET name = ${name},
        industry = ${industry},
        timezone = ${timezone},
        currency = ${currency},
        -- Merged rather than replaced: the profile carries keys this screen does not offer, and
        -- a write that silently drops what it was not asked about is a write nobody can trust.
        profile = ${
          tone === null
            ? ctx.sql`profile - 'tone'`
            : ctx.sql`profile || jsonb_build_object('tone', ${tone}::text)`
        },
        updated_at = now()
    WHERE id = ${ctx.organizationId}`

  const after = await organizationProfile(ctx, actor)

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'organization.updated',
    entityType: 'organization',
    entityId: ctx.organizationId,
    before: {
      name: before.name,
      industry: before.industry,
      timezone: before.timezone,
      currency: before.currency,
      tone: before.tone,
    },
    after: { name, industry, timezone, currency, tone },
  })

  // The clock is the one of these that changes what everybody else sees, so it is the one that
  // goes on the activity feed rather than only into the audit log.
  if (before.timezone !== timezone) {
    await writeActivity(ctx, {
      actorType: actor.type,
      actorUserId: actor.userId,
      actorLabel: actor.displayName,
      verb: 'changed',
      entityType: 'organization',
      entityId: ctx.organizationId,
      entityLabel: name,
      summary:
        `The company clock moved from ${before.timezone} to ${timezone}. That is what “today” and ` +
        `“overdue” mean for the ${before.peopleOnTheOrgClock} ` +
        `${before.peopleOnTheOrgClock === 1 ? 'person' : 'people'} who have no timezone of their own.`,
    })
  }

  return after
}

/**
 * Adds a term, or changes what one already means.
 *
 * One entry per term, matched without case, because two entries for the same term append their
 * meanings to the same query twice. Saving an existing term therefore replaces it rather than
 * quietly making a second one — which is also how somebody corrects a meaning.
 */
export async function setGlossaryTerm(
  ctx: TenantContext,
  actor: Actor,
  input: { term: string; meaning: string },
): Promise<OrganizationProfileView> {
  const decision = can(actor, 'settings:update', {
    type: 'settings',
    organizationId: ctx.organizationId,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const term = input.term.trim()
  const meaning = input.meaning.trim()
  // A one-character term expands nearly every query it appears in; an empty one compiles to a
  // regular expression that matches all of them. The database refuses both as well.
  if (term.length < 2) {
    throw new ValidationError(
      'A term needs at least two characters. A shorter one would match almost every search and ' +
        'add its meaning to all of them.',
    )
  }
  if (term.length > 40) throw new ValidationError('That is a phrase, not a term.')
  if (meaning.length < 2) throw new ValidationError('Say what the term means.')
  if (meaning.length > 200) {
    throw new ValidationError('A meaning is a few words, not a definition somebody has to read.')
  }

  const before = await organizationProfile(ctx, actor)
  const kept = before.glossary.filter(
    (entry) => entry.term.trim().toLowerCase() !== term.toLowerCase(),
  )
  if (kept.length >= MAX_GLOSSARY) {
    throw new ValidationError(
      `The glossary already holds ${MAX_GLOSSARY} terms, which is as many as a search can carry. ` +
        'Take one out first.',
    )
  }
  const replacing = kept.length !== before.glossary.length

  await ctx.sql`
    UPDATE organizations SET glossary = ${ctx.sql.json([...kept, { term, meaning }])}, updated_at = now()
    WHERE id = ${ctx.organizationId}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: replacing ? 'organization.glossary_changed' : 'organization.glossary_added',
    entityType: 'organization',
    entityId: ctx.organizationId,
    before: replacing
      ? { term, meaning: before.glossary.find((entry) => entry.term.toLowerCase() === term.toLowerCase())?.meaning ?? null }
      : null,
    after: { term, meaning },
  })

  return organizationProfile(ctx, actor)
}

export async function removeGlossaryTerm(
  ctx: TenantContext,
  actor: Actor,
  input: { term: string },
): Promise<OrganizationProfileView> {
  const decision = can(actor, 'settings:update', {
    type: 'settings',
    organizationId: ctx.organizationId,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const term = input.term.trim().toLowerCase()
  const before = await organizationProfile(ctx, actor)
  const entry = before.glossary.find((row) => row.term.trim().toLowerCase() === term)
  if (!entry) {
    throw new ValidationError('That term is not in the glossary. Nothing was changed.')
  }

  await ctx.sql`
    UPDATE organizations
    SET glossary = ${ctx.sql.json(before.glossary.filter((row) => row.term.trim().toLowerCase() !== term))},
        updated_at = now()
    WHERE id = ${ctx.organizationId}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'organization.glossary_removed',
    entityType: 'organization',
    entityId: ctx.organizationId,
    before: { term: entry.term, meaning: entry.meaning },
    after: null,
  })

  return organizationProfile(ctx, actor)
}
