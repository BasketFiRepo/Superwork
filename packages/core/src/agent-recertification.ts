/**
 * Whether anybody still stands behind what an agent may do (ADR 0068).
 *
 * `agents.recertified_at` has existed since migration 0006, is selected into `AgentPersona`
 * and again by the AI-governance screen's own query, and is written by nothing and rendered
 * nowhere.
 *
 * The control it was for is the one this product otherwise has no version of. Publishing takes
 * two people and a step-up — one proposes, another approves — and that happens when something
 * *changes*. Nothing happens when nothing changes, so an agent granted `email:send` and
 * `restricted` reading in March still holds them in December, and the only record is a
 * publication nine months old.
 *
 * The rule is pure and lives here rather than in SQL because three places have to agree about
 * it: the screen that shows the state, the repository that refuses to widen a stale agent, and
 * the runtime that lowers its ceiling. A rule computed three times is a rule that will differ
 * three ways.
 */

export type CertificationState =
  /** Nobody has ever said this configuration is right. */
  | 'never'
  /** Somebody has, recently enough, and about the configuration that is running. */
  | 'current'
  /** Somebody has — about a configuration that has since been republished. */
  | 'changed'
  /** Somebody has, about this configuration, longer ago than the organization allows. */
  | 'expired'

export interface Certification {
  state: CertificationState
  /** When the standing attestation runs out. Null when there is nothing to run out. */
  dueAt: Date | null
  daysOverdue: number
  /** True for every state but `current` — the one thing callers usually want to ask. */
  stale: boolean
  /** What a screen should say, and what a refusal should quote. */
  summary: string
}

const DAY_MS = 86_400_000

export interface CertifiableAgent {
  name: string
  /**
   * The ordinal of the published configuration — `agent_versions.ordinal`, or 0 for an agent
   * that has never been through the approval flow.
   *
   * Deliberately not `agents.version`, which the touch trigger increments on *every* write to
   * the row. Anchoring on that would mean pausing an agent for the weekend invalidated the
   * attestation, and pausing narrows what it may do. What an attestation is about is the
   * configuration, and the configuration changes when somebody publishes one.
   */
  publishedVersion: number
  recertifiedAt: Date | null
  recertifiedVersion: number | null
  recertifiedByName?: string | null
}

/**
 * Reads an agent's attestation against the organization's interval.
 *
 * **Republication makes it stale immediately**, before any interval has passed, and that is the
 * more important half: an attestation is about a configuration, not about an agent. "Reviewed in
 * March" said of something republished twice since is a date attached to nothing — which is why
 * the version is recorded beside the date rather than the date alone.
 */
export function certificationState(
  agent: CertifiableAgent,
  intervalDays: number,
  now: Date = new Date(),
): Certification {
  if (!agent.recertifiedAt || agent.recertifiedVersion === null) {
    return {
      state: 'never',
      dueAt: null,
      daysOverdue: 0,
      stale: true,
      summary: `Nobody has confirmed what ${agent.name} may do.`,
    }
  }

  const by = agent.recertifiedByName ?? 'Somebody'
  const on = agent.recertifiedAt.toISOString().slice(0, 10)

  if (agent.recertifiedVersion !== agent.publishedVersion) {
    return {
      state: 'changed',
      dueAt: null,
      daysOverdue: 0,
      stale: true,
      summary:
        `${by} confirmed version ${agent.recertifiedVersion} on ${on}. ` +
        `${agent.name} is on version ${agent.publishedVersion} now, so that was about a different ` +
        'configuration.',
    }
  }

  const dueAt = new Date(agent.recertifiedAt.getTime() + intervalDays * DAY_MS)
  if (now.getTime() > dueAt.getTime()) {
    return {
      state: 'expired',
      dueAt,
      daysOverdue: Math.floor((now.getTime() - dueAt.getTime()) / DAY_MS),
      stale: true,
      summary: `${by} confirmed this on ${on}, which was more than ${intervalDays} days ago.`,
    }
  }

  return {
    state: 'current',
    dueAt,
    daysOverdue: 0,
    stale: false,
    summary: `${by} confirmed version ${agent.recertifiedVersion} on ${on}.`,
  }
}

/** The organization's interval, with the default the schema states when nothing is set. */
export const DEFAULT_RECERTIFICATION_DAYS = 90
