# ADR 0054 — A send that can be stopped

**Status:** accepted · **Date:** 2026-08-19

## Context
`send_email` declares `recallWindowSeconds` in its **own output schema**. It dates the row a
minute ahead, enqueues the dispatch with `notBefore` on it, and the worker reads `recalled_at`
before handing anything to the provider — the comment there has always said "the recall window: a
user who changes their mind inside it wins".

Nothing has ever written `recalled_at`. The window was a delay with no button behind it, and the
tool had been telling every caller about a recall the product did not have. Two more columns on
the same table were in the same state: `failed_at` and `error` were never written, so a send that
had exhausted its retries looked exactly like one still waiting for its window to close.

## Decision

**The row arbitrates, not the order the code happens to check things in.** The worker used to
read `recalled_at` and *then* call the provider. A recall arriving between those two would have
set `recalled_at` on a message the recipient already had — the database saying "recalled" while
the outside world had the email, which is the worst of the available lies.

So dispatch **claims** the row first: a conditional update that sets `dispatch_started_at` only
if the send is unsent, unrecalled and due. A recall is a conditional update that succeeds only if
the claim has not been taken. Whichever statement finds no row is the one that lost, and neither
side has to be trusted to check in the right order (ADRs 0028, 0030, 0040, 0047). The CHECK that
a send cannot be both recalled and sent is the backstop that should never fire.

**Stopping your own outgoing message needs no permission.** A member has `email:draft:own` and no
send permission at all. Requiring `email:send` to *stop* a send would mean watching your own
mistake leave while the one person who could call it back was in a meeting. Recall is the
narrowing direction throughout: it does not ask for a fresh proof either (ADRs 0044, 0046, 0050).
Somebody else's send still needs the permission that could have sent it.

**A stopped draft goes back to `draft`, not to `approved`.** Somebody changed their mind about
sending this; sending it again should need the approval again, because the thing that was
approved is the thing they no longer want sent (§25.7).

**The reason is required and recorded**, with who stopped it, held together by a CHECK. Stopping
an approved, externally visible send reverses a decision somebody had already made, and the
record should say who changed their mind and why.

**That check is `NOT VALID`, deliberately.** Rolling this migration back drops the attribution
columns, so a send already stopped returns with `recalled_at` set and nobody named — and
re-applying would then refuse over the product's own seeded data. This was found by the ordering
check (`db:reset && db:seed && db:rollback && db:migrate`), not by reading. The constraint is
enforced on everything written from here on, which is what it is for. Inventing a name for a
recall that happened before the column existed would be worse than admitting the row predates it.

**Waiting is not failing.** A dispatch message whose send is not due yet is now *deferred* — put
back with its attempt returned — rather than thrown and counted as a failure. The outbox
dead-letters after six attempts with exponential backoff, so a recall window an organization
lengthened could otherwise exhaust the retry budget of the very send it was protecting. This path
was hard to reach in practice, because `notBefore` already keeps the message out of the batch; it
is fixed because the alternative is a trap laid for whoever changes the window.

**A send that gave up says so on its own row.** `failed_at` and `error` are written when the
outbox message reaches its terminus, and the claim is released when it does not — an attempt that
failed is not an attempt that reached anybody.

## What is deliberately not built

**A settable recall window.** `EMAIL_SEND_DELAY_SECONDS` is deployment configuration, and the
number is the same for everybody in an installation. Making it a per-organization setting is the
same pattern as ADRs 0046 and 0050 and should be done when somebody asks for a different number,
not before — the screen already tells a person exactly how long they have.

**Recalling after it has gone.** There is no such thing. The refusal says so and names the honest
next step: write to them again. A product that offered to unsend a delivered message would be
lying about something the recipient can see.

**Undo on the inbox.** The panel lives on Approvals, because that is where the decision to send
was made and where somebody who has just changed their mind is still standing.

## Consequences
- The Approvals screen shows what is on its way out, with a live countdown that starts from the
  number the server rendered and only ticks after mount — a clock that renders a different second
  on each side is the hydration mismatch this product has already been bitten by.
- Once the window closes the button stays, and the label changes to say stopping only works until
  the send begins. Hiding it would take away a stop that would have worked.
- The demo seeds one approved email waiting out its real window, so the screen has something in
  the state the window exists for. A running worker sends it a minute later, exactly as in life.
- Fifteen tests, including four on the race in both directions; removing the claim condition from
  the recall makes one of them fail.
