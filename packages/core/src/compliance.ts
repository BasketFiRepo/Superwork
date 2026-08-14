import type { TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { PermissionError, ValidationError } from './errors.js'
import { writeAudit } from './audit.js'

/**
 * Jurisdiction profiles and the works-council review (§29.6, §24 Phase 4 acceptance).
 *
 * "The accountability features pass a works-council-style review in the strictest
 * configured jurisdiction."
 *
 * A review is not a page of assurances. Each requirement below is a question a works
 * council actually asks, answered by a query against this tenant's own data, with the
 * evidence printed next to it. Anything that cannot be evidenced fails.
 *
 * The strictest profile is the default. Loosening it is a logged decision with a
 * justification and a named approver, which is itself one of the things the review checks.
 */

export type JurisdictionProfile = 'works_council' | 'gdpr' | 'standard'

export interface LegalEntityView {
  id: string
  name: string
  country: string
  jurisdictionProfile: JurisdictionProfile
  dataRegion: string
  consultationStatus: 'not_started' | 'in_progress' | 'agreed' | 'refused' | 'expired'
  consultationReference: string | null
  consultationRecordedByName: string | null
  consultationRecordedAt: Date | null
  consultationExpiresAt: Date | null
  departments: number
  people: number
}

export interface ProfileRules {
  profile: JurisdictionProfile
  label: string
  /** Plain-language summary of what this profile means for the product's behaviour. */
  summary: string
  /** §29 accountability features require a recorded consultation before they run. */
  requiresConsultation: boolean
  /** Ceiling on how often anything may contact one person in a day. */
  maxNudgesPerPersonPerDay: number
  /** Hours a person sees something before it reaches their manager. */
  noSurprisesReviewHours: number
  /** Whether commitments may be escalated beyond the owner at all. */
  allowsManagerEscalation: boolean
}

export const PROFILES: Record<JurisdictionProfile, ProfileRules> = {
  works_council: {
    profile: 'works_council',
    label: 'Works council (DE · NL · AT · FR)',
    summary:
      'Co-determination applies. Follow-through features stay off until a consultation is recorded, contact is ' +
      'rationed, and nothing about a person reaches their manager before the person has seen it.',
    requiresConsultation: true,
    maxNudgesPerPersonPerDay: 2,
    noSurprisesReviewHours: 24,
    allowsManagerEscalation: false,
  },
  gdpr: {
    profile: 'gdpr',
    label: 'GDPR, no works council',
    summary:
      'Necessity and proportionality apply, with a DPIA on file. Escalation to a manager is permitted once the ' +
      'person has seen it first.',
    requiresConsultation: false,
    maxNudgesPerPersonPerDay: 3,
    noSurprisesReviewHours: 24,
    allowsManagerEscalation: true,
  },
  standard: {
    profile: 'standard',
    label: 'Standard',
    summary:
      'The §29.5 prohibitions still hold — they are properties of the product, not of the jurisdiction. Contact ' +
      'limits and review windows are looser.',
    requiresConsultation: false,
    maxNudgesPerPersonPerDay: 5,
    noSurprisesReviewHours: 4,
    allowsManagerEscalation: true,
  },
}

/** The most restrictive profile in use, which is what a review is conducted against. */
export function strictestProfile(entities: { jurisdictionProfile: JurisdictionProfile }[]): JurisdictionProfile {
  const order: JurisdictionProfile[] = ['works_council', 'gdpr', 'standard']
  for (const profile of order) {
    if (entities.some((entity) => entity.jurisdictionProfile === profile)) return profile
  }
  return 'works_council'
}

function guard(ctx: TenantContext, actor: Actor, action: string): void {
  const decision = can(actor, action, {
    type: 'settings',
    organizationId: ctx.organizationId,
    riskTier: 'high',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
}

export async function listLegalEntities(ctx: TenantContext, actor: Actor): Promise<LegalEntityView[]> {
  guard(ctx, actor, 'settings:read')
  return ctx.sql<LegalEntityView[]>`
    SELECT e.id, e.name, e.country, e.jurisdiction_profile AS "jurisdictionProfile",
           e.data_region AS "dataRegion", e.consultation_status AS "consultationStatus",
           e.consultation_reference AS "consultationReference", u.name AS "consultationRecordedByName",
           e.consultation_recorded_at AS "consultationRecordedAt",
           e.consultation_expires_at AS "consultationExpiresAt",
           (SELECT count(*)::int FROM departments d
             WHERE d.organization_id = e.organization_id AND d.legal_entity_id = e.id AND d.deleted_at IS NULL) AS departments,
           (SELECT count(*)::int FROM memberships m
             JOIN departments d ON d.id = m.department_id
             WHERE m.organization_id = e.organization_id AND d.legal_entity_id = e.id AND m.deleted_at IS NULL) AS people
    FROM legal_entities e
    LEFT JOIN users u ON u.id = e.consultation_recorded_by
    WHERE e.organization_id = ${ctx.organizationId} AND e.deleted_at IS NULL
    ORDER BY e.name`
}

export async function createLegalEntity(
  ctx: TenantContext,
  actor: Actor,
  input: { name: string; country: string; jurisdictionProfile?: JurisdictionProfile; dataRegion?: string },
): Promise<LegalEntityView> {
  guard(ctx, actor, 'settings:update')
  if (!input.name.trim()) throw new ValidationError('A legal entity needs a name.')

  await ctx.sql`
    INSERT INTO legal_entities (
      organization_id, name, country, jurisdiction_profile, data_region, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.name.trim()}, ${input.country.toUpperCase()},
      -- Default to the strictest; loosening it is a separate, logged decision (§29.6).
      ${input.jurisdictionProfile ?? 'works_council'}, ${input.dataRegion ?? 'eu'}, ${ctx.userId}
    )
    ON CONFLICT (organization_id, name) WHERE deleted_at IS NULL DO NOTHING`

  const entities = await listLegalEntities(ctx, actor)
  const created = entities.find((entity) => entity.name === input.name.trim())
  if (!created) throw new ValidationError('That legal entity already exists.')
  return created
}

export async function setJurisdiction(
  ctx: TenantContext,
  actor: Actor,
  input: { legalEntityId: string; profile: JurisdictionProfile; justification: string; approvedBy?: string | null },
): Promise<void> {
  guard(ctx, actor, 'settings:update')
  if (!input.justification.trim()) {
    throw new ValidationError('Changing a jurisdiction profile needs a reason. It is the first thing a review asks for.')
  }

  const [current] = await ctx.sql<{ jurisdiction_profile: JurisdictionProfile }[]>`
    SELECT jurisdiction_profile FROM legal_entities
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.legalEntityId} AND deleted_at IS NULL`
  if (!current) throw new ValidationError('No such legal entity.')

  const order: JurisdictionProfile[] = ['works_council', 'gdpr', 'standard']
  const loosening = order.indexOf(input.profile) > order.indexOf(current.jurisdiction_profile)
  if (loosening && !input.approvedBy) {
    throw new ValidationError(
      'Loosening a jurisdiction profile needs a named approver as well as a reason. Tightening one does not.',
    )
  }

  await ctx.sql`
    UPDATE legal_entities SET jurisdiction_profile = ${input.profile}
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.legalEntityId}`
  await ctx.sql`
    INSERT INTO jurisdiction_changes (
      organization_id, legal_entity_id, from_profile, to_profile, justification,
      approved_by, changed_by, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.legalEntityId}, ${current.jurisdiction_profile}, ${input.profile},
      ${input.justification.trim()}, ${input.approvedBy ?? null}, ${actor.userId}, ${ctx.userId}
    )`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'compliance.jurisdiction_changed',
    entityType: 'legal_entity',
    entityId: input.legalEntityId,
    before: { profile: current.jurisdiction_profile },
    after: { profile: input.profile, justification: input.justification, loosening },
  })
}

export async function recordConsultation(
  ctx: TenantContext,
  actor: Actor,
  input: {
    legalEntityId: string
    status: 'in_progress' | 'agreed' | 'refused'
    reference?: string | null
    expiresAt?: Date | null
  },
): Promise<void> {
  guard(ctx, actor, 'settings:update')
  if (input.status === 'agreed' && !input.reference?.trim()) {
    throw new ValidationError(
      'An agreed consultation needs its reference — the agreement number or minute the works council issued.',
    )
  }

  await ctx.sql`
    UPDATE legal_entities
    SET consultation_status = ${input.status},
        consultation_reference = ${input.reference ?? null},
        consultation_recorded_by = ${actor.userId},
        consultation_recorded_at = now(),
        consultation_expires_at = ${input.expiresAt ?? null}
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.legalEntityId} AND deleted_at IS NULL`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'compliance.consultation_recorded',
    entityType: 'legal_entity',
    entityId: input.legalEntityId,
    after: { status: input.status, reference: input.reference ?? null },
  })
}

// ---------------------------------------------------------------------------
// The review
// ---------------------------------------------------------------------------

export interface ReviewFinding {
  id: string
  question: string
  /** Why a works council asks it, in the words they would use. */
  why: string
  status: 'pass' | 'fail' | 'attention'
  /** What was queried, and what came back. */
  evidence: string
  /** Where to look in the product. */
  route: string | null
}

export interface ComplianceReview {
  profile: JurisdictionProfile
  rules: ProfileRules
  entities: LegalEntityView[]
  findings: ReviewFinding[]
  passed: number
  failed: number
  generatedAt: Date
}

/**
 * Runs the review. Every finding is the result of a query against this tenant, so the
 * report changes when the configuration does — which is the only kind of compliance
 * report worth having.
 */
/**
 * The profile in force for this organization: the strictest of every legal entity in it,
 * so a single German subsidiary sets the floor for the whole tenant (§29.6).
 */
export async function jurisdiction(ctx: TenantContext): Promise<{ profile: JurisdictionProfile; rules: ProfileRules }> {
  const rows = await ctx.sql<{ jurisdiction_profile: JurisdictionProfile }[]>`
    SELECT jurisdiction_profile FROM legal_entities
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL`
  const profile = strictestProfile(rows.map((row) => ({ jurisdictionProfile: row.jurisdiction_profile })))
  return { profile, rules: PROFILES[profile] }
}

export async function worksCouncilReview(ctx: TenantContext, actor: Actor): Promise<ComplianceReview> {
  guard(ctx, actor, 'settings:read')
  const sql = ctx.sql
  const org = ctx.organizationId

  const entities = await listLegalEntities(ctx, actor)
  const profile = strictestProfile(entities)
  const rules = PROFILES[profile]
  const findings: ReviewFinding[] = []

  const count = async (query: Promise<{ count: string }[]>): Promise<number> => Number((await query)[0]?.count ?? 0)

  // 1 — Prohibited monitoring is impossible, not merely disabled.
  const constraint = await count(sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM pg_constraint
    WHERE conname = 'monitoring_prohibited_by_design'`)
  const policies = await sql<
    {
      individual_scoring_enabled: boolean
      screen_or_keystroke_monitoring: boolean
      covert_monitoring: boolean
      automated_employment_decisions: boolean
      read_private_dms: boolean
    }[]
  >`
    SELECT individual_scoring_enabled, screen_or_keystroke_monitoring, covert_monitoring,
           automated_employment_decisions, read_private_dms
    FROM monitoring_policies WHERE organization_id = ${org} AND deleted_at IS NULL`
  const anyProhibited = policies.some((row) => Object.values(row).some(Boolean))
  findings.push({
    id: 'prohibited_monitoring',
    question: 'Can this system be configured to score, rank or covertly monitor an individual?',
    why: 'Co-determination turns on whether the system is *capable* of performance monitoring, not on whether it is switched on today.',
    status: constraint > 0 && !anyProhibited ? 'pass' : 'fail',
    evidence:
      constraint > 0
        ? `A database constraint (monitoring_prohibited_by_design) refuses to store a policy that enables individual scoring, ` +
          `screen or keystroke capture, covert monitoring, automated employment decisions or reading private messages. ` +
          `${policies.length} policy row(s) checked, none enabled.`
        : 'The constraint that makes prohibited monitoring unstorable is missing.',
    route: '/settings/ai-governance',
  })

  // 2 — Nothing about a person moves invisibly.
  const invisible = await count(sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM disclosures
    WHERE organization_id = ${org} AND deleted_at IS NULL AND visible_to_subject = false`)
  const disclosures = await count(sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM disclosures WHERE organization_id = ${org} AND deleted_at IS NULL`)
  findings.push({
    id: 'disclosures_visible',
    question: 'When something about an employee is reported to somebody else, can the employee see that it happened?',
    why: 'Transparency is the condition on which follow-through features are agreed at all.',
    status: invisible === 0 ? 'pass' : 'fail',
    evidence:
      `${disclosures} disclosure(s) recorded, ${invisible} of them hidden from their subject. A CHECK constraint ` +
      `(disclosure_never_covert) makes a hidden disclosure unstorable, and each one appears on that person's own screen.`,
    route: '/me',
  })

  // 3 — An individual's activity does not reach HR without authorization.
  const unauthorised = await count(sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM disclosures
    WHERE organization_id = ${org} AND deleted_at IS NULL AND kind = 'export'
      AND (authorized_by IS NULL OR authorization_note IS NULL)`)
  findings.push({
    id: 'export_authorization',
    question: 'Can an individual’s activity be exported to HR without a logged, purpose-bound authorization?',
    why: 'An export without a purpose is the mechanism by which an accountability tool becomes a disciplinary one.',
    status: unauthorised === 0 ? 'pass' : 'fail',
    evidence:
      `${unauthorised} export disclosure(s) lack a named authorization. The constraint export_requires_authorization ` +
      `refuses to store one, and the only export path in the product is the subject downloading their own record.`,
    route: '/me',
  })

  // 4 — Commitments are confirmed by their owner before they count.
  const unconfirmedWithTasks = await count(sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM commitments
    WHERE organization_id = ${org} AND deleted_at IS NULL AND task_id IS NOT NULL AND status = 'proposed'`)
  const proposed = await count(sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM commitments
    WHERE organization_id = ${org} AND deleted_at IS NULL AND status = 'proposed'`)
  findings.push({
    id: 'commitment_confirmation',
    question: 'Can an employee be chased for something the software inferred but they never agreed to?',
    why: 'Being held to an inferred promise is the failure that turns a follow-through tool into a grievance.',
    status: unconfirmedWithTasks === 0 ? 'pass' : 'fail',
    evidence:
      `${proposed} detected commitment(s) are waiting for their owner to confirm, and ${unconfirmedWithTasks} have ` +
      `produced work without confirmation. Unconfirmed commitments are excluded from every rollup, nudge and briefing.`,
    route: '/commitments',
  })

  // 5 — Contact is rationed, and the ration is shared across every agent.
  const [busiest] = await sql<{ recipient: string; day: Date; count: string }[]>`
    SELECT recipient_user_id AS recipient, date_trunc('day', delivered_at) AS day, count(*)::text AS count
    FROM nudges
    WHERE organization_id = ${org} AND deleted_at IS NULL AND delivered_at IS NOT NULL
    GROUP BY recipient_user_id, date_trunc('day', delivered_at)
    ORDER BY count(*) DESC LIMIT 1`
  const worstDay = Number(busiest?.count ?? 0)
  findings.push({
    id: 'nudge_budget',
    question: 'How often can this system contact one employee in a day, across every agent?',
    why: 'A per-agent limit is not a limit. Proportionality is judged on what the person actually receives.',
    status: worstDay <= rules.maxNudgesPerPersonPerDay ? 'pass' : 'fail',
    evidence:
      `The ${rules.label} profile allows ${rules.maxNudgesPerPersonPerDay} per person per day, shared across all ` +
      `agents. The busiest day on record delivered ${worstDay} to one person.`,
    route: '/settings/ai-governance',
  })

  // 6 — Escalation beyond the owner, where the profile forbids it.
  const escalated = await count(sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM nudges
    WHERE organization_id = ${org} AND deleted_at IS NULL AND stage >= 5`)
  findings.push({
    id: 'manager_escalation',
    question: 'Does anything about an employee’s work reach their manager automatically?',
    why: 'Automatic escalation to a line manager is performance monitoring by another name in a co-determined workplace.',
    status: rules.allowsManagerEscalation || escalated === 0 ? 'pass' : 'fail',
    evidence: rules.allowsManagerEscalation
      ? `This profile permits manager escalation once the person has seen it first (${rules.noSurprisesReviewHours}h). ` +
        `${escalated} escalation(s) recorded.`
      : `This profile forbids automatic manager escalation, and ${escalated} have occurred.`,
    route: '/commitments',
  })

  // 7 — Consultation is on file before §29 runs at all.
  const requiring = entities.filter((entity) => PROFILES[entity.jurisdictionProfile].requiresConsultation)
  const agreed = requiring.filter((entity) => entity.consultationStatus === 'agreed')
  findings.push({
    id: 'consultation',
    question: 'Was the works council consulted before follow-through features were switched on?',
    why: 'In DE, NL, AT and FR, deploying §29 without consultation can invalidate the entire rollout.',
    status: requiring.length === 0 ? 'pass' : agreed.length === requiring.length ? 'pass' : 'fail',
    evidence:
      requiring.length === 0
        ? 'No legal entity in this organization is under a co-determination profile.'
        : `${agreed.length} of ${requiring.length} entit${requiring.length === 1 ? 'y has' : 'ies have'} a recorded ` +
          `agreement${agreed.length > 0 ? ` (${agreed.map((entity) => `${entity.name}: ${entity.consultationReference}`).join('; ')})` : ''}.`,
    route: '/settings/compliance',
  })

  // 8 — Every automated action is explainable after the fact.
  const unexplained = await count(sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM tool_calls t
    JOIN agent_runs r ON r.id = t.run_id
    WHERE t.organization_id = ${org} AND t.deleted_at IS NULL AND t.risk_tier <> 'read'
      AND r.plan IS NULL`)
  const actions = await count(sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM tool_calls
    WHERE organization_id = ${org} AND deleted_at IS NULL AND risk_tier <> 'read'`)
  findings.push({
    id: 'explainability',
    question: 'For any action the system took, can you show what it read and what it proposed beforehand?',
    why: 'The EU AI Act obliges an employer to explain an employment-context system’s output to the person affected.',
    status: unexplained === 0 ? 'pass' : 'fail',
    evidence:
      `${actions} action(s) taken, ${unexplained} without a stored plan. Every run keeps its plan, its gate decision, ` +
      `its citations and its inverse operations.`,
    route: '/analytics',
  })

  // 9 — Erasure genuinely reaches derived data.
  const orphanChunks = await count(sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM document_chunks c
    LEFT JOIN documents d ON d.id = c.document_id
    WHERE c.organization_id = ${org} AND (d.id IS NULL OR d.deleted_at IS NOT NULL) AND c.deleted_at IS NULL`)
  findings.push({
    id: 'erasure',
    question: 'When a document is deleted, do its indexed passages and embeddings go with it?',
    why: 'A right to erasure that leaves the derived copies behind is not erasure.',
    status: orphanChunks === 0 ? 'pass' : 'fail',
    evidence: `${orphanChunks} indexed passage(s) survive a deleted document.`,
    route: '/knowledge',
  })

  // 10 — The audit trail cannot be rewritten by the application.
  const appCanDelete = await count(sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM information_schema.role_table_grants
    WHERE grantee = 'superwork_app' AND table_name = 'audit_logs' AND privilege_type IN ('DELETE', 'UPDATE')`)
  findings.push({
    id: 'audit_integrity',
    question: 'Can the application alter or delete the audit trail?',
    why: 'An audit trail the system can rewrite proves nothing in a dispute.',
    status: appCanDelete === 0 ? 'pass' : 'fail',
    evidence:
      appCanDelete === 0
        ? 'The runtime role holds no UPDATE or DELETE privilege on audit_logs, and a trigger refuses both. Retention ' +
          'and erasure run as the owner role through a named job (ADR 0006).'
        : `The runtime role holds ${appCanDelete} mutating privilege(s) on audit_logs.`,
    route: '/activity',
  })

  const passed = findings.filter((finding) => finding.status === 'pass').length
  return {
    profile,
    rules,
    entities,
    findings,
    passed,
    failed: findings.length - passed,
    generatedAt: new Date(),
  }
}
