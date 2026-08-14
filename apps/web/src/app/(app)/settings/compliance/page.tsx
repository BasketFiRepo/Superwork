import { requireSession, withActor } from '@/lib/session'
import { listLegalEntities, PROFILES, worksCouncilReview, PermissionError } from '@superwork/core'
import { CompliancePanel } from '@/components/CompliancePanel'

export const dynamic = 'force-dynamic'

/**
 * The works-council review (§29.6, §24 Phase 4 acceptance).
 *
 * Every line is the result of a query against this tenant's own data, so the report
 * changes when the configuration does. A page of assurances would pass no review.
 */
export default async function CompliancePage() {
  const session = await requireSession()

  let data: {
    review: Awaited<ReturnType<typeof worksCouncilReview>>
    entities: Awaited<ReturnType<typeof listLegalEntities>>
  } | null = null
  let denied: string | null = null

  try {
    data = await withActor(session, async (ctx, actor) => ({
      review: await worksCouncilReview(ctx, actor),
      entities: await listLegalEntities(ctx, actor),
    }))
  } catch (error) {
    if (error instanceof PermissionError) denied = error.message
    else throw error
  }

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Admin</span>
        <h1>Jurisdiction and review</h1>
        <p className="prose secondary">
          Accountability features are legally constrained, and the constraints differ by
          country. Each entity runs under a profile, the strictest one in use governs the
          review, and every question below is answered by a query rather than a promise.
        </p>
      </header>

      {denied ? (
        <div className="panel">
          <div className="empty small secondary">{denied}</div>
        </div>
      ) : data ? (
        <CompliancePanel
          review={{
            profile: data.review.profile,
            rules: data.review.rules,
            passed: data.review.passed,
            failed: data.review.failed,
            findings: data.review.findings,
            generatedAt: data.review.generatedAt.toISOString(),
          }}
          entities={data.entities.map((entity) => ({
            id: entity.id,
            name: entity.name,
            country: entity.country,
            jurisdictionProfile: entity.jurisdictionProfile,
            consultationStatus: entity.consultationStatus,
            consultationReference: entity.consultationReference,
            consultationRecordedByName: entity.consultationRecordedByName,
            people: entity.people,
          }))}
          profiles={Object.values(PROFILES).map((profile) => ({
            profile: profile.profile,
            label: profile.label,
            summary: profile.summary,
            maxNudgesPerPersonPerDay: profile.maxNudgesPerPersonPerDay,
            allowsManagerEscalation: profile.allowsManagerEscalation,
            requiresConsultation: profile.requiresConsultation,
          }))}
        />
      ) : null}
    </div>
  )
}
