# ADR 0034 — A note nobody can read is not a note

**Status:** accepted · **Date:** 2026-08-15

## Context
Two tables were written by the agent and read by nothing, and in both cases the tool's own
description made a promise the product did not keep.

**`task_comments`.** `comment_on_task@v1` says the comment is *"attributed to the agent by
name. Never post as if a person wrote it."* Nothing read the table, so the agent has been
leaving notes on people's tasks that no screen showed — and no person could add one at all,
because the only writer was a tool. `agent_id` was never filled in, so even the attribution
the description promised was missing. The `mentions` array has been on the row since the
first migration and was never populated: naming somebody did nothing.

**`follow_ups`.** `create_follow_up@v1` says it records a dated follow-up *"so it resurfaces
if no reply arrives."* It never resurfaced. Nothing read the table, no worker swept it, and
`status` had only ever held `open` and `cancelled` — so every follow-up the agent has
recorded since Phase 2 is still open, and the promise in that sentence was carried entirely
by the word "record".

## Decision

**Comments are a thread on the task, and the agent's are marked as the agent's.** A comment
needs only a *read* of the task: discussing work you can see is not changing it, and
requiring `task:update` would silence exactly the person who most often needs to speak —
whoever is waiting on it. Your own words are yours to remove; anybody else's needs a say over
the task.

**A mention is an address, so it is checked like one.** Mentioning somebody writes a
notification onto their reminders screen (ADR 0033), and a database trigger refuses a
mention naming anybody outside the organization. An array column has no foreign key to lean
on, and addressing that can name a row in another tenant is the shape §3.2 exists to stop.
It does not email them: nothing leaves the company because a colleague typed a name.

**A follow-up closes itself when the customer writes back.** The sweep does this *before* it
surfaces anything, because being chased about a thread that has already been answered is the
fastest way to teach somebody to ignore the product. That outcome is recorded as `replied`
rather than as somebody's decision — how a follow-up ended is the useful part, and three
endings (`done`, `cancelled`, `replied`) are three different facts.

**What is left tells its owner, once.** A unique index on the notification makes "once"
structural rather than a flag somebody remembers to set — the same shape the nudge delivery
uses.

**Nothing is sent outward.** A follow-up coming due surfaces internally and stops there.
Drafting the reply is a separate act a person takes, and §25.7 forbids the product from
sending anything outward on its own under any setting. The acceptance loop asserts the outbox
is empty after the whole sequence, because that is the property somebody would want checked
rather than described.

**One open follow-up per conversation**, by partial unique index. Two agents recording
"chase this on Friday" against the same thread is two people chasing the same customer.

## Consequences
- `cancel_follow_up@v1` used to set `status = 'cancelled'` *and* soft-delete the row, which
  would now violate the check that a closed follow-up says when it closed. It records the
  ending and keeps the row instead: the thread's screen shows how each follow-up finished,
  and a soft-deleted one would take that with it.
- The worker's nudge pass now sweeps follow-ups too. They share a tick because they are the
  same act — surfacing what somebody needs to see today, inside the controls that already
  exist for it.
- A follow-up is readable by anybody who may read conversations, unlike the reminders screen,
  which is one person's own and refused to everybody else (ADR 0033). The difference is what
  the record is *about*: a customer thread, or a person.
- `follow_ups.task_id` is accepted and stored, and no screen shows a follow-up on a task yet.
  The conversation is where the agent puts them; the column is honoured rather than ignored,
  and this is the place that says so.
