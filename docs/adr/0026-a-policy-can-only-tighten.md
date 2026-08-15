# ADR 0026 — A policy can only tighten

**Status:** accepted · **Date:** 2026-08-15

## Context
`approval_policies` has been seeded since migration 0005 with three rules — external
communication needs a manager, twenty or more writes needs a person, autopilot may never
take a high-risk action — and read by nothing.

The gate carried its own copy of one of them: `writes.length > 20`, the same twenty the
seeded "Bulk changes" row states. **The row and the constant agreed**, which is why nothing
looked broken. An admin could not see or change the rule that was actually governing them,
and `approvals.policy_id` and `policy_reason` were columns nothing filled — so an approval
could not answer *why am I being asked this?* while a table of rules sat beside it
governing nothing.

Wiring the table up turned up four defects on the paths it touches.

## Decision

**A policy can only tighten.** There is no `allow` effect and there will not be one. A rule
may raise the approver's role, shorten the deadline, or forbid an action outright; it can
never remove an approval the product would otherwise require. The floor — any write is held
for a person — stays in code and is passed *into* the evaluator, which ORs it in rather than
replacing it. Switching every rule off returns to that floor.

This is what keeps §25.7 — *nothing is auto-sent externally in v1, ever, under any setting* —
true in the presence of a configurable rule engine: there is no configuration that reaches
it. The screen says so at the top, because the first thing somebody will try is turning a
rule off to let the agent send mail unattended, and the honest answer is that it does not
work that way.

**A deny is refused, not held.** A rule that says "forbidden" must not produce a card
somebody can approve. A denied plan has its writes struck out with the policy's own name as
the reason, so the person who asked can see *which rule* stopped them rather than being told
no. Denies are evaluated first, which is why the seeded autopilot rule sits at priority 5
and the requirements at 10 and 20.

**A rule that matches on nothing is inert, not universal.** An empty `match` would otherwise
catch every plan including read-only ones. It matches nothing, the screen says the rule is
inert, and writing one is refused.

**Rules are checked against the tool registry when they are written.** A policy naming a
tool that does not exist is refused rather than quietly never matching. A rule that silently
matches nothing is worse than no rule, because it reads as protection.

**A policy that names a role routes by it.** `approver_user_id` defaulted to the requester,
so "external mail needs a manager" became "the member who asked may approve it". When a
policy names a role the requester does not hold, the approval is routed to the role and
`decideApproval` enforces it — the column was written and never consulted.

**A manager can now decide an approval.** An approval carries no department, so
`approval:decide:department` — the manager's grant, and the only decide grant below admin —
could never be satisfied. A manager had therefore never been able to decide anything, which
made "a manager decides this" meaningless before it started. The base capability is asked
with `grantedScope`; the row's own `approverRole` does the narrowing that matters. ADR 0021,
on a third surface.

**Self-approval means a person clearing their own request, not an agent's.** The old rule
bound `member` alone, so a manager could self-approve a high-risk action and an owner
certainly could — the comment said "the configured threshold" and the code said "one role".
It also keyed on `approverUserId`, which defaults to the requester, rather than on who
actually asked. Now: nobody clears their own high-risk request, whatever their role. An
agent's proposal is deliberately not self-approval — the person did not propose it, their
agent did, and a human deciding what their agent suggested is the entire design (§5.1).

**An approval is not readable by everyone.** `listApprovals` and `getApproval` accepted an
actor and never used it, so anybody signed in — down to a `guest` — could read every
approval in the organization. A preview *is* the draft: recipients, subject lines, bodies,
amounts. Three ways in and no fourth: you asked for it, you are the one being asked, or you
may decide approvals. Cross-visibility reports absence, not denial.

**The deadline is the deadline.** `expires_at` was the SLA times six, so every "4 hours"
card expired in a day and the number on the screen was a decoration.

## Consequences
- Changing the rules needs a password at the keyboard, in both directions. Adding one only
  tightens and does not strictly need it, but both arrive through the same screen and a
  control that asks *sometimes* teaches people to click through when it does.
- Turning a rule off requires a reason, recorded in the audit log. "Who turned this off and
  why" is not answerable from a boolean.
- The rule form is constrained — one tool, or a number of changes, or a risk level — not
  free JSON. Arbitrary documents make a rule engine whose failures are silent.
- An approval routed to a role is visible to everybody holding it, and approvals carry no
  department, so a department-scoped decider currently sees the whole queue. Narrowing that
  needs a department on the approval, which is a schema change and a separate decision.
- `delegated_to` is still a column nothing writes. Delegating an approval to a named person
  for a period is a real feature and is not this one.
