# ADR 0013 — An edit is a narrower approval, and a custom tool is an ordinary tool

**Status:** accepted · **Date:** 2026-08-14

Two decisions, recorded together because they are the same decision twice: a convenience
feature must not become a way around the policy engine.

## Approve with edits (§11.2)

### Context
Rejecting a good draft over one wrong sentence is a bad trade — the work is thrown away and
the only signal recorded is "no". People want to fix the sentence and approve. But an
approval card that can rewrite an arbitrary argument is a permission bypass with a friendly
button on it: change the recipient, change the amount, change the target of a write, and the
gate that ran ten minutes ago no longer describes what is about to happen.

### Decision
**Editability is declared by the tool, not by the UI.** A `preview()` change may carry
`editable: { arg }`, naming the argument it describes. The stored preview *is* the
allow-list: `editableArgs()` derives it from the same rows the person looked at, so the two
cannot drift.

**An edit is checked against what the card offered.** `assertEditsAreOffered()` refuses an
edit to a step that was not previewed or an argument that was not marked editable — before
the decision is recorded, not after.

**A recipient is never editable.** `draft_email@v1` offers the subject and the body. The
address is resolved from known contacts on the account, and letting an approval introduce
one would be the same hole as letting retrieved content introduce one (§5.9.4).

**The edited plan is re-gated.** `continueAfterApproval` re-runs `gatePlan` over the edited
plan: schemas re-validated, permissions re-checked, previews re-rendered. If the edited plan
is riskier than the one on the card, the run goes back to `awaiting_approval` instead of
executing on a stale gate.

**The correction is its own signal.** `approved_with_edits` is a distinct status and a
distinct column in the trust ledger. "Your team approves 94% of drafted follow-ups
unedited" is only meaningful if edits are counted separately.

### Consequences
Adding an editable field to a tool is one property on one preview line. The cost is that a
tool author must think about which arguments are safe to hand to an approver — which is the
thinking that should happen anyway.

## Admin-authored HTTP tools (§22)

### Context
The most valuable integration is usually the one nobody has built: the customer's own ERP,
ticketing system or internal API. Letting an admin define a tool is the difference between a
product that fits a company and one it has to fit around. It is also the largest hole
anybody could put in this design.

### Decision
**A custom tool is a `Tool`.** Same interface, same registry lookup, same gate, same
approval card, same `tool_calls` row. The model is never told which tools are custom, and
nothing in the execution path branches on it. No exceptions — a custom tool must not be a
permission bypass.

**The tenant overlay is passed, never registered.** The registry is a process-wide map;
putting one organization's tool in it would expose that tool to every other organization in
the same process. Custom tools are built per tenant per run and threaded through the gate
and the runtime as an explicit parameter.

**Orchestrator only.** A sub-agent's registry is a structural guarantee — the Researcher
cannot write because it holds no write tool. An admin-authored tool must not be a way to
hand it one.

**The host allow-list is a table of decisions.** A tool cannot be activated until a named
person has reviewed its host with a reason, on a recorded date. Revoking a host disables
every tool that used it in the same transaction — a tool left live against a host nobody
trusts is the gap that would otherwise open. `status = 'active'` requires `approved_by`, by
`CHECK` constraint.

**Refused at definition time:** anything that is not https; private, loopback and
link-local addresses (169.254.169.254 is the one that matters); credentials in a URL or a
literal credential in a header, which must be a `${SECRET}` reference; a URL placeholder no
parameter declares; a permission outside a fixed list the roles actually grant; and calling
a non-`GET` a read. Editing a tool returns it to draft and clears its approval, so a live
tool cannot be re-pointed at another host.

**Arguments are data at every position.** The input schema is `strict`, so an argument the
definition never declared never reaches the request. Path segments are percent-encoded,
query values go through `URLSearchParams`, body values are serialized as JSON.

**Never reversible.** Superwork cannot construct an inverse for somebody else's system, so a
custom tool declares `reversible: false`, is never offered as undoable, and says so on its
own approval card.

**The transport is a provider with a mock.** `HTTP_TOOLS_MODE` defaults to `mock`, which
returns a deterministic locally-generated response marked `simulated`. The whole product,
including a tenant's own tools, still runs with zero external credentials.

### Consequences
- An admin can extend the agent's reach without an engineer, and an auditor can answer
  "which outside systems can this reach, and who said so" from two tables.
- Members cannot call custom tools by default: the permissions on offer are the ones only
  admins and managers hold. Widening that is a role change, which is visible.
- DNS rebinding is not addressed here — a hostname that resolves to a private address at
  call time passes the name check. Closing it needs resolution-time validation in the live
  transport, and this build does not ship a live transport.
