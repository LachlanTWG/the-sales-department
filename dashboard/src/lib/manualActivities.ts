// Shared plumbing for hand-entered activities. Two entry points use this:
// the authed dashboard drawer (app/(app)/activities/actions.ts) and the
// token-gated GHL-embedded form (app/eod-entry/actions.ts). Both must produce
// identical payloads for the backend's /api/activities/manual endpoint, which
// runs the same logActivities() dual-write (Activity Log sheet + Postgres)
// as the live webhooks.

export const ALLOWED_EVENT_TYPES = [
  "eod_update",
  "quote_sent",
  "site_visit_booked",
  "email_sent",
  "job_won",
] as const;
export type EventType = (typeof ALLOWED_EVENT_TYPES)[number];

// DB enum → the sheet's "Event Type" label that the backend / logActivities expects.
export const EVENT_TYPE_TO_SHEET: Record<EventType, string> = {
  eod_update:        "EOD Update",
  quote_sent:        "Quote Sent",
  site_visit_booked: "Site Visit Booked",
  email_sent:        "Email Sent",
  job_won:           "Job Won",
};

export type NewActivityItem = {
  contact_name?: string;
  contact_id?: string; // GHL contact id, when the entry came from the browser extension
  contact_address?: string;
  outcome?: string;
  ad_source?: string;
  quote_job_value?: string;
  appointment_at?: string; // "YYYY-MM-DDTHH:MM" from datetime-local
  visit_kind?: "in_person" | "virtual";
  /** Job won only — used for Sales Exec Invoicing commission rows */
  quote_number?: string;
  /** Job won only — equal split across all active roster execs on that company */
  split_commission?: boolean;
  /**
   * Job won only — full commission schedule then /2 client charge
   * (Quotie / process win without a salesman). Independent of split.
   */
  half_commission_charge?: boolean;
};

export type SheetActivity = {
  date: string;
  salesPerson: string;
  contactName: string;
  eventType: string;
  outcome: string;
  adSource: string;
  quoteJobValue: string;
  contactAddress: string;
  contactId: string;
  appointmentDateTime: string;
  appointmentDate: string;
  visitKind?: "in_person" | "virtual";
  quoteNumber?: string;
  splitCommission?: boolean;
  halfCommissionCharge?: boolean;
};

export function isIsoDate(v: string | null | undefined): boolean {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

// Strip $, commas and whitespace; keep pipe separators (alternative quote
// tiers). Mirrors the /webhook/quote cleaning in src/server.js.
export function cleanValue(raw: string | null | undefined): string {
  return String(raw || "")
    .split("|")
    .map(v => v.replace(/[$,\s]/g, "").trim())
    .filter(Boolean)
    .join("|");
}

export function isMeaningful(it: NewActivityItem): boolean {
  return Boolean(
    (it.contact_name && it.contact_name.trim()) ||
    (it.quote_job_value && it.quote_job_value.trim()) ||
    (it.contact_address && it.contact_address.trim()) ||
    (it.outcome && it.outcome.trim()) ||
    (it.appointment_at && it.appointment_at.trim()),
  );
}

export function buildSheetActivities(
  occurredOn: string,
  eventType: EventType,
  salesPersonName: string,
  items: NewActivityItem[],
): SheetActivity[] {
  const sheetType = EVENT_TYPE_TO_SHEET[eventType];
  return items.map(it => ({
    date: occurredOn,
    salesPerson: salesPersonName,
    contactName: it.contact_name?.trim() || "",
    eventType: sheetType,
    outcome: it.outcome?.trim() || "",
    adSource: it.ad_source?.trim() || "",
    quoteJobValue:
      eventType === "quote_sent" || eventType === "job_won"
        ? cleanValue(it.quote_job_value)
        : "",
    contactAddress: it.contact_address?.trim() || "",
    contactId: it.contact_id?.trim() || "",
    appointmentDateTime: it.appointment_at?.trim() || "",
    appointmentDate: it.appointment_at ? it.appointment_at.slice(0, 10) : "",
    ...(eventType === "site_visit_booked" && it.visit_kind
      ? { visitKind: it.visit_kind }
      : {}),
    ...(eventType === "job_won"
      ? {
          quoteNumber: (it.quote_number || "").trim(),
          splitCommission: Boolean(it.split_commission),
          halfCommissionCharge: Boolean(it.half_commission_charge),
        }
      : {}),
  }));
}

export type PostResult = { ok: true; count: number } | { ok: false; error: string };

// INGEST_URL (the Supabase Edge Function base, e.g.
// https://<ref>.supabase.co/functions/v1/ingest) takes precedence once set.
// String-concat, not new URL(path, base): an absolute path would REPLACE
// the /functions/v1/ingest prefix and 404 at the gateway. NODE_SERVICE_URL
// stays as the Railway fallback until the cutover.
export async function postManualActivities(
  companyName: string,
  activities: SheetActivity[],
): Promise<PostResult> {
  const ingestBase = process.env.INGEST_URL;
  const base = process.env.NODE_SERVICE_URL;
  const secret = process.env.WEBHOOK_SECRET;
  if (!ingestBase && !base) return { ok: false, error: "INGEST_URL / NODE_SERVICE_URL not configured" };
  const endpoint = ingestBase
    ? `${ingestBase.replace(/\/+$/, "")}/api/activities/manual`
    : new URL("/api/activities/manual", base).toString();

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify({ companyName, activities }),
      cache: "no-store",
    });
  } catch (e) {
    return { ok: false, error: `Couldn't reach the activity service: ${(e as Error).message}` };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg = `Service error ${res.status}`;
    try { msg = JSON.parse(text).error || msg; } catch { /* keep default */ }
    return { ok: false, error: msg };
  }
  return { ok: true, count: activities.length };
}
