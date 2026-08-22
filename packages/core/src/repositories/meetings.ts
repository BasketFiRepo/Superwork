import type { Sensitivity, TenantContext } from '@superwork/db'
import { asJson } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'
import { link } from '../links.js'
import { canReadProject } from './projects.js'
import { ingestDocument } from '../retrieval/ingest.js'
import { recordIngestion } from '../retrieval/ingestion-queue.js'

/**
 * Meetings and the transcript pipeline (§12.5).
 *
 * Segment timestamps are the citation anchors for everything derived from a meeting, so
 * a decision or an action item can always be traced to the moment it was said. Action
 * items never become tasks blindly — they go through a review step.
 */

export type MeetingStatus = 'scheduled' | 'in_progress' | 'completed' | 'cancelled'

export interface MeetingView {
  id: string
  title: string
  agenda: { item: string; source?: string }[]
  projectId: string | null
  projectName: string | null
  companyId: string | null
  companyName: string | null
  organizerId: string | null
  organizerName: string | null
  startsAt: Date
  endsAt: Date
  timezone: string
  location: string | null
  status: MeetingStatus
  seriesId: string | null
  seriesOrdinal: number | null
  recordingConsentRequired: boolean
  recordingConsentMode: string
  consentGiven: number
  participantCount: number
  hasTranscript: boolean
  decisionCount: number
  createdAt: Date
}

const SELECT_MEETING = (ctx: TenantContext) => ctx.sql`
  SELECT m.id, m.title, m.agenda, m.project_id AS "projectId", p.name AS "projectName",
         m.company_id AS "companyId", c.name AS "companyName",
         m.organizer_id AS "organizerId", u.name AS "organizerName",
         m.starts_at AS "startsAt", m.ends_at AS "endsAt", m.timezone, m.location, m.status,
         m.series_id AS "seriesId", m.series_ordinal AS "seriesOrdinal",
         m.recording_consent_required AS "recordingConsentRequired",
         m.recording_consent_mode AS "recordingConsentMode",
         (SELECT count(*)::int FROM meeting_participants mp
           WHERE mp.meeting_id = m.id AND mp.consented_at IS NOT NULL) AS "consentGiven",
         (SELECT count(*)::int FROM meeting_participants mp
           WHERE mp.meeting_id = m.id AND mp.deleted_at IS NULL) AS "participantCount",
         EXISTS (SELECT 1 FROM transcripts t WHERE t.meeting_id = m.id AND t.deleted_at IS NULL) AS "hasTranscript",
         (SELECT count(*)::int FROM decisions d WHERE d.meeting_id = m.id AND d.deleted_at IS NULL) AS "decisionCount",
         m.created_at AS "createdAt"
  FROM meetings m
  LEFT JOIN projects p ON p.id = m.project_id
  LEFT JOIN companies c ON c.id = m.company_id
  LEFT JOIN users u ON u.id = m.organizer_id`

export async function listMeetings(
  ctx: TenantContext,
  actor: Actor,
  filter: { from?: Date; to?: Date; projectId?: string; companyId?: string; limit?: number } = {},
): Promise<MeetingView[]> {
  const decision = can(actor, 'project:read', { type: 'project', organizationId: ctx.organizationId })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const sql = ctx.sql
  return sql<MeetingView[]>`
    ${SELECT_MEETING(ctx)}
    WHERE m.organization_id = ${ctx.organizationId} AND m.deleted_at IS NULL
      ${filter.from ? sql`AND m.starts_at >= ${filter.from}` : sql``}
      ${filter.to ? sql`AND m.starts_at <= ${filter.to}` : sql``}
      ${filter.projectId ? sql`AND m.project_id = ${filter.projectId}` : sql``}
      ${filter.companyId ? sql`AND m.company_id = ${filter.companyId}` : sql``}
    ORDER BY m.starts_at DESC
    LIMIT ${Math.min(filter.limit ?? 50, 200)}`
}

export async function getMeeting(ctx: TenantContext, actor: Actor, id: string): Promise<MeetingView> {
  const [row] = await ctx.sql<MeetingView[]>`
    ${SELECT_MEETING(ctx)}
    WHERE m.organization_id = ${ctx.organizationId} AND m.id = ${id} AND m.deleted_at IS NULL`
  if (!row) throw new NotFoundError()

  const decision = can(actor, 'project:read', {
    type: 'project',
    id: row.id,
    organizationId: ctx.organizationId,
    ownerId: row.organizerId,
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  return row
}

export interface ParticipantView {
  id: string
  displayName: string
  userId: string | null
  contactId: string | null
  role: string
  attended: boolean | null
  consentedAt: Date | null
  isExternal: boolean
}

export async function listParticipants(ctx: TenantContext, meetingId: string): Promise<ParticipantView[]> {
  return ctx.sql<ParticipantView[]>`
    SELECT id, display_name AS "displayName", user_id AS "userId", contact_id AS "contactId",
           role, attended, consented_at AS "consentedAt", (user_id IS NULL) AS "isExternal"
    FROM meeting_participants
    WHERE organization_id = ${ctx.organizationId} AND meeting_id = ${meetingId} AND deleted_at IS NULL
    ORDER BY (user_id IS NULL), display_name`
}

export interface CreateMeetingInput {
  title: string
  startsAt: Date
  endsAt: Date
  timezone?: string
  projectId?: string | null
  companyId?: string | null
  location?: string | null
  agenda?: { item: string; source?: string }[]
  participants?: { userId?: string; contactId?: string; displayName: string; role?: string }[]
  seriesId?: string | null
  seriesOrdinal?: number | null
  recordingConsentMode?: 'all_parties' | 'one_party'
  agentRunId?: string | null
}

export async function createMeeting(ctx: TenantContext, actor: Actor, input: CreateMeetingInput): Promise<MeetingView> {
  const decision = can(actor, 'project:update', {
    type: 'project',
    organizationId: ctx.organizationId,
    riskTier: 'high', // Creating a meeting sends invitations — externally visible.
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  if (input.endsAt <= input.startsAt) throw new ValidationError('A meeting has to end after it starts.')

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO meetings (
      organization_id, title, agenda, project_id, company_id, organizer_id,
      starts_at, ends_at, timezone, location, status, series_id, series_ordinal,
      recording_consent_mode, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.title}, ${ctx.sql.json(asJson(input.agenda ?? []))},
      ${input.projectId ?? null}, ${input.companyId ?? null}, ${actor.userId},
      ${input.startsAt}, ${input.endsAt}, ${input.timezone ?? ctx.timezone},
      ${input.location ?? null}, 'scheduled', ${input.seriesId ?? null}, ${input.seriesOrdinal ?? null},
      ${input.recordingConsentMode ?? 'all_parties'}, ${ctx.userId}
    ) RETURNING id`

  const id = row!.id

  for (const participant of input.participants ?? []) {
    await ctx.sql`
      INSERT INTO meeting_participants (
        organization_id, meeting_id, user_id, contact_id, display_name, role, created_by
      ) VALUES (
        ${ctx.organizationId}, ${id}, ${participant.userId ?? null}, ${participant.contactId ?? null},
        ${participant.displayName}, ${participant.role ?? 'attendee'}, ${ctx.userId}
      )`
  }

  if (input.projectId) await link(ctx, { type: 'meeting', id }, { type: 'project', id: input.projectId }, 'relates_to')
  if (input.companyId) await link(ctx, { type: 'meeting', id }, { type: 'company', id: input.companyId }, 'relates_to')

  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.agent?.agentName ?? actor.displayName,
    verb: 'scheduled',
    entityType: 'meeting',
    entityId: id,
    entityLabel: input.title,
    summary: `Scheduled "${input.title}"`,
    agentRunId: input.agentRunId ?? null,
  })

  return getMeeting(ctx, actor, id)
}

/** Recording requires per-meeting acknowledgement; some jurisdictions require everyone's. */
export async function recordConsent(
  ctx: TenantContext,
  actor: Actor,
  meetingId: string,
  participantId: string,
): Promise<void> {
  await getMeeting(ctx, actor, meetingId)
  await ctx.sql`
    UPDATE meeting_participants SET consented_at = now()
    WHERE organization_id = ${ctx.organizationId} AND meeting_id = ${meetingId} AND id = ${participantId}`
  await writeAudit(ctx, {
    actorType: 'user',
    actorId: actor.userId,
    action: 'meeting.consent',
    entityType: 'meeting',
    entityId: meetingId,
    after: { participantId, consentedAt: new Date().toISOString() },
  })
}

export interface ConsentState {
  required: boolean
  mode: string
  given: number
  total: number
  satisfied: boolean
  message: string
}

export function consentState(meeting: MeetingView): ConsentState {
  const satisfied =
    !meeting.recordingConsentRequired ||
    (meeting.recordingConsentMode === 'all_parties'
      ? meeting.consentGiven >= meeting.participantCount && meeting.participantCount > 0
      : meeting.consentGiven >= 1)

  return {
    required: meeting.recordingConsentRequired,
    mode: meeting.recordingConsentMode,
    given: meeting.consentGiven,
    total: meeting.participantCount,
    satisfied,
    message: satisfied
      ? 'Consent recorded. This meeting may be transcribed.'
      : meeting.recordingConsentMode === 'all_parties'
        ? `This jurisdiction requires every participant to consent. ${meeting.consentGiven} of ${meeting.participantCount} have.`
        : 'At least one participant must acknowledge recording before a transcript can be attached.',
  }
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

export interface TranscriptSegmentInput {
  speaker: string
  speakerUserId?: string | null
  startsAtSeconds: number
  endsAtSeconds?: number | null
  text: string
}

export interface TranscriptView {
  id: string
  meetingId: string
  source: string
  durationSeconds: number | null
  documentId: string | null
  processedAt: Date | null
  segmentCount: number
}

/**
 * Attaching a transcript ingests it into company memory as a document, so meeting
 * content is retrievable and citable alongside everything else.
 */
export async function attachTranscript(
  ctx: TenantContext,
  actor: Actor,
  input: { meetingId: string; source?: string; segments: TranscriptSegmentInput[] },
): Promise<TranscriptView> {
  const meeting = await getMeeting(ctx, actor, input.meetingId)

  const decision = can(actor, 'document:create', {
    type: 'document',
    organizationId: ctx.organizationId,
    // The transcript's document is owned by whoever attaches it, so that is the resource the
    // check is about — the same omission `uploadDocument` had (ADR 0045).
    ownerId: actor.userId,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const consent = consentState(meeting)
  if (!consent.satisfied) {
    throw new ValidationError(consent.message)
  }
  if (input.segments.length === 0) throw new ValidationError('A transcript needs at least one segment.')

  const duration = Math.max(...input.segments.map((s) => s.endsAtSeconds ?? s.startsAtSeconds))

  const [transcriptRow] = await ctx.sql<{ id: string }[]>`
    INSERT INTO transcripts (organization_id, meeting_id, source, duration_seconds, created_by)
    VALUES (${ctx.organizationId}, ${input.meetingId}, ${input.source ?? 'upload'}, ${duration}, ${ctx.userId})
    ON CONFLICT (meeting_id) WHERE deleted_at IS NULL DO UPDATE SET duration_seconds = EXCLUDED.duration_seconds
    RETURNING id`
  const transcriptId = transcriptRow!.id

  await ctx.sql`DELETE FROM transcript_segments WHERE organization_id = ${ctx.organizationId} AND transcript_id = ${transcriptId}`

  for (const [index, segment] of input.segments.entries()) {
    await ctx.sql`
      INSERT INTO transcript_segments (
        organization_id, transcript_id, ordinal, speaker, speaker_user_id,
        starts_at_seconds, ends_at_seconds, text, trust_level, created_by
      ) VALUES (
        ${ctx.organizationId}, ${transcriptId}, ${index}, ${segment.speaker},
        ${segment.speakerUserId ?? null}, ${segment.startsAtSeconds}, ${segment.endsAtSeconds ?? null},
        ${segment.text}, ${segment.speakerUserId ? 'org_data' : 'untrusted_external'}, ${ctx.userId}
      )`
  }

  // Ingest as a document so the transcript is searchable and citable.
  const markdown = [
    `# ${meeting.title}`,
    '',
    `Meeting on ${meeting.startsAt.toISOString().slice(0, 10)}.`,
    '',
    ...input.segments.map((s) => `## ${formatTimestamp(s.startsAtSeconds)} — ${s.speaker}\n\n${s.text}`),
  ].join('\n')

  const [docRow] = await ctx.sql<{ id: string }[]>`
    INSERT INTO documents (
      organization_id, title, doc_type, source, company_id, project_id, owner_id,
      sensitivity, index_status, created_by
    ) VALUES (
      ${ctx.organizationId}, ${`Transcript — ${meeting.title}`}, 'transcript', 'transcript',
      ${meeting.companyId}, ${meeting.projectId}, ${actor.userId}, 'internal', 'pending', ${ctx.userId}
    ) RETURNING id`

  const transcriptIngest = await ingestDocument(ctx, {
    documentId: docRow!.id,
    body: markdown,
    title: `Transcript — ${meeting.title}`,
    docType: 'transcript',
    companyId: meeting.companyId,
    projectId: meeting.projectId,
    ownerId: actor.userId,
    // Participant speech includes external voices; scan it like any untrusted source.
    untrusted: input.segments.some((s) => !s.speakerUserId),
  })
  await recordIngestion(ctx, {
    documentId: docRow!.id,
    reason: `Transcript of “${meeting.title}”`,
    result: transcriptIngest,
  })

  await ctx.sql`
    UPDATE transcripts SET document_id = ${docRow!.id}, processed_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${transcriptId}`
  await ctx.sql`
    UPDATE meetings SET status = 'completed'
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.meetingId} AND status <> 'cancelled'`

  await link(ctx, { type: 'document', id: docRow!.id }, { type: 'meeting', id: input.meetingId }, 'derived_from')

  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.agent?.agentName ?? actor.displayName,
    verb: 'attached a transcript to',
    entityType: 'meeting',
    entityId: input.meetingId,
    entityLabel: meeting.title,
    summary: `Attached a ${input.segments.length}-segment transcript to "${meeting.title}" and indexed it into company memory.`,
  })

  return {
    id: transcriptId,
    meetingId: input.meetingId,
    source: input.source ?? 'upload',
    durationSeconds: duration,
    documentId: docRow!.id,
    processedAt: new Date(),
    segmentCount: input.segments.length,
  }
}

export interface SegmentView {
  id: string
  ordinal: number
  speaker: string
  speakerUserId: string | null
  startsAtSeconds: number
  endsAtSeconds: number | null
  text: string
  anchor: string
  trustLevel: string
}

export async function listSegments(ctx: TenantContext, meetingId: string): Promise<SegmentView[]> {
  const rows = await ctx.sql<Omit<SegmentView, 'anchor'>[]>`
    SELECT s.id, s.ordinal, s.speaker, s.speaker_user_id AS "speakerUserId",
           s.starts_at_seconds AS "startsAtSeconds", s.ends_at_seconds AS "endsAtSeconds",
           s.text, s.trust_level AS "trustLevel"
    FROM transcript_segments s
    JOIN transcripts t ON t.id = s.transcript_id
    WHERE s.organization_id = ${ctx.organizationId} AND t.meeting_id = ${meetingId} AND s.deleted_at IS NULL
    ORDER BY s.ordinal`
  return rows.map((row) => ({ ...row, anchor: formatTimestamp(row.startsAtSeconds) }))
}

export function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export interface DecisionView {
  id: string
  summary: string
  rationale: string | null
  rejectedAlternatives: string[]
  status: string
  decidedBy: string | null
  decidedByName: string | null
  decidedAt: Date
  meetingId: string | null
  meetingTitle: string | null
  projectId: string | null
  sourceSegmentId: string | null
  sourceAnchor: string | null
  /** Who stood behind it, and when. Written by nothing until ADR 0065. */
  confirmedAt: Date | null
  confirmedBy: string | null
  confirmedByName: string | null
  confidence: number | null
  /** Whether the assistant extracted it from a transcript, rather than a person writing it. */
  fromAgentRun: boolean
}

/**
 * A decision row plus the project fields the read gate needs. The project is the only
 * container a decision has and the only classification available to it — `decisions` carries
 * no `sensitivity` of its own, and neither does `meetings`.
 */
type DecisionRow = DecisionView & {
  projectOwnerId: string | null
  projectCreatedBy: string | null
  projectDepartmentId: string | null
  projectTeamId: string | null
  projectSensitivity: Sensitivity | null
}

const SELECT_DECISION = (ctx: TenantContext) => ctx.sql`
  SELECT d.id, d.summary, d.rationale, d.rejected_alternatives AS "rejectedAlternatives",
         d.status, d.decided_by AS "decidedBy", u.name AS "decidedByName", d.decided_at AS "decidedAt",
         d.meeting_id AS "meetingId", m.title AS "meetingTitle", d.project_id AS "projectId",
         d.source_segment_id AS "sourceSegmentId",
         s.starts_at_seconds::text AS "sourceAnchor",
         d.confirmed_at AS "confirmedAt", d.confirmed_by AS "confirmedBy",
         cu.name AS "confirmedByName", d.confidence,
         (d.agent_run_id IS NOT NULL) AS "fromAgentRun",
         p.owner_id AS "projectOwnerId", p.created_by AS "projectCreatedBy",
         p.department_id AS "projectDepartmentId", p.team_id AS "projectTeamId",
         p.sensitivity AS "projectSensitivity"
  FROM decisions d
  LEFT JOIN users u ON u.id = d.decided_by
  LEFT JOIN users cu ON cu.id = d.confirmed_by
  LEFT JOIN meetings m ON m.id = d.meeting_id
  LEFT JOIN transcript_segments s ON s.id = d.source_segment_id
  LEFT JOIN projects p ON p.id = d.project_id`

/**
 * Drops the rows this actor may not read.
 *
 * A decision filed against a project takes that project's classification and scope, decided by
 * `canReadProject` — the same call the projects list makes, so the two cannot disagree about a
 * project a person is not cleared for. A decision on no project has nothing narrower to be
 * judged by and stands on the organization-level gate above.
 */
function visibleDecisions(actor: Actor, organizationId: string, rows: DecisionRow[]): DecisionView[] {
  return rows
    .filter((row) => {
      if (!row.projectId || !row.projectSensitivity) return true
      return canReadProject(actor, organizationId, {
        id: row.projectId,
        ownerId: row.projectOwnerId,
        createdBy: row.projectCreatedBy,
        departmentId: row.projectDepartmentId,
        teamId: row.projectTeamId,
        sensitivity: row.projectSensitivity,
      }).allow
    })
    .map(strip)
}

function strip(row: DecisionRow): DecisionView {
  const {
    projectOwnerId: _o,
    projectCreatedBy: _c,
    projectDepartmentId: _d,
    projectTeamId: _t,
    projectSensitivity: _s,
    ...view
  } = row
  return view
}

/**
 * The decision log (§12.2).
 *
 * This took no actor and made no permission check of any kind until ADR 0065: RLS kept it
 * inside the organization and that was the entire gate, on a list of what was decided in
 * meetings — commercial terms, personnel, pricing. Every comparable list here takes an actor,
 * asks `grantedScope` and filters by clearance. This one now does too.
 */
export async function listDecisions(
  ctx: TenantContext,
  actor: Actor,
  filter: { projectId?: string; meetingId?: string; unconfirmedOnly?: boolean; limit?: number } = {},
): Promise<DecisionView[]> {
  const gate = can(actor, 'project:read', { type: 'project', organizationId: ctx.organizationId })
  if (!gate.allow) throw new PermissionError(gate.reason)

  const sql = ctx.sql
  const rows = await sql<DecisionRow[]>`
    ${SELECT_DECISION(ctx)}
    WHERE d.organization_id = ${ctx.organizationId} AND d.deleted_at IS NULL
      ${filter.projectId ? sql`AND d.project_id = ${filter.projectId}` : sql``}
      ${filter.meetingId ? sql`AND d.meeting_id = ${filter.meetingId}` : sql``}
      ${filter.unconfirmedOnly ? sql`AND d.confirmed_at IS NULL` : sql``}
    ORDER BY d.decided_at DESC
    LIMIT ${Math.min(filter.limit ?? 50, 200)}`
  return visibleDecisions(actor, ctx.organizationId, rows)
}

/** One decision, with the read gate that governs the list. */
export async function getDecision(ctx: TenantContext, actor: Actor, id: string): Promise<DecisionView> {
  const gate = can(actor, 'project:read', { type: 'project', organizationId: ctx.organizationId })
  if (!gate.allow) throw new PermissionError(gate.reason)

  const rows = await ctx.sql<DecisionRow[]>`
    ${SELECT_DECISION(ctx)}
    WHERE d.organization_id = ${ctx.organizationId} AND d.id = ${id} AND d.deleted_at IS NULL`
  const row = rows[0]
  if (!row) throw new NotFoundError()
  const [visible] = visibleDecisions(actor, ctx.organizationId, [row])
  // A decision on a project above this actor's clearance answers as though it is not here,
  // never as forbidden — the refusal would otherwise confirm that it exists (§3.2).
  if (!visible) throw new NotFoundError()
  return visible
}

/** Unguarded read by id, for the paths that have just written the row they are reading back. */
async function loadDecision(ctx: TenantContext, id: string): Promise<DecisionView> {
  const rows = await ctx.sql<DecisionRow[]>`
    ${SELECT_DECISION(ctx)}
    WHERE d.organization_id = ${ctx.organizationId} AND d.id = ${id}`
  if (!rows[0]) throw new NotFoundError()
  return strip(rows[0])
}

export interface RecordDecisionInput {
  summary: string
  rationale?: string | null
  rejectedAlternatives?: string[]
  meetingId?: string | null
  projectId?: string | null
  decidedBy?: string | null
  status?: 'decided' | 'deferred' | 'reversed'
  sourceSegmentId?: string | null
  confidence?: number
  agentRunId?: string | null
  /**
   * When it was decided, if the caller knows better than the transcript does. Left out by the
   * summarizer, which is the only caller — it is `whenItWasSaid` that knows (ADR 0078).
   */
  decidedAt?: Date
}

/**
 * When the decision was actually made (ADR 0078).
 *
 * `decided_at` defaulted to `now()` — the moment the summarizer ran — while being the `ORDER BY`
 * of the decision log and both of the table's indexes. So a meeting summarised a week late
 * produced decisions that sorted above ones made yesterday.
 *
 * The answer was already in the data and had been since 0010. A decision carries the transcript
 * segment it was read out of; a segment carries its offset into the recording; the meeting
 * carries when it began. Nobody had written the addition.
 *
 * Three answers in order of how much they know: the line it was said on, the meeting it was said
 * in, and — for a decision recorded outside any meeting — now, which is then the truth rather
 * than a default standing in for one.
 */
async function whenItWasSaid(
  ctx: TenantContext,
  input: { meetingId?: string | null; sourceSegmentId?: string | null },
): Promise<Date> {
  if (input.sourceSegmentId) {
    const [said] = await ctx.sql<{ at: Date }[]>`
      SELECT m.starts_at + make_interval(secs => seg.starts_at_seconds) AS at
      FROM transcript_segments seg
      JOIN transcripts tr ON tr.id = seg.transcript_id
      JOIN meetings m ON m.id = tr.meeting_id
      WHERE seg.organization_id = ${ctx.organizationId} AND seg.id = ${input.sourceSegmentId}`
    if (said) return said.at
  }
  if (input.meetingId) {
    const [meeting] = await ctx.sql<{ at: Date }[]>`
      SELECT starts_at AS at FROM meetings
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.meetingId}`
    if (meeting) return meeting.at
  }
  return new Date()
}

export async function recordDecision(
  ctx: TenantContext,
  actor: Actor,
  input: RecordDecisionInput,
): Promise<DecisionView> {
  const decision = can(actor, 'project:update', {
    type: 'project',
    organizationId: ctx.organizationId,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  if (!input.summary.trim()) throw new ValidationError('A decision needs a summary.')

  const decidedAt = input.decidedAt ?? (await whenItWasSaid(ctx, input))

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO decisions (
      organization_id, project_id, meeting_id, summary, rationale, rejected_alternatives,
      decided_by, decided_at, status, source_segment_id, confidence, agent_run_id, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.projectId ?? null}, ${input.meetingId ?? null},
      ${input.summary.trim()}, ${input.rationale ?? null}, ${input.rejectedAlternatives ?? []},
      ${input.decidedBy ?? actor.userId}, ${decidedAt}, ${input.status ?? 'decided'},
      ${input.sourceSegmentId ?? null}, ${input.confidence ?? null}, ${input.agentRunId ?? null}, ${ctx.userId}
    ) RETURNING id`

  if (input.sourceSegmentId) {
    await link(ctx, { type: 'decision', id: row!.id }, { type: 'transcript_segment', id: input.sourceSegmentId }, 'derived_from')
  }

  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.agent?.agentName ?? actor.displayName,
    verb: input.status === 'deferred' ? 'recorded a deferral' : 'recorded a decision',
    entityType: 'decision',
    entityId: row!.id,
    entityLabel: input.summary.slice(0, 80),
    summary: `${input.status === 'deferred' ? 'Deferred' : 'Decided'}: ${input.summary.slice(0, 140)}`,
    agentRunId: input.agentRunId ?? null,
  })

  // Read back by id. It used to take the newest row of the meeting and fall back to the
  // newest row in the organization, which is a guess that two summarizers running at once
  // would get wrong — and now that the list filters by clearance, a guess that could come
  // back empty.
  return loadDecision(ctx, row!.id)
}

/**
 * Who may stand behind a decision (ADR 0065).
 *
 * Being in the room comes first. The person who can say whether a transcript was read
 * correctly is somebody who was there, not somebody senior to the project — so a participant
 * or the organizer of the meeting it came from may confirm it, whatever their role. Somebody
 * with a say over the project may too, because a decision filed against a project is part of
 * that project's record and there has to be a route when nobody who attended is left.
 *
 * Returns the reason when the answer is no, so a refusal names what would work.
 */
async function mayConfirm(
  ctx: TenantContext,
  actor: Actor,
  decision: DecisionView,
): Promise<{ allow: true } | { allow: false; reason: string }> {
  if (actor.type !== 'user') {
    return {
      allow: false,
      reason:
        'Only a person can confirm a decision. The assistant read it out of a transcript — it ' +
        'cannot also be the one who agrees that it read it right.',
    }
  }

  if (decision.meetingId) {
    const [wasThere] = await ctx.sql<{ id: string }[]>`
      SELECT m.id FROM meetings m
      WHERE m.organization_id = ${ctx.organizationId} AND m.id = ${decision.meetingId}
        AND m.deleted_at IS NULL
        AND (m.organizer_id = ${actor.userId} OR EXISTS (
          SELECT 1 FROM meeting_participants mp
          WHERE mp.organization_id = m.organization_id AND mp.meeting_id = m.id
            AND mp.user_id = ${actor.userId} AND mp.deleted_at IS NULL
        ))`
    if (wasThere) return { allow: true }
  }

  const say = can(actor, 'project:update', {
    type: 'project',
    ...(decision.projectId ? { id: decision.projectId } : {}),
    organizationId: ctx.organizationId,
    riskTier: 'low',
  })
  if (say.allow) return { allow: true }

  return {
    allow: false,
    reason:
      `${say.reason} Confirming a decision is for somebody who was in the meeting it came from, ` +
      'or who has a say over the project it belongs to.',
  }
}

/**
 * Stands behind a decision, or takes that back (ADR 0065).
 *
 * Every decision in the log was extracted by the assistant from a transcript and carries a
 * confidence — `recordDecision` is called from exactly one place, the meeting summarizer. The
 * confirmation is the human half of that, and the same rule `confirmMemory` states: an
 * assistant confirming its own observation is how a wrong reading becomes the record.
 *
 * **Confirming asks for no reason; withdrawing does.** A confirmation is an affirmation of
 * text that is already there — the decision is its own reason. Withdrawing says the standing
 * record is wrong while leaving it in place, so the next person to read it needs to know what
 * the signature knew.
 */
export async function setDecisionConfirmation(
  ctx: TenantContext,
  actor: Actor,
  input: { decisionId: string; confirmed: boolean; reason?: string },
): Promise<DecisionView> {
  const before = await getDecision(ctx, actor, input.decisionId)

  const allowed = await mayConfirm(ctx, actor, before)
  if (!allowed.allow) throw new PermissionError(allowed.reason)

  if (input.confirmed && before.confirmedAt) {
    throw new ValidationError(
      before.confirmedBy === actor.userId
        ? 'You have already confirmed this.'
        : `${before.confirmedByName ?? 'Somebody'} has already confirmed this. Two signatures on one ` +
          'line would say less than one, not more — withdraw theirs first if it was wrong.',
    )
  }
  if (!input.confirmed && !before.confirmedAt) {
    throw new ValidationError('Nobody has confirmed this, so there is nothing to withdraw.')
  }

  const reason = input.reason?.trim() ?? ''
  if (!input.confirmed && reason.length < 4) {
    throw new ValidationError(
      'Say why it is being withdrawn. The decision stays on the record either way, so the next ' +
        'person to read it needs to know what changed.',
    )
  }

  await ctx.sql`
    UPDATE decisions
    SET confirmed_at = ${input.confirmed ? ctx.sql`now()` : null},
        confirmed_by = ${input.confirmed ? actor.userId : null},
        updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.decisionId} AND deleted_at IS NULL`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: input.confirmed ? 'decision.confirmed' : 'decision.confirmation_withdrawn',
    entityType: 'decision',
    entityId: input.decisionId,
    before: { confirmedBy: before.confirmedByName, summary: before.summary },
    after: {
      confirmedBy: input.confirmed ? actor.displayName : null,
      // What was being agreed with: an extraction the model was this sure of.
      extractedByAssistant: before.fromAgentRun,
      confidence: before.confidence,
      ...(reason ? { reason } : {}),
    },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: input.confirmed ? 'confirmed' : 'withdrew a confirmation',
    entityType: 'decision',
    entityId: input.decisionId,
    entityLabel: before.summary.slice(0, 80),
    summary: input.confirmed
      ? `${actor.displayName} confirmed: ${before.summary.slice(0, 140)}`
      : `${actor.displayName} withdrew the confirmation on “${before.summary.slice(0, 100)}”. ${reason}`,
  })

  return loadDecision(ctx, input.decisionId)
}

/** Whether this actor may confirm, so a page can say why not rather than show a dead button. */
export async function confirmability(
  ctx: TenantContext,
  actor: Actor,
  decisions: DecisionView[],
): Promise<Record<string, { allow: boolean; reason: string | null }>> {
  const out: Record<string, { allow: boolean; reason: string | null }> = {}
  for (const decision of decisions) {
    const answer = await mayConfirm(ctx, actor, decision)
    out[decision.id] = { allow: answer.allow, reason: answer.allow ? null : answer.reason }
  }
  return out
}

/**
 * A recurring series carries rolling context: "in the last four sessions, this decision
 * was deferred three times" (§12.5).
 */
export async function seriesContext(
  ctx: TenantContext,
  seriesId: string,
  limit = 4,
): Promise<{ occurrences: number; deferrals: { summary: string; times: number }[]; lastMeetings: { id: string; title: string; startsAt: Date }[] }> {
  const meetings = await ctx.sql<{ id: string; title: string; startsAt: Date }[]>`
    SELECT id, title, starts_at AS "startsAt" FROM meetings
    WHERE organization_id = ${ctx.organizationId} AND series_id = ${seriesId} AND deleted_at IS NULL
      AND status = 'completed'
    ORDER BY starts_at DESC LIMIT ${limit}`

  const deferrals = await ctx.sql<{ summary: string; times: number }[]>`
    SELECT d.summary, count(*)::int AS times
    FROM decisions d
    JOIN meetings m ON m.id = d.meeting_id
    WHERE d.organization_id = ${ctx.organizationId} AND m.series_id = ${seriesId}
      AND d.status = 'deferred' AND d.deleted_at IS NULL
    GROUP BY d.summary
    HAVING count(*) > 1
    ORDER BY count(*) DESC`

  return { occurrences: meetings.length, deferrals, lastMeetings: meetings }
}
