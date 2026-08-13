# ADR 0011 — The strictest jurisdiction is the default, and the review is a query

**Status:** accepted · **Date:** 2026-08-13

## Context
The accountability features (§29) are the ones an operations leader buys and the ones a
works council can block. In DE, NL, AT and FR, deploying them without consultation can
invalidate an entire rollout. Phase 4 is accepted when they "pass a works-council-style
review in the strictest configured jurisdiction" (§24).

Two failure modes were available. Default to permissive and let admins tighten — which
means the first tenant in Germany is non-compliant until somebody notices. Or ship a
compliance page of assurances — which passes no review, because a reviewer asks *show me*,
not *tell me*.

## Decision
**The strictest profile is the default.** A new legal entity starts on `works_council`.
Tightening is a normal edit. Loosening needs a justification *and* a named approver, and
writes a row in `jurisdiction_changes` that the review reads back.

**Consultation is a record, not a checkbox.** A constraint refuses to store an `agreed`
consultation without the reference the works council issued and the person who recorded it.

**The review is a set of queries.** Each finding is a question a works council actually
asks, answered against this tenant's own rows, with the evidence printed beside it:

| Question | Answered by |
|---|---|
| Can it score or covertly monitor an individual? | the `monitoring_prohibited_by_design` constraint plus every policy row |
| Can something be reported about somebody invisibly? | count of disclosures with `visible_to_subject = false` |
| Can activity reach HR unauthorized? | count of `export` disclosures lacking an authorization |
| Can somebody be chased for an inferred promise? | count of unconfirmed commitments that produced work |
| How often can one person be contacted? | the busiest delivered day in `nudges` |
| Was the council consulted first? | consultation status and reference per entity |
| Can any action be explained afterwards? | count of write tool calls whose run has no stored plan |
| Does erasure reach derived data? | count of chunks surviving a deleted document |
| Can the app rewrite the audit trail? | `information_schema.role_table_grants` |

Most of them are answered by a schema property rather than a runtime check, which is the
point: the answer cannot be massaged for the review.

## Consequences
- A tenant in Germany is compliant on day one and has to be deliberately loosened.
- The review can fail, and does — the consultation finding fails until an agreement is
  recorded, which is what makes the passing version worth anything.
- Profiles constrain product behaviour rather than describing it: the nudge budget and
  manager escalation both read the profile, so tightening the jurisdiction tightens the
  product the same hour.
- The §29.5 prohibitions are *not* profile-dependent. They hold in every jurisdiction,
  because they are properties of the product rather than of the law it happens to be under.
