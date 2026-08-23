import { Link } from '@/components/Link'
import { notFound } from 'next/navigation'
import { requireSession, withActor } from '@/lib/session'
import { can } from '@superwork/auth'
import {
  confirmability,
  consentState,
  getMeeting,
  listCommitments,
  listDecisions,
  listParticipants,
  listSegments,
  NotFoundError,
  seriesContext,
} from '@superwork/core'
import { MeetingSummaryPanel } from '@/components/MeetingSummaryPanel'
import { MeetingDecisions } from '@/components/MeetingDecisions'
import { MeetingAttendance } from '@/components/MeetingAttendance'

export const dynamic = 'force-dynamic'

export default async function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params

  try {
    const data = await withActor(session, async (ctx, actor) => {
      const meeting = await getMeeting(ctx, actor, id)
      const decisions = await listDecisions(ctx, actor, { meetingId: id })
      return {
        meeting,
        participants: await listParticipants(ctx, id),
        // The same question `setAttendance` asks, so the panel offers what the repository will
        // accept and names what would work when it will not (ADR 0065).
        recordAttendance: can(actor, 'project:update', {
          type: 'project',
          id: meeting.id,
          organizationId: ctx.organizationId,
          ownerId: meeting.organizerId,
          riskTier: 'low',
        }),
        segments: await listSegments(ctx, id),
        decisions,
        // The same question the repository asks, so the panel offers what it will accept —
        // and names what would work when it will not (ADR 0065).
        confirmable: await confirmability(ctx, actor, decisions),
        commitments: await listCommitments(ctx, actor, { limit: 100 }),
        series: meeting.seriesId ? await seriesContext(ctx, meeting.seriesId) : null,
      }
    })

    const consent = consentState(data.meeting)
    const segmentIds = new Set(data.segments.map((s) => s.id))
    const meetingCommitments = data.commitments.filter((c) => c.sourceSegmentId && segmentIds.has(c.sourceSegmentId))
    const notes = await withActor(session, async (ctx) =>
      ctx.sql<{ body: string; created_at: Date }[]>`
        SELECT body, created_at FROM notes
        WHERE organization_id = ${ctx.organizationId} AND entity_type = 'meeting' AND entity_id = ${id}
          AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    )

    return (
      <div className="stack stack-8">
        <header className="stack stack-3">
          <Link className="small secondary" href="/meetings">
            ← Meetings
          </Link>
          <h1>{data.meeting.title}</h1>
          <div className="row wrap">
            <span className="chip">
              {new Intl.DateTimeFormat('en-GB', {
                timeZone: session.timezone,
                weekday: 'short',
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              }).format(data.meeting.startsAt)}
            </span>
            {data.meeting.companyName ? <span className="chip">{data.meeting.companyName}</span> : null}
            {data.meeting.projectName ? <span className="chip">{data.meeting.projectName}</span> : null}
            <span className="chip">{data.participants.length} participants</span>
            {data.meeting.seriesOrdinal ? (
              <span className="chip">#{data.meeting.seriesOrdinal} in this series</span>
            ) : null}
          </div>
        </header>

        <div className={`banner ${consent.satisfied ? 'banner-accent' : 'banner-attention'}`}>
          <div className="stack stack-2">
            <strong>Recording consent</strong>
            <span>{consent.message}</span>
          </div>
        </div>

        {data.series && data.series.deferrals.length > 0 ? (
          <div className="banner banner-attention">
            <div className="stack stack-2">
              <strong>This series keeps deferring the same thing</strong>
              {data.series.deferrals.map((d) => (
                <span key={d.summary}>
                  &ldquo;{d.summary}&rdquo; — deferred {d.times} times across {data.series!.occurrences} sessions.
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {data.meeting.agenda.length > 0 ? (
          <section className="panel">
            <div className="panel-header">
              <h2>Agenda</h2>
            </div>
            <div className="panel-body stack stack-2">
              {data.meeting.agenda.map((item, index) => (
                <div className="row-tight" key={index}>
                  <span className="small">{item.item}</span>
                  {item.source ? <span className="chip">{item.source}</span> : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <MeetingAttendance
          meetingId={id}
          canRecord={data.recordAttendance.allow}
          refusal={data.recordAttendance.allow ? null : data.recordAttendance.reason}
          hasStarted={data.meeting.startsAt.getTime() <= Date.now()}
          participants={data.participants.map((p) => ({
            id: p.id,
            displayName: p.displayName,
            role: p.role,
            isExternal: p.isExternal,
            attended: p.attended,
            attendedSetByName: p.attendedSetByName,
            attendedSetAt: p.attendedSetAt ? p.attendedSetAt.toISOString() : null,
          }))}
        />

        <MeetingSummaryPanel
          meetingId={id}
          hasTranscript={data.meeting.hasTranscript}
          existingSummary={notes[0]?.body ?? null}
        />

        {data.decisions.length > 0 ? (
          <MeetingDecisions
            decisions={data.decisions.map((d) => ({
              id: d.id,
              summary: d.summary,
              status: d.status,
              confidence: d.confidence,
              confirmedAt: d.confirmedAt ? d.confirmedAt.toISOString() : null,
              confirmedByName: d.confirmedByName,
              fromAgentRun: d.fromAgentRun,
              decidedAt: d.decidedAt.toISOString(),
              canConfirm: data.confirmable[d.id]?.allow ?? false,
              refusal: data.confirmable[d.id]?.reason ?? null,
            }))}
          />
        ) : null}

        {meetingCommitments.length > 0 ? (
          <section className="panel">
            <div className="panel-header">
              <h2>Action items proposed</h2>
              <Link className="btn btn-ghost btn-sm" href="/commitments">
                Open the ledger
              </Link>
            </div>
            <div className="panel-body stack stack-4">
              <p className="small muted">
                These are proposals. Nothing becomes a task, and nobody is chased, until the named
                owner confirms.
              </p>
              {meetingCommitments.map((c) => (
                <div className="spread" key={c.id}>
                  <span className="small">{c.obligation}</span>
                  <div className="row-tight">
                    <span className="chip">{c.direction === 'we_owe' ? 'we owe' : 'they owe'}</span>
                    <span className="chip">{c.ownerName ?? 'no owner yet'}</span>
                    <span className={c.status === 'proposed' ? 'chip chip-attention' : 'chip chip-positive'}>
                      {c.status === 'proposed' ? 'needs confirmation' : c.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="panel">
          <div className="panel-header">
            <h2>Transcript</h2>
            <span className="small muted">{data.segments.length} segments</span>
          </div>
          {data.segments.length === 0 ? (
            <div className="empty small secondary">
              No transcript attached. Attaching one indexes it into company memory.
            </div>
          ) : (
            <div className="panel-body stack stack-4">
              {data.segments.map((segment) => (
                <div
                  className="row"
                  key={segment.id}
                  data-testid="transcript-segment"
                  style={{ alignItems: 'flex-start' }}
                  id={segment.anchor}
                >
                  <span className="trace-time mono" data-testid="segment-anchor" style={{ minWidth: 44 }}>
                    {segment.anchor}
                  </span>
                  <div className="stack stack-1 grow">
                    <span className="micro">
                      {segment.speaker}
                      {segment.speakerUserId ? '' : ' · external'}
                    </span>
                    <span className="small">{segment.text}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    )
  } catch (error) {
    if (error instanceof NotFoundError) notFound()
    throw error
  }
}
