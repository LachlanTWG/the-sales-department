# Quotie Pipeline Integration

> How EOD call outcomes drive Quotie's `/pipeline` page. Quotie's side went live 2026-09-01; **this repo's wiring shipped 2026-09-02 (commit 58f607a, Buzz-approved full cutover, all 6 companies)** — "Requires Quoting" now creates a Quotie pipeline lead instead of a "Prepare quote" task. The "proposed changes" section below is now the as-built description; per-company `quotie_config.actions` overrides remain the opt-out lever. Quotie also backfilled all open "Prepare quote for X" tasks into Requires Quoting pipeline leads (38 leads, 2026-09-02) and completed those tasks.

## What Quotie built

Quotie now has a `/pipeline` page: a read-only kanban of the whole sales cycle. Stages are **derived** from data — nobody drags cards. A lead moves columns only when something real happens: a call gets logged, a quote gets sent, a visit gets booked, a deal closes.

**Pre-quote board:** `Day 1–5 (by attempt count; first no-answer = Day 1) → Parked (not a good time) → Requires Quoting → Site Visit`
**Post-quote board:** `Quote Sent → 1st/2nd/3rd+ Follow-Up → 🔥 Hot → Site Visit → 🤝 Verbal Yes → ✍️ Signed → Won / Lost / Expired`

The pre-quote half runs on Quotie's `callback_leads` (5-strike auto-abandon cadence). **The EOD popup is the intended source of those call events** — an exec logs an outcome on the GHL contact page, and the matching Quotie card moves within seconds.

## The endpoint (live on Quotie prod)

`POST https://ucmgleztmtyoptcflsia.supabase.co/functions/v1/api-callbacks`
Auth: existing per-company Quotie API key (`Authorization: Bearer qk_…`). **All 6 live "EOD Creator" keys already have the required `callbacks:write` scope** — no key changes needed.

```json
{
  "ghl_contact_id": "<required — scraped GHL contact id>",
  "outcome": "no_answer | answered | voicemail | wrong_number | callback_requested | requires_quoting | lost",
  "notes": "optional — lands in the lead's attempt history",
  "callback_date": "optional ISO — when to call back",
  "attempted_by": "optional Quotie users.auth_id — from the existing user_map",
  "callback_reason": "optional"
}
```

What Quotie does per outcome (mirrors its in-app callback actions exactly):

| Outcome | Effect in Quotie |
|---|---|
| `no_answer` / `voicemail` | Attempt +1 (strike). At 5 strikes → lead auto-abandons. Otherwise callback bumps to next business day; card moves Day N → Day N+1 |
| `answered` | Attempt +1; if `callback_date` supplied → lead becomes "contacted" with that date |
| `callback_requested` | Attempt +1, lead → **Parked** column, callback date = supplied or next business day |
| `requires_quoting` | Lead → **Requires Quoting** column with a "+ Create Quote" button on the card |
| `wrong_number` | Logged to history only; lead untouched |
| `lost` | Closes the contact's active lead (Lost) + logs the attempt; `{noop:true}` HTTP 200 when no lead exists |

If the GHL contact has no Quotie callback lead yet, one is created automatically (contact auto-imported from GHL if needed — same shared import used by api-tasks/api-site-visits, dedupe + soft-delete revive included). Response: `201` with `{lead_id, lead_status, attempt_number, attempt_count, callback_date, contact, contact_source, created_lead, warnings?}`. Client errors never block anything on our side by design — same "never throw, never fail the EOD submit" philosophy as the existing Quotie actions.

## Changes to this repo (as-built — see "Full intake mapping" below for the final table)

Mirroring the existing `createQuotieTask` / `createQuotieSiteVisit` pattern in `dashboard/src/app/eod-entry/`:

1. **`quotie.ts`** — add `createQuotieCallback(config, payload)`: server-only, 10s timeout, never throws, returns a `quotie_result` for the banner.
2. **`DEFAULT_QUOTIE_ACTIONS` remap:**
   - `"Requires Quoting"` → api-callbacks `{outcome: "requires_quoting"}` — **replacing** the current api-tasks "Prepare quote for {contact}" call (Buzz's decision: the pipeline card + Create Quote button supersedes the task)
   - `"Not a Good Time..."` → api-callbacks `{outcome: "callback_requested"}` (replacing the "Call back {contact}" task)
   - No-answer-type EOD outcomes → api-callbacks `{outcome: "no_answer"}` / `{outcome: "voicemail"}`
   - `"Book Site Visit"` → **unchanged** (api-site-visits already moves the lead to the Site Visit column)
   - `"Waiting on Photos"` → **unchanged** (stays an api-tasks task)
3. **`actions.ts`** — wire the new action type: server-side re-resolution (never trust client `type`), await the call, surface `quotie_result`, failure never fails the EOD submit.
4. `attempted_by` from the existing per-company `user_map` (unmapped execs → attempt logged unattributed, same as tasks today).

**Rollout lever unchanged:** `companies.quotie_config.actions` per-company overrides (incl. `null` to disable) — companies can be moved to the new mapping one at a time; anyone without `quotie_config` sees zero change.

## Open questions for the Buzz ↔ Lockie briefing

- **"DQ Not Proceeding"** (added to standard outcomes in `fb28e98`) — should it map to Quotie? The endpoint has no "mark lost" outcome today; if wanted, Quotie would add one (small change). Quotie's pipeline Lost column already exists and would catch it.
- Which exact EOD 2/3 outcome strings count as `no_answer` vs `voicemail` (the outcome list includes learned per-company values — mapping should probably be prefix/explicit-list based like the existing action map).
- Cut over all 6 companies at once, or pilot Bolton EC first (per-company config makes either trivial).

## Testing safety (unchanged rules)

- **Never test against real leads** — dev and prod share LIVE GHL locations. Use the Lachlan Boys / Buzz Brady test contacts only.
- api-callbacks makes **no GHL writes** (at most a 5s GET to import an unknown contact), so it's the safest of the three endpoints to smoke.
- It has already been E2E-tested from this direction: full outcome matrix on Quotie dev (2026-08-29) + prod smoke (2026-09-01), all test rows cleaned.

## References (Quotie repo)

- `.claude/docs/integrations/external-api.md` — full `POST /v1/callbacks` contract
- `.claude/docs/features/pipeline-overview.md` — stage derivation rules
- `.claude/docs/integrations/eod-creator.md` — integration state + rollout runbook

## Full intake mapping — SHIPPED (b8b808d, 2026-09-02)

The EOD selector is now the front door for Quotie's pipeline:

| EOD step | Selection | Quotie effect |
|---|---|---|
| EOD 2 | Didn't Answer | `no_answer` — creates the lead on first strike (Day 1), bumps Day N after, auto-abandon at 5. Fires even without an EOD 3 outcome; skipped when EOD 3 itself maps to a callback |
| EOD 3 | Requires Quoting | `requires_quoting` — Requires Quoting column w/ Create Quote button |
| EOD 3 | Not a Good Time to Talk | `callback_requested` — Parked column (replaces the "Call back" task; optional "Call back on" date field feeds `callback_date`) |
| EOD 3 | Lost - * / DQ - * / Abandoned - * (14 outcomes) | `lost` — closes the lead; quiet `{noop:true}` when the contact has no lead |
| EOD 3 | Book Site Visit / Waiting on Photos | unchanged (api-site-visits / api-tasks) |
| EOD 3 | Quote Sent, Verbal Confirmation, Not Ready Yet ×2 | unmapped (candidates: Verbal Confirmation → Quotie's Verbal Yes; Not Ready Yet → Parked — both need small api-callbacks additions first) |

Overrides: per-company `quotie_config.actions` (EOD 3) + new `quotie_config.answered_callbacks` (EOD 2), `null` disables. Note: EOD 2 has no voicemail selection today — defensive `voicemail` mapping exists if one is ever added.
