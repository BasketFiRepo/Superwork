# ADR 0089 — A scan that was written down

**Status:** accepted · **Date:** 2026-08-31

## Context

Two scans have run over every inbound message since Phase 2. `sanitizeMessage` strips remote
images, scripts and embeds and counts the links; `detectInjection` looks for an instruction aimed
at the assistant. Both run **on every read**, recomputed each time, and neither was recorded when
the message arrived.

`messages.sanitized_at`, `remote_image_count` and `link_count` had no writer at all. So the
question *"which correspondence carried a script, or a tracking pixel?"* had no answer — the
finding existed for exactly as long as it took to render one thread, and was thrown away.

`injection_flagged` had one writer, and it is the sharp part: `ground.ts`, which sets the flag when
an **agent** happens to ground on the thread during a run. Nothing sets it when the message lands.

That produces two screens disagreeing about the same message:

| Screen | How it decides | What it showed |
|---|---|---|
| Thread view | re-scans the body on read, ORs with the column | **flagged** |
| Inbox list | `EXISTS (… AND injection_flagged)` — an aggregate over conversations has nothing to re-scan with | **not flagged** |

So a thread carrying an injection attempt showed no flag until some agent grounded on it — and the
list is the screen triage works from. The safer-looking screen was the one under-reporting.

## Decision

### Scan once, on arrival, and write down what was found

`fileInbound` runs both scans and records `sanitized_at`, `remote_image_count`, `link_count` and
`injection_flagged` with the row. The two screens now read the same fact, and the corpus can be
asked a question it could not be asked before.

`cc_addresses` is written at the same time, which needed `cc` on the `InboundMessage` contract:
the column had no source to be written from. That is ADR 0084's lesson again — a mock that cannot
produce what the consumer eats is why the consumer never gets built — and it matters here beyond
tidiness, because a thread that cannot say who else was on it is the mailbox-shaped hole this whole
subsystem exists to close.

### What is deliberately **not** stored: the rendering

The body stays raw and every read re-runs the current sanitizer over it.

Storing the rendered text would be the obvious way to answer "what did we show somebody last
Tuesday" — and it would be a security regression. A stored rendering is served to the next reader
*instead of* running the sanitizer, so every later improvement to that sanitizer would stop at the
messages already in the table. The one thing you must not do with a safety filter is grandfather
rows past it.

So the split is: **the finding is history, the rendering is now.** The record says what the scan
found on arrival; the screen says the body was checked again just now.

### A message nobody scanned says so

`sanitized_at IS NULL` is the honest state of everything filed before this — including the demo's
own seeded history. The thread view says *"not scanned on arrival — this message predates the
record"* rather than showing a clean scan it never performed. A CHECK says the counts cannot claim
otherwise: findings with no scan behind them is a number nobody can source.

### The read that notices still writes

A message the live scan flags and the table does not is the same bug seen from the other end, and
it will outlive arrival scanning: a detector that learns a pattern after the message landed. The
thread view writes the flag when it finds one, bounded to false → true, untrusted external content,
and only when the stored flag actually disagrees. A read that wrote on every pass would be its own
bug; a read that notices and stays quiet leaves the list lying.

## Consequences

- The inbox list and the thread view agree about the same message.
- `messages.cc_addresses`, `sanitized_at`, `remote_image_count` and `link_count` gain writers, and
  `injection_flagged` gains one that is not an agent's side effect.
- A partial index backs the list's per-thread `EXISTS`, which now has rows to find.
- Detector: **54 → 50**.
- Not fixed, and not worth pretending otherwise: sanitizing is still work per read. That is the
  price of always rendering through the current rules, and it is the right side to err on.

## Lesson

The columns were right. They were added in Phase 2 by somebody who had thought about exactly this
and named the four things worth keeping — and then the write was never made, so for a year the
product recomputed the answer on every render and threw it away.

An empty column with a good name is not a design waiting to be finished. It reads like one, which
is why it survived so long: every review saw a schema that clearly understood the problem.
