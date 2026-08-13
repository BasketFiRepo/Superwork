# ADR 0009 — An API key acts as a person, and MCP is read-only

**Status:** accepted · **Date:** 2026-08-13

## Context
Phase 3 opens two doors into the product: a public REST API and an MCP server that lets an
outside model use Superwork's tools (§22). Both are the classic way a carefully built
permission model gets bypassed — a "service account" with its own grants, and a tool
endpoint that skips the plan, the gate and the approval.

## Decision
**Every key has a principal.** `api_keys.principal_user_id` is `NOT NULL`, and every
request loads that person's `Actor` and authorizes through the same `can()` the UI uses.
A key can never read or change anything its principal could not, and revoking the person's
membership revokes the key's reach with it. Scopes narrow further; they never widen.

**Secrets are hashed and shown once.** The row stores a SHA-256 hash and a recognisable
prefix. Resolution runs on the pre-tenant `superwork_auth` role, because the organization
is not known until the key is found — the same boundary sign-in uses.

**Rate limits are counted in the database**, from `api_requests`, so every process agrees
and a restart does not hand somebody a fresh budget.

**MCP exposes read-tier tools only.** A model outside this system, calling a write tool,
would have no plan, no gate, no approval, no undo and no accountable human reading a
preview. Rather than reproduce those guarantees at a second door, the door only opens onto
reads. `POST /api/v1/runs` is the supported way to make something happen, and it is capped
at `assist` — an API caller can have work proposed, never executed unattended.

## Consequences
- Nothing reachable over the API or MCP escapes the audit trail or the permission model.
- An integration that needs to act does so by starting a run, which lands in Approvals like
  any other proposal.
- A key is as powerful as a person and no more, so offboarding is one action rather than
  an audit of forgotten service accounts.
