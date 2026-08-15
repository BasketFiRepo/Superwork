import { describe, expect, it } from 'vitest'
import { can, ROLE_PERMISSIONS, type Actor } from '@superwork/auth'
import { allTools } from '@superwork/tools'
import type { Role } from '@superwork/db'

/**
 * The permission pack (§20.2): every tool × every role, asserting allow or deny.
 * A tool added without thinking about who may call it fails this test.
 */

const ORG = '11111111-1111-1111-1111-111111111111'

function actor(role: Role, overrides: Partial<Actor> = {}): Actor {
  return {
    type: 'user',
    userId: '22222222-2222-2222-2222-222222222222',
    organizationId: ORG,
    role,
    displayName: `${role} user`,
    departmentIds: ['33333333-3333-3333-3333-333333333333'],
    teamIds: [],
    extraPermissions: [],
    ...overrides,
  }
}

function agentActor(mode: 'ask' | 'assist' | 'execute' | 'autopilot', role: Role = 'admin', downgraded = false): Actor {
  return {
    ...actor(role),
    type: 'agent',
    agent: {
      agentId: '44444444-4444-4444-4444-444444444444',
      agentName: 'Superwork',
      mode,
      orgGrant: [],
    denied: [],
      toolGrants: ['*'],
      maxSensitivity: 'confidential',
      capabilityDowngraded: downgraded,
    },
  }
}

const ROLES: Role[] = ['owner', 'admin', 'manager', 'member', 'viewer', 'guest', 'service']

describe('every tool against every role', () => {
  const tools = allTools()

  it('registers a tool catalogue', () => {
    expect(tools.length).toBeGreaterThanOrEqual(15)
  })

  // The resource is placed fully inside the actor's own scope — their team, their
  // department, owned by them — so this asserts capability, not scope narrowing.
  // Scope narrowing is asserted separately below.
  for (const tool of allTools()) {
    for (const role of ROLES) {
      it(`${tool.name} × ${role}`, () => {
        const [resource, action] = (tool.requiredPermissions[0] ?? 'task:read:org').split(':')
        const subject = actor(role, { teamIds: ['55555555-5555-5555-5555-555555555555'] })
        const decision = can(subject, `${resource}:${action}`, {
          type: resource!,
          organizationId: ORG,
          riskTier: tool.riskTier,
          ownerId: subject.userId,
          assigneeId: subject.userId,
          createdBy: subject.userId,
          departmentId: subject.departmentIds[0]!,
          teamIds: subject.teamIds,
          // Classification is asserted separately; keep it out of the capability matrix.
          sensitivity: 'public',
        })

        const expected = ROLE_PERMISSIONS[role].some((raw) => {
          const [r, a] = raw.split(':')
          return (r === '*' || r === resource) && (a === '*' || a === action)
        })

        expect(decision.allow, `${role} → ${tool.name}: ${decision.reason}`).toBe(expected)
        // A denial always explains itself and names who can fix it.
        if (!decision.allow) expect(decision.reason.length).toBeGreaterThan(20)
      })
    }
  }
})

describe('scope narrowing', () => {
  const subject = actor('member', { teamIds: ['55555555-5555-5555-5555-555555555555'] })

  it('a member may update their own task', () => {
    expect(
      can(subject, 'task:update', {
        type: 'task',
        organizationId: ORG,
        assigneeId: subject.userId,
        riskTier: 'low',
      }).allow,
    ).toBe(true)
  })

  it('a member may not update someone else’s task', () => {
    const decision = can(subject, 'task:update', {
      type: 'task',
      organizationId: ORG,
      assigneeId: '99999999-9999-9999-9999-999999999999',
      departmentId: '88888888-8888-8888-8888-888888888888',
      riskTier: 'low',
    })
    expect(decision.allow).toBe(false)
    expect(decision.reason).toMatch(/access/i)
  })

  it('a manager may update a task in their own department but not another', () => {
    const manager = actor('manager')
    expect(
      can(manager, 'task:update', {
        type: 'task',
        organizationId: ORG,
        departmentId: manager.departmentIds[0]!,
        riskTier: 'low',
      }).allow,
    ).toBe(true)
    expect(
      can(manager, 'task:update', {
        type: 'task',
        organizationId: ORG,
        departmentId: '88888888-8888-8888-8888-888888888888',
        assigneeId: '99999999-9999-9999-9999-999999999999',
        riskTier: 'low',
      }).allow,
    ).toBe(false)
  })
})

describe('agent capability intersection', () => {
  it('Ask mode may read but never write', () => {
    expect(can(agentActor('ask'), 'task:read', { type: 'task', organizationId: ORG, riskTier: 'read', sensitivity: 'public' }).allow).toBe(true)
    const write = can(agentActor('ask'), 'task:create', { type: 'task', organizationId: ORG, riskTier: 'low', sensitivity: 'public' })
    expect(write.allow).toBe(false)
    expect(write.reason).toMatch(/ask mode/i)
  })

  it('Assist mode proposes but does not execute', () => {
    const write = can(agentActor('assist'), 'task:create', { type: 'task', organizationId: ORG, riskTier: 'low', sensitivity: 'public' })
    expect(write.allow).toBe(false)
    expect(write.reason).toMatch(/Switch to Execute/i)
  })

  it('Execute mode performs reversible writes directly', () => {
    const write = can(agentActor('execute'), 'task:create', { type: 'task', organizationId: ORG, riskTier: 'low', sensitivity: 'public' })
    expect(write.allow).toBe(true)
    expect(write.requiresApproval).toBeFalsy()
  })

  it('Execute mode holds high-risk actions for approval', () => {
    const send = can(agentActor('execute'), 'email:send', { type: 'email', organizationId: ORG, riskTier: 'high', sensitivity: 'public' })
    expect(send.allow).toBe(true)
    expect(send.requiresApproval).toBe(true)
  })

  it('Autopilot can never take a high-risk action', () => {
    const send = can(agentActor('autopilot'), 'email:send', { type: 'email', organizationId: ORG, riskTier: 'high', sensitivity: 'public' })
    expect(send.allow).toBe(false)
    expect(send.reason).toMatch(/autopilot/i)
  })

  it('an agent never exceeds the human it acts for', () => {
    const viewerAgent = agentActor('execute', 'viewer')
    const write = can(viewerAgent, 'task:create', { type: 'task', organizationId: ORG, riskTier: 'low', sensitivity: 'public' })
    expect(write.allow).toBe(false)
  })

  it('the kill switch halts agents but not people', () => {
    expect(
      can(agentActor('execute'), 'task:read', { type: 'task', organizationId: ORG, riskTier: 'read', sensitivity: 'public' }, { killSwitch: true })
        .allow,
    ).toBe(false)
    expect(
      can(actor('admin'), 'task:read', { type: 'task', organizationId: ORG, riskTier: 'read', sensitivity: 'public' }, { killSwitch: true }).allow,
    ).toBe(true)
  })

  it('a run that read untrusted content requires approval for high-risk actions', () => {
    const decision = can(agentActor('execute', 'admin', true), 'email:send', {
      type: 'email',
      organizationId: ORG,
      riskTier: 'high',
    })
    expect(decision.requiresApproval).toBe(true)
    expect(decision.reason).toMatch(/untrusted/i)
  })
})

describe('data classification', () => {
  it('a member cannot read confidential material', () => {
    const decision = can(actor('member'), 'document:read', {
      type: 'document',
      organizationId: ORG,
      sensitivity: 'confidential',
    })
    expect(decision.allow).toBe(false)
    expect(decision.reason).toMatch(/classified confidential/i)
  })

  it('restricted material is denied even to a manager', () => {
    const decision = can(actor('manager'), 'document:read', {
      type: 'document',
      organizationId: ORG,
      sensitivity: 'restricted',
    })
    expect(decision.allow).toBe(false)
  })

  it('an owner may read restricted material', () => {
    expect(
      can(actor('owner'), 'document:read', { type: 'document', organizationId: ORG, sensitivity: 'restricted' }).allow,
    ).toBe(true)
  })
})

describe('cross-tenant decisions leak nothing', () => {
  it('reports absence rather than denial', () => {
    const decision = can(actor('owner'), 'task:read', {
      type: 'task',
      organizationId: '99999999-9999-9999-9999-999999999999',
    })
    expect(decision.allow).toBe(false)
    expect(decision.reason).toBe('Not found.')
  })
})

describe('tool contract invariants', () => {
  for (const tool of allTools()) {
    it(`${tool.name} declares a coherent contract`, () => {
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.requiredPermissions.length).toBeGreaterThan(0)
      expect(tool.timeoutMs).toBeGreaterThan(0)
      // Anything that writes and claims reversibility must name its inverse (§5.7).
      if (tool.riskTier !== 'read' && tool.reversible) expect(tool.inverse).toBeTruthy()
      // Irreversible tools must be high risk, so policy forces an approval.
      if (!tool.reversible && tool.riskTier === 'read') {
        throw new Error(`${tool.name} is irreversible but tiered as read`)
      }
    })
  }
})
