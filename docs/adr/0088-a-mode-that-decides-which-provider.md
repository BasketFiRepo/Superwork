# ADR 0088 — A mode that decides which provider

**Status:** accepted · **Date:** 2026-08-25

## Context

Somebody looked at a running Superwork and said the integrations seemed like dummies rather than
anything real. Half of that is the design working: every provider ships as a mock so the product
runs end to end with no credentials (§13.2), and everything around the simulated edge — permissions,
approvals, previews, the audit trail — is real.

The other half was a bug, and it was ours.

Six capabilities have a mode variable. **Four of them switched nothing:**

| Variable | Consulted by the resolver? |
|---|---|
| `AI_MODE` | yes — `AnthropicProvider` or the mock |
| `HTTP_TOOLS_MODE` | yes — `FetchHttpTransport` or the mock |
| `EMAIL_MODE` | **no** — `emailProvider()` returned the mock unconditionally |
| `STORAGE_MODE` | **no** |
| `BILLING_MODE` | **no** — added the day before this, by the same hand |
| `CALENDAR_MODE` | **no**, and there is no calendar resolver, mock or caller at all |

Worse than ignored: `emailMode()` and `billingMode()` read the variable **only to print it on the
integrations screen**. So a deployment could set `EMAIL_MODE=live`, open Settings → Integrations,
read the word "live" back off its own screen, and be running on a provider that files every message
into memory and sends nothing.

This is the failure this codebase keeps finding, one layer further out than usual. Not a column
nothing writes — a **setting nothing reads**. And worse than the feature-flag version (ADR 0022),
because that screen said "declared but inert" and this one said "live".

## Decision

### A mode that cannot be honoured stops the process

Not a warning, not a fallback: the environment refuses to load, naming the capability, the variable
and the two things that fix it. Falling back to the mock is what produced the bug — a system
confident and wrong about whether it is connected to anything.

The refusal is separate from `AI_MODE=live requires ANTHROPIC_API_KEY`, and the difference is
deliberate: `ai` *can* be live and arrived without a credential; `email` cannot be live at all.
Two situations, two sentences.

`sandbox` is refused exactly as `live` is. It is no more implemented, and a mode that sounds safer
is the one somebody tries first.

### The resolver consults the mode

`resolve(capability, mock, live?)` picks the live factory when the mode is not `mock` and one
exists. Because the environment has already refused everything else, the fallback to the mock at
this point cannot lie: by the time anything resolves, `mock` is the only thing the mode can say.

The test override still beats both. It is how tests and the sandbox substitute an implementation,
and it is deliberately not reachable from configuration.

### The screen reports what resolved, never what was asked for

`capabilityCatalogue()` reads `.mode` off the provider in force. An implementation injected by a
test or a sandbox therefore reports itself honestly, which is the property that makes the row mean
"this is what you are running" rather than "this is what you typed".

`calendar` keeps its row and says the true thing out loud: nothing implements this capability yet,
so there is nothing to connect.

### One list, and a test that refuses drift

`LIVE_IMPLEMENTED` is two entries in `@superwork/config`, because the environment must know what is
buildable and `@superwork/config` cannot import `@superwork/integrations` without inverting the
dependency. That makes it a second place a fact lives, so a test asserts it against the resolvers —
the same shape as the feature-flag list and its database CHECK (ADR 0022), for the same reason.

## Consequences

- `EMAIL_MODE`, `STORAGE_MODE`, `BILLING_MODE` and `CALENDAR_MODE` now either do what they say or
  stop the process. None of them can be believed and wrong.
- The integrations screen and the "simulated" badge on a mailbox report the provider in force.
- Making a capability real is now two visible steps: write the live provider, add it to
  `LIVE_IMPLEMENTED`. Until the first, the second refuses to boot.
- No schema change, and the column detector is unmoved at 54: this was never about a column.

## Lesson

ADR 0086 added `billingProvider()` and wired `BILLING_MODE` into a display helper, and the same
increment's README section said the mode "chooses the implementation now". It did not. The sentence
was written from the intent rather than from the code, one file away from the resolver that ignores
it, and it passed a review, a test suite and a browser walk — because everything it claimed was true
in `mock`, which is the only mode anything runs in.

A switch nobody can flip is inert and looks it. A switch that flips and changes nothing looks like
a working feature from every angle except the one nobody checks.
