import NextLink from 'next/link'
import type { ComponentProps } from 'react'

/**
 * Every link in Superwork.
 *
 * `next/link` prefetches each link as it scrolls into view. That is a good bargain for an app
 * whose routes can be prepared in advance, and this is not one: every screen here is
 * `force-dynamic` — it reads the signed-in person's own rows, through row-level security, at the
 * moment they ask — and none of them has a loading boundary. Next knows that, so a prefetch of
 * one of these routes answers in six milliseconds with a hundred and eighty-three bytes that say
 * "nothing can be prepared for this", and caches nothing at all.
 *
 * Opening the task list fired a hundred and forty-four of them: one per row, one per navigation
 * item. Nothing was made faster by any of them. So links here do not prefetch, and the rule is
 * one import rather than three hundred call sites — `tests/unit/link-prefetch.test.ts` refuses a
 * file that reaches for `next/link` directly, because a rule that lives in a code review is a
 * rule until somebody is in a hurry.
 *
 * `prefetch` comes before the spread, so the day a screen has a loading boundary worth preparing
 * — which is the thing that would make a prefetch return something — that link can pass it and
 * say why.
 */
export function Link(props: ComponentProps<typeof NextLink>) {
  return <NextLink prefetch={false} {...props} />
}
