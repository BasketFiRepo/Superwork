# ADR 0047 — When you are written to

**Status:** accepted · **Date:** 2026-08-17

## Context
`notification_preferences` has held three columns since migration 0010 that nothing has ever
honoured.

**`quiet_hours`** defaulted to 18:30–08:30 for everybody and was consulted by no code path at
all. So a comment mentioning somebody at half past eleven at night reached them immediately, and
the reminder ladder — which had learnt about weekends and public holidays (ADR 0039) — knew
nothing about the evening. The screen showed the window read-only under a *Coming soon · phase 6*
chip, which was honest and useless.

**`channel_defaults`** and **`per_type`** are the shape of "which of these do I want the moment
it happens, and which can wait for the morning". Every notification in the product was written
by a hand-rolled `INSERT INTO notifications` with `delivery` hard-coded at the call site —
**seven call sites** — so the person being written to had no say, and no call site could have
given them one without every other call site agreeing.

## Decision

**One writer.** `notify()` is now the only way a notification is created. Routing a notification
is not a decision a call site should make: it is a fact about the recipient, and the recipient is
the same person whichever subsystem is writing to them. Seven inserts became seven calls, and
the two decisions — how it is delivered and when it becomes visible — are made in one place
where they can be read, tested and changed.

**Quiet hours hold; they never drop.** The row is written the moment the thing happens, with
`deliver_after` set to the end of the recipient's window, and becomes visible when the window
opens. `deliver_after` has been on the table since migration 0005, defaulted to `now()` and
written by nothing — it is exactly the mechanism this needs. No sweep releases anything: the read
path compares to `now()`, so a stopped worker cannot hide a notification, and a notification that
silently did not arrive stays impossible. This is the same reasoning as the ladder saying *why*
it held a reminder rather than appearing to lose it.

**The window is the recipient's, in the recipient's timezone.** Not the organization's, not the
server's (§26.5). The end of the window is computed from wall-clock parts rather than by adding
hours, so on the morning the clocks change it still ends at the time the person wrote down.

**A window may not cover the day.** Sixteen hours is the ceiling, so at least eight hours a day
a colleague can reach you. "Never write to me" is not on offer: people rely on reaching each
other through this product, and the honest form of that wish is turning individual kinds down,
one at a time, in the open. Refused with the number that stopped it, and refused again by a CHECK
constraint calling an `IMMUTABLE` validator — the shape inside jsonb is exactly where a typo
would otherwise be stored and then silently ignored, which is a preference that appears to save
and does nothing.

**Three deliveries, and none of them is "lost".** `immediate` interrupts, subject to the window.
`digest` does not interrupt and arrives in the daily briefing — a delivery mode with nowhere to
arrive would be a setting that changes nothing, so the briefing gained a *Waiting for you here*
section built from those rows. `none` is still recorded: it does not appear in the list or on the
badge, and it can be found by somebody who goes looking. Turning a kind back on does not rewrite
what happened while it was off.

**Two kinds cannot be turned down.** `disclosure` — the notice that something about you reached
somebody else — and `agent_needs_input`. The product's claim is that nothing about a person
reaches their manager that the person has not already seen (§29.3); a preference that could
switch that off would make the guarantee a setting, and a guarantee somebody can turn off is not
one. Enforced in the setter *and* in `notify()`, so a row written by anything else still cannot
mute it.

**And the disclosure is now actually sent.** `recordDisclosure` wrote a row on the subject's own
record and told them nothing — the guarantee relied on the person thinking to go and look. It
now notifies them in the same transaction as the record, which is the same argument the
disclosure itself makes about being written in the same transaction as the delivery.

**A reminder is scheduled into the open hours, and checked again at delivery.** Scheduling shifts
a rung past the recipient's window as well as past their weekend, because the ladder tells people
when it will arrive and the row should say something true. Delivery checks anyway: a window can
change after a rung is written, which is the same reason ADR 0039 checks the calendar at delivery
rather than trusting the scheduled date.

**It is the person's own, entirely.** `onlyYourOwn` on the read, `actor.userId` on the write. No
administrator sets somebody else's quiet hours, for the same reason no administrator enrols
somebody else's second factor (ADR 0043): "who may write to me at eleven at night" is not a
management decision.

## What is deliberately not built

**Email as a real channel.** `channel_defaults` keeps an `email` key and the product still sends
nothing outbound without a person pressing send (§25.7). The in-app channel is the one that
exists, so it is the one that is settable; an email column that routed nothing would be the
defect this ADR is about.

**Per-type quiet hours.** One window per person. A window per kind is a plausible next step and
a much larger surface — and the honest way to say "not this kind, ever" already exists.

## Consequences
- `notifications.delivery` is constrained to the three deliveries, and `disclosure` joins the
  known types.
- The badge counts only what is both visible and immediate, so a held or turned-down
  notification cannot inflate it.
- Marking notifications read can no longer mark something the person cannot yet see.
- Three test packs and two acceptance loops had to name the hour they meant, because they
  asserted that something arrives and that now depends on the recipient's window — the same cost
  ADR 0039 imposed when the product learnt what a weekend is. `makeReachable` in the fixtures
  says it out loud, and the loops ask the ladder when its next rung is due rather than picking an
  hour of their own.
