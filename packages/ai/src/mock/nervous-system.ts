/**
 * Deterministic handlers for the Phase 2 task classes (§5.12).
 *
 * Each one reasons over the real grounding the runtime supplied. The briefing handler in
 * particular is *structurally* unable to invent a figure: it only interpolates counts
 * that were computed in SQL and handed to it.
 */

// ---------------------------------------------------------------------------
// Inbox triage
// ---------------------------------------------------------------------------

export interface TriageInputPayload {
  subject: string
  lastMessage: string
  lastDirection: 'inbound' | 'outbound' | 'internal'
  daysWaiting: number
  slaDays: number
  companyName?: string | null
  injectionFlagged?: boolean
}

export interface TriageResult {
  category: 'needs_reply' | 'needs_action' | 'waiting_on_others' | 'fyi' | 'urgent' | 'spam'
  priority: 'urgent' | 'high' | 'medium' | 'low'
  sentiment: 'positive' | 'neutral' | 'negative'
  reason: string
  suggestedFollowUpDays: number | null
}

const QUESTION = /\?|could you|can you|would you|please (?:send|confirm|share|advise)|let me know/i
const ACTION = /\b(invoice|payment|overdue|dispute|reissue|credit note|escalat|claim|deadline|deliver)\b/i
const FYI = /\b(fyi|for your information|no action|heads[- ]up|just so you know)\b/i
const URGENT = /\b(urgent|asap|immediately|today|critical|stop the line|blocked)\b/i
const NEGATIVE = /\b(disappoint|unhappy|frustrat|unacceptable|delay|late|chasing again|escalate)\b/i
const POSITIVE = /\b(thanks|thank you|great|appreciate|perfect|happy with)\b/i
const SPAM = /\b(unsubscribe|special offer|limited time|click here to claim|winner)\b/i

export function triageFor(input: TriageInputPayload): TriageResult {
  const text = `${input.subject}\n${input.lastMessage}`
  const pastSla = input.lastDirection === 'inbound' && input.daysWaiting > input.slaDays

  if (SPAM.test(text) && input.lastDirection === 'inbound') {
    return {
      category: 'spam',
      priority: 'low',
      sentiment: 'neutral',
      reason: 'Reads as unsolicited bulk mail.',
      suggestedFollowUpDays: null,
    }
  }

  // Content that tried to instruct the agent is never routed as routine.
  if (input.injectionFlagged) {
    return {
      category: 'needs_action',
      priority: 'high',
      sentiment: 'neutral',
      reason: 'This thread contains content that attempted to instruct the assistant. A person should look at it.',
      suggestedFollowUpDays: 1,
    }
  }

  const category: TriageResult['category'] =
    input.lastDirection === 'outbound'
      ? 'waiting_on_others'
      : FYI.test(text) && !QUESTION.test(text)
        ? 'fyi'
        : URGENT.test(text)
          ? 'urgent'
          : ACTION.test(text)
            ? 'needs_action'
            : QUESTION.test(text)
              ? 'needs_reply'
              : 'needs_reply'

  const priority: TriageResult['priority'] =
    URGENT.test(text) || (pastSla && input.daysWaiting > input.slaDays * 2)
      ? 'urgent'
      : pastSla || ACTION.test(text)
        ? 'high'
        : category === 'fyi'
          ? 'low'
          : 'medium'

  const sentiment: TriageResult['sentiment'] = NEGATIVE.test(text)
    ? 'negative'
    : POSITIVE.test(text)
      ? 'positive'
      : 'neutral'

  const reason = pastSla
    ? `${input.companyName ?? 'They'} wrote ${input.daysWaiting} days ago and the account SLA is ${input.slaDays} days.`
    : input.lastDirection === 'outbound'
      ? 'We sent the last message, so the ball is with them.'
      : category === 'fyi'
        ? 'Informational — no question or request in the last message.'
        : 'The last message asks for something from us.'

  return {
    category,
    priority,
    sentiment,
    reason,
    suggestedFollowUpDays: category === 'waiting_on_others' ? Math.max(2, input.slaDays) : null,
  }
}

// ---------------------------------------------------------------------------
// Commitment extraction
// ---------------------------------------------------------------------------

export interface DetectedCommitment {
  obligation: string
  direction: 'we_owe' | 'they_owe'
  dueHint: string | null
  confidence: number
  excerpt: string
}

const OURS = /\b(?:I|we|we'?ll|I'?ll)\s+(?:will\s+)?(send|share|confirm|provide|reissue|deliver|prepare|circulate|get back|revert|look into|chase|book|arrange|update)\b/i
const THEIRS = /\b(?:you|they|your team|he|she)\s+(?:will\s+)?(send|share|confirm|provide|deliver|approve|sign|release|revert|get back)\b/i
const DUE_HINT =
  /\b(by|before|no later than)\s+((?:end of )?(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|next week|this week|the \d{1,2}(?:st|nd|rd|th)?)|\d{4}-\d{2}-\d{2})/i

/**
 * Sentence-level detection. Deliberately conservative: a missed commitment costs a chase,
 * a false one costs someone being chased for a promise they never made (§29.1).
 */
export function extractCommitments(text: string): DetectedCommitment[] {
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15 && s.length < 400)

  const found: DetectedCommitment[] = []

  for (const sentence of sentences) {
    const ours = OURS.test(sentence)
    const theirs = !ours && THEIRS.test(sentence)
    if (!ours && !theirs) continue

    const dueHint = DUE_HINT.exec(sentence)?.[2]?.toLowerCase() ?? null
    // A date makes it a commitment rather than an intention.
    const confidence = Math.min(0.95, (ours ? 0.6 : 0.55) + (dueHint ? 0.25 : 0))

    found.push({
      obligation: sentence.replace(/\s+/g, ' ').trim(),
      direction: ours ? 'we_owe' : 'they_owe',
      dueHint,
      confidence: Number(confidence.toFixed(2)),
      excerpt: sentence.slice(0, 300),
    })
  }

  return found.slice(0, 8)
}

/** Resolves a natural-language due hint against a reference instant. Never guesses a year. */
export function resolveDueHint(hint: string | null, now: Date): Date | null {
  if (!hint) return null
  const base = new Date(now)
  const at5pm = (d: Date) => {
    d.setUTCHours(17, 0, 0, 0)
    return d
  }
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

  if (/^(?:end of )?today$/.test(hint)) return at5pm(base)
  if (/^(?:end of )?tomorrow$/.test(hint)) {
    base.setUTCDate(base.getUTCDate() + 1)
    return at5pm(base)
  }
  if (/next week/.test(hint)) {
    base.setUTCDate(base.getUTCDate() + 7)
    return at5pm(base)
  }
  if (/this week/.test(hint)) {
    base.setUTCDate(base.getUTCDate() + (5 - base.getUTCDay() + 7) % 7)
    return at5pm(base)
  }
  const isoMatch = /^\d{4}-\d{2}-\d{2}$/.exec(hint)
  if (isoMatch) {
    const parsed = new Date(`${hint}T17:00:00Z`)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  const weekdayIndex = weekdays.findIndex((d) => hint.includes(d))
  if (weekdayIndex >= 0) {
    const delta = (weekdayIndex - base.getUTCDay() + 7) % 7 || 7
    base.setUTCDate(base.getUTCDate() + delta)
    return at5pm(base)
  }
  return null
}

// ---------------------------------------------------------------------------
// Meeting summarization
// ---------------------------------------------------------------------------

export interface MeetingGrounding {
  title: string
  segments: { ordinal: number; speaker: string; startsAtSeconds: number; text: string; anchor: string }[]
  participants: string[]
  /** Participants who are colleagues; anyone else speaks for the other side. */
  internalParticipants?: string[]
  seriesContext?: { occurrences: number; deferrals: { summary: string; times: number }[] } | null
}

export interface MeetingSummary {
  summary: string
  decisions: { summary: string; rationale: string | null; status: 'decided' | 'deferred'; segmentOrdinal: number; confidence: number }[]
  actionItems: {
    title: string
    /** A participant this resolves to, or null when nobody can be named with confidence. */
    ownerHint: string | null
    /** The literal subject that was said, kept even when it resolves to nobody present. */
    mentionedOwner: string | null
    dueHint: string | null
    /** False when an external participant said it — that makes it *their* commitment. */
    speakerIsInternal: boolean
    segmentOrdinal: number
    confidence: number
  }[]
  openQuestions: { question: string; segmentOrdinal: number }[]
  risks: { risk: string; segmentOrdinal: number }[]
  sentiment: 'positive' | 'neutral' | 'negative'
}

const DECIDED = /\b(we(?:'| a)re going with|we agreed|decision is|we'?ll go ahead|agreed that|let'?s go with|signed off)\b/i
const DEFERRED = /\b(park(?:ed)? (?:that|this|it)|come back to (?:that|this|it)|defer|revisit next|leave (?:that|this) for now|not now)\b/i
// A bare "to" matched things like "slow to confirm windows", which is a complaint, not
// a commitment. The subject must be a pronoun or a name, and the modal must be a real
// undertaking. Pronouns are spelled with both cases because a sentence-initial "We"
// is not the same string as a mid-sentence "we", and a two-letter pronoun does not
// reach the name pattern's minimum length.
const ACTION_ITEM =
  /\b(I|[Ww]e|[Hh]e|[Ss]he|[Tt]hey|[Yy]ou|[A-Z][a-z]{2,})\s+(?:will|'ll|shall|(?:is|are|am) going to|needs? to|should)\s+(send|draft|prepare|confirm|chase|book|arrange|update|review|circulate|check|raise|fix|close|write|document|pull|run|release|issue|share|escalate|get back|revert|look into)\b/
const OPEN_QUESTION = /\b(?:we (?:still )?(?:don'?t|do not) know|open question|need to find out|unclear whether|who owns)\b|\?$/i
const RISK = /\b(risk|exposure|if (?:that|this) slips|worst case|could fail|might miss|penalt|claim)\b/i

export function summarizeMeeting(g: MeetingGrounding): MeetingSummary {
  const decisions: MeetingSummary['decisions'] = []
  const actionItems: MeetingSummary['actionItems'] = []
  const openQuestions: MeetingSummary['openQuestions'] = []
  const risks: MeetingSummary['risks'] = []
  let negative = 0
  let positive = 0

  for (const segment of g.segments) {
    const text = segment.text.trim()

    if (DEFERRED.test(text)) {
      decisions.push({
        summary: trimSentence(text),
        rationale: null,
        status: 'deferred',
        segmentOrdinal: segment.ordinal,
        confidence: 0.7,
      })
    } else if (DECIDED.test(text)) {
      decisions.push({
        summary: trimSentence(text),
        rationale: nextClause(text),
        status: 'decided',
        segmentOrdinal: segment.ordinal,
        confidence: 0.8,
      })
    }

    const action = ACTION_ITEM.exec(text)
    if (action) {
      const subject = action[1] ?? null
      const owner = resolveOwner(subject, segment.speaker, g.participants)
      const internal = (g.internalParticipants ?? g.participants).includes(segment.speaker)
      actionItems.push({
        title: trimSentence(text),
        ownerHint: owner,
        mentionedOwner: subject,
        dueHint: DUE_HINT.exec(text)?.[2]?.toLowerCase() ?? null,
        speakerIsInternal: internal,
        segmentOrdinal: segment.ordinal,
        // Without a resolvable owner this is a suggestion, and the UI has to ask.
        confidence: owner ? 0.8 : 0.5,
      })
    }

    if (OPEN_QUESTION.test(text)) {
      openQuestions.push({ question: trimSentence(text), segmentOrdinal: segment.ordinal })
    }
    if (RISK.test(text)) {
      risks.push({ risk: trimSentence(text), segmentOrdinal: segment.ordinal })
    }
    if (NEGATIVE.test(text)) negative += 1
    if (POSITIVE.test(text)) positive += 1
  }

  const parts: string[] = []
  parts.push(
    `${g.participants.length} ${g.participants.length === 1 ? 'person' : 'people'} across ${g.segments.length} turns.`,
  )
  if (decisions.length) {
    const decided = decisions.filter((d) => d.status === 'decided').length
    const deferred = decisions.length - decided
    parts.push(
      `${decided} ${decided === 1 ? 'decision' : 'decisions'} recorded${deferred ? ` and ${deferred} deferred` : ''}.`,
    )
  } else {
    parts.push('No decision was reached.')
  }
  if (actionItems.length) {
    parts.push(`${actionItems.length} action ${actionItems.length === 1 ? 'item' : 'items'} proposed for review.`)
  }
  if (openQuestions.length) parts.push(`${openQuestions.length} open question${openQuestions.length === 1 ? '' : 's'}.`)

  const repeated = g.seriesContext?.deferrals ?? []
  if (repeated.length > 0) {
    parts.push(
      `In this series, ${repeated
        .map((d) => `"${trimSentence(d.summary)}" has now been deferred ${d.times} times`)
        .join('; ')}.`,
    )
  }

  return {
    summary: parts.join(' '),
    decisions,
    actionItems,
    openQuestions,
    risks,
    sentiment: negative > positive ? 'negative' : positive > negative ? 'positive' : 'neutral',
  }
}

function trimSentence(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  return cleaned.length > 220 ? `${cleaned.slice(0, 217)}…` : cleaned
}

function nextClause(text: string): string | null {
  const match = /\b(?:because|since|as|so that)\b\s+([^.!?]+)/i.exec(text)
  return match?.[1]?.trim() ?? null
}

const FIRST_PERSON = new Set(['i', 'we'])
const AMBIGUOUS_PRONOUN = new Set(['you', 'they', 'he', 'she', 'it'])

/**
 * Resolving an owner is where a helpful summary turns into a false accusation, so this
 * is deliberately strict. "I" and "we" belong to the speaker. Other pronouns are
 * ambiguous and resolve to nobody. A name must match a participant's name *part* exactly
 * — prefix matching once turned "I will confirm" into a commitment by Ingrid.
 */
function resolveOwner(candidate: string | null, speaker: string, participants: string[]): string | null {
  if (!candidate) return participants.includes(speaker) ? speaker : null

  const lower = candidate.toLowerCase()
  if (FIRST_PERSON.has(lower)) return participants.includes(speaker) ? speaker : null
  if (AMBIGUOUS_PRONOUN.has(lower)) return null

  const match = participants.find((p) => p.split(/\s+/).some((part) => part.toLowerCase() === lower))
  // A third party who was not in the room cannot be assigned work by inference.
  return match ?? null
}

// ---------------------------------------------------------------------------
// CRM 360° narration
// ---------------------------------------------------------------------------

export interface CrmGrounding {
  companyName: string
  facts: { claim: string }[]
  risks: string[]
  openThreads: number
  weOwe: number
  theyOwe: number
  nextBestAction: string | null
}

export function narrate360(g: CrmGrounding): { text: string; nextBestAction: string | null } {
  if (g.facts.length === 0) {
    return {
      text: `Nothing is recorded against ${g.companyName} yet — no threads, commitments or documents. There is no state to summarise, and I would rather say that than invent one.`,
      nextBestAction: null,
    }
  }

  const lines = g.facts.map((f) => f.claim)
  if (g.risks.length > 0) lines.push(`Worth watching: ${g.risks.join(' ')}`)

  return { text: lines.join(' '), nextBestAction: g.nextBestAction }
}

// ---------------------------------------------------------------------------
// Daily briefing narrative
// ---------------------------------------------------------------------------

export interface BriefingGrounding {
  kind: 'daily' | 'end_of_day'
  userName: string
  timezone: string
  basis: string
  counts: Record<string, number>
  meetings: { title: string; localTime: string; minutes: number }[]
  overdue: { title: string; daysOverdue: number }[]
  approvals: { title: string; hoursWaiting: number }[]
  commitments: { obligation: string; companyName: string | null }[]
  blockingOthers: { title: string; waitingCount: number }[]
  staleThreads: { companyName: string; daysWaiting: number }[]
  completedToday: { title: string }[]
  slippedToday: { title: string; daysOverdue: number }[]
  agentActions: { summary: string; costCents: number }[]
  recommendation: { headline: string; why: string }
}

/**
 * Writes the connective prose around numbers that were already computed. Every figure it
 * emits is read from `counts` — there is no arithmetic here and no way to state a number
 * the database did not produce.
 */
export function briefingNarrative(g: BriefingGrounding): { text: string } {
  const c = g.counts
  const first = g.userName.split(' ')[0] ?? g.userName
  const lines: string[] = []

  if (g.kind === 'daily') {
    const opener: string[] = []
    if (c['meetings']) {
      opener.push(
        `${c['meetings']} ${c['meetings'] === 1 ? 'meeting' : 'meetings'}${
          g.meetings[0] ? `, starting at ${g.meetings[0].localTime}` : ''
        }`,
      )
    }
    if (c['dueToday']) opener.push(`${c['dueToday']} ${c['dueToday'] === 1 ? 'task' : 'tasks'} due`)
    if (c['overdue']) opener.push(`${c['overdue']} overdue`)
    lines.push(
      opener.length
        ? `Morning ${first}. Today: ${joinList(opener)}.`
        : `Morning ${first}. Nothing is due today and nothing is overdue.`,
    )

    if (c['approvals']) {
      const oldest = g.approvals[0]
      lines.push(
        `${c['approvals']} ${c['approvals'] === 1 ? 'approval is' : 'approvals are'} waiting on you${
          oldest ? `, the oldest for ${Math.round(oldest.hoursWaiting)} hours` : ''
        }.`,
      )
    }
    if (c['blockingOthers']) {
      const item = g.blockingOthers[0]!
      lines.push(
        `${c['blockingOthers']} of your items ${c['blockingOthers'] === 1 ? 'is' : 'are'} blocking other people — "${item.title}" has ${item.waitingCount} waiting on it.`,
      )
    }
    if (c['commitmentsDue']) {
      const item = g.commitments[0]!
      lines.push(
        `${c['commitmentsDue']} ${c['commitmentsDue'] === 1 ? 'commitment you confirmed is' : 'commitments you confirmed are'} due${
          item.companyName ? `, including one to ${item.companyName}` : ''
        }.`,
      )
    }
    if (c['staleThreads']) {
      const worst = g.staleThreads[0]!
      lines.push(
        `${c['staleThreads']} customer ${c['staleThreads'] === 1 ? 'thread is' : 'threads are'} past their reply SLA — ${worst.companyName} has been waiting ${worst.daysWaiting} days.`,
      )
    }
  } else {
    lines.push(
      c['completedToday']
        ? `${first}, you closed ${c['completedToday']} ${c['completedToday'] === 1 ? 'item' : 'items'} today.`
        : `${first}, nothing was marked complete today.`,
    )
    if (c['slippedToday']) {
      const worst = g.slippedToday[0]!
      lines.push(
        `${c['slippedToday']} ${c['slippedToday'] === 1 ? 'item' : 'items'} slipped, including "${worst.title}". Moving a date in advance counts as kept — leaving it silent does not.`,
      )
    }
    if (c['overdue']) lines.push(`${c['overdue']} ${c['overdue'] === 1 ? 'item carries' : 'items carry'} into tomorrow.`)
    if (c['agentActions']) {
      lines.push(
        `What I did on your behalf today: ${g.agentActions
          .slice(0, 3)
          .map((a) => a.summary.split('.')[0])
          .join('; ')}${c['agentActions'] > 3 ? `, and ${c['agentActions'] - 3} more` : ''}.`,
      )
    } else {
      lines.push('I took no actions on your behalf today.')
    }
  }

  lines.push(`${g.recommendation.headline}. ${g.recommendation.why}`)
  lines.push(g.basis)

  return { text: lines.join(' ') }
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}
