# ADR 0052 — An organization that describes itself

**Status:** accepted · **Date:** 2026-08-19

## Context
`organizations` is the first table the product ever wrote and almost the last one it learned to
change. Two columns picked up a control along the way — `data_region` (ADR 0025) and the agent
kill switch — and everything else in the row stayed whatever the seed said. So every
organization is Northwind Logistics, in Europe/London, that thinks a reefer is a
temperature-controlled trailer.

The re-derived coverage list (`pnpm check:columns`) separates two failures that look alike in a
report and are opposite in the fix.

**Read by live code and settable by nobody.** `name` is the header of every screen, half the
grounding the model is given, and the name on the transparency report a person can ask for about
themselves. `industry` is the other half. `timezone` is what "today" and "overdue" mean for
everybody with no timezone of their own, the fallback for a department that sets none (ADR 0039),
and the clock a recurring task is rolled on. `glossary` is expanded into every search query
before it is embedded.

**Read by nothing at all.** `currency` was a column with a value nobody consulted: `formatCents`
has taken a currency since Phase 1 and no caller ever passed one, so every organization's money
was written in pounds — including the refusal that quotes a budget back at somebody. And
`profile.tone`, which the seed fills with a sentence about how the company writes, reached
nothing: the system prompt has a VOICE section and the organization had no say in it.

## Decision

**Both, but not the same way.** The four that are read become settable. The two that are read by
nothing get a reader in this change — not a settings field. A control whose effect nobody can
name is the anti-pattern this whole build exists to remove, and adding one while removing four
would be a poor trade.

**The currency reaches the money.** `organizationCurrency(ctx)` is the one place that answers,
and the session carries it to the screens. Every `formatCents` call site now passes it, including
the two spend refusals — the place a currency is felt, because that is where a figure is quoted
back at a person who is being stopped.

**The tone reaches the prompt, and cannot displace it.** `system.v2` puts the organization's note
at the end of VOICE, after the rules about hedging honestly and every number carrying its basis.
Those are not the organization's to switch off. The sentence is composed in the runtime rather
than in the template, so an organization that has said nothing contributes nothing rather than an
empty instruction the model has to interpret.

**Which prompt version is live has one writer.** `SYSTEM_PROMPT_VERSION` and `loadSystemPrompt()`
live in `@superwork/ai` beside the templates, and the runtime asks for the prompt rather than
naming a number. This was not tidiness: with the version named at the call site, a test could
assert the *template* renders the tone while the product sent a prompt without the placeholder,
and every test would pass. Verified by reverting the constant and watching the test fail.

**The slug is deliberately not settable.** It is an address. Changing an address silently breaks
every link anybody kept, and the honest form of that wish is a redirect, which is not a settings
field.

**The clock says what it reaches.** Changing the timezone changes which work is late, for
everybody who has no timezone of their own. The screen counts them and the departments that fall
back to it, the change goes on the activity feed rather than only into the audit log, and the
permission check is `riskTier: 'high'` where renaming the company would not be. What it does not
get is a step-up prompt: this is a description of the company, not a loosening of a guarantee,
and the direction rule of ADRs 0044, 0046 and 0050 is about the latter.

**Attribution is the audit record, not new columns.** ADRs 0044, 0046 and 0050 added
`*_set_by` / `*_set_at` / `*_reason` to settings where a default names nobody and a chosen value
has to name its chooser. That pattern is for controls that weaken something. Nothing here can be
weakened by being changed, `audit_logs` already keeps who, when and the before and after, and
five more columns on the organization would be ceremony rather than a guarantee.

**The glossary is validated as data, in the database.** `sw_glossary_ok` refuses a term shorter
than two characters, because `transformQuery` builds a word-boundary regular expression out of
every term: an empty one compiles to `\b\b`, which matches every query, and one blank entry would
append its meaning to every search anybody ever ran. It also refuses duplicate terms
case-insensitively, since two entries for the same term append the same meaning twice. Saving a
term that exists replaces it, which is how a meaning gets corrected. And the term is escaped
before it becomes a pattern, so a glossary entry can add to what a search looks for and never
change what it means.

**The profile is merged, not replaced.** `profile` carries keys this screen does not offer, and a
write that silently drops what it was not asked about is a write nobody can trust — so the tone
is set with `profile || jsonb_build_object(…)` and cleared with `profile - 'tone'`.

## What is deliberately not built

**Working hours, operating sites and pain points.** The seed writes all three into `profile` and
nothing reads them. Working hours in particular would be a second answer to a question the
product already answers twice over — quiet hours say when a person may be written to (ADR 0047)
and the working calendar says which days they work (ADRs 0039, 0051) — and a third source would
be two places disagreeing about when somebody is at work. They stay unread rather than becoming
a field that looks like it does something.

**`allowed_regions`.** It gates where data may live, and widening it is a residency decision that
belongs with the jurisdiction work rather than on a page about the company's name.

**Per-person timezone and title.** `users.timezone` and `memberships.title` are also seed-only
and are somebody's own record rather than the organization's. They are the same shape and a
different screen.

## Consequences
- `pnpm check:columns` still reports `organizations.profile` keys, `slug` and `allowed_regions`,
  and now that is a decision recorded here rather than an oversight.
- Money is written in the organization's own currency everywhere it is written, and a spend
  refusal quotes a figure in it. One end-to-end test exceeds a real budget and asserts the
  refusal says `$` and not `£`; reverting the wiring makes it fail.
- `system.v2` is the live prompt. `system.v1` stays on disk: a recorded run that was planned
  under it should still be readable beside the prompt it was given.
- The organization screen counts the people and departments on the company clock, so a person
  moving it can see what it reaches before they do.
