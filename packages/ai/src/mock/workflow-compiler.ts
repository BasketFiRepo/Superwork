/**
 * The workflow compiler (§10.3).
 *
 * Plain language in, a schema-validated DAG out — plus the two things that make the DAG
 * safe to look at: a plain-English readback of what it will actually do, and the risks it
 * detected, with the approval step it inserted because of them.
 *
 * Deterministic, like every other mock handler: the same sentence always compiles to the
 * same graph, so a dry run, a screenshot and a test agree with each other.
 */

export type NodeType = 'trigger' | 'query' | 'for_each' | 'action' | 'approval' | 'notify'

export interface WorkflowNode {
  id: string
  type: NodeType
  label: string
  /** For `query`: the named aggregate. For `action`: the tool. */
  ref?: string
  args?: Record<string, unknown>
  /** Downstream node ids. */
  next: string[]
}

export interface WorkflowGraph {
  trigger: {
    kind: 'schedule' | 'event' | 'manual'
    /** Cron for schedules; an event name otherwise. */
    spec: string
    description: string
  }
  nodes: WorkflowNode[]
}

export interface DetectedRisk {
  severity: 'low' | 'medium' | 'high'
  message: string
  /** What the compiler did about it, if anything. */
  mitigation: string | null
}

export interface CompiledWorkflow {
  name: string
  graph: WorkflowGraph
  readback: string
  risks: DetectedRisk[]
  /** Set when the sentence did not describe something this compiler can build. */
  unsupported: string | null
}

const SCHEDULE = /\b(every|each)\s+(weekday|day|hour|month|monday|tuesday|wednesday|thursday|friday|week|morning)\b/i
const TIME = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i
const QUIET = /\b(no reply|not replied|gone quiet|went quiet|no response|unanswered)\b/i
const OVERDUE = /\b(overdue|past due|late|slipping)\b/i
const RENEWAL = /\b(renew|renewal|expiring|expires)\b/i
// An adjective between the verb and the noun is ordinary English — "create a dated
// follow-up task" is the same instruction as "create a task", and a compiler that only
// understood the second would send people hunting for the phrasing it liked.
const DRAFT_EMAIL = /\b(draft|write|prepare|send)\s+(a\s+|an\s+|them\s+a\s+|the\s+)?(?:\w+[- ]){0,2}(follow[- ]?up|reply|chaser|email|message)\b/i
const CREATE_TASK = /\b(create|open|raise|add)\s+(a\s+|an\s+|the\s+)?(?:\w+[- ]){0,2}(task|to-?do|action)\b/i
const NOTIFY = /\b(tell|notify|let\s+\w+\s+know|post|message)\b/i
const APPROVE = /\b(ask (?:me|us) to approve|for approval|approve it|check with me)\b/i
const SEND = /\b(send|email them|reply to them)\b/i

const DAYS = /\b(\d+)\s*(day|days|business days|working days)\b/i

function cron(text: string): { spec: string; description: string } {
  // "Every hour" and "every month" have no time of day to read, so they are matched first.
  if (/\b(every|each)\s+hour\b|\bhourly\b/i.test(text)) {
    return { spec: '0 * * * *', description: 'every hour, on the hour' }
  }

  const time = TIME.exec(text)
  let hour = 9
  if (time) {
    hour = Number(time[1])
    const meridiem = time[3]?.toLowerCase()
    if (meridiem === 'pm' && hour < 12) hour += 12
    if (meridiem === 'am' && hour === 12) hour = 0
  }
  const at = `${String(hour).padStart(2, '0')}:00`

  if (/\b(every|each)\s+month\b|\bmonthly\b/i.test(text)) {
    return { spec: `0 ${hour} 1 * *`, description: `on the first of the month at ${at}` }
  }
  if (/\bweekday|monday to friday\b/i.test(text)) {
    return { spec: `0 ${hour} * * 1-5`, description: `every weekday at ${at}` }
  }
  if (/\bweek\b/i.test(text) && !/\bweekday\b/i.test(text)) {
    return { spec: `0 ${hour} * * 1`, description: `every Monday at ${at}` }
  }
  return { spec: `0 ${hour} * * *`, description: `every day at ${at}` }
}

/**
 * Compiles one sentence. What it cannot build it says it cannot build — a compiler that
 * guesses produces an automation nobody can predict, which is the thing dry runs exist to
 * catch and the thing this refuses to create in the first place.
 */
export function compileWorkflow(description: string): CompiledWorkflow {
  const text = description.trim()
  const nodes: WorkflowNode[] = []
  const risks: DetectedRisk[] = []

  const trigger = SCHEDULE.test(text)
    ? { kind: 'schedule' as const, ...cron(text) }
    : { kind: 'manual' as const, spec: 'manual', description: 'when somebody runs it' }

  nodes.push({ id: 'trigger', type: 'trigger', label: `Trigger — ${trigger.description}`, next: ['find'] })

  // What it looks for.
  const days = DAYS.exec(text)
  const threshold = days ? Number(days[1]) : null
  // `qualifier` is how the subject is narrowed, in the readback's own words. An overdue
  // task is already narrowed by the word "overdue"; a customer thread is not.
  let query: { ref: string; label: string; subject: string; qualifier: string }
  if (QUIET.test(text)) {
    query = {
      ref: 'stale_customer_threads',
      label: threshold
        ? `Find customer threads with no reply for ${threshold} days`
        : 'Find customer threads past their reply SLA',
      subject: 'customer thread',
      qualifier: threshold ? ` with no reply for ${threshold} days` : ' past its agreed reply time',
    }
  } else if (OVERDUE.test(text)) {
    query = { ref: 'tasks_overdue', label: 'Find overdue tasks', subject: 'overdue task', qualifier: '' }
  } else if (RENEWAL.test(text)) {
    return {
      name: title(text),
      graph: { trigger, nodes },
      readback: '',
      risks: [],
      unsupported:
        'Renewal dates are on the company record, but there is no named query for "contracts expiring soon" yet. ' +
        'Add one to the safe query layer and this sentence will compile.',
    }
  } else {
    return {
      name: title(text),
      graph: { trigger, nodes },
      readback: '',
      risks: [],
      unsupported:
        'I could not tell what this should look for. Name the thing to watch — threads with no reply, overdue ' +
        'tasks — and I will compile it. Guessing here would produce an automation nobody can predict.',
    }
  }

  nodes.push({
    id: 'find',
    type: 'query',
    label: query.label,
    ref: query.ref,
    args: threshold ? { slaDaysOverride: threshold } : {},
    next: ['each'],
  })
  nodes.push({ id: 'each', type: 'for_each', label: `For each ${query.subject}`, next: [] })

  // What it does with each one.
  const actions: WorkflowNode[] = []
  if (CREATE_TASK.test(text)) {
    actions.push({
      id: 'task',
      type: 'action',
      label: 'Create a dated follow-up task for the account owner',
      ref: 'create_task@v1',
      args: {},
      next: [],
    })
  }
  if (DRAFT_EMAIL.test(text)) {
    actions.push({
      id: 'draft',
      type: 'action',
      label: 'Draft a reply referencing the last exchange',
      ref: 'draft_email@v1',
      args: {},
      next: [],
    })
  }
  if (actions.length === 0) {
    return {
      name: title(text),
      graph: { trigger, nodes },
      readback: '',
      risks: [],
      unsupported:
        'I could not tell what this should do about what it finds. Say "create a task" or "draft a reply" — ' +
        'those are the actions a workflow may take on its own.',
    }
  }

  // Risks, and what the compiler does about them.
  const sendsExternally = SEND.test(text) && !APPROVE.test(text)
  if (actions.some((node) => node.ref === 'draft_email@v1')) {
    risks.push({
      severity: 'high',
      message: 'This produces messages addressed to people outside the company.',
      mitigation:
        'An approval step was added before anything leaves. Superwork never sends externally without a person ' +
        'saying yes, whatever the sentence asked for.',
    })
  }
  if (sendsExternally) {
    risks.push({
      severity: 'high',
      message: 'The description asked for the message to be sent, not drafted.',
      mitigation: 'Compiled as a draft plus an approval. Sending is a decision a person makes.',
    })
  }
  if (trigger.kind === 'schedule' && !threshold && QUIET.test(text)) {
    risks.push({
      severity: 'medium',
      message: 'No quiet period was given, so the account SLA on each customer decides.',
      mitigation: null,
    })
  }

  const needsApproval = actions.some((node) => node.ref === 'draft_email@v1') || APPROVE.test(text)
  const chain: string[] = actions.map((node) => node.id)
  nodes.push(...actions)

  if (needsApproval) {
    nodes.push({
      id: 'approve',
      type: 'approval',
      label: 'Hold the batch for approval',
      next: NOTIFY.test(text) ? ['notify'] : [],
    })
  }
  if (NOTIFY.test(text)) {
    nodes.push({ id: 'notify', type: 'notify', label: 'Tell the account owner what happened', next: [] })
  }

  // Wire the graph: for_each fans out to each action, actions converge on approval.
  const forEach = nodes.find((node) => node.id === 'each')!
  forEach.next = chain
  for (const action of actions) {
    action.next = needsApproval ? ['approve'] : NOTIFY.test(text) ? ['notify'] : []
  }

  return {
    name: title(text),
    graph: { trigger, nodes },
    readback: readbackFor({ trigger, nodes }, query.subject, query.qualifier),
    risks,
    unsupported: null,
  }
}

function title(text: string): string {
  const words = text.replace(/[^a-zA-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 6)
  return words.length ? words.join(' ').replace(/^\w/, (c) => c.toUpperCase()) : 'Untitled workflow'
}

/**
 * The plain-English readback (§10.3.3). A person approves this sentence, not the JSON —
 * so it has to describe the graph that will actually run, including the approval step the
 * compiler inserted whether or not it was asked for.
 */
export function readbackFor(graph: WorkflowGraph, subject: string, qualifier = ''): string {
  const parts: string[] = []
  parts.push(
    graph.trigger.kind === 'schedule'
      ? `${capitalize(graph.trigger.description)},`
      : 'When somebody runs it,',
  )
  const query = graph.nodes.find((node) => node.type === 'query')
  parts.push(`for every ${subject}${qualifier}`)
  const actions = graph.nodes.filter((node) => node.type === 'action')
  const described = actions.map((node) =>
    node.ref === 'create_task@v1' ? 'create a dated task for its owner' : 'draft a reply',
  )
  parts.push(described.join(' and '))

  if (graph.nodes.some((node) => node.type === 'approval')) {
    parts.push('and hold everything for you to approve before anything is sent')
  }
  if (graph.nodes.some((node) => node.type === 'notify')) {
    parts.push('then tell the account owner what happened')
  }
  return `${parts.join(' ')}.${query ? '' : ''}`
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
