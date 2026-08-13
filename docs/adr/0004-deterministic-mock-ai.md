# ADR 0004 — Mock AI reasons over real data

**Status:** accepted · **Date:** 2026-08-13

## Context
The product must run end to end with no external credentials. The tempting shortcut is a
mock provider that returns canned strings.

## Decision
`MockLLMProvider` is a deterministic, seeded rule engine that consumes the same grounding
payload a live model would: real aggregate rows, real retrieved passages, real customer
names. It emits the same typed `Plan`, `Answer` and `Report` objects, through the same
runtime, tools, permission checks, approvals and audit trail.

## Consequences
- The demo, CI and the eval harness all run with `AI_MODE=mock`, and the harness can tell
  "the plumbing broke" from "the model was wrong" — the same fixtures run against both.
- Every response is badged `Simulated` wherever it is displayed, and `AUTOPILOT_ENABLED`
  is rejected at boot while `AI_MODE=mock`, so simulated output can never act unattended.
- The rule engine is a real maintenance surface: a new intent needs a rule as well as a
  prompt. That cost buys a test suite that does not flake.
