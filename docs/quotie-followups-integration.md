# Quotie Follow-Ups Integration (post-quote lane)

> The companion to [`quotie-pipeline-integration.md`](./quotie-pipeline-integration.md). That doc wired the EOD popup into Quotie's **pre-quote** pipeline (`api-callbacks` → callback leads, Day N / Parked / Requires Quoting / Lost). This one adds the **post-quote** half: once a quote has actually been sent, the same EOD selector now drives Quotie's quote follow-up cadence via `api-follow-ups`. Built on branch `quotie-followups` — **not deployed, not cut over to any company yet.** The popup now also *reads* Quotie when it opens, and splits the old single Quotie checkbox into an independent task checkbox and a follow-up checkbox.

## Why two lanes

Quotie has two separate boards, and they are backed by different tables:

- **Pre-quote** — `callback_leads`. A lead nobody has quoted yet. Endpoint: `POST api-callbacks`.
- **Post-quote** — `quote_groups`. A quote that has been **sent** and is now being chased. Endpoint: `POST api-follow-ups`.

Before this change the popup only knew the pre-quote lane, so an exec logging "Not a Good Time to Talk" against a customer who already had a quote out created a *callback lead* — a second, parallel record with its own strike cadence — while the real quote sat untouched in the follow-up queue. The exec's call never moved the thing it was actually about.

So the popup now picks a lane, and the two never cross.

## How the lane is picked

**Quotie answers first.** When the popup opens it asks Quotie what it already knows about this GHL contact (`GET api-follow-ups/contact`, below). Quotie's own `lane` is the default: it is the only side that can see whether a **sent** quote is still open. A contact with one is post-quote no matter what the GHL stage says.

**EOD 1 · Stage is the fallback, not an override.** Stage `Post Quote Follow Up` → post-quote lane, everything else → pre-quote — but only when the Quotie read returned nothing (integration off, no contact id, or the read failed). A stage change never overrules a loaded Quotie state; Quotie knows about the sent quote and the GHL stage is frequently stale.

**The exec can still flip it.** The Pre-quote / Post-quote toggle now lives *inside* the follow-up panel and is visible the whole time that panel is open. Flipping it overrides both for that one submission; changing the stage resets the override, and so does a successful submit. When the chosen outcome only maps in the *other* lane, an amber hint says so — logging in the current lane just sets the follow-up date.

**The server never trusts the toggle blindly.** `submitEodEntry` re-derives the lane from `eod_fields.stage` whenever the client sends nothing or sends an unrecognised value, and it always re-resolves the action from `quotie_config` — the client's `type` is still only used as a "did the config change under me" cross-check, exactly as before.

## Reading Quotie on open

`GET {api_url}/api-follow-ups/contact?ghl_contact_id=…` — side-effect free on Quotie's side (no contact import, no attempt rows, no writes) and carrying names only, never auth ids, so the whole payload is handed straight to the browser.

`getQuotieFollowUpState()` runs inside the page's existing `Promise.all` with a **4s** guard (the write calls get 10s; this one is on the popup's critical path) and never throws. It returns the contact, the lane, and each lane's current record:

- `post_quote` — the primary open sent quote group: `follow_up_local` (`{date, time}` company-local wall clock, `time: null` at midnight), `reschedule_count`, `group_name`, `is_hot`, `verbal_confirmed_at`, `other_open_groups`, `pipeline_value`
- `pre_quote` — the active callback lead: `callback_local`, `attempt_count`, `status`, `callback_reason`

The panel prints it as a single line, always for the lane the exec is about to log against:

> In Quotie: follow-up due Thu 18 Sep 14:30 · 2nd follow-up · Metal Roof Options · +1 other open quote
> In Quotie: call back Mon 22 Sep · 3 attempts · Requires Quoting

An overdue date renders amber with `(overdue)`. A miss reads `No Quotie record yet — logging will create a callback lead.` (pre) or `No open sent quote in Quotie — switch to Pre-quote to log a call-back.` (post). A failed read reads `Couldn't reach Quotie — will still update on submit.` — the read is advisory only and never blocks the log.

The same read runs again through the `fetchQuotieFollowUpState` server action after every successful submit, so the line shows the move that just landed without reloading the popup. It also prefills the date/time picker, but **only when Quotie's date is today or later** — a stale date would quietly re-book the past.

## The two checkboxes

The sticky bar carries two independent checkboxes, left of "Log it". Either, both or neither:

| Checkbox | Fires | Auto-ticks when |
|---|---|---|
| **Quotie task** | `api-tasks` only | the EOD 3 outcome maps to a `task` action |
| **Set follow-up** | the one pipeline call (below) | the outcome or EOD 2 answer means something to Quotie in *either* lane |


Touching either one pins it for the rest of the session. They no longer share a box: a submit can now book a site visit, move the pipeline **and** create a task, and the banner reports each leg on its own line (`✓ Site visit booked in Quotie`, `✓ Follow-up set in Quotie · 18 Sep 14:30 · 3rd follow-up`, `✓ Task created in Quotie`; failures per leg in amber).

For a terminal outcome (`lost` / `abandoned` / `requires_quoting`) the follow-up checkbox reads **"Update Quotie"** instead, and the date picker is hidden — the move still fires, there is just nowhere for a date to land.

## One call, whatever drove it

"Set follow-up" never adds a *second* Quotie call. `resolveFollowUpPlan()` (pure, pinned by `src/scripts/quotieResolver.test.mts`) picks exactly one, in this precedence:

1. **EOD 3** — the standard outcome maps to a pipeline move in this lane
2. **EOD 2** — the no-answer / voicemail signal, when EOD 3 mapped to nothing
3. **plain** — neither, and the exec ticked the box anyway

The checkbox owns the **whole** leg: unticked, nothing is sent, outcome-driven moves included. An exec who unticks it on a Lost call does not find the quote closed in Quotie anyway. (Ticked, the client always sends `quotie_follow_up` — an empty object for the terminal outcomes where the picker is hidden, since presence is the signal.)

The exec's date is then merged into whichever call that is:

| Plan | Endpoint field | Date |
|---|---|---|
| post `reschedule` / `verbal_yes` / `hot` | `follow_up_date` + `follow_up_time` | merged; a reschedule with no date defaults to tomorrow |
| post `no_answer` (EOD 2) | `follow_up_date` + `follow_up_time` | merged — an explicit date **replaces** Quotie's no-answer bump |
| pre `callback_requested` | `callback_date` + `callback_time` | merged; defaults to tomorrow on the plain path |
| pre `no_answer` / `voicemail` (EOD 2) | `callback_date` + `callback_time` | merged — replaces the next-business-day bump; the 5-strike auto-abandon is untouched |
| post/pre `lost` / `abandoned`, pre `requires_quoting` | — | **not applied.** The move fires as before and the banner appends `follow-up date not applied (quote closed)` / `(requires quoting)` |
| plain, post lane | `reschedule` | required |
| plain, pre lane | `callback_requested`, reason `Follow-up set from EOD log` | required |

The picker is **required** only where Quotie cannot invent a date for itself: a `reschedule`, a `callback_requested`, and the plain set. On the EOD 2 no-answer path (and for `verbal_yes` / `hot`) it is optional — leave it blank and Quotie bumps by the usual delay; fill it in and the explicit date wins.

The EOD 2 signal still yields when a site visit was booked in the same submit — a call that ended in a booking must not also log a no-answer attempt.

`callback_time` is new on `POST /v1/callbacks`; both endpoints now parse `*_date` / `*_time` identically (Quotie's `_shared/localDateTime.ts`).

**Old clients keep working.** `quotie: {type: callback | follow_up}`, `quotie_answered_callback` and `quotie_task` all still trigger the same legs across the deploy boundary; the new `quotie_follow_up` input is simply the current popup's way of saying "the box is ticked, here is the date".

## What happens when there is no quote

`POST api-follow-ups` needs an **open sent quote group** for the contact. If the contact has none, Quotie answers `404` with `error.details.reason = "no_quote_group"`. The popup surfaces that as:

> ⚠ Quotie: no sent quote in Quotie for this contact — switch to Pre-quote

The EOD activity, the GHL pipeline move and everything else still succeed — a Quotie failure has never been allowed to fail the EOD submit and still isn't. The exec flips the toggle to Pre-quote and re-logs.

## The outcome map

### Post-quote lane (`api-follow-ups`)

| EOD step | Selection | Quotie effect |
|---|---|---|
| EOD 2 | Didn't Answer / Voicemail | `no_answer` — logs the attempt and pushes the follow-up out by the acting exec's own no-answer delay (in company working days), or to the exec's own date when one is set. Fires even with no EOD 3 outcome; skipped when EOD 3 already owns the move |
| EOD 3 | Not Ready Yet - Post Quote | `reschedule` — **date required** (defaults to tomorrow if a stale client omits it), logs a `contacted` attempt, bumps the reschedule count, sets the group to `follow_up_needed` |
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

`follow_up_date` / `callback_date` go to Quotie as bare `YYYY-MM-DD` and `follow_up_time` / `callback_time` as `HH:MM` — **both lanes carry a time now**. Quotie reads both as a **wall clock in the company's timezone** (`companies.timezone`, default `Australia/Sydney`). This side must never compose an ISO timestamp: Vercel runs UTC, and an AU date built from server-local `Date` fields is a day out for most of the working day. Every date this code computes or formats goes through `Intl` pinned to `Australia/Sydney`.

Date-only means company-local midnight, which is exactly what Quotie's own browser UI stores and what its reminder banner reads back as "no time set" — so the success banner prints a bare date for midnight and `18 Sep 14:30` when a real time was set.

## What is deliberately excluded

- **Won.** Covered by the `Job won` event type.
- **`quote_group_id`.** The endpoint accepts one, but the popup only knows the GHL contact — Quotie picks the most urgent open group (ordered by follow-up date, nulls last, then newest send). `lost` / `abandoned` close only that primary group and report the rest as `other_open_groups`, which the banner surfaces as "N other open quotes untouched" so the exec knows to check.

## Testing safety (unchanged rules)

- **Never test against real leads** — dev and prod share LIVE GHL locations. Lachlan Boys / Buzz Brady test contacts only.
- `api-follow-ups` makes **no GHL writes** beyond the shared contact import (a 5s GET for an unknown contact), so it is as safe to smoke as `api-callbacks` — but unlike `api-callbacks` it **closes real quote groups** on `lost` / `abandoned`. Smoke those two against a throwaway quote only.
- Nothing here has been run against Quotie prod or dev from this repo yet.

## Verification

```bash
npm test                                   # resolver assertions (repo root, node --test)
cd dashboard && pnpm exec tsc --noEmit     # typecheck
cd dashboard && pnpm build                 # what Vercel runs
```

`src/scripts/quotieResolver.test.mts` pins the pure rules: lane selection, both lanes' outcome maps, the lane-separation rule, the safe client projection, the one-call precedence and the date-merge table above. It runs under `node --experimental-strip-types`, importing `quotie.ts` directly — no build step, no network.

## References (Quotie repo)

- `.claude/docs/integrations/external-api.md` — full `POST /v1/follow-ups` contract (request, per-outcome behaviour, 404 `no_quote_group`)
- `supabase/functions/api-follow-ups/index.ts` — the implementation
- `.claude/docs/features/follow-ups.md` — the in-app follow-up dashboard the endpoint mirrors
- `.claude/docs/integrations/eod-creator.md` — integration state + rollout runbook
