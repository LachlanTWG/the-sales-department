# Quotie Follow-Ups Integration (post-quote lane)

> The companion to [`quotie-pipeline-integration.md`](./quotie-pipeline-integration.md). That doc wired the EOD popup into Quotie's **pre-quote** pipeline (`api-callbacks` → callback leads, Day N / Parked / Requires Quoting / Lost). This one adds the **post-quote** half: once a quote has actually been sent, the same EOD selector now drives Quotie's quote follow-up cadence via `api-follow-ups`. Built on branch `quotie-followups` — **not deployed, not cut over to any company yet.**

## Why two lanes

Quotie has two separate boards, and they are backed by different tables:

- **Pre-quote** — `callback_leads`. A lead nobody has quoted yet. Endpoint: `POST api-callbacks`.
- **Post-quote** — `quote_groups`. A quote that has been **sent** and is now being chased. Endpoint: `POST api-follow-ups`.

Before this change the popup only knew the pre-quote lane, so an exec logging "Not a Good Time to Talk" against a customer who already had a quote out created a *callback lead* — a second, parallel record with its own strike cadence — while the real quote sat untouched in the follow-up queue. The exec's call never moved the thing it was actually about.

So the popup now picks a lane, and the two never cross.

## How the lane is picked

**EOD 1 · Stage drives it.** Stage `Post Quote Follow Up` → post-quote lane. Everything else → pre-quote.

**The exec can flip it.** A two-button Pre-quote / Post-quote toggle sits in its own "Quotie lane" row directly under EOD 3 (same styling as the EOD 1 stage buttons). It appears whenever the chosen outcome or EOD 2 answer maps to a Quotie pipeline move in *either* lane — so an exec on the Post Quote stage who picks "Not Ready Yet - Pre-Quote" still sees it, with an amber hint that nothing will be sent in the current lane and they should switch. It is hidden for the plain "also create a task" case. Flipping it overrides the stage for that one submission; changing the stage resets the override, and so does a successful submit.

**The server never trusts the toggle blindly.** `submitEodEntry` re-derives the lane from `eod_fields.stage` whenever the client sends nothing or sends an unrecognised value, and it always re-resolves the action from `quotie_config` — the client's `type` is still only used as a "did the config change under me" cross-check, exactly as before.

## What happens when there is no quote

`POST api-follow-ups` needs an **open sent quote group** for the contact. If the contact has none, Quotie answers `404` with `error.details.reason = "no_quote_group"`. The popup surfaces that as:

> ⚠ Quotie: no sent quote in Quotie for this contact — switch to Pre-quote

The EOD activity, the GHL pipeline move and everything else still succeed — a Quotie failure has never been allowed to fail the EOD submit and still isn't. The exec flips the toggle to Pre-quote and re-logs.

## The outcome map

### Post-quote lane (`api-follow-ups`)

| EOD step | Selection | Quotie effect |
|---|---|---|
| EOD 2 | Didn't Answer / Voicemail | `no_answer` — logs the attempt and pushes the follow-up out by the acting exec's own no-answer delay (in company working days). Fires even with no EOD 3 outcome; skipped when EOD 3 already owns the move |
| EOD 3 | Not Ready Yet - Post Quote | `reschedule` — **date required**, logs a `contacted` attempt, bumps the reschedule count, sets the group to `follow_up_needed` |
| EOD 3 | Not a Good Time to Talk | `reschedule` (same as above — **not** the pre-quote "Parked") |
| EOD 3 | Verbal Confirmation | `verbal_yes` — flags **every** open group for the contact, card moves to Verbal Yes. Optional date also reschedules |
| EOD 3 | Lost - * / DQ - * (12 outcomes) | `lost` — closes the primary open group as lost, `outcome_notes` from the notes box |
| EOD 3 | Abandoned - Not Responding / Abandoned - Headache | `abandoned` — same close, distinct outcome (the pre-quote lane folds these into `lost`; the post-quote lane keeps Quotie's own distinction) |
| EOD 3 | Requires Quoting | falls through to `api-callbacks` `requires_quoting` (see lane-neutral, below) |
| EOD 3 | Book Site Visit | unchanged — `api-site-visits` |
| EOD 3 | Waiting on Photos | unchanged — `api-tasks` |
| EOD 3 | Quote Sent | **nothing.** Quotie already knows a quote went out via its own send pipeline |

`hot` is a supported outcome and is wired end-to-end (blurb, optional date, banner) but no default EOD 3 outcome maps to it — it is there for a per-company override.

**Won is deliberately not offered.** A win is its own popup event type (`Job won`) with its own commission/GHL handling; bolting it onto the EOD 3 selector would give two ways to close a deal that write different things.

### Pre-quote lane (`api-callbacks`) — one addition

| EOD step | Selection | Quotie effect |
|---|---|---|
| EOD 3 | **Not Ready Yet - Pre-Quote** (new) | `callback_requested` — parks the lead for a later call-back, same as Not a Good Time |

Everything else in the pre-quote lane is byte-for-byte what it was. The only other change is cosmetic: the `callback_reason` line for `callback_requested` now reads `Call back requested — {outcome} (EOD log)` instead of hard-coding "Not a good time", because two outcomes share it now.

### Lane-neutral fallback

An outcome with no post-quote mapping falls back to its **pre-quote** action only when that action is lane-neutral:

- `task` — a task is a task regardless of lane
- `site_visit` — ditto
- `callback` with outcome `requires_quoting` — a post-quote contact who needs a **new** quote legitimately re-enters the Requires Quoting column

Every other pre-quote callback (`callback_requested`, `no_answer`, `voicemail`, `lost`) is **not** offered in the post-quote lane. That is the lane-separation rule: a contact with a live quote must never be pushed into the callback-lead cadence.

## New `quotie_config` keys

All three are optional; a company with none of them gets the defaults above.

| Key | Shape | Meaning |
|---|---|---|
| `post_quote_actions` | `{ [eod3Outcome]: action \| null }` | Post-quote lane overrides. Same semantics as the existing `actions`: merged field-by-field over the default, `null` disables |
| `answered_follow_ups` | `{ [eod2Value]: outcome \| null }` | Post-quote lane EOD 2 overrides. Same semantics as `answered_callbacks` |
| `post_quote_stages` | `string[]` | EOD 1 stage values that select the post-quote lane. Default `["Post Quote Follow Up"]` |

```json
{
  "api_url": "https://ucmgleztmtyoptcflsia.supabase.co/functions/v1",
  "api_key": "qk_…",
  "user_map": { "Lachlan": "…auth_id…" },

  "actions": { "Waiting on Photos": { "type": "task", "titleTemplate": "Chase photos from {contact}" } },
  "answered_callbacks": { "Didn't Answer": "no_answer" },

  "post_quote_stages": ["Post Quote Follow Up"],
  "post_quote_actions": {
    "Verbal Confirmation": { "type": "follow_up", "outcome": "hot" },
    "Abandoned - Headache": null
  },
  "answered_follow_ups": { "Didn't Answer": "no_answer" }
}
```

`api_key`, `api_url` and `user_map` are server-only and have never reached the browser. The projection the form receives (`safeQuotieClientConfig`) now carries both lanes' outcome maps, both lanes' EOD 2 signals and the stage list — outcome **names** only, no keys, no auth ids, no task templates.

## Disabling per company

- **A single outcome, post-quote only:** `"post_quote_actions": { "Verbal Confirmation": null }`
- **The whole post-quote lane:** `"post_quote_stages": []` — no stage ever selects it, and the toggle's Post-quote side resolves to nothing. (Execs can still flip the toggle manually; every outcome will just resolve to null and fall back to the plain task.)
- **The EOD 2 no-answer push:** `"answered_follow_ups": { "Didn't Answer": null }`
- **Everything Quotie:** unset `api_key`, as before — the section disappears entirely.

Companies with no `quotie_config` see zero change, and companies already on the pre-quote lane see zero change until their EOD 1 stage is `Post Quote Follow Up`.

## Dates and timezones

`follow_up_date` goes to Quotie as bare `YYYY-MM-DD` and `follow_up_time` as `HH:MM`. Quotie reads both as a **wall clock in the company's timezone** (`companies.timezone`, default `Australia/Sydney`). This side must never compose an ISO timestamp: Vercel runs UTC, and an AU date built from server-local `Date` fields is a day out for most of the working day. Every date this code computes or formats goes through `Intl` pinned to `Australia/Sydney`.

Date-only means company-local midnight, which is exactly what Quotie's own browser UI stores and what its reminder banner reads back as "no time set" — so the success banner prints a bare date for midnight and `18 Sep 14:30` when a real time was set.

## What is deliberately excluded

- **Won.** Covered by the `Job won` event type.
- **A time picker in the pre-quote lane.** `callback_date` stays date-only for now; api-callbacks' cadence works in whole days.
- **`quote_group_id`.** The endpoint accepts one, but the popup only knows the GHL contact — Quotie picks the most urgent open group (ordered by follow-up date, nulls last, then newest send). `lost` / `abandoned` close only that primary group and report the rest as `other_open_groups`, which the banner surfaces as "N other open quotes untouched" so the exec knows to check.

## Testing safety (unchanged rules)

- **Never test against real leads** — dev and prod share LIVE GHL locations. Lachlan Boys / Buzz Brady test contacts only.
- `api-follow-ups` makes **no GHL writes** beyond the shared contact import (a 5s GET for an unknown contact), so it is as safe to smoke as `api-callbacks` — but unlike `api-callbacks` it **closes real quote groups** on `lost` / `abandoned`. Smoke those two against a throwaway quote only.
- Nothing here has been run against Quotie prod or dev from this repo yet.

## References (Quotie repo)

- `.claude/docs/integrations/external-api.md` — full `POST /v1/follow-ups` contract (request, per-outcome behaviour, 404 `no_quote_group`)
- `supabase/functions/api-follow-ups/index.ts` — the implementation
- `.claude/docs/features/follow-ups.md` — the in-app follow-up dashboard the endpoint mirrors
- `.claude/docs/integrations/eod-creator.md` — integration state + rollout runbook
