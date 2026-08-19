# ADR 0058 — The one error the check names

**Status:** accepted · **Date:** 2026-08-19

## Context

`Every screen, in a real browser` ends by asserting that nothing was written to the console on the
way round. That assertion has been failing on about one run in eight, always with the same line:

```
Minified React error #418 (on /tasks?filter=all)
```

#418 says React found that the DOM it had been handed did not match the tree it was hydrating,
threw the tree away, and rendered the screen again on the client. It had already cost re-runs on
four pull requests. ADR 0055's postscript blamed `new Date()` in a server component and introduced
`requestNow()`; three clean runs followed and the diagnosis looked settled. It was not — the same
line came back on PR #56, whose diff does not touch that screen.

So it was chased properly, in a production build, against a fresh demo, with the document
throttled so it reproduces at ten to fifteen per cent instead of one in eight. What that ruled out
is more useful than what it found:

- **The server is not sending two different things.** The page renders its own clock once per
  request through `requestNow()`; two hundred and fifty consecutive responses were checked and the
  HTML and the flight payload it is built from never disagreed once.
- **The browser is not misreading it.** With the client bundle blocked, so nothing could touch the
  DOM after it was parsed, the tree the parser built is byte-identical to what the server sent.
- **The page React leaves behind is right.** Captured on a failing load, the recovered DOM is
  identical to the server's HTML — comments, entities and all. Nothing is wrong on the screen; it
  was rendered twice.
- **It is not the size.** Twenty-five rows missed *more* often than a hundred. Below about twelve
  rows it stops, and above that the rate is flat.
- **It is not the data.** The rows either side of the threshold are the plainest on the screen.
- **It is not prefetching.** An early experiment that blocked every prefetch came back clean
  twenty times out of twenty, which was wrong: intercepting requests slows every one of them,
  including the ones being measured. With prefetching genuinely removed — zero prefetch requests
  on the screen — it still happens.
- **It is not a version we can leave behind.** Next is already on the last 15.5 release.

A **loading boundary does fix it**: `app/(app)/loading.tsx` hydrates the shell separately from the
screen, and thirty consecutive throttled loads came back clean where the baseline was two to four
per twenty. It also breaks `router.refresh()`, which sixty components here use to replace an
optimistic update with the truth — three refresh-dependent assertions failed in every run with it
in place and none without. That cure is worse than the disease, and the disease is a screen being
rendered twice.

## Decision

**The check names this one error and counts it, rather than failing on it or hiding it.** Every
other console error is still fatal. The exemption is matched on the exact error code, so nothing
else can arrive through the same door, and every run prints either

```
· React hydrated every screen without having to render it again
```

or the count and the screens it happened on. If that number climbs, or names a screen it has never
named before, somebody should read this file again rather than shrug at a green run.

What makes that safe is that this assertion is not what holds a screen to account. By the time it
runs, every screen has already had to show its rows, its numbers, its refusals and its states, and
any of those failing is still red. The thing being tolerated is a screen rendering twice and
arriving at the same answer — which is exactly what was measured, four different ways.

**A list no longer prefetches every row.** This came out of the same investigation and stands on
its own. `next/link` prefetches every link that scrolls into view; opening the task list fired a
hundred and forty-four such requests — one per row, one per navigation item. Every screen here is
`force-dynamic` and none has a loading boundary, so Next cannot prepare any of them: each request
answers in six milliseconds with a hundred and eighty-three bytes that say so, and caches nothing.
A hundred and forty-four round trips bought nothing at all.

So links come from `@/components/Link`, which sets `prefetch={false}` before the spread. One
import states the rule; `tests/unit/link-prefetch.test.ts` refuses the file that reaches for
`next/link` directly, because a rule that lives in a code review is a rule until somebody is in a
hurry. `prefetch` comes before the spread so that the day a screen has a loading boundary worth
preparing — the thing that would make a prefetch return something — that link can pass it and say
why.

## Alternatives

**Suppress the error quietly.** This repository has already recorded that a red check somebody
re-runs by habit is worse than no check; a green one that got there by not looking is worse still.
Counting and printing it costs one line of output and keeps the fact in front of whoever reads the
run.

**Fail on it and re-run.** That is what has been happening. It taught four pull requests' worth of
reviewers that a red browser job means "press it again", which is the habit worth the most to
avoid.

**Take the loading boundary and repair `router.refresh()`.** Sixty components would have to change
their idea of what happens after a write, to fix a screen that renders twice and gets the right
answer. Wrong order of costs.

**Shorten the list.** Twenty-five rows missed more often than a hundred, so this would have been a
change that felt like a fix and was not — which is the reason the measurement was made before the
change rather than after.

## Consequences

- The browser job stops being randomly red, and says on every run whether the condition occurred.
- Opening the task list makes a hundred and forty-four fewer requests. The browser check asserts
  it directly: `0 prefetches` for a hundred rows, and the row still opens when it is pressed.
- Nothing is prefetched anywhere any more. Nothing was being prepared by it, so nothing is lost —
  and the day a screen earns a loading boundary, its links can ask for prefetching by name.
- `scripts/browser-check.ts` carries the reasoning where it is enforced, not only here, because
  the next person to see #418 will be reading the check and not the ADR index.
