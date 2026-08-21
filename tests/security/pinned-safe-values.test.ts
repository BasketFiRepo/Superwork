import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools } from '@superwork/db'
import { pinnedColumns } from '../../scripts/column-coverage.js'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * A default is not a control (ADR 0072).
 *
 * Three columns the detector reported as "read by the product, written by nothing in it". For
 * each, the answer was not to build a writer — it was to make the safe value the only value,
 * the way `monitoring_policies` already works.
 *
 * A DEFAULT decides what happens when nobody says otherwise and says nothing at all about what
 * happens when somebody does. These use `adminSql()` deliberately: the owner connection is the
 * most privileged writer there is, and a rule that only the repository layer keeps is a rule
 * anything holding a connection can break.
 */

let org: TenantFixture

beforeAll(async () => {
  org = await createTenant('pinned-safe-values')
})

afterAll(async () => {
  await destroyTenant('pinned-safe-values')
  await closePools()
})

describe('a custom tool is never reversible', () => {
  /**
   * `gate.ts` reads this to decide what an agent may do unattended. A `true` here buys an
   * external HTTP call the undo path cannot take back, while the run's own card says it can.
   */
  it('cannot be declared undoable, whatever writes the row', async () => {
    await expect(
      adminSql()`
        INSERT INTO custom_tools (organization_id, name, description, method, url_template, host,
                                  risk_tier, reversible, status, created_by)
        VALUES (${org.organizationId}, 'claims_undo@v1', 'Pretends it can be taken back.', 'POST',
                'https://api.example/undo', 'api.example', 'high', true, 'draft', ${org.ownerId})`,
    ).rejects.toThrow(/custom_tools_never_reversible/i)
  })

  it('and an existing one cannot be edited into claiming it', async () => {
    const [tool] = await adminSql()<{ id: string }[]>`
      INSERT INTO custom_tools (organization_id, name, description, method, url_template, host,
                                risk_tier, status, created_by)
      VALUES (${org.organizationId}, 'honest_tool@v1', 'Says what it is.', 'POST',
              'https://api.example/thing', 'api.example', 'high', 'draft', ${org.ownerId})
      RETURNING id`
    // The default is what it got, because the repository never mentions the column.
    const [row] = await adminSql()<{ reversible: boolean }[]>`
      SELECT reversible FROM custom_tools WHERE id = ${tool!.id}`
    expect(row!.reversible).toBe(false)

    await expect(
      adminSql()`UPDATE custom_tools SET reversible = true WHERE id = ${tool!.id}`,
    ).rejects.toThrow(/custom_tools_never_reversible/i)
  })
})

describe('a simulation is always a simulation', () => {
  it('cannot record that it was not one', async () => {
    const [agent] = await adminSql()<{ id: string }[]>`
      INSERT INTO agents (organization_id, key, name, purpose, owner_user_id, mode, status,
                          tool_grants, max_sensitivity, is_demo, created_by)
      VALUES (${org.organizationId}, 'simulated-subject', 'Rehearsal', 'Rehearses.',
              ${org.ownerId}, 'ask'::sw_agent_mode, 'active', ARRAY['*'], 'internal', true,
              ${org.ownerId})
      RETURNING id`
    await expect(
      adminSql()`
        INSERT INTO agent_simulations (organization_id, agent_id, snapshot, window_from, window_to,
                                       status, simulated, created_by)
        VALUES (${org.organizationId}, ${agent!.id}, '{}'::jsonb, now() - interval '7 days', now(),
                'succeeded', false, ${org.ownerId})`,
    ).rejects.toThrow(/agent_simulations_always_simulated/i)
  })
})

describe('recording consent is always required', () => {
  /**
   * §12.5 requires per-meeting acknowledgement before a transcript may be attached, and
   * `consentState()` short-circuits to satisfied the moment this is false. Turning it off does
   * not skip a formality; it skips the consent regime.
   */
  it('cannot be switched off for a meeting', async () => {
    await expect(
      adminSql()`
        INSERT INTO meetings (organization_id, title, starts_at, ends_at,
                              recording_consent_required, created_by)
        VALUES (${org.organizationId}, 'Recorded quietly', now(), now() + interval '1 hour',
                false, ${org.ownerId})`,
    ).rejects.toThrow(/meetings_consent_always_required/i)
  })

  it('but the jurisdictional dial beside it still turns', async () => {
    // What is pinned is that consent is needed at all. Which parties must give it is a
    // jurisdiction question, and that column stays settable.
    const [row] = await adminSql()<{ mode: string }[]>`
      INSERT INTO meetings (organization_id, title, starts_at, ends_at,
                            recording_consent_mode, created_by)
      VALUES (${org.organizationId}, 'One-party jurisdiction', now(), now() + interval '1 hour',
              'one_party', ${org.ownerId})
      RETURNING recording_consent_mode AS mode`
    expect(row!.mode).toBe('one_party')
  })
})

describe('the detector reads the pins', () => {
  /**
   * The point of a CHECK over a DEFAULT is partly that the instrument can see it. If these did
   * not land in the "pinned by a constraint" list they would sit on the work queue forever,
   * and somebody would eventually build the writer.
   */
  it('so all three leave the queue rather than waiting on a writer', async () => {
    const rows = await adminSql()<{ table: string; definition: string }[]>`
      SELECT pc.relname AS table, pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class pc ON pc.oid = con.conrelid
      JOIN pg_namespace pn ON pn.oid = pc.relnamespace AND pn.nspname = 'public'
      WHERE con.contype = 'c' AND con.conname IN (
        'custom_tools_never_reversible', 'agent_simulations_always_simulated',
        'meetings_consent_always_required')`
    expect(rows).toHaveLength(3)
    const pinned = new Set(
      rows.flatMap((row) => pinnedColumns(row.definition).map((column) => `${row.table}.${column}`)),
    )
    expect(pinned).toContain('custom_tools.reversible')
    expect(pinned).toContain('agent_simulations.simulated')
    expect(pinned).toContain('meetings.recording_consent_required')
  })
})
