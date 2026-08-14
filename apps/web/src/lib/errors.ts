import { NextResponse } from 'next/server'
import { StepUpRequiredError } from '@superwork/core'

/**
 * One place that turns a thrown domain error into a response.
 *
 * `StepUpRequiredError` needs its own shape: the caller can fix it by proving who they
 * are, so it answers 401 with a flag the client reads to ask for a password — rather than
 * a flat "not permitted" shown to somebody who is, in fact, permitted.
 */
export function errorResponse(error: unknown, fallback = 'That could not be done.'): NextResponse {
  if (error instanceof StepUpRequiredError) {
    return NextResponse.json({ error: error.message, stepUpRequired: true, action: error.action }, { status: 401 })
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : fallback },
    { status: 400 },
  )
}
