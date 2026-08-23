# ADR 0081 — Who was actually in the room

**Status:** accepted · **Date:** 2026-08-23

## Context

`meeting_participants.attended` has existed since migration 0010. It is selected into
`ParticipantView` by `listParticipants`, rendered on no screen, and the only thing that has ever
written it is the seed.

An empty column is ordinary — the detector has found seventy-five of them. What made this one
worth building rather than dropping is the sentence resting on it.

The **personal record** is the screen §29.3 exists for: the one that tells a person what Superwork
holds about them. It carried a row labelled **"Meetings you attended"**, described as *"Attendance,
and the lines you spoke where a transcript was recorded with consent."* Its count was:

```sql
SELECT count(*) FROM meeting_participants
 WHERE organization_id = … AND deleted_at IS NULL AND user_id = …
```

That is the number of meetings somebody put your name on. The product was showing people their
invitations under the word attendance, on the one screen whose entire purpose is telling them
accurately what is recorded about them.

The asymmetry is the tell. Consent on this same table is properly built: `consented_at` is written
by `recordConsent` and `consentState` genuinely refuses a transcript without it. Somebody built the
harder half of this subsystem and left the easier half as a column.

## Decision

**Three states, and the empty one is not a gap.** `attended` stays a nullable boolean and all three
values mean something distinct:

- `true` — somebody records that this person was there;
- `false` — somebody records that they were not, which is a **claim about a person**;
- `null` — nobody has recorded an answer, and nothing is being claimed.

Collapsing the last two is the failure this ADR is mostly about. It is what the seed did, and what
a screen does when it renders "no answer" and "did not come" the same way.

**A claim carries a name.** `attended_set_by` and `attended_set_at`, with a CHECK requiring both
whenever `attended` is not null — the attribution pattern from ADR 0041. A fact about somebody that
nobody is answerable for is a rumour the database is repeating. Withdrawing an answer clears the
name with it, because nobody is making that claim any more.

**Deliberately no `attended_reason`.** The attribution pattern elsewhere carries one. Here it would
be a field inviting somebody to record *why* a colleague was absent, which is a note about a person
rather than a fact about a meeting — and the beginning of the file §29.5 exists to prevent. Who
says they were not there is answerable; why they were not there is theirs.

**Recording it needs `project:update`, not a read.** A viewer may open a meeting; they may not say
who was in it. Neither may a member. Writing down that a colleague missed something is not an
ordinary act of reading the calendar.

**And no tally, anywhere.** *Who was in this room* is a fact about a meeting. *Who misses the most
meetings* is a measure of a person, and the difference is only that nobody wrote the second query.
The panel says so on its face — "No count of this is kept about anybody" — and a source-reading
test refuses the repository, the transparency module and the component the moment a `GROUP BY`
keyed on a person appears in any of them. The same line ADR 0070 drew for digests and ADR 0079 for
the audit log.

The one place attendance is counted is your own personal record, which `personalRecord` already
refuses for any `userId` but the caller's. That is transparency, not scoring: the prohibition is on
the product computing this *about* people *for* somebody else.

**The record now says both true things.** One row for the list, one for the room:

- *Meetings you were on the list for* — "Being on the list is not the same as being in the room."
- *Meetings recorded as attended* — and where absences exist, it says how many say you were not
  there, because that is held about you and §29.3 means you see it first.

## Two rules the database keeps

**Attendance cannot be recorded for a meeting that has not started.** Nobody knows who turned up to
a room that has not opened, and the value the old code reached for was `false` — an accusation
rather than a blank. A trigger rather than a CHECK, for the reason `logInteraction` already states
about the same shape: a constraint cannot call `now()`, and a row legitimate when written must not
turn invalid as the clock passes it.

**Whoever is named as recording it has to be a member here**, the rule
`sw_agent_budget_setter_same_org` already keeps: a foreign key to `users` reaches every tenant, so
on its own it says almost nothing.

Both are split across insert and update (ADR 0057), because these rules **refuse**: renaming a
participant on next week's meeting must not be turned down over an attendance the rename never
touched, and a test asserts exactly that.

### The bug the tests found

The setter trigger's first version fired on `NEW.attended_set_by IS DISTINCT FROM OLD.attended_set_by`
alone. Clearing the attribution — which is what withdrawing a record does — then fired it with
`attended_set_by` null, found no membership for nobody, and refused. **An attendance record could be
made and never unmade.** The `IS NOT NULL` guard now leading that WHEN clause is load-bearing, not
tidiness, and the test that withdraws a record is what found it.

## A column that went

`meetings.recording_consent_state` is dropped. It was never read or written. The consent state the
product actually uses is derived by `consentState` from `meeting_participants.consented_at` — one
row per person, with the moment each of them agreed. A jsonb blob on the meeting is the same fact
kept a second way, and the two would disagree the first time anybody wrote to it. The same reason
`contacts.next_step` went in 0062 and `workflow_step_runs.cost_cents` in 0064.

## What the seed was saying

`attended` was `meeting.daysAgo > 0` — everybody attended every past meeting, and **every future
meeting recorded everybody as having not attended**. The second half is the one that matters: the
demo shipped with an accusation against six people for a meeting that had not happened, because
`false` was standing in for "we do not know yet".

The seed now records attendance only for meetings that have actually started, attributed to the
organiser at the meeting's end — and `SeedMeeting` gained `absentKeys`, so Ruth Kavanagh missed the
third weekly operations meeting. That is why the escalation contact carried over again: the one
person who could have named it was not in the room. A demo where everybody attends everything is a
demo where this column has nothing to show.

## Consequences

- The personal record stops calling invitations attendance.
- `meeting_participants.attended` comes off the detector's queue, and a redundant column goes with
  it: **75 → 73**.
- A missed meeting is something the product can hold, with a name against who says so.
- Nothing anywhere counts attendance about anybody but the person reading their own record.

## Lesson

The column detector finds columns nothing writes. This one had been on the list for a while and
looked like the least interesting kind — a boolean on a join table, shown on no screen.

What made it worth doing was not the column. It was the label three files away that had been
quietly true about a different column all along. **An empty column is a missing feature; an empty
column with a sentence built on top of it is a false statement**, and the detector cannot tell you
which one you are looking at. Only reading what the product says out loud can.
