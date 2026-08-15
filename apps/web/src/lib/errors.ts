import { NextResponse } from 'next/server'
import { StepUpRequiredError, SuperworkError, type FailureClass } from '@superwork/core'

/**
 * One place that turns a thrown domain error into a response.
 *
 * `StepUpRequiredError` needs its own shape: the caller can fix it by proving who they
 * are, so it answers 401 with a flag the client reads to ask for a password — rather than
 * a flat "not permitted" shown to somebody who is, in fact, permitted.
 *
 * Everything else answers with the status its failure class means. This used to be 400 for
 * every domain error, which made a refusal and a missing row indistinguishable to any
 * caller that did not read the prose — including our own screens. The insight card is the
 * case that surfaced it: its refusal says the rating alone would be accepted, and it cannot
 * offer that without knowing a refusal is what happened.
 *
 * A row in another tenant throws `NotFoundError`, so cross-tenant access answers 404 and
 * never 403 (§3.2) — the status now carries that distinction rather than flattening it.
 */
const STATUS_BY_CLASS: Partial<Record<FailureClass, number>> = {
  auth: 401,
  permission: 403,
  not_found: 404,
  conflict: 409,
}

export function errorResponse(error: unknown, fallback = 'That could not be done.'): NextResponse {
  if (error instanceof StepUpRequiredError) {
    return NextResponse.json({ error: error.message, stepUpRequired: true, action: error.action }, { status: 401 })
  }
  if (error instanceof SuperworkError) {
    // The class travels in the body too: a client branching on it does not have to match
    // against a sentence somebody will reword.
    return NextResponse.json(
      { error: error.message, failureClass: error.failureClass },
      { status: STATUS_BY_CLASS[error.failureClass] ?? 400 },
    )
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : fallback },
    { status: 400 },
  )
}
