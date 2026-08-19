# ADR 0056 — A customer somebody added

**Status:** accepted · **Date:** 2026-08-19

## Context
`companies` and `contacts` are read by the companies screen, the relationship view, the inbox's
routing, the watchers that ask whether an account has gone quiet, and the ACL that decides who may
see either record at all. Both have been written by the seed and by nothing else since Phase 0.
**There was no way to add a customer to this product.**

Neither table had ever carried a single CHECK, which is why the fields the product acts on could
hold anything the day something started writing them:

| Column | What acts on it |
|---|---|
| `domains` | `companyForAddress` — which company an inbound message belongs to |
| `reply_sla_days` | how long a thread may go unanswered before somebody is chased |
| `check_in_days` | how long an account may go quiet before the same happens |
| `health_status` | shown against the account, with no vocabulary at all |
| `sensitivity` | what the ACL reads to decide who may see the record |

## Decision

**The domain list is the field that needed the most care, because it is the one the product
*acts* on.** `companyForAddress` splits an address at the `@` and looks the remainder up here.
Three failures were possible and all of them silent:

- An entry with an `@` in it, or no dot, or in mixed case, matches nothing — and mail from a
  customer simply stops being attributed to them. Normalised on the way in, refused with a
  sentence in the repository, and refused again by `sw_domain_list_ok` for any other writer.
- **Two companies claiming one domain makes the answer arbitrary.** Refused, naming the company
  that already receives mail from it, rather than left to whichever row the planner returns
  first. This is checked in the repository rather than by a constraint: an exclusion constraint
  over array overlap is possible but would refuse without being able to say *which* company has
  it, and a refusal that does not name what would work is a wall.

**The two day counts have floors, and the floor is 1.** Zero means "chase the moment a message
arrives, for ever", which nobody would choose on purpose. Both are refused in the repository with
the consequence spelled out, and bounded again by a CHECK.

**`health_status` gets a vocabulary.** The column had none — no enum, no CHECK — so it could have
held anything at all. Four values, in the code and in the database.

**The classification ceiling is *not* re-checked here.** The sensitivity is part of the resource
the create is checked against, so `can()` already refuses a record somebody could not read
afterwards, in better words than a second copy would produce. Documents need their own check
(ADR 0045) because there the level comes from a classifier reading the content rather than from
the caller. A rule enforced in two places is a rule that will be enforced differently in two
places — this one was written, found redundant against the engine, and deleted.

**A duplicate contact is not refused.** Two records for the same person is what the merge queue
exists to notice (§8.4), and refusing the row would remove the thing the queue works on. Instead
the sweep is asked to look immediately after the row lands, so the duplicate surfaces as something
a person resolves with both records in front of them — rather than as a refusal at the moment they
were trying to write something down.

**Two different gates, on purpose.** A member may add a contact — somebody they have met — and may
not open an account; that is `company:create:org`, which only an administrator carries. Where that
is wrong for a particular person, ADR 0055 is now the answer: grant them the one capability rather
than making them an administrator.

## What is deliberately not built

**Conversations and messages.** They are the record of correspondence, and correspondence arrives
through an integration this product does not have credentials for (build rule 3). Inventing a form
that fabricates an inbound email would put words in a customer's mouth. `logInteraction` already
exists for "we spoke on the phone" and is reachable by the agent; giving a person a form for it is
a small, separate piece.

**Deleting a company from a screen.** Archiving one raises questions this change does not answer —
what happens to its conversations, its contacts, its projects — and the same questions were worth a
refusal with a count when departments got theirs (ADR 0036). Until that exists, the browser walk
accepts "added now, or already there from a previous run" rather than pretending it can tidy up.

## Consequences
- The companies screen can add a company and a contact, and says what a domain decides.
- The three numbers watchers act on are numbers somebody chose, and a change of health goes on the
  activity feed because it is the one other people act on.
- Fourteen tests. Removing the cross-company domain check fails one of them.
- The acceptance loop adds a real company, matches a real address to it, is refused a second
  company on the same domain, and puts the demo back.
