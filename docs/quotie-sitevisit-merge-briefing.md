# Quotie ↔ Site-Visit Merge

> **For Lockie.** This branch (`quotie-sitevisit-merge`) unifies the three separate site-visit-booking code paths into one shared server-side handler, and adds a new ingest route so bookings made in **Quotie's own UI** flow back into the EOD tracker + Slack. Nothing here is deployed — it's local commits only, waiting on this briefing. **No new secrets on your side.** Quotie sets two secrets on its side.

## Why this exists

Today a site visit can be booked in three places, and each does a *different* subset of the follow-through work:

| Path | Logs `site_visit_booked` activity | Slack booking summary | Pushes to Quotie | Resolves the pending banner row |
|---|---|---|---|---|
| **Pending banner** (`completePendingSiteVisit`) — exec fills details on a GHL-calendar-originated booking | ✅ | ✅ | ❌ | ✅ |
| **EOD-3 "Book Site Visit"** (`submitEodEntry`) — outcome picked in the EOD log | ❌ (only the `eod_update`) | ❌ | ✅ | ❌ |
| **Quotie UI** — booked directly inside Quotie | ❌ (never reached this repo) | ❌ | n/a | n/a |

Two loops fall out of that:

1. **EOD-3 double-handling:** an exec books via EOD-3, but because that path never logged a `site_visit_booked` activity, never sent Slack, and never resolved the pending row, the same booking would *still* appear in the pending banner later — someone re-handles it.
2. **Quotie-side blind spot:** a visit booked inside Quotie's UI never appeared in the EOD tracker or on Slack at all.

## What this branch changes: three paths → one handler

All three now run the **same four legs**, each with an **explicit on/off toggle** at the call-site (never inferred):

- **a. Activity** — insert the `site_visit_booked` activity (via `postManualActivities` → your `/api/activities/manual`)
- **b. Slack** — booking summary via `NODE_SERVICE_URL` `/api/site-visit-summary` (your existing endpoint, unchanged)
- **c. Quotie** — push the booking to Quotie via `createQuotieSiteVisit`
- **d. Pending** — resolve the matching `pending_site_visits` row so the booking can't resurface in the banner

A failure in any leg never fails the others or the EOD submit (your existing never-throw idiom, preserved).

### Per-path behaviour after the merge

| Path | a. Activity | b. Slack | c. Quotie | d. Pending |
|---|---|---|---|---|
| **Pending banner** | ✅ (unchanged) | ✅ (unchanged) | ✅ **NEW** — **links** to the existing GHL appointment (id from `raw_payload`), never creates a duplicate | ✅ by known `pending_id` (unchanged) |
| **EOD-3 "Book Site Visit"** | ✅ **NEW** | ✅ **NEW** | ✅ (unchanged) — creates the GHL appointment per the form toggle | ✅ **NEW** — pre-resolves by contact + appointment time |
| **Quotie UI** (via new ingest route) | ✅ (source `'quotie'`) | ✅ | n/a (origin) | n/a |

**Files:** `dashboard/src/app/eod-entry/actions.ts` (shared `handleSiteVisitBooked`, both callers rewired), `dashboard/src/app/eod-entry/quotie.ts` (`createQuotieSiteVisit` gains an optional `ghl_appointment_id`), `supabase/functions/ingest/index.ts` (new route).

## The Quotie → ingest payload contract

New route on the ingest edge function, same Bearer `WEBHOOK_SECRET` auth as every other webhook route (`verify_jwt` is already off on `ingest`):

```
POST {INGEST_URL}/webhook/quotie/site-visit
Authorization: Bearer <WEBHOOK_SECRET>
```

```json
{
  "source": "quotie",
  "ghl_location_id": "<required — resolves the company, same as the GHL routes>",
  "company_name": "<informational>",
  "contact_name": "<required>",
  "contact_phone": "",
  "contact_email": "",
  "address": "",
  "visit_date": "<required — YYYY-MM-DD>",
  "visit_time": "<optional — HH:MM>",
  "booked_by_name": "<roster name; unmatched → 'Team' (unattributed)>",
  "ghl_appointment_id": "<optional — Quotie's GHL appointment id>",
  "quotie_site_visit_id": "<optional — Quotie's own id>"
}
```

What the route does:

1. Resolves the company by `ghl_location_id` (unknown location → `404`, body persisted for replay).
2. **Dedupe guard:** if an activity already exists for `contact_name` + `visit_date` + source `'quotie'`, returns `200 {"skipped":"duplicate"}` and does nothing else. Safe under retries/replays.
3. Inserts a `site_visit_booked` activity with `source = 'quotie'`; sales person matched from `booked_by_name` against the roster (first-name canonical), else `Team`.
4. Forwards the Slack booking summary to `NODE_SERVICE_URL/api/site-visit-summary` (best-effort — a Slack failure never fails the insert).
5. `?dryrun=1` returns the would-be row without inserting, like the other webhook routes.

Response on success: `200 {"status":"logged","type":"site-visit","source":"quotie","company":"…","salesPerson":"…","slack":"sent|skipped"}`.

## Double-handling loops this closes

- **EOD-3 booking no longer resurfaces in the banner.** The EOD-3 path now logs the `site_visit_booked` activity *and* pre-resolves any open pending row matching the contact + appointment time.
- **Pending-banner bookings now reach Quotie** (previously they only logged + Slacked locally).
- **Quotie-UI bookings now reach the tracker + Slack** via the new route.

## ⚠️ Reporting change — expect site-visit counts to rise

**EOD-3 "Book Site Visit" submissions now produce BOTH an `eod_update` and a `site_visit_booked` activity.** Previously an EOD-3 booking only wrote the `eod_update`, so those bookings were **invisible in `site_visit_booked` reporting** — the site-visit numbers in reports/sheets were an *undercount*. After this change, site-visit counts in reports/sheets will **rise** to reflect bookings that were previously uncounted.

This is not double-counting: the **pending pre-resolution** built into this branch prevents the same *physical* booking from being counted twice when it also arrives via the GHL calendar webhook path — that pending row is resolved (not re-logged) once the EOD-3 booking is handled. The rise is real, previously-missing volume, not inflation.

## Secrets

**Your side: nothing new.** The new ingest route reuses the existing `WEBHOOK_SECRET`. It uses one *optional* env, `NODE_SERVICE_URL` (the Railway base) to forward the Slack summary — if it's already set for other reasons the summary works; if it's unset the route still logs the activity and just skips Slack. (Set it on the `ingest` function only if you want Quotie-UI bookings to Slack.)

**Quotie's side (Buzz sets on Quotie prod):**

| Quotie secret | Value |
|---|---|
| `EOD_INGEST_WEBHOOK_SECRET` | = your `WEBHOOK_SECRET` (shared) |
| `EOD_INGEST_URL` | your ingest base, e.g. `https://<ref>.supabase.co/functions/v1/ingest` |

Quotie's notifier POSTs to `EOD_INGEST_URL/webhook/quotie/site-visit` with `Authorization: Bearer <EOD_INGEST_WEBHOOK_SECRET>`. (On Quotie dev, `EOD_INGEST_URL` is intentionally left unset so it's a no-op there.)

The `ghl_appointment_id` parameter on `createQuotieSiteVisit` is **live on Quotie dev and deploying to Quotie prod** — it lets a caller link an existing GHL appointment instead of creating a new one. This branch uses it on the pending-banner path (link, don't duplicate — see "Linking the GHL appointment" below).

## Deliberately NOT in this branch (Workstream D)

Merging the *two EOD-logger UIs* into one is parked. When it lands it will add a **"Send Slack summary" checkbox** to the unified site-visit UI:

- **default-checked every time** (no sticky memory — it resets each open),
- a **dynamic submit label** reflecting what will happen,
- and it **gates only the Slack leg** — the activity log and the Quotie push always run regardless.

The shared `handleSiteVisitBooked` already takes an explicit `sendSlack` toggle, so Workstream D only needs to wire that checkbox to it.

## Linking the GHL appointment (pending-banner path)

A pending booking already exists as a GHL appointment (the calendar webhook created it), so the pending-banner path **links** to it in Quotie rather than creating a duplicate. The `/webhook/ghl/site-visit` handler in `src/server.js` already stores the whole calendar webhook body as `pending_site_visits.raw_payload`, and the GHL appointment id lives inside it — **no webhook or schema change is needed, and this works for existing pending rows too.**

Contract (the extractor is null-safe and falls back in order):

```
raw_payload.calendar.appointmentId        // primary — e.g. "ti0PKiP7l8iA4y16NOFm"
raw_payload["Appointment ID - Automated"] // fallback custom-field key
→ undefined                               // neither present
```

The pending path extracts that id from the pending row and passes it to Quotie as `ghl_appointment_id`, always with `create_ghl_appointment: false`. If neither field is present, Quotie simply records the visit without linking (still no duplicate appointment).

## Deploy checklist

1. Review this branch locally (nothing is deployed; `main` auto-deploys prod, so **do not merge until briefed**).
2. Merge `quotie-sitevisit-merge` → `main` → Vercel (dashboard) + Railway (Node) auto-deploy.
3. Deploy the `ingest` edge function (the new route ships with it): `npx supabase functions deploy ingest --project-ref <ref>`.
4. **Set nothing new** on your side (optionally set `NODE_SERVICE_URL` on the `ingest` function if you want Quotie-UI bookings to Slack).
5. Quotie sets its two secrets (`EOD_INGEST_WEBHOOK_SECRET`, `EOD_INGEST_URL`) on Quotie prod.
6. Smoke test: book a visit in Quotie's UI → confirm the tracker activity (source `quotie`) + Slack summary; book via EOD-3 → confirm it does **not** re-appear in the pending banner.
