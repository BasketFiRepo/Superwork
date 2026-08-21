# ADR 0067 — A check that can be run twice

**Status:** accepted · **Date:** 2026-08-21

## Context

`scripts/browser-check.ts` is the only thing in this project that opens a real browser and
presses the buttons. Nothing else can tell you that a control exists, is reachable, says what it
does and does what it says. Every increment for the last twenty has been signed off partly on
its word.

It could only be run once.

The second run died four beats after the company walk, on
`waiting for locator('[data-testid="add-contact-open"]')` — a selector with nothing to do with
companies. The actual sequence: the walk adds a company with the domain `browsercheck.example`;
on the next run that domain is taken, so the create is refused; a refused create leaves the
editor open; and `add-contact-open` only renders when the editor is closed. The failure named
the fourth consequence of the first cause.

The walk's own comment said it "accepts either outcome: added now, or already there from a
previous run. A second run must not turn a working check red over a row the first one left."
The intent was written down and not met, which is the most expensive kind of comment.

Behind that one there were seven more, all the same shape. The check consumes demo state as
well as creating it: it stops the one approved email waiting out its recall window, agrees with
every memory candidate the seed provides, lifts the restriction on the Coldstore agreement,
extends the rate card's term past its end. And three creates — a department, a milestone, a
knowledge space — succeeded once and were refused afterwards, each refusal counting as a stray
400 against the check's own last beat, *"No console errors on any screen"*.

This cost a verification run twice in two days and was reported both times without being fixed,
which is how a known defect becomes a habit.

## Decision

**Every walk tells the two runs apart before it types anything.** Not by catching the failure
afterwards — by asking first. `alreadyMade(container, text, editor)` answers "is this here
already", and closes the editor the walk was about to fill in. The three creates use it, and
each reports which run it was: *"made now"* or *"made by an earlier run, and not made twice"*.
Nothing is refused, so nothing arrives as a 400 nobody expected.

**A walk that consumes state says what it found.** Stopping a send is terminal — it goes back
to being a draft and needs approving again — and agreeing with a memory candidate takes it off
the list for good. Those cannot be put back, so the run that finds them gone asserts what is
true of *that*: nothing is on its way out, or nothing is waiting to be agreed with, and the
panel says where such things come from. Both branches are statements about the product; neither
is a skip.

**A walk that can put something back, does.** The rate card's term is extended and then set
back to where the demo had it, through the same control — otherwise the next run finds no
expired document to ask about, and the state this walk exists to check quietly leaves the demo.

**Two assertions were narrower than the beat they were named for.** *"A thread says whether
anybody has decided who may read it"* checked only for "nobody has". Once somebody has, the
attribution survives being set back down — that is the whole point of recording who decided
(ADR 0061) — and the beat's own name covers both. It now checks what it says.

**Two `.first()` calls were asserting about a row they had not chosen.** *"And can take their
own words back again"* took the first comment on the task, and the assistant leaves comments
there too, which nobody may remove. *"And the owner can take it back again"* took the first
share, which may be one somebody else granted. Both are now scoped to the row this run created.
They were fragile before this change and would have failed on any demo whose ordering differed;
the second run is what made them fail reliably enough to see.

**The run the model-cost walk needs is found by asking what a run cost.** It used to read run
links out of the activity feed, which shows the newest handful — and every walk above it starts
runs of its own, so on a second run both visible links were tool-only workflow runs and the
model-calling ones were buried. Analytics lists runs with their cost, and a run with a cost is a
run that called a model. That is the question the walk is asking, so it is now the question it
asks.

**CI runs it twice.** The step costs about two minutes. Without it this rots again within a
month, and the next person to find out is whoever needs the check to work on a Friday.

## What this is not

It is not a mode. There is no `--fresh` flag and no reset between the runs: the check works out
where it is from what is on the screen, the way a person would. A second code path that only CI
exercises would be a second thing to keep true.

It is not a licence to leave the demo dirty. Where a walk can put something back it still does,
and most do. This is about the handful that genuinely cannot.

## Consequences

- `pnpm check:browser` passes twice, and three times, against one seeded demo — 334 beats on the
  fresh run, 322 and 321 on the ones after, the difference being walks that correctly took the
  already-done branch.
- The eight beats that assumed a virgin database now say which run they are on.
- The check no longer generates 400s it did not intend, so its "no console errors" beat means
  what it says on every run rather than only the first.
- CI proves the property instead of a comment claiming it.
