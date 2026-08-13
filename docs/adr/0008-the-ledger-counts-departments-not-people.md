# ADR 0008 — The AI ledger counts departments, never people

**Status:** accepted · **Date:** 2026-08-13

## Context
Phase 3 has to make one question answerable from the interface: what did the AI read,
propose, execute and cost last month, per department (§24). Every input for that already
exists — citations for reads, plan steps for proposals, tool calls for actions, usage
records for cost — and all of them carry a `principal_user_id`.

That is the problem. The same query, grouped one column differently, is a productivity
ranking of named colleagues: the report §29.5 prohibits, and the one a nervous executive
will eventually ask for. "We chose not to build it" is a weak defence when the data is one
`GROUP BY` away.

## Decision
`ledgerReport` groups by department and by agent, and by nothing else. There is no
per-user parameter, no per-user column in the returned type, and no route that accepts
one. Rows are filtered through the same `can(actor, 'agent_run:read', { departmentId })`
the API uses, so a manager sees their own department and an admin sees the organization.

Individuals see their own usage on their own screen — the personal record (§29.3) — which
only they can open.

The isolation test asserts the absence: the serialized report may not contain another
member's id, and the department row type may not gain a `byUser` key.

## Consequences
- An admin can answer the Phase 3 question without being handed a surveillance tool.
- "Who used the AI most" is not a supported question, and answering it would mean writing
  a new query, changing a shape a test pins, and passing code review — three places a
  person has to decide to do it deliberately.
- Cost attribution stops at the department. Charging an individual back for their AI usage
  is not possible, which is the intended trade.
