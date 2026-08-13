import type { TaskClass } from '@superwork/config'

/**
 * The mock brain (§5.12).
 *
 * Mock mode is not `return "Lorem ipsum"`. It is a deterministic, seeded, rule-based
 * implementation that reasons over the *real* grounding the runtime retrieved from the
 * database — real customers, real overdue counts, real document excerpts. It exercises
 * the same runtime, tools, permissions, approvals and logging as a live model, which is
 * what lets the whole product, its demo and its CI run with no API key, and lets the
 * eval harness tell "the plumbing broke" apart from "the model was wrong".
 *
 * Every response it produces is badged `Simulated` wherever it is displayed.
 */

export interface Grounding {
  now: string
  timezone: string
  me: { name: string; role: string }
  mode: string
  capabilities: { canDraft: boolean; canExecuteLow: boolean; canExecuteHigh: boolean }
  aggregates: Record<string, { basis: string; rows: Record<string, unknown>[] }>
  knowledge: {
    documentId: string
    documentTitle: string
    anchor: string
    headingPath: string
    content: string
    score: number
    isSuperseded: boolean
  }[]
  noAnswer: boolean
  untrusted: { sourceId: string; label: string; flagged: boolean; patterns: string[] }[]
}

export interface PlanStepDraft {
  id: string
  tool: string
  args: Record<string, unknown>
  intent: string
}

export interface PlanDraft {
  intent: string
  summary: string
  steps: PlanStepDraft[]
  needsAttention: { label: string; reason: string; entityType: string; entityId: string }[]
  clarification?: { question: string; options: { id: string; label: string }[] }
  /** Set when the request is a question rather than an instruction to act. */
  answerOnly: boolean
}

export interface AnswerDraft {
  text: string
  citations: { claim: string; knowledgeIndex: number }[]
  usedAggregates: string[]
}

export interface CriticVerdict {
  verdict: 'pass' | 'block'
  findings: { severity: 'low' | 'medium' | 'high'; message: string }[]
}

const FOLLOW_UP = /\b(follow[- ]?ups?|chase|chasing|gone quiet|went quiet|no reply|unanswered|stale|overdue customers?)\b/i
const OVERDUE_WORK = /\b(overdue|slipping|behind|late)\b/i
const CLEANUP = /\b(clean ?up|tidy|triage|sort out|reprioriti[sz]e)\b/i
const QUESTION = /^(what|who|when|where|why|how|which|is|are|do|does|can|should|tell me|show me|summari[sz]e)\b|\?\s*$/i

function daysFromNow(iso: string, days: number, hour = 17): string {
  const base = new Date(iso)
  base.setUTCDate(base.getUTCDate() + days)
  base.setUTCHours(hour, 0, 0, 0)
  return base.toISOString()
}

function str(row: Record<string, unknown>, key: string): string {
  const v = row[key]
  return v === null || v === undefined ? '' : String(v)
}

function num(row: Record<string, unknown>, key: string): number {
  return Number(row[key] ?? 0)
}

export function planFor(request: string, g: Grounding): PlanDraft {
  const stale = g.aggregates['stale_customer_threads']?.rows ?? []
  const overdue = g.aggregates['tasks_overdue']?.rows ?? []

  // --- Follow up with customers who have gone quiet --------------------------
  if (FOLLOW_UP.test(request) && stale.length > 0) {
    const actionable = stale.filter((r) => r['ambiguous'] !== true)
    const ambiguous = stale.filter((r) => r['ambiguous'] === true)
    const steps: PlanStepDraft[] = []

    for (const row of actionable) {
      const company = str(row, 'company_name')
      const conversationId = str(row, 'conversation_id')
      const waiting = num(row, 'days_waiting')
      steps.push({
        id: `task-${conversationId.slice(0, 8)}`,
        tool: 'create_task',
        args: {
          title: `Follow up with ${company}`,
          description: `No reply for ${waiting} days on "${str(row, 'subject')}".`,
          assigneeId: str(row, 'owner_id') || null,
          priority: waiting > 10 ? 'high' : 'medium',
          dueAt: daysFromNow(g.now, 1),
          derivedFrom: { type: 'conversation', id: conversationId },
        },
        intent: `Give ${str(row, 'owner_name') || 'the account owner'} an owned, dated action for ${company}.`,
      })
      if (g.capabilities.canDraft) {
        steps.push({
          id: `draft-${conversationId.slice(0, 8)}`,
          tool: 'draft_email',
          args: {
            conversationId,
            companyId: str(row, 'company_id'),
            subject: `Re: ${str(row, 'subject')}`,
            referenceLastExchange: true,
          },
          intent: `Draft a reply referencing the last exchange with ${company}. Nothing is sent without approval.`,
        })
      }
    }

    return {
      intent: 'follow_up_stale_customers',
      answerOnly: false,
      summary:
        `${actionable.length} ${actionable.length === 1 ? 'customer has' : 'customers have'} not had a reply beyond their agreed SLA. ` +
        `I will create a dated follow-up task for each account owner` +
        (g.capabilities.canDraft ? ' and draft a reply referencing each thread’s last exchange.' : '.') +
        (ambiguous.length
          ? ` ${ambiguous.length} further ${ambiguous.length === 1 ? 'thread is' : 'threads are'} ambiguous — we sent the last message, so chasing may be wrong. I have flagged rather than drafted those.`
          : ''),
      steps,
      needsAttention: ambiguous.map((row) => ({
        label: str(row, 'company_name'),
        reason: 'We sent the last message, so this thread may already be closed.',
        entityType: 'conversation',
        entityId: str(row, 'conversation_id'),
      })),
    }
  }

  // --- Clean up overdue work -------------------------------------------------
  if ((OVERDUE_WORK.test(request) || CLEANUP.test(request)) && overdue.length > 0 && !QUESTION.test(request)) {
    const steps: PlanStepDraft[] = overdue.slice(0, 10).map((row) => ({
      id: `due-${str(row, 'id').slice(0, 8)}`,
      tool: 'update_task',
      args: {
        id: str(row, 'id'),
        dueAt: daysFromNow(g.now, num(row, 'days_overdue') > 14 ? 5 : 2),
        priority: num(row, 'days_overdue') > 14 ? 'high' : str(row, 'priority') || 'medium',
      },
      intent: `"${str(row, 'title')}" is ${num(row, 'days_overdue')} days past due — propose a realistic new date rather than leaving it silently late.`,
    }))
    return {
      intent: 'reschedule_overdue',
      answerOnly: false,
      summary: `${overdue.length} tasks are past their due date. I will propose new dates based on how far each has slipped. Renegotiating a date in advance is the behaviour worth encouraging, so nothing here is marked as a failure.`,
      steps,
      needsAttention: [],
    }
  }

  // --- Nothing to act on -----------------------------------------------------
  if (FOLLOW_UP.test(request) && stale.length === 0) {
    return {
      intent: 'follow_up_stale_customers',
      answerOnly: true,
      summary: 'No customer threads are past their reply SLA right now, so there is nothing to chase.',
      steps: [],
      needsAttention: [],
    }
  }

  return {
    intent: 'answer',
    answerOnly: true,
    summary: 'This reads as a question rather than an instruction to change anything, so I will answer it and cite what I used.',
    steps: [],
    needsAttention: [],
  }
}

export function answerFor(request: string, g: Grounding): AnswerDraft {
  const citations: AnswerDraft['citations'] = []
  const usedAggregates: string[] = []
  const lines: string[] = []

  // Numbers always come from the database, never from the model (§7.3).
  for (const [name, agg] of Object.entries(g.aggregates)) {
    if (agg.rows.length === 0) continue
    usedAggregates.push(name)
    if (name === 'tasks_overdue') {
      lines.push(`${agg.rows.length} tasks are overdue. ${agg.basis}`)
    } else if (name === 'stale_customer_threads') {
      const actionable = agg.rows.filter((r) => r['ambiguous'] !== true)
      lines.push(
        `${actionable.length} customer ${actionable.length === 1 ? 'thread is' : 'threads are'} past the reply SLA: ${actionable
          .map((r) => str(r, 'company_name'))
          .join(', ')}.`,
      )
    } else if (name === 'tasks_by_status') {
      lines.push(
        agg.rows.map((r) => `${num(r, 'count')} ${str(r, 'status').replace(/_/g, ' ')}`).join(', ') + '.',
      )
    }
  }

  if (g.noAnswer && g.knowledge.length === 0) {
    return {
      text:
        lines.length > 0
          ? lines.join(' ')
          : "I don't have anything on this in company memory. If you upload the document that covers it, I'll index it and answer properly — I'd rather say that than guess.",
      citations,
      usedAggregates,
    }
  }

  const top = g.knowledge.slice(0, 4)
  top.forEach((chunk, index) => {
    const sentence = firstMeaningfulSentence(chunk.content)
    if (!sentence) return
    const prefix = chunk.isSuperseded ? 'A superseded version of this document says: ' : ''
    lines.push(`${prefix}${sentence}`)
    citations.push({ claim: sentence, knowledgeIndex: index })
  })

  if (lines.length === 0) {
    lines.push("I found sources but nothing in them answers this directly, so I'd rather flag that than paraphrase around it.")
  }

  return { text: lines.join(' '), citations, usedAggregates }
}

function firstMeaningfulSentence(content: string): string {
  const cleaned = content
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('#') && !line.trim().startsWith('|'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  const sentence = cleaned.split(/(?<=[.!?])\s/)[0] ?? cleaned
  return sentence.length > 320 ? `${sentence.slice(0, 317)}...` : sentence
}

export function reportFor(
  outcome: { created: number; updated: number; drafted: number; sent: number; skipped: string[]; failed: string[] },
): string {
  const parts: string[] = []
  if (outcome.created) parts.push(`${outcome.created} ${outcome.created === 1 ? 'task' : 'tasks'} created`)
  if (outcome.updated) parts.push(`${outcome.updated} updated`)
  if (outcome.drafted) parts.push(`${outcome.drafted} ${outcome.drafted === 1 ? 'draft' : 'drafts'} saved to Approvals`)
  parts.push(outcome.sent ? `${outcome.sent} sent` : 'nothing was sent')

  const body = [parts.join(', ') + '.']
  if (outcome.skipped.length) body.push(`Skipped: ${outcome.skipped.join('; ')}.`)
  if (outcome.failed.length) body.push(`Failed: ${outcome.failed.join('; ')}.`)
  return body.join(' ')
}

/** The Critic runs on every execute:high plan and every outbound draft (§5.4). */
export function criticFor(payload: { subject?: string; body?: string; recipients?: string[]; knownContacts?: string[] }): CriticVerdict {
  const findings: CriticVerdict['findings'] = []
  const text = `${payload.subject ?? ''}\n${payload.body ?? ''}`

  if (/\b(?:api[_-]?key|password|bearer\s+[a-z0-9._-]{16,}|sk-[a-z0-9]{16,})\b/i.test(text)) {
    findings.push({ severity: 'high', message: 'The draft contains what looks like a credential.' })
  }
  if (/\b(?:iban|sort\s?code|account\s?number)\b/i.test(text)) {
    findings.push({ severity: 'high', message: 'The draft contains bank details.' })
  }
  if (/\b(?:salary|payroll|compensation)\b/i.test(text)) {
    findings.push({ severity: 'high', message: 'The draft references compensation data.' })
  }
  if (/\bI (?:guarantee|promise|commit)\b/i.test(text)) {
    findings.push({ severity: 'medium', message: 'The draft makes a commitment that no one has verified.' })
  }

  const known = new Set((payload.knownContacts ?? []).map((c) => c.toLowerCase()))
  for (const recipient of payload.recipients ?? []) {
    if (!known.has(recipient.toLowerCase())) {
      findings.push({
        severity: 'high',
        message: `Recipient ${recipient} is not a known contact on this account. Egress to unrecognised addresses is blocked.`,
      })
    }
  }

  return { verdict: findings.some((f) => f.severity === 'high') ? 'block' : 'pass', findings }
}

export const MOCK_HANDLED_CLASSES: TaskClass[] = [
  'agent.plan',
  'agent.answer',
  'agent.report',
  'agent.critic',
  'inbox.classify',
  'email.draft',
]
