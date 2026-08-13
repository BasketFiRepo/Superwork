# ADR 0010 — Fair-share scheduling lives in the database

**Status:** accepted · **Date:** 2026-08-13

## Context
Phase 4 has to hold one property under load: no department can starve another's agent runs
(§24). First-come-first-served fails it on the first bulk job — one department queues two
hundred runs at 09:00 and everybody else waits behind them, which is exactly the morning an
operations team stops trusting the product.

The obvious fix is a scheduler in the worker process. That fails differently: two workers
disagree about whose turn it is, a restart hands somebody a fresh turn, and the state that
decides fairness is invisible to anybody debugging it at 3am.

## Decision
Deficit weighted round-robin, held in `department_quotas` and applied in the same
transaction that claims a run.

Each scheduling decision credits every backlogged department its own weight and charges the
served one the total weight of the backlog. Over N decisions a department is served
N·wᵢ/Σw times — its share exactly — and the deficits stay bounded rather than inflating.
Claiming uses `FOR UPDATE SKIP LOCKED`, so two schedulers never take the same run.

Three refinements matter as much as the algorithm:

- **Interactive beats bulk** at equal weight. A person at a keyboard is not a nightly sweep,
  and the §26.9 budget for interactive queue wait is two seconds.
- **A department at its concurrency cap is skipped, not blocking.** Its cap bounds itself
  and nobody else.
- **The department is resolved at enqueue**, not at claim. A membership change must not
  silently re-class work that is already waiting.

`startRun` enqueues and a pump drains, so when nothing else is queued an interactive run
still starts in milliseconds — the queue is invisible until it is needed.

## Consequences
- Fairness survives restarts, multiple workers and a process that dies mid-claim.
- The state is inspectable: `/settings/queue` shows every department's weight, backlog and
  the wait it is actually producing, measured against the budget.
- A claim costs one extra round trip per waiting department. At the tested scale that is
  microseconds against a run measured in seconds, and the alternative — a fairness bug
  nobody can see — is not cheaper.
- Weights cannot be set to zero. Silencing a department by starving it would be invisible;
  pausing its agents is visible.
