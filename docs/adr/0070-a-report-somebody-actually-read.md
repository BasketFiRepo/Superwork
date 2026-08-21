# ADR 0070 — A report somebody actually read

**Status:** accepted · **Date:** 2026-08-21

## Context

`agent_digests.read_at` has existed since the digest was built and nothing has ever written it.
`listDigests` selects it into every `DigestView`; `DigestPanel` — the only thing that renders a
digest — never receives it. Another column the interface fetches and drops.

Reading the code for *why* turned up the bigger half. The digest's own header says an agent that
acts unattended "has to report, in one place, everything it did", and the AI-governance screen
says "Every agent has a named accountable human". `saveDigest` writes the row, writes a
disclosure to everyone named in it, and **tells the owner nothing**.

The report was filed to a table the accountable human reaches only by opening Settings,
choosing Agents, choosing that agent, and scrolling. An agent reporting into a void is not
reporting, and `read_at` could not be written because there was nothing to read it *from*.

## Decision

**The digest is delivered.** `saveDigest` notifies its recipient — a new `agent_digest`
notification type, pointing at the agent so the notification is a way in rather than a summary
to squint at.

**It is muteable, unlike a disclosure.** A weekly summary is not an interruption, and an owner
who prefers to read these on the agent page is entitled to say so. What governance reads is the
*receipt*, not the notification, so silencing the one does not hide the other. `disclosure` and
`agent_needs_input` stay unmuteable for the reasons already written beside them.

**The receipt is the recipient's and nobody else's.** `markDigestRead` moves only a row whose
`recipient_user_id` is the person asking, and `sw_digest_read_by_recipient` makes the weaker
half true of every writer. Somebody else marking a report read would forge the one fact the
governance screen reads to decide whether an agent is overseen at all.

**It is a person's act, not a page render.** The panel offers "I have read this" rather than
marking on view. An automatic receipt records that a browser fetched something, and this column
is asked to mean that a human read it.

**The first read is the one recorded.** A second visit does not move the date, so "how long
that report sat unread" stays answerable.

**Two unread reports withhold autopilot** — the same lever ADR 0068 uses for a stale
recertification, and for the same reason: an agent nobody is reading is unattended in both
directions. **One missed week is forgiven on purpose.** A person on holiday should not silently
change what their agent is allowed to be, and a rule that fires on the first miss would be
switched off within a month.

## The thing this must not become

Counting reports somebody has not read is one query away from measuring a person, and §29.5
forbids individual productivity scoring by construction rather than by policy.

The line is drawn where it can be checked: `unreadDigests` counts **per agent**, and there is no
aggregate keyed on the recipient anywhere. The test asserts that — it greps the source for
`GROUP BY recipient_user_id` and requires none — because the difference between "which agents
are overseen" and "who is bad at reading their post" is only that nobody wrote the second query,
and that is not a difference a comment can hold.

The screen follows the same rule: what an administrator reads on the agent page is exactly what
the owner reads. Nothing about a person's reading habits reaches anybody by a route the person
cannot see, which is §29.3 applied to the one new fact this introduces.

## Consequences

- An agent's weekly report reaches the person accountable for it, for the first time.
- The panel says "1 report Maya Ellison has not read" or "Read by Maya Ellison", and each
  report carries `read` or `not read`.
- Two unread reports drop an autopilot agent to `execute` and the run says which reports are
  outstanding on its own timeline.
- `agent_digests.read_at` comes off the detector's queue: **100 → 99**.
