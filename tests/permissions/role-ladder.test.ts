import { describe, expect, it } from 'vitest'
import { can, parsePermission, ROLE_LADDER, ROLE_PERMISSIONS, type Actor } from '@superwork/auth'
import type { Role } from '@superwork/db'

/**
 * A rung may add. It may never take away (ADR 0059).
 *
 * The four ladder roles were four hand-maintained lists, and twenty-one places had drifted far
 * enough that a higher role could do less than a lower one — a manager who could not log a call
 * a member could log, an admin who could not touch a milestone a manager could. Nobody decided
 * any of that; it is what four lists look like after eleven increments of edits.
 *
 * This is the test that makes the invariant a property rather than a habit. It walks every
 * `resource:action` any list mentions — wildcards expanded against every resource and action
 * seen anywhere — through four shapes of resource, and asks the real policy engine. A grant that
 * is allowed at one rung and refused at the next fails, and the failure names the pair.
 *
 * `guest` and `service` are deliberately absent: a guest is somebody from outside invited to one
 * team, sideways from the ladder rather than beneath it, and a service actor starts with nothing
 * and is given what it needs (ADR 0055). `permissions.ts` says the same thing where the lists are.
 */

const ORG = '11111111-1111-1111-1111-111111111111'
const USER = '22222222-2222-2222-2222-222222222222'
const DEPARTMENT = '33333333-3333-3333-3333-333333333333'
const TEAM = '44444444-4444-4444-4444-444444444444'

function actor(role: Role): Actor {
  return {
    type: 'user',
    userId: USER,
    organizationId: ORG,
    role,
    displayName: `${role} user`,
    departmentIds: [DEPARTMENT],
    teamIds: [TEAM],
    extraPermissions: [],
  }
}

/** The four ways a resource can present itself to `scopeSatisfied`. */
const SHAPES: Record<string, Record<string, unknown>> = {
  // Theirs: the shape a create takes, where the row will be owned by whoever asked (ADR 0045).
  own: { ownerId: USER, createdBy: USER, assigneeId: USER },
  // In their department, and in their team: the two scopes between `own` and `org`.
  department: { departmentId: DEPARTMENT },
  team: { teamId: TEAM },
  // Somebody else's, filed against nothing — which is what a company is, and what caught this.
  bare: {},
}

function catalogue(): string[] {
  const resources = new Set<string>()
  const actions = new Set<string>()
  const pairs = new Set<string>()
  for (const list of Object.values(ROLE_PERMISSIONS)) {
    for (const raw of list) {
      const { resource, action } = parsePermission(raw)
      if (resource !== '*') resources.add(resource)
      if (action !== '*') actions.add(action)
    }
  }
  for (const list of Object.values(ROLE_PERMISSIONS)) {
    for (const raw of list) {
      const { resource, action } = parsePermission(raw)
      if (resource === '*' && action === '*') continue
      if (resource === '*') for (const r of resources) pairs.add(`${r}:${action}`)
      else if (action === '*') for (const a of actions) pairs.add(`${resource}:${a}`)
      else pairs.add(`${resource}:${action}`)
    }
  }
  return [...pairs].sort()
}

describe('the role ladder', () => {
  const pairs = catalogue()

  it('is built from something worth walking', () => {
    // If the catalogue ever collapses, this test would pass by having nothing to check.
    expect(pairs.length).toBeGreaterThan(100)
    expect(pairs).toContain('note:create')
    expect(pairs).toContain('milestone:create')
  })

  it('never takes something away from the rung above', () => {
    const broken: string[] = []
    for (const pair of pairs) {
      const [resource, action] = pair.split(':') as [string, string]
      for (const [shapeName, shape] of Object.entries(SHAPES)) {
        const allowed = ROLE_LADDER.map(
          (role) =>
            can(actor(role), action, {
              type: resource,
              organizationId: ORG,
              riskTier: 'low',
              ...shape,
            } as never).allow,
        )
        for (let rung = 1; rung < allowed.length; rung++) {
          if (allowed[rung - 1] && !allowed[rung]) {
            broken.push(`${ROLE_LADDER[rung - 1]} can but ${ROLE_LADDER[rung]} cannot — ${pair} (${shapeName})`)
          }
        }
      }
    }
    expect(broken).toEqual([])
  })

  it('is composed, so the lists cannot drift apart again', () => {
    for (let rung = 1; rung < ROLE_LADDER.length - 1; rung++) {
      const below = ROLE_PERMISSIONS[ROLE_LADDER[rung - 1]!]
      const above = ROLE_PERMISSIONS[ROLE_LADDER[rung]!]
      expect(above.slice(0, below.length)).toEqual(below)
    }
    // The owner is the one rung stated as a wildcard rather than a list, so it is checked by
    // behaviour above rather than by prefix here.
    expect(ROLE_PERMISSIONS.owner).toEqual(['*:*:org'])
  })

  it('says each permission once', () => {
    for (const [role, list] of Object.entries(ROLE_PERMISSIONS)) {
      expect(new Set(list).size, `${role} repeats a grant`).toBe(list.length)
    }
  })
})

describe('the two that were found by hand', () => {
  it('lets an account manager write down the call they just made', () => {
    // ADR 0057 shipped the form and recorded that a manager could not use it: a company belongs
    // to no department, so `note:*:department` was never satisfied.
    const decision = can(actor('manager'), 'create', {
      type: 'note',
      organizationId: ORG,
      riskTier: 'low',
      ownerId: USER,
    } as never)
    expect(decision.allow).toBe(true)
    expect(can(actor('member'), 'create', {
      type: 'note',
      organizationId: ORG,
      riskTier: 'low',
      ownerId: USER,
    } as never).allow).toBe(true)
  })

  it('lets an administrator move a milestone, which only a manager could', () => {
    for (const verb of ['create', 'update', 'complete']) {
      expect(
        can(actor('admin'), verb, {
          type: 'milestone',
          organizationId: ORG,
          riskTier: 'low',
          ownerId: USER,
        } as never).allow,
        `admin cannot ${verb} a milestone`,
      ).toBe(true)
    }
  })

  it('still refuses what the ladder never granted', () => {
    // The fix widens the rungs against each other, not against nothing: a viewer writes nothing,
    // and a manager does not inherit the administrator's settings.
    expect(can(actor('viewer'), 'create', {
      type: 'task', organizationId: ORG, riskTier: 'low', ownerId: USER,
    } as never).allow).toBe(false)
    expect(can(actor('manager'), 'update', {
      type: 'settings', organizationId: ORG, riskTier: 'low',
    } as never).allow).toBe(false)
    expect(can(actor('member'), 'update', {
      type: 'company', organizationId: ORG, riskTier: 'low',
    } as never).allow).toBe(false)
  })
})
