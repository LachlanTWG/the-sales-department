// Read layer for the Site Visits calendar. Pulls `site_visit_booked`
// activities for a date range and buckets each into a Sydney-local day +
// time label. RLS scopes what the client can see (admin = all, roster exec =
// every exec's visits); the caller narrows further by sales_person / company.
//
// All day bucketing is done HERE, on the server, in the Sydney timezone —
// never on the client, whose local tz (and Vercel's UTC) would disagree with
// the business tz and shift visits across midnight.

import type { SupabaseClient } from "@supabase/supabase-js";
import { SYDNEY_TZ } from "./format";
import { addDaysIso } from "./dates";

const PAGE_SIZE = 1000;
async function pageAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
}

export type SiteVisit = {
  id: string;
  companyId: string;
  salesPersonId: string | null;
  salesPersonName: string;
  contactName: string;
  contactAddress: string;
  contactId: string | null;
  adSource: string;
  outcome: string;                // round-tripped so the edit drawer is faithful
  quoteJobValue: string;          // (usually empty for site visits)
  appointmentAt: string | null;   // raw ISO timestamptz, or null
  occurredOn: string;             // YYYY-MM-DD the booking was logged
  dayKey: string;                 // YYYY-MM-DD in Sydney (appointment, else booking date)
  timeLabel: string;              // Sydney time "9:00am", or "Time TBC" when unscheduled
  localTimeLabel: string | null;  // time in the client's own tz, when it differs from Sydney
  localCity: string | null;       // e.g. "Perth"
  scheduled: boolean;             // has a real appointment time
  sortMs: number;                 // ordering within a day (timed first, TBC last)
  virtual: boolean;               // Virtual Site Visit (calendar name/title)
};

// Sydney-tz day formatter. en-CA renders the date as YYYY-MM-DD.
const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: SYDNEY_TZ, year: "numeric", month: "2-digit", day: "2-digit",
});

function sydneyDayKey(iso: string): string {
  return dayFmt.format(new Date(iso));               // "2026-06-18"
}

/** Format an instant as a short time ("9:00am") in any IANA timezone. */
export function formatTimeInTz(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true,
  }).format(new Date(iso)).replace(/\s/g, "").toLowerCase();
}

/** Human city label from an IANA tz, e.g. "Australia/Perth" → "Perth". */
export function tzCityLabel(tz: string): string {
  return (tz.split("/").pop() || tz).replace(/_/g, " ");
}

// ─── Appointment timezone correction ─────────────────────────────────
//
// The webhook stores an appointment's *client-local wall clock* but tags it
// as UTC. So "3:15pm in Perth" lands in the DB as `2026-06-17T15:15:00Z`,
// which naively renders as 1:15am Sydney / 11:15pm Perth — both wrong, and
// it also buckets the visit onto the wrong calendar day.
//
// Fix: read the stored wall-clock digits, reinterpret them in the client's
// timezone to get the true instant, then render that instant in Sydney (the
// execs' reference) and in the client's tz (its real local time).

/** Offset (ms) where  localWallClock = utc + offset, for `tz` at `utcMs`. */
function tzOffsetMsAt(tz: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const m: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") m[p.type] = Number(p.value);
  return Date.UTC(m.year, m.month - 1, m.day, m.hour, m.minute, m.second) - utcMs;
}

/** The UTC instant (ms) of a wall-clock that is local to `tz`. */
function wallClockToInstant(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let instant = guess - tzOffsetMsAt(tz, guess);
  instant = guess - tzOffsetMsAt(tz, instant);   // refine once across a DST edge
  return instant;
}

/** Pull the literal wall-clock digits out of a stored timestamp string. */
function parseWallClock(ts: string): { y: number; mo: number; d: number; h: number; mi: number } | null {
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] };
}

/** Corrected instant (ISO) for a stored appointment, given the client's tz. */
function correctedInstantIso(storedTs: string, clientTz: string): string {
  const wc = parseWallClock(storedTs);
  if (!wc) return storedTs;                         // unparseable — leave as-is
  return new Date(wallClockToInstant(wc.y, wc.mo, wc.d, wc.h, wc.mi, clientTz)).toISOString();
}

type ActivityRow = {
  id: string;
  company_id: string;
  sales_person_id: string | null;
  sales_person_name: string | null;
  contact_name: string | null;
  contact_address: string | null;
  contact_id: string | null;
  ad_source: string | null;
  outcome: string | null;
  quote_job_value: string | null;
  appointment_at: string | null;
  occurred_on: string;
  visit_kind: string | null;
};

const SELECT =
  "id, company_id, sales_person_id, sales_person_name, contact_name, contact_address, contact_id, ad_source, outcome, quote_job_value, appointment_at, occurred_on, visit_kind";

function toVisit(r: ActivityRow, clientTz: string): SiteVisit {
  const scheduled = !!r.appointment_at;
  const tzDiffers = clientTz !== SYDNEY_TZ;

  // Corrected instant: the stored wall-clock reinterpreted in the client's tz.
  const instantIso = scheduled ? correctedInstantIso(r.appointment_at!, clientTz) : null;

  const dayKey = instantIso ? sydneyDayKey(instantIso) : r.occurred_on;
  return {
    id: r.id,
    companyId: r.company_id,
    salesPersonId: r.sales_person_id,
    salesPersonName: r.sales_person_name || "—",
    contactName: (r.contact_name || "").trim() || "Unknown contact",
    contactAddress: (r.contact_address || "").replace(/,\s*$/, "").trim(),
    contactId: r.contact_id,
    adSource: r.ad_source || "",
    outcome: r.outcome || "",
    quoteJobValue: r.quote_job_value || "",
    appointmentAt: r.appointment_at,
    occurredOn: r.occurred_on,
    dayKey,
    timeLabel: instantIso ? formatTimeInTz(instantIso, SYDNEY_TZ) : "Time TBC",
    localTimeLabel: instantIso && tzDiffers ? formatTimeInTz(instantIso, clientTz) : null,
    localCity: instantIso && tzDiffers ? tzCityLabel(clientTz) : null,
    scheduled,
    virtual: String(r.visit_kind || "").toLowerCase() === "virtual",
    sortMs: instantIso
      ? new Date(instantIso).getTime()
      : new Date(`${r.occurred_on}T23:59:59Z`).getTime(),   // TBC sorts last in its day
  };
}

export type LoadSiteVisitsOpts = {
  gridStart: string;                 // YYYY-MM-DD, first visible day (Sydney)
  gridEnd: string;                   // YYYY-MM-DD, last visible day (Sydney)
  salesPersonIds: string[] | null;   // null = no person filter (all the viewer may see)
  companyId?: string;                // optional company filter
  companyTzById: Map<string, string>; // company_id → IANA tz, for appointment correction
};

/**
 * Load every site visit whose Sydney appointment day falls within the visible
 * grid. Visits with no appointment time are placed on their booking date and
 * labelled "Time TBC". Returns sorted by day then time.
 */
export async function loadSiteVisits(
  supabase: SupabaseClient,
  opts: LoadSiteVisitsOpts,
): Promise<SiteVisit[]> {
  const { gridStart, gridEnd, salesPersonIds, companyId, companyTzById } = opts;

  // An explicit empty person filter means "show nothing" (caller scoped to a
  // roster they aren't on); skip the round-trip.
  if (salesPersonIds && salesPersonIds.length === 0) return [];

  // We filter on the stored appointment_at (client wall-clock tagged as UTC),
  // then re-bucket by the *corrected* Sydney day. The two can differ by up to
  // a client's UTC offset, so pad the fetch window ±2 days and clip exactly by
  // dayKey afterwards.
  const queryStartUtc = `${addDaysIso(gridStart, -2)}T00:00:00.000Z`;
  const queryEndUtc = `${addDaysIso(gridEnd, 2)}T23:59:59.999Z`;

  // Fresh scoped query per call — PostgREST builders are single-use, and
  // returning one lets TS infer the builder type without fragile generics.
  function scoped() {
    let q = supabase.from("activities").select(SELECT).eq("event_type", "site_visit_booked");
    const activeIds = [...companyTzById.keys()];
    if (companyId) {
      if (!companyTzById.has(companyId)) {
        q = q.eq("company_id", "00000000-0000-0000-0000-000000000000");
      } else {
        q = q.eq("company_id", companyId);
      }
    } else if (activeIds.length > 0) {
      q = q.in("company_id", activeIds);
    } else {
      q = q.eq("company_id", "00000000-0000-0000-0000-000000000000");
    }
    if (salesPersonIds) q = q.in("sales_person_id", salesPersonIds);
    return q;
  }

  const [scheduledRows, unscheduledRows] = await Promise.all([
    pageAll<ActivityRow>((from, to) =>
      scoped()
        .not("appointment_at", "is", null)
        .gte("appointment_at", queryStartUtc)
        .lte("appointment_at", queryEndUtc)
        .range(from, to),
    ),
    pageAll<ActivityRow>((from, to) =>
      scoped()
        .is("appointment_at", null)
        .gte("occurred_on", gridStart)
        .lte("occurred_on", gridEnd)
        .range(from, to),
    ),
  ]);

  const visits = [...scheduledRows, ...unscheduledRows]
    .map(r => toVisit(r, companyTzById.get(r.company_id) || SYDNEY_TZ))
    .filter(v => v.dayKey >= gridStart && v.dayKey <= gridEnd);   // exact Sydney-day clip

  visits.sort((a, b) => (a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : a.sortMs - b.sortMs));
  return visits;
}
