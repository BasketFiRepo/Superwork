import type { TenantContext } from '@superwork/db'
import type { Actor } from '@superwork/auth'
import { PermissionError, ValidationError } from './errors.js'
import { writeAudit } from './audit.js'

/**
 * The personal record (§29.3, §24 Phase 3 acceptance).
 *
 * "Every employee can open one screen showing what is tracked about them and what was
 * reported to whom."
 *
 * Two rules shape this file. The record is self-service only — a screen that lets a
 * manager read an individual's activity file is the surveillance product this
 * specification exists to refuse. And a disclosure is written when information about a
 * person reaches somebody else, at the moment it reaches them, so this screen is a record
 * rather than a reconstruction.
 */

export interface TrackedCategory {
  key: string
  label: string
  /** What is stored, in the words a person would use. */
  description: string
  count: number
  /** Who can see it, stated plainly. */
  visibility: string
  route: string | null
}

export interface DisclosureView {
  id: string
  kind: string
  recipientLabel: string
  recipientUserId: string | null
  summary: string
  fields: string[]
  authorizedByName: string | null
  authorizationNote: string | null
  disclosedAt: Date
  sourceType: string | null
  sourceId: string | null
}

export interface PersonalRecord {
  userId: string
  name: string
  email: string
  generatedAt: Date
  tracked: TrackedCategory[]
  disclosures: DisclosureView[]
  /** Stated as prohibitions, because they are enforced by a constraint, not a setting. */
  neverCollected: string[]
  monitoring: {
    jurisdictionProfile: string
    noSurprisesReviewHours: number
    nudgeBudgetPerDay: number
  }
  rights: { label: string; description: string; action: string }[]
}

const NEVER_COLLECTED = [
  'A productivity score, ranking or league table of individuals.',
  'Keystrokes, screen contents, webcam, microphone, location or idle time.',
  'Anything gathered without you being told — covert monitoring is not configurable.',
  'Private messages between people. The assistant never reads human-to-human DMs.',
  'Automated decisions about employment, pay, promotion or discipline.',
]

/**
 * Assembles the record. `userId` is always the caller: there is no supported way to read
 * somebody else's personal record, and the parameter exists only so the signature reads
 * honestly.
 */
export async function personalRecord(ctx: TenantContext, actor: Actor, userId: string): Promise<PersonalRecord> {
  if (userId !== actor.userId) {
    throw new PermissionError(
      'This screen shows what is held about you. Nobody — including an admin — can open another person’s record here.',
    )
  }

  const sql = ctx.sql
  const org = ctx.organizationId

  const [me] = await sql<{ name: string; email: string }[]>`
    SELECT name, email FROM users WHERE id = ${userId}`
  if (!me) throw new ValidationError('That person is not a member of this organization.')

  const [counts] = await sql<
    {
      tasks: string
      conversations: string
      commitments: string
      meetings: string
      transcript_lines: string
      activities: string
      runs: string
      briefings: string
      notes: string
      documents: string
    }[]
  >`
    SELECT
      (SELECT count(*) FROM tasks
        WHERE organization_id = ${org} AND deleted_at IS NULL
          AND (assignee_id = ${userId} OR created_by = ${userId}))::text AS tasks,
      (SELECT count(*) FROM conversations
        WHERE organization_id = ${org} AND deleted_at IS NULL
          AND (owner_id = ${userId} OR assigned_to = ${userId}))::text AS conversations,
      (SELECT count(*) FROM commitments
        WHERE organization_id = ${org} AND deleted_at IS NULL AND owner_user_id = ${userId})::text AS commitments,
      (SELECT count(*) FROM meeting_participants
        WHERE organization_id = ${org} AND deleted_at IS NULL AND user_id = ${userId})::text AS meetings,
      (SELECT count(*) FROM transcript_segments
        WHERE organization_id = ${org} AND deleted_at IS NULL AND speaker_user_id = ${userId})::text AS transcript_lines,
      (SELECT count(*) FROM activities
        WHERE organization_id = ${org} AND deleted_at IS NULL AND actor_user_id = ${userId})::text AS activities,
      (SELECT count(*) FROM agent_runs
        WHERE organization_id = ${org} AND deleted_at IS NULL AND principal_user_id = ${userId})::text AS runs,
      (SELECT count(*) FROM briefings
        WHERE organization_id = ${org} AND deleted_at IS NULL AND user_id = ${userId})::text AS briefings,
      (SELECT count(*) FROM notes
        WHERE organization_id = ${org} AND deleted_at IS NULL AND created_by = ${userId})::text AS notes,
      (SELECT count(*) FROM documents
        WHERE organization_id = ${org} AND deleted_at IS NULL AND owner_id = ${userId})::text AS documents`

  const row = counts ?? {
    tasks: '0', conversations: '0', commitments: '0', meetings: '0', transcript_lines: '0',
    activities: '0', runs: '0', briefings: '0', notes: '0', documents: '0',
  }

  const tracked: TrackedCategory[] = [
    {
      key: 'work',
      label: 'Work you own or created',
      description: 'Tasks you own or created, with their dates, status and history.',
      count: Number(row.tasks),
      visibility: 'Your colleagues, as work items — the same as any project tool.',
      route: '/tasks',
    },
    {
      key: 'threads',
      label: 'Customer threads you own',
      description: 'Business correspondence with customers and suppliers on accounts you own.',
      count: Number(row.conversations),
      visibility: 'People who work those accounts. Personal messages are not stored here at all.',
      route: '/inbox',
    },
    {
      key: 'commitments',
      label: 'Commitments in your name',
      description: 'Promises detected in mail and meetings. They count only once you confirm them.',
      count: Number(row.commitments),
      visibility: 'You, and the account team. Unconfirmed ones appear to nobody but you.',
      route: '/commitments',
    },
    {
      key: 'meetings',
      label: 'Meetings you attended',
      description: 'Attendance, and the lines you spoke where a transcript was recorded with consent.',
      count: Number(row.meetings),
      visibility: 'Attendees, and whoever can see the meeting.',
      route: '/meetings',
    },
    {
      key: 'transcript',
      label: 'Transcript lines attributed to you',
      description: 'Words recorded against your name in meeting transcripts.',
      count: Number(row.transcript_lines),
      visibility: 'Anyone who can open that meeting.',
      route: '/meetings',
    },
    {
      key: 'activity',
      label: 'Actions you took in Superwork',
      description: 'What you changed and when — the same trail your colleagues have.',
      count: Number(row.activities),
      visibility: 'Colleagues on the affected item, and admins in the audit log.',
      route: '/activity',
    },
    {
      key: 'runs',
      label: 'Things you asked the assistant to do',
      description: 'Your requests, the plans produced, what was approved and what it cost.',
      count: Number(row.runs),
      visibility: 'You. Admins see them in aggregate by department, never ranked by person.',
      route: '/activity',
    },
    {
      key: 'briefings',
      label: 'Briefings written for you',
      description: 'Your daily briefings and end-of-day summaries.',
      count: Number(row.briefings),
      visibility: 'You only.',
      route: '/briefing',
    },
    {
      key: 'authored',
      label: 'Documents and notes you wrote',
      description: 'Files you own and notes you added, including their indexed passages.',
      count: Number(row.documents) + Number(row.notes),
      visibility: 'Whoever the document is shared with.',
      route: '/knowledge',
    },
  ]

  const disclosures = await listDisclosures(ctx, actor, userId)

  const [policy] = await sql<
    { jurisdiction_profile: string; no_surprises_review_hours: number; nudge_budget_per_person_per_day: number }[]
  >`
    SELECT jurisdiction_profile, no_surprises_review_hours, nudge_budget_per_person_per_day
    FROM monitoring_policies
    WHERE organization_id = ${org} AND deleted_at IS NULL
    ORDER BY created_at LIMIT 1`

  return {
    userId,
    name: me.name,
    email: me.email,
    generatedAt: new Date(),
    tracked,
    disclosures,
    neverCollected: NEVER_COLLECTED,
    monitoring: {
      jurisdictionProfile: policy?.jurisdiction_profile ?? 'strict',
      noSurprisesReviewHours: policy?.no_surprises_review_hours ?? 24,
      nudgeBudgetPerDay: policy?.nudge_budget_per_person_per_day ?? 3,
    },
    rights: [
      {
        label: 'Download everything held about you',
        description: 'A machine-readable copy of the records listed above. Downloading is itself recorded here.',
        action: 'export',
      },
      {
        label: 'Correct something that is wrong',
        description: 'Disputing a commitment or a transcript line goes to the person who recorded it.',
        action: 'correct',
      },
    ],
  }
}

export async function listDisclosures(
  ctx: TenantContext,
  actor: Actor,
  userId: string,
  limit = 100,
): Promise<DisclosureView[]> {
  if (userId !== actor.userId) {
    throw new PermissionError('You can only read the disclosure record for yourself.')
  }
  return ctx.sql<DisclosureView[]>`
    SELECT d.id, d.kind, d.recipient_label AS "recipientLabel", d.recipient_user_id AS "recipientUserId",
           d.summary, d.fields, u.name AS "authorizedByName", d.authorization_note AS "authorizationNote",
           d.disclosed_at AS "disclosedAt", d.source_type AS "sourceType", d.source_id AS "sourceId"
    FROM disclosures d
    LEFT JOIN users u ON u.id = d.authorized_by
    WHERE d.organization_id = ${ctx.organizationId} AND d.deleted_at IS NULL
      AND d.subject_user_id = ${userId}
    ORDER BY d.disclosed_at DESC
    LIMIT ${Math.min(limit, 500)}`
}

export interface DisclosureInput {
  subjectUserId: string
  recipientUserId?: string | null
  recipientLabel: string
  // `legal_hold` is not a disclosure to a recipient — it is the notice that records
  // concerning the person are being preserved. It belongs in this log because this is the
  // one place a person already looks to find out what is being done with what is theirs.
  kind: 'weekly_digest' | 'department_report' | 'export' | 'manager_rollup' | 'api_read' | 'legal_hold'
  summary: string
  fields?: string[]
  authorizedBy?: string | null
  authorizationNote?: string | null
  agentRunId?: string | null
  sourceType?: string | null
  sourceId?: string | null
}

/**
 * Records that something about a person reached somebody else. Call this in the same
 * transaction as the delivery: a disclosure written afterwards is a disclosure that can
 * be forgotten (§29.3).
 *
 * A person is never disclosed to themselves — reading your own briefing is not a
 * disclosure, and filling the record with those would bury the ones that matter.
 */
export async function recordDisclosure(ctx: TenantContext, input: DisclosureInput): Promise<string | null> {
  if (input.recipientUserId && input.recipientUserId === input.subjectUserId && input.kind !== 'export') return null
  if (input.kind === 'export' && (!input.authorizedBy || !input.authorizationNote)) {
    throw new ValidationError(
      'Exporting an individual’s record requires a named authorization and a reason, which are recorded with it.',
    )
  }

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO disclosures (
      organization_id, subject_user_id, recipient_user_id, recipient_label, kind, summary,
      fields, authorized_by, authorization_note, agent_run_id, source_type, source_id, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.subjectUserId}, ${input.recipientUserId ?? null},
      ${input.recipientLabel}, ${input.kind}, ${input.summary}, ${input.fields ?? []},
      ${input.authorizedBy ?? null}, ${input.authorizationNote ?? null}, ${input.agentRunId ?? null},
      ${input.sourceType ?? null}, ${input.sourceId ?? null}, ${ctx.userId}
    ) RETURNING id`
  return row!.id
}

export interface PersonalExport {
  subject: { id: string; name: string; email: string }
  exportedAt: string
  organization: string
  record: PersonalRecord
  rows: Record<string, unknown[]>
}

/**
 * The data a person may take with them. Self-service, and the act of exporting is itself
 * a disclosure — including when the subject does it, so the record is complete.
 */
export async function exportPersonalRecord(ctx: TenantContext, actor: Actor): Promise<PersonalExport> {
  const record = await personalRecord(ctx, actor, actor.userId)
  const sql = ctx.sql
  const org = ctx.organizationId
  const userId = actor.userId

  const [tasks, commitments, activities, runs, briefings, transcript] = await Promise.all([
    // The same predicate the summary counts, so the download matches the screen.
    sql`SELECT id, title, status, priority, due_at, created_at FROM tasks
        WHERE organization_id = ${org} AND deleted_at IS NULL
          AND (assignee_id = ${userId} OR created_by = ${userId})
        ORDER BY created_at DESC LIMIT 500`,
    sql`SELECT id, obligation, direction, status, due_at, created_at FROM commitments
        WHERE organization_id = ${org} AND deleted_at IS NULL AND owner_user_id = ${userId}
        ORDER BY created_at DESC LIMIT 500`,
    sql`SELECT id, verb, entity_type, entity_label, summary, created_at FROM activities
        WHERE organization_id = ${org} AND deleted_at IS NULL AND actor_user_id = ${userId}
        ORDER BY created_at DESC LIMIT 500`,
    sql`SELECT id, request, mode, status, cost_cents, created_at FROM agent_runs
        WHERE organization_id = ${org} AND deleted_at IS NULL AND principal_user_id = ${userId}
        ORDER BY created_at DESC LIMIT 500`,
    sql`SELECT id, kind, local_date, narrative, generated_at FROM briefings
        WHERE organization_id = ${org} AND deleted_at IS NULL AND user_id = ${userId}
        ORDER BY generated_at DESC LIMIT 200`,
    sql`SELECT s.id, s.text, s.starts_at_seconds, m.title AS meeting, m.starts_at
        FROM transcript_segments s
        JOIN transcripts t ON t.id = s.transcript_id
        JOIN meetings m ON m.id = t.meeting_id
        WHERE s.organization_id = ${org} AND s.deleted_at IS NULL AND s.speaker_user_id = ${userId}
        ORDER BY m.starts_at DESC LIMIT 500`,
  ])

  const [organization] = await sql<{ name: string }[]>`SELECT name FROM organizations WHERE id = ${org}`

  await recordDisclosure(ctx, {
    subjectUserId: userId,
    recipientUserId: userId,
    recipientLabel: `${record.name} (downloaded it themselves)`,
    kind: 'export',
    summary: 'You downloaded a copy of everything held about you.',
    fields: ['tasks', 'commitments', 'activity', 'agent runs', 'briefings', 'transcript lines'],
    authorizedBy: userId,
    authorizationNote: 'Requested by the subject of the record.',
  })

  await writeAudit(ctx, {
    actorType: 'user',
    actorId: actor.userId,
    action: 'personal_record.export',
    entityType: 'user',
    entityId: userId,
    after: { categories: record.tracked.map((t) => t.key).join(', ') },
  })

  return {
    subject: { id: userId, name: record.name, email: record.email },
    exportedAt: new Date().toISOString(),
    organization: organization?.name ?? 'Unknown organization',
    record,
    rows: {
      tasks: tasks as unknown[],
      commitments: commitments as unknown[],
      activity: activities as unknown[],
      agentRuns: runs as unknown[],
      briefings: briefings as unknown[],
      transcriptLines: transcript as unknown[],
    },
  }
}
