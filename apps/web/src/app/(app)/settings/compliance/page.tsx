import { requireSession, withActor } from '@/lib/session'
import {
  jurisdictionHistory,
  listLegalEntities,
  PROFILES,
  worksCouncilReview,
  PermissionError,
} from '@superwork/core'
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
    history: Awaited<ReturnType<typeof jurisdictionHistory>>
  } | null = null
  let denied: string | null = null

  try {
    data = await withActor(session, async (ctx, actor) => ({
      review: await worksCouncilReview(ctx, actor),
      entities: await listLegalEntities(ctx, actor),
      history: await jurisdictionHistory(ctx, actor, { limit: 50 }),
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

      {data ? (
        <section className="panel" data-testid="jurisdiction-history">
          <div className="panel-header">
            <h2>Every change to a profile or a consultation</h2>
            <span className="small muted">
              {data.history.length === 0 ? 'Nothing has changed' : `${data.history.length} recorded`}
            </span>
          </div>

          <div className="panel-body">
            <p className="prose small secondary" style={{ margin: 0 }} data-testid="history-note">
              This row is written by the database, in the same statement as the change. There is
              no path — a script, a sync, a migration — that can move a profile or a consultation
              without producing one. A change that arrives without a stated reason is recorded as
              unexplained rather than not recorded, because a change nobody can see is worse than
              one that is visibly unaccounted for.
            </p>
          </div>

          {data.history.length === 0 ? (
            <div className="panel-body">
              <div className="empty small secondary">
                No entity has changed profile or consultation since it was created.
              </div>
            </div>
          ) : (
            <div className="panel-body-flush table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 150 }}>When</th>
                    <th>Entity</th>
                    <th style={{ width: 210 }}>Change</th>
                    <th>Why, and who</th>
                  </tr>
                </thead>
                <tbody>
                  {data.history.map((change) => (
                    <tr key={change.id} data-testid="history-row">
                      <td className="small secondary">{change.changedAt.toISOString().slice(0, 16).replace('T', ' ')}</td>
                      <td className="small">{change.entityName}</td>
                      <td className="small secondary">
                        <span className={change.loosening ? 'chip chip-critical' : 'chip'}>
                          {change.changeKind === 'profile' ? (change.loosening ? 'loosened' : 'tightened') : 'consultation'}
                        </span>{' '}
                        {change.fromState.replace(/_/g, ' ')} → {change.toState.replace(/_/g, ' ')}
                      </td>
                      <td className="small secondary">
                        {change.justified ? (
                          change.justification
                        ) : (
                          <span className="chip chip-critical" data-testid="history-unexplained">
                            no reason stated
                          </span>
                        )}
                        <div className="small muted">
                          {change.changedByName ?? 'unknown'}
                          {change.approvedByName ? ` · approved by ${change.approvedByName}` : ''}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </div>
  )
}
