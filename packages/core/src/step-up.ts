import type { Actor } from '@superwork/auth'
import { PermissionError } from './errors.js'

/**
 * Step-up authentication (§4.1).
 *
 * A permission answers "may this person do this at all". Step-up answers a different
 * question — "is the person who may do it still the one at the keyboard" — and it is asked
 * only of the handful of actions nobody can take back: publishing an agent, widening what
 * one may do, pointing a tool at somebody else's system, turning the kill switch off.
 *
 * The threat is a session, not a password: an unlocked laptop, a lifted cookie, a tab left
 * open in a shared room. So the proof has to be recent, and five minutes is recent enough
 * to be true and short enough to be worth something.
 */
export const STEP_UP_MAX_AGE_MS = 5 * 60_000

/** The actions that require it. The UI reads this list too, so the two cannot disagree. */
export const STEP_UP_ACTIONS = {
  'agent.publish': 'publishing an agent, or widening what one is allowed to do',
  'agent.rollback': 'restoring an agent to an earlier configuration',
  'custom_tool.activate': 'letting a tool call a system outside this company',
  'custom_tool_host.review': 'adding a system that tools may call',
  'kill_switch.release': 'letting the agents run again',
  'retention.set': 'changing how long Superwork keeps something',
  'erasure.execute': 'erasing a person from this organization',
} as const

export type StepUpAction = keyof typeof STEP_UP_ACTIONS

export function isSteppedUp(actor: Actor, now = new Date()): boolean {
  if (!actor.steppedUpAt) return false
  return now.getTime() - actor.steppedUpAt.getTime() <= STEP_UP_MAX_AGE_MS
}

/**
 * Throws unless the actor re-authenticated recently. Called in the repository, beside the
 * permission check, so an action cannot be reached without it by way of a different caller
 * — the API layer asking politely is not a control.
 */
export function assertSteppedUp(actor: Actor, action: StepUpAction, now = new Date()): void {
  // An agent has no keyboard to be sitting at. It cannot step up, and it must never be
  // able to do any of these — the change-control path exists for exactly that reason.
  if (actor.type !== 'user') {
    throw new PermissionError(
      `Only a person can confirm ${STEP_UP_ACTIONS[action]}. This was attempted by ${actor.type === 'agent' ? 'an agent' : `a ${actor.type}`}.`,
    )
  }
  if (!isSteppedUp(actor, now)) {
    throw new StepUpRequiredError(action)
  }
}

/**
 * Distinct from a plain refusal: the caller can fix this by asking for a password, and the
 * interface needs to tell them so rather than showing "not permitted" to somebody who is.
 */
export class StepUpRequiredError extends PermissionError {
  override readonly name = 'StepUpRequiredError'
  readonly action: StepUpAction

  constructor(action: StepUpAction) {
    super(
      `Confirm your password to continue — ${STEP_UP_ACTIONS[action]} cannot be undone, ` +
        'so Superwork checks that it is still you.',
    )
    this.action = action
  }
}
