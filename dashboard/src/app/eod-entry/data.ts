// Server-side data for the /eod-entry popup: per-company dropdown options and
// the contact's prior history. Options are SELF-LEARNING — the distinct
// values this company has actually logged (via the GHL webhook or this form),
// merged with a standard default list — so a new option added to a GHL custom
// field shows up here after its first webhook, no config. One-off typos are
// filtered by requiring 3+ uses for non-default values.

import { createAdminClient } from "@/lib/supabase/admin";

export type EodOptions = {
  stages: string[];
  outcomes: string[];
  sources: string[];
};

export type HistoryEntry = {
  date: string;   // YYYY-MM-DD
  label: string;  // "EOD update", "Quote sent", ...
  detail: string; // compact per-type summary
  person: string;
};

export type ContactHistory = {
  /** The contact's name as recorded in our DB — more reliable than the
   *  extension's DOM scrape, which can pick up page headings ("Contacts"). */
  canonicalName: string;
  total: number;
  firstDate: string;
  lastDate: string;
  answered: number;
  didntAnswer: number;
  lastStage: string;
  quotes: number;
  quotedTotal: number; // sum of per-quote tier averages, dollars
  siteVisits: number;
  emails: number;
  jobsWon: number;
  /** Most frequent ad_source on this contact (any activity type). */
  topSource: string;
  /**
   * Most recent EOD 5 / contact source for this contact (prefer eod_update
   * outcome slot 5 or ad_source). Used to prefill Job Won lead source.
   */
  lastSource: string;
  /** Most recent non-empty contact_address from prior activities. */
  lastAddress: string;
  recent: HistoryEntry[];
};

/** Roofing clients get roofing fields; everyone else gets solar fields. */
export type SiteVisitVertical = "roofing" | "solar";

export type PreviousQuote = {
  date: string;
  value: string;
  person: string;
  /** Quotie / email quote number when known (e.g. "7544"). */
  number: string;
};

/** Open calendar bookings waiting for the exec to log details in the popup. */
export type PendingSiteVisit = {
  id: string;
  contactId: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  contactAddress: string;
  salesPersonName: string;
  /** Human visit time from GHL (e.g. "Friday, July 31, 2026 10:00 AM"). */
  appointmentDisplay: string;
  appointmentRaw: string;
  /** For datetime-local: YYYY-MM-DDTHH:MM when parseable. */
  appointmentLocal: string;
  /** Date the booking was made (YYYY-MM-DD). */
  bookedOn: string;
  /** AU/NZ display of bookedOn (DD/MM/YYYY). */
  bookedOnDisplay: string;
  /** Prefill for roofing rough value from GHL when present. */
  roughJobValue: string;
  vertical: SiteVisitVertical;
  previousQuotes: PreviousQuote[];
  createdAt: string;
};

export function companyVertical(companyName: string, slug?: string): SiteVisitVertical {
  const s = `${companyName} ${slug || ""}`.toLowerCase();
  if (s.includes("roof")) return "roofing";
  return "solar";
}

/** Convert GHL appointment strings / timestamptz into datetime-local value. */
export function toDatetimeLocalValue(
  appointmentAt: string | null | undefined,
  appointmentRaw: string | null | undefined,
): string {
  const tryParse = (s: string): string => {
    // "2026-08-11 10:30:00" or "2026-08-11T10:30:00"
    const m = s.match(/(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})/);
    if (m) return `${m[1]}T${m[2]}`;
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      // Prefer wall-clock digits from the string when present
      const iso = d.toISOString();
      return iso.slice(0, 16);
    }
    return "";
  };
  if (appointmentAt) {
    const v = tryParse(appointmentAt);
    if (v) return v;
  }
  if (appointmentRaw) {
    const v = tryParse(appointmentRaw);
    if (v) return v;
  }
  return "";
}

function pickFromRaw(raw: Record<string, unknown> | null, ...keys: string[]): string {
  if (!raw) return "";
  for (const k of keys) {
    const v = raw[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  const cal = raw.calendar as Record<string, unknown> | undefined;
  if (cal) {
    for (const k of keys) {
      const v = cal[k];
      if (v != null && String(v).trim()) return String(v).trim();
    }
  }
  return "";
}

type PendingRow = {
  id: string;
  contact_id: string | null;
  contact_name: string | null;
  contact_address: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  sales_person_name: string | null;
  appointment_raw: string | null;
  appointment_at: string | null;
  appointment_display: string | null;
  booked_on: string | null;
  rough_job_value: string | null;
  raw_payload: Record<string, unknown> | null;
  created_at: string | null;
};

export async function fetchPendingSiteVisits(
  companyId: string,
  companyName: string,
  companySlug?: string,
  opts?: {
    ghlLocationId?: string;
    /** Company IANA timezone for "next future appointment" selection. */
    timeZone?: string;
    /** Contact currently open in the popup — used when pending row is sparse/stale. */
    pageContactId?: string;
    pageContactName?: string;
    people?: string[];
  },
): Promise<PendingSiteVisit[]> {
  const supabase = createAdminClient();
  const vertical = companyVertical(companyName, companySlug);
  const people = opts?.people || [];
  const { data, error } = await supabase
    .from("pending_site_visits")
    .select(
      "id, contact_id, contact_name, contact_address, contact_phone, contact_email, " +
      "sales_person_name, appointment_raw, appointment_at, appointment_display, " +
      "booked_on, rough_job_value, raw_payload, created_at",
    )
    .eq("company_id", companyId)
    .is("resolved_at", null)
    .is("dismissed_at", null)
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) {
    console.error("[eod-entry] fetchPendingSiteVisits:", error.message);
    return [];
  }

  const rows = (data ?? []) as unknown as PendingRow[];
  const out: PendingSiteVisit[] = [];
  for (const r of rows) {
    const raw = (r.raw_payload || null) as Record<string, unknown> | null;
    let contactId = r.contact_id || pickFromRaw(raw, "contact_id") || "";
    // Test/stale ids like "pending-jd-test" — fall back to the open contact.
    if (!contactId || contactId.startsWith("pending-")) {
      const pageName = (opts?.pageContactName || "").toLowerCase();
      const rowName = (r.contact_name || pickFromRaw(raw, "full_name") || "").toLowerCase();
      if (opts?.pageContactId && pageName && rowName && (pageName === rowName || rowName.includes(pageName.split(" ")[0]))) {
        contactId = opts.pageContactId;
      }
    }
    let contactName =
      r.contact_name ||
      pickFromRaw(raw, "full_name", "contact_name") ||
      opts?.pageContactName ||
      "";
    let contactPhone =
      r.contact_phone || pickFromRaw(raw, "phone") || "";
    let contactEmail =
      r.contact_email || pickFromRaw(raw, "email") || "";
    let contactAddress =
      r.contact_address ||
      pickFromRaw(raw, "address1", "full_address") ||
      "";
    // Prefer real street address over our test placeholders.
    if (/^12 example st$/i.test(contactAddress.trim())) contactAddress = "";

    let rawApptDisplay =
      r.appointment_display ||
      r.appointment_raw ||
      pickFromRaw(raw, "Appointment Date Time", "startTime") ||
      "";
    // Ignore known test placeholders so live calendar data can win.
    if (/^2026-08-01T11:00/.test(rawApptDisplay) || rawApptDisplay === "2026-08-01T11:00:00") {
      rawApptDisplay = "";
    }

    let bookedOn = "";
    if (r.booked_on) bookedOn = String(r.booked_on).slice(0, 10);
    else {
      const br = pickFromRaw(raw, "Date Appointment Booked - Automated", "date_created");
      const m = br.match(/^(\d{4}-\d{2}-\d{2})/);
      if (m) bookedOn = m[1];
      else {
        const dmy = br.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (dmy) bookedOn = `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
        else bookedOn = r.created_at ? String(r.created_at).slice(0, 10) : "";
      }
    }

    // Rough job value is always manual — never prefill from GHL.
    const roughJobValue = "";

    let salesPersonName = r.sales_person_name || "";
    if (!salesPersonName || /^unknown$/i.test(salesPersonName)) {
      const fromRaw =
        pickFromRaw(raw, "assigned_to") ||
        (raw?.customData as { assigned_to?: string } | undefined)?.assigned_to ||
        pickFromRaw(raw, "owner") ||
        "";
      salesPersonName = matchRosterName(String(fromRaw), people) || salesPersonName;
    }

    // Fill gaps from GHL Contacts API + live calendar appointments.
    const lookupId = contactId || opts?.pageContactId || "";
    if (opts?.ghlLocationId && lookupId) {
      const needContact =
        !contactPhone || !contactEmail || !contactAddress ||
        !salesPersonName || /^unknown$/i.test(salesPersonName) || !contactName;
      if (needContact) {
        const ghl = await fetchGhlContact(opts.ghlLocationId, lookupId, people);
        if (!contactName && ghl.name) contactName = ghl.name;
        if (!contactPhone && ghl.phone) contactPhone = ghl.phone;
        if (!contactEmail && ghl.email) contactEmail = ghl.email;
        if (!contactAddress && ghl.address) contactAddress = ghl.address;
        if ((!salesPersonName || /^unknown$/i.test(salesPersonName)) && ghl.ownerName) {
          salesPersonName = matchRosterName(ghl.ownerName, people) || ghl.ownerName;
        }
      }
      if (!contactId && lookupId) contactId = lookupId;

      // Authoritative visit time: NEXT future non-cancelled site-visit booking
      // from GHL (never trust stale webhook / cancelled slots).
      const appt = await fetchGhlContactAppointment(
        opts.ghlLocationId,
        lookupId,
        opts.timeZone || "Australia/Sydney",
      );
      if (appt?.startTime) {
        rawApptDisplay = appt.startTime;
        if (appt.address) {
          contactAddress = appt.address.trim() || contactAddress;
        }
        // dateAdded is when the booking was created in GHL
        if (appt.dateAdded) {
          const dm = String(appt.dateAdded).match(/^(\d{4})-(\d{2})-(\d{2})/);
          if (dm) bookedOn = `${dm[1]}-${dm[2]}-${dm[3]}`;
        }
      }
    }

    const appointmentLocal = toDatetimeLocalValue(
      rawApptDisplay,
      r.appointment_at || r.appointment_raw || "",
    );
    const appointmentDisplay = formatVisitDisplay(
      rawApptDisplay,
      appointmentLocal,
      r.appointment_raw || "",
    );
    const bookedOnDisplay = formatAuNzDate(bookedOn) || bookedOn;

    // Quotes for every vertical — roofing + solar (empty → "no previous quote").
    // Numbers come from GHL "Quote N Detail" fields / contact custom fields when
    // Quotie webhook omitted them (historical: almost all quote_sent rows).
    const previousQuotes =
      contactId || contactName
        ? await fetchPreviousQuotes(companyId, contactId, contactName, {
            ghlLocationId: opts?.ghlLocationId,
            ghlRawPayload: raw,
          })
        : [];

    out.push({
      id: r.id,
      contactId,
      contactName,
      contactPhone,
      contactEmail,
      contactAddress,
      salesPersonName: salesPersonName || "",
      appointmentDisplay,
      appointmentRaw: r.appointment_raw || rawApptDisplay,
      appointmentLocal,
      bookedOn,
      // Display-ready booked date for the auto panel
      // (stored ISO still in bookedOn for submit)
      roughJobValue: roughJobValue ? String(roughJobValue) : "",
      vertical,
      previousQuotes,
      createdAt: r.created_at || "",
      bookedOnDisplay,
    });
  }
  return out;
}

/** Normalise a money string for matching: "16,758.83" / "$16758.83" → "16758.83" */
function normaliseMoney(raw: string | null | undefined): string {
  if (raw == null) return "";
  const n = String(raw).replace(/[$,\s]/g, "").trim();
  if (!n || !/^\d+(\.\d+)?$/.test(n)) return "";
  // Strip trailing zeros so 16758.80 matches 16758.8 from either source
  const num = Number(n);
  if (!Number.isFinite(num)) return n;
  return String(Math.round(num * 100) / 100);
}

/**
 * Parse GHL / automation "Quote N Detail" lines:
 *   "7381 - $16,758.83 - 13.3kW Solar (...)"
 *   "7382 - $14,657.20 - ..."
 * Empty placeholders (" -  - ") return null.
 * Requires a $ amount so ISO dates like "2026-07-23" never match.
 */
function parseQuoteDetailLine(text: string | null | undefined): { number: string; value: string } | null {
  if (!text) return null;
  const s = String(text).trim();
  if (!s || /^[-–—\s]*$/.test(s)) return null;
  // "7381 - $16,758.83 - description" — $ is required (avoids date false-positives)
  let m = s.match(/^(\d{3,8})\s*[-–—]\s*\$\s*([\d,]+(?:\.\d{1,2})?)/);
  if (m) {
    const value = normaliseMoney(m[2]);
    // Real quote values are hundreds+; reject junk
    if (value && Number(value) >= 100) return { number: m[1], value };
  }
  // "Quote 7381 — $16,758.83"
  m = s.match(/\bquote\s*#?\s*(\d{3,8})\b[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (m) {
    const value = normaliseMoney(m[2]);
    if (value && Number(value) >= 100) return { number: m[1], value };
  }
  return null;
}

/** Walk a raw object (webhook payload) and collect Quote Detail lines. */
function extractQuoteDetailsFromRaw(
  raw: Record<string, unknown> | null | undefined,
): { number: string; value: string }[] {
  if (!raw || typeof raw !== "object") return [];
  const found: { number: string; value: string }[] = [];
  const seen = new Set<string>();

  const push = (parsed: { number: string; value: string } | null) => {
    if (!parsed?.number) return;
    const key = `${parsed.number}|${parsed.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(parsed);
  };

  const visit = (node: unknown, keyHint = ""): void => {
    if (node == null) return;
    if (typeof node === "string") {
      // Prefer keys that look like Quote Detail; still pattern-match any string.
      if (/quote/i.test(keyHint) || parseQuoteDetailLine(node)) {
        push(parseQuoteDetailLine(node));
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, keyHint);
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        visit(v, k);
      }
    }
  };

  // Named fields first (webhook): "Quote 1 Detail", "Quote 2 Detail", ...
  for (const [k, v] of Object.entries(raw)) {
    if (/quote\s*\d*\s*detail/i.test(k) && typeof v === "string") {
      push(parseQuoteDetailLine(v));
    }
  }
  // Also accept pipe-separated quoteNumbers on the Quotie payload when present.
  for (const k of ["quoteNumber", "quote_number", "quoteNo", "quote_no", "quoteNumbers"]) {
    const v = raw[k];
    if (v == null) continue;
    const parts = String(v).split("|").map(s => s.trim()).filter(Boolean);
    for (const p of parts) {
      const digits = p.replace(/[^\d]/g, "");
      if (digits.length >= 3 && digits.length <= 8) push({ number: digits, value: "" });
    }
  }
  // Deep scan as fallback (custom field bags, nested contact, etc.)
  visit(raw);
  return found;
}

/**
 * Live GHL contact custom-field values that look like Quote Detail lines.
 * Fields arrive as {id, value} without names — we pattern-match the value.
 */
async function fetchGhlQuoteDetails(
  ghlLocationId: string,
  contactId: string,
): Promise<{ number: string; value: string }[]> {
  if (!ghlLocationId || !contactId || contactId.startsWith("pending-")) return [];
  const tokens = loadGhlTokens();
  const token = tokens[ghlLocationId];
  if (!token) return [];
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      headers: ghlHeaders(token),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const body = await res.json();
    const c = body?.contact ?? {};
    const fields = (c.customFields || c.customField || []) as { value?: unknown }[];
    const out: { number: string; value: string }[] = [];
    const seen = new Set<string>();
    for (const f of Array.isArray(fields) ? fields : []) {
      const parsed = parseQuoteDetailLine(String(f?.value ?? ""));
      if (!parsed?.number) continue;
      const key = `${parsed.number}|${parsed.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(parsed);
    }
    return out;
  } catch {
    return [];
  }
}

/** Pull a quote number from Quotie/Make raw payload or free-text subjects. */
function extractQuoteNumber(
  raw: Record<string, unknown> | null | undefined,
  ...textBits: (string | null | undefined)[]
): string {
  if (raw && typeof raw === "object") {
    for (const k of [
      "quoteNumber", "quote_number", "quoteNo", "quote_no",
      "quoteId", "quote_id", "number", "id",
    ]) {
      const v = raw[k];
      if (v != null && String(v).trim()) {
        const digits = String(v).replace(/[^\d]/g, "");
        // Prefer real quote numbers (3+ digits); skip UUIDs / long ids
        if (digits.length >= 3 && digits.length <= 8) return digits;
        const asStr = String(v).trim();
        if (/^\d{3,8}$/.test(asStr)) return asStr;
      }
    }
  }
  for (const t of textBits) {
    if (!t) continue;
    // "Quote 7544 - Ben Musca - Bolton Electrical"
    const m = String(t).match(/\bquote\s*#?\s*(\d{3,8})\b/i);
    if (m) return m[1];
  }
  return "";
}

function activityDateIso(rawDate: string | Date | null | undefined): string {
  if (rawDate == null || rawDate === "") return "";
  if (typeof rawDate === "string") return String(rawDate).slice(0, 10);
  if (rawDate instanceof Date && !Number.isNaN(rawDate.getTime())) {
    return rawDate.toISOString().slice(0, 10);
  }
  return String(rawDate || "").slice(0, 10);
}

/**
 * Previous quotes for a contact — values from quote_sent activities, numbers
 * from GHL Quote Detail custom fields (primary), email subjects, or Quotie
 * payload when present. Multi-option pipe values are split into one row each.
 */
async function fetchPreviousQuotes(
  companyId: string,
  contactId: string,
  contactName: string,
  opts?: {
    ghlLocationId?: string;
    ghlRawPayload?: Record<string, unknown> | null;
  },
): Promise<PreviousQuote[]> {
  const supabase = createAdminClient();
  const safeName = contactName.replace(/["\\]/g, "").trim();
  let q = supabase
    .from("activities")
    .select(
      "occurred_on, quote_job_value, sales_person_name, contact_id, contact_name, raw_payload, outcome",
    )
    .eq("company_id", companyId)
    .eq("event_type", "quote_sent")
    .order("occurred_on", { ascending: false })
    .limit(20);
  if (contactId && safeName) {
    q = q.or(`contact_id.eq.${contactId},contact_name.ilike."${safeName}"`);
  } else if (contactId) {
    q = q.eq("contact_id", contactId);
  } else if (safeName) {
    q = q.ilike("contact_name", safeName);
  } else {
    return [];
  }
  const { data, error } = await q;
  if (error) {
    console.error("[eod-entry] fetchPreviousQuotes:", error.message);
    return [];
  }

  // ── Number sources ────────────────────────────────────────────────
  // 1) GHL contact custom fields (live) — e.g. "7381 - $16,758.83 - …"
  // 2) Pending webhook raw_payload named "Quote N Detail"
  // 3) Email subjects "Quote 7544 - Name - Company"
  // Quotie webhook historically omits quote numbers (0/1600 rows have them).
  const ghlDetails: { number: string; value: string }[] = [];
  const seenGhl = new Set<string>();
  const pushGhl = (list: { number: string; value: string }[]) => {
    for (const d of list) {
      const key = `${d.number}|${d.value}`;
      if (seenGhl.has(key)) continue;
      seenGhl.add(key);
      ghlDetails.push(d);
    }
  };
  if (opts?.ghlRawPayload) pushGhl(extractQuoteDetailsFromRaw(opts.ghlRawPayload));
  if (opts?.ghlLocationId && contactId) {
    pushGhl(await fetchGhlQuoteDetails(opts.ghlLocationId, contactId));
  }

  // Index GHL details by normaliseMoney(value) for value→number matching
  const numberByValue = new Map<string, string>();
  const unusedGhlNumbers: string[] = [];
  for (const d of ghlDetails) {
    if (d.value) {
      if (!numberByValue.has(d.value)) numberByValue.set(d.value, d.number);
    } else {
      unusedGhlNumbers.push(d.number);
    }
  }

  const numbersByDate = new Map<string, string[]>();
  if (contactId || safeName) {
    let eq = supabase
      .from("activities")
      .select("occurred_on, outcome, contact_name")
      .eq("company_id", companyId)
      .eq("event_type", "email_sent")
      .ilike("outcome", "%quote%")
      .order("occurred_on", { ascending: false })
      .limit(40);
    if (contactId && safeName) {
      eq = eq.or(
        `contact_id.eq.${contactId},contact_name.ilike."${safeName}",outcome.ilike."%${safeName}%"`,
      );
    } else if (contactId) {
      eq = eq.eq("contact_id", contactId);
    } else {
      eq = eq.or(`contact_name.ilike."${safeName}",outcome.ilike."%${safeName}%"`);
    }
    const { data: emails, error: emailErr } = await eq;
    if (emailErr) {
      console.error("[eod-entry] fetchPreviousQuotes emails:", emailErr.message);
    } else {
      for (const em of emails ?? []) {
        const num = extractQuoteNumber(null, em.outcome as string | null);
        if (!num) continue;
        const d = activityDateIso(em.occurred_on as string | Date | null);
        if (!d) continue;
        const list = numbersByDate.get(d) || [];
        if (!list.includes(num)) list.push(num);
        numbersByDate.set(d, list);
      }
    }
  }

  const usedNumbers = new Set<string>();
  const claimNumber = (n: string): string => {
    if (!n || usedNumbers.has(n)) return "";
    usedNumbers.add(n);
    return n;
  };

  // Expand each activity: "16758.83|14657.20" → two rows (one number each).
  const rows: PreviousQuote[] = [];
  for (const r of data ?? []) {
    if (!r.quote_job_value) continue;
    const dateIso = activityDateIso(r.occurred_on as string | Date | null);
    const person = String(r.sales_person_name || "");
    const raw = (r.raw_payload || null) as Record<string, unknown> | null;
    const values = String(r.quote_job_value)
      .split("|")
      .map(v => normaliseMoney(v) || v.replace(/[$,\s]/g, "").trim())
      .filter(Boolean);

    // Pipe-separated numbers on the same payload (future Quotie shape)
    const payloadNumbers = String(
      (raw as { quoteNumber?: string; quote_number?: string; quoteNumbers?: string } | null)
        ?.quoteNumber ||
      (raw as { quote_number?: string } | null)?.quote_number ||
      (raw as { quoteNumbers?: string } | null)?.quoteNumbers ||
      "",
    )
      .split("|")
      .map(s => s.replace(/[^\d]/g, ""))
      .filter(s => s.length >= 3 && s.length <= 8);

    values.forEach((value, idx) => {
      let number = "";
      // 1) Same-index number from Quotie payload
      if (payloadNumbers[idx]) number = claimNumber(payloadNumbers[idx]);
      // 2) Match GHL detail by dollar value
      if (!number) {
        const byVal = numberByValue.get(normaliseMoney(value) || value);
        if (byVal) number = claimNumber(byVal);
      }
      // 3) Single-number payload / outcome
      if (!number && values.length === 1) {
        number = claimNumber(extractQuoteNumber(raw, r.outcome as string | null));
      }
      // 4) Email subject for that day
      if (!number && dateIso) {
        const candidates = numbersByDate.get(dateIso) || [];
        const free = candidates.find(n => !usedNumbers.has(n));
        if (free) number = claimNumber(free);
      }
      // 5) Leftover GHL numbers (no value match) in order
      if (!number) {
        const free = unusedGhlNumbers.find(n => !usedNumbers.has(n));
        if (free) number = claimNumber(free);
        else {
          const freeGhl = ghlDetails.find(d => !usedNumbers.has(d.number));
          if (freeGhl) number = claimNumber(freeGhl.number);
        }
      }
      rows.push({ date: dateIso, value, person, number: number || "" });
    });
    if (rows.length >= 12) break;
  }

  // If activities are empty but GHL has quote details, still surface them.
  if (rows.length === 0 && ghlDetails.length > 0) {
    for (const d of ghlDetails) {
      if (!d.number && !d.value) continue;
      rows.push({
        date: "",
        value: d.value || "",
        person: "",
        number: d.number,
      });
    }
  }

  return rows.slice(0, 12);
}

/** GHL contact fields we pull for the EOD entry form / pending site visits. */
export type GhlContact = {
  name: string;
  /** Street Address (address1), with city/state/postcode when present. */
  address: string;
  phone: string;
  email: string;
  /** Roster-friendly owner/assignee name when we can resolve it. */
  ownerName: string;
};

const DEFAULT_STAGES = ["New Leads", "Pre-Quote Follow Up", "Post Quote Follow Up"];
// The pipeline workflows branch on string equality against these values, so
// they must stay in sync with the workflow conditions. Deliberately uses the
// CORRECTED "Not a Good Time to Talk" (GHL's field had a "TIme" typo, being
// retired) — the workflow branch conditions must be updated to match. The
// lowercase learned-options dedup hides the historical typo'd variant.
// EOD 3 dropdown order (top → bottom) — matches the order execs expect when selecting.
const DEFAULT_OUTCOMES = [
  "Not a Good Time to Talk",
  "Requires Quoting",
  "Book Site Visit",
  "Not Ready Yet - Pre-Quote",
  "Not Ready Yet - Post Quote",
  "Quote Sent",
  "Verbal Confirmation",
  "Waiting on Photos",
  // Terminal — Lost
  "Lost - Price",
  "Lost - Time Related",
  "Lost - Priorities Changed",
  // Terminal — DQ (Incorrect Details ≠ Wrong Contact/Spam: real lead, bad contact info)
  "DQ - Incorrect Details",
  "DQ - Wrong Contact / Spam",
  "DQ - Out of Service Area",
  "DQ - Extent of Works",
  "DQ - Price",
  "DQ - Lead Looking for Work",
  "DQ - Recommended Another Company",
  "DQ - Trying to Sell Me Something",
  "DQ - Not Proceeding",
  // Terminal — Abandoned
  "Abandoned - Not Responding",
  "Abandoned - Headache",
];
const DEFAULT_SOURCES = [
  "Facebook Ad Form",
  "Facebook Message",
  "Google Ads",
  "Website Form",
  "Direct Phone Call",
  "Direct Email",
  "Direct Lead passed on from Client",
];

const EVENT_LABELS: Record<string, string> = {
  eod_update: "EOD update",
  quote_sent: "Quote sent",
  site_visit_booked: "Site visit",
  email_sent: "Email",
  job_won: "Job won",
};

type ActivityRow = {
  occurred_on: string;
  event_type: string;
  outcome: string | null;
  quote_job_value: string | null;
  sales_person_name: string | null;
  ad_source: string | null;
  appointment_at: string | null;
  contact_id: string | null;
  contact_name: string | null;
  contact_address: string | null;
};

/** Mean of pipe-separated quote tiers (they're alternatives, never summed). */
function quoteGroupValue(raw: string | null): number {
  const parts = String(raw || "")
    .split("|")
    .map(v => parseFloat(v.replace(/[^0-9.]/g, "")))
    .filter(n => Number.isFinite(n) && n > 0);
  if (parts.length === 0) return 0;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

function mergeLearned(learned: Map<string, number>, defaults: string[]): string[] {
  const out = [...defaults];
  const known = new Set(defaults.map(d => d.toLowerCase()));
  const extras = [...learned.entries()]
    .filter(([v, n]) => n >= 3 && !known.has(v.toLowerCase()))
    .sort((a, b) => b[1] - a[1])
    .map(([v]) => v);
  return [...out, ...extras];
}

export async function fetchEodOptions(companyId: string): Promise<EodOptions> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("activities")
    .select("outcome")
    .eq("company_id", companyId)
    .eq("event_type", "eod_update")
    .order("occurred_on", { ascending: false })
    .limit(1000);

  const counts = [new Map<string, number>(), new Map<string, number>(), new Map<string, number>()];
  for (const row of data ?? []) {
    const parts = String(row.outcome || "").split("|").map(p => p.trim());
    // parts: 0=stage, 1=answered, 2=std outcome, 3=custom, 4=source
    for (const [slot, idx] of [[0, 0], [1, 2], [2, 4]] as const) {
      const v = parts[idx];
      if (v) counts[slot].set(v, (counts[slot].get(v) ?? 0) + 1);
    }
  }

  return {
    stages: mergeLearned(counts[0], DEFAULT_STAGES),
    outcomes: mergeLearned(counts[1], DEFAULT_OUTCOMES),
    sources: mergeLearned(counts[2], DEFAULT_SOURCES),
  };
}

// ─── GHL contact lookup ──────────────────────────────────────────────
// Authoritative name + Street Address. GHL_LOCATION_TOKENS is a JSON map of
// { "<ghl location id>": "<private integration token>" } — each sub-account
// issues its own token (Settings → Private Integrations, View Contacts
// scope). DOM scraping in the extension is the fallback when a location has
// no token; it's fragile (GHL headings, i18n keys), hence this.

/** Build a single-line address from GHL contact fields (Street Address first). */
export function formatGhlAddress(c: {
  address1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
}): string {
  const street = String(c.address1 || "").trim();
  if (!street) return "";
  const city = String(c.city || "").trim();
  const state = String(c.state || "").trim();
  const postal = String(c.postalCode || "").trim();
  const region = [state, postal].filter(Boolean).join(" ");
  const locality = [city, region].filter(Boolean).join(" ");
  return locality ? `${street}, ${locality}` : street;
}

function ghlHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Version: "2021-07-28",
    Accept: "application/json",
    "User-Agent": "EOD-Creator/1.0 (contact lookup)",
  };
}

function loadGhlTokens(): Record<string, string> {
  try {
    return JSON.parse(process.env.GHL_LOCATION_TOKENS || "{}");
  } catch {
    return {};
  }
}

/** Resolve a GHL user id → display name (for contact assignedTo / owner). */
async function fetchGhlUserName(token: string, userId: string): Promise<string> {
  if (!userId || userId.length < 8) return "";
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/users/${userId}`, {
      headers: ghlHeaders(token),
      cache: "no-store",
    });
    if (!res.ok) return "";
    const body = await res.json();
    const u = body?.user ?? body ?? {};
    return (
      [u.firstName, u.lastName].filter(Boolean).join(" ").trim() ||
      String(u.name || u.email || "").trim()
    );
  } catch {
    return "";
  }
}

/** Map a free-text or full name onto a roster short name (e.g. "Lachlan Boys" → "Lachlan"). */
export function matchRosterName(raw: string, people: string[]): string {
  const t = (raw || "").trim();
  if (!t || people.length === 0) return "";
  if (people.includes(t)) return t;
  const lower = t.toLowerCase();
  const exact = people.find(p => p.toLowerCase() === lower);
  if (exact) return exact;
  const first = lower.split(/\s+/)[0];
  const byFirst = people.find(p => p.toLowerCase() === first || p.toLowerCase().startsWith(first));
  return byFirst || "";
}

export async function fetchGhlContact(
  ghlLocationId: string,
  contactId: string,
  people: string[] = [],
): Promise<GhlContact> {
  const empty: GhlContact = { name: "", address: "", phone: "", email: "", ownerName: "" };
  if (!ghlLocationId || !contactId || contactId.startsWith("pending-")) return empty;
  const tokens = loadGhlTokens();
  const token = tokens[ghlLocationId];
  if (!token) return empty;

  try {
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      headers: ghlHeaders(token),
      cache: "no-store",
    });
    if (!res.ok) return empty;
    const body = await res.json();
    const c = body?.contact ?? {};
    const name =
      [c.firstName, c.lastName].filter(Boolean).join(" ").trim() ||
      String(c.contactName || "").trim();
    const phone = String(c.phone || c.phoneLabel || "").trim();
    const email = String(c.email || "").trim();
    const address = formatGhlAddress(c) || String(c.address1 || "").trim();

    let ownerName = "";
    const assignedId = String(c.assignedTo || c.assigned_to || "").trim();
    if (assignedId) {
      const userName = await fetchGhlUserName(token, assignedId);
      ownerName = matchRosterName(userName, people) || matchRosterName(userName.split(/\s+/)[0] || "", people) || userName;
    }

    return { name, address, phone, email, ownerName };
  } catch {
    return empty;
  }
}

export type GhlAppointment = {
  startTime: string;   // "2026-08-11 10:30:00" wall clock from GHL (location local)
  endTime: string;
  address: string;
  title: string;
  dateAdded: string;   // when the booking was made
  id: string;
};

const DEAD_APPT_STATUSES = new Set([
  "cancelled", "canceled", "noshow", "no_show", "invalid", "abandoned",
]);

/** Current wall-clock in a location timezone as "YYYY-MM-DD HH:mm:ss" (sortable). */
export function wallClockNow(timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date());
    const g = (t: string) => parts.find(p => p.type === t)?.value || "00";
    return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
  } catch {
    return new Date().toISOString().slice(0, 19).replace("T", " ");
  }
}

/** Normalise GHL start strings to "YYYY-MM-DD HH:mm:ss" for comparison. */
function normaliseWallStart(raw: string): string {
  const m = String(raw).trim().match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})(?::(\d{2}))?/);
  if (!m) return String(raw).trim();
  return `${m[1]} ${m[2]}:${m[3] || "00"}`;
}

/**
 * Pick the next future site-visit booking for a contact from GHL.
 *
 * Rules (in order):
 *  1. Ignore deleted + cancelled / no-show
 *  2. Prefer titles that look like a site visit
 *  3. Among those, take the earliest start still in the future
 *     (2h grace so an in-progress visit still counts)
 *  4. If nothing is future, take the most recent non-cancelled
 *
 * Uses GET /contacts/{id}/appointments (works with View Contacts PITs).
 * `timeZone` is the client company timezone (e.g. Pacific/Auckland).
 */
export async function fetchGhlContactAppointment(
  ghlLocationId: string,
  contactId: string,
  timeZone = "Australia/Sydney",
): Promise<GhlAppointment | null> {
  if (!ghlLocationId || !contactId || contactId.startsWith("pending-")) return null;
  const tokens = loadGhlTokens();
  const token = tokens[ghlLocationId];
  if (!token) return null;

  try {
    const res = await fetch(
      `https://services.leadconnectorhq.com/contacts/${contactId}/appointments`,
      { headers: ghlHeaders(token), cache: "no-store" },
    );
    if (!res.ok) return null;
    const body = await res.json();
    const events = (body?.events || body?.appointments || []) as Record<string, unknown>[];
    if (!Array.isArray(events) || events.length === 0) return null;

    const parsed = events
      .filter(e => !e.deleted)
      .map(e => {
        const startTime = String(e.startTime || e.start_time || "").trim();
        const endTime = String(e.endTime || e.end_time || "").trim();
        const dateAdded = String(e.dateAdded || e.date_added || e.createdAt || "").trim();
        const status = String(
          e.appointmentStatus || e.appoinmentStatus || e.status || "",
        ).toLowerCase();
        const title = String(e.title || "").trim();
        return {
          startTime,
          startNorm: normaliseWallStart(startTime),
          endTime,
          address: String(e.address || "").trim(),
          title,
          dateAdded,
          id: String(e.id || ""),
          status,
          isSiteVisit: /site\s*visit/i.test(title),
        };
      })
      .filter(e => e.startTime && !DEAD_APPT_STATUSES.has(e.status));

    if (parsed.length === 0) return null;

    // Prefer site-visit-titled bookings when any exist.
    const sitePool = parsed.filter(e => e.isSiteVisit);
    const pool = sitePool.length > 0 ? sitePool : parsed;

    const nowLocal = wallClockNow(timeZone);
    // 2h grace: allow an appointment that started recently (still "this visit").
    const grace = (() => {
      const [datePart, timePart] = nowLocal.split(" ");
      const [y, mo, d] = datePart.split("-").map(Number);
      const [h, mi, s] = timePart.split(":").map(Number);
      const ms = Date.UTC(y, mo - 1, d, h, mi, s) - 2 * 60 * 60 * 1000;
      const dt = new Date(ms);
      const pad = (n: number) => String(n).padStart(2, "0");
      // Reconstruct as wall-clock string in the same numeric space we subtracted
      return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`;
    })();

    const future = pool
      .filter(e => e.startNorm >= grace)
      .sort((a, b) => a.startNorm.localeCompare(b.startNorm));

    // Next upcoming (or in-progress). Else most recent past non-cancelled.
    const pick =
      future[0] ||
      pool.slice().sort((a, b) => b.startNorm.localeCompare(a.startNorm))[0];

    return {
      startTime: pick.startTime,
      endTime: pick.endTime,
      address: pick.address,
      title: pick.title,
      dateAdded: pick.dateAdded,
      id: pick.id,
    };
  } catch {
    return null;
  }
}

/** AU/NZ friendly date: DD/MM/YYYY. Accepts ISO date, Date objects, or Date-parseable strings. */
export function formatAuNzDate(raw: string | Date | null | undefined): string {
  if (raw == null || raw === "") return "";
  // Already DD/MM/YYYY
  if (typeof raw === "string" && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(raw.trim())) {
    const [dd, mm, yyyy] = raw.trim().split("/");
    return `${dd.padStart(2, "0")}/${mm.padStart(2, "0")}/${yyyy}`;
  }
  let y: number, m: number, d: number;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    // Calendar dates from Postgres often arrive as UTC midnight — use UTC parts.
    y = raw.getUTCFullYear();
    m = raw.getUTCMonth() + 1;
    d = raw.getUTCDate();
  } else {
    const s = String(raw).trim();
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) {
      y = +iso[1]; m = +iso[2]; d = +iso[3];
    } else {
      const dt = new Date(s);
      if (Number.isNaN(dt.getTime())) return s; // already human text — leave it
      y = dt.getUTCFullYear();
      m = dt.getUTCMonth() + 1;
      d = dt.getUTCDate();
    }
  }
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
}

/** AU/NZ friendly time: h:mm AM/PM from ISO or datetime-local. */
export function formatAuNzTime(raw: string | null | undefined): string {
  if (!raw) return "";
  const s = String(raw).trim();
  const m = s.match(/(?:T|\s)(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (!m) {
    // Already human? e.g. "Friday, July 31, 2026 10:00 AM"
    if (/\b(am|pm)\b/i.test(s)) return s;
    return s;
  }
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${min} ${ampm}`;
}

/** Visit time display for popup/Slack: "11/08/2026 10:30 AM" or keep human GHL string with date reformatted when possible. */
export function formatVisitDisplay(
  appointmentDisplay: string,
  appointmentLocal: string,
  appointmentRaw: string,
): string {
  const local = appointmentLocal || "";
  if (local && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(local)) {
    return `${formatAuNzDate(local)} ${formatAuNzTime(local)}`.trim();
  }
  const raw = appointmentDisplay || appointmentRaw || "";
  // ISO-ish
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return `${formatAuNzDate(raw)} ${formatAuNzTime(raw)}`.trim();
  }
  return raw;
}

/** @deprecated Prefer fetchGhlContact — kept for call-sites that only need name. */
export async function fetchGhlContactName(
  ghlLocationId: string,
  contactId: string,
): Promise<string> {
  return (await fetchGhlContact(ghlLocationId, contactId)).name;
}

// Obvious non-names from GHL page furniture: section headings and raw i18n
// keys (dot-separated tokens like "snapshots.loadSnapshotsTemplate.x").
const JUNK_NAMES = new Set([
  "contacts", "contact", "conversations", "opportunities", "activity",
  "notes", "tasks", "appointments", "associations", "documents",
]);

export function cleanScrapedName(raw: string): string {
  const text = (raw || "").trim();
  if (!text || text.length > 80) return "";
  if (JUNK_NAMES.has(text.toLowerCase())) return "";
  if (/^[\w-]+(\.[\w-]+)+$/.test(text)) return ""; // i18n key, not a name
  return text;
}

// ─── Today / Me tabs ─────────────────────────────────────────────────

export type DayTally = {
  eodUpdates: number;
  answered: number;
  didntAnswer: number;
  quotes: number;
  quotedTotal: number;
  siteVisits: number;
  emails: number;
  jobsWon: number;
};

export type CompanyToday = {
  tally: DayTally;
  perPerson: { name: string; tally: DayTally }[];
};

export type MyToday = {
  total: DayTally;
  perCompany: { company: string; date: string; tally: DayTally }[];
};

const emptyTally = (): DayTally => ({
  eodUpdates: 0, answered: 0, didntAnswer: 0,
  quotes: 0, quotedTotal: 0, siteVisits: 0, emails: 0, jobsWon: 0,
});

type TallyRow = { event_type: string; outcome: string | null; quote_job_value: string | null };

function addToTally(t: DayTally, row: TallyRow) {
  switch (row.event_type) {
    case "eod_update": {
      t.eodUpdates++;
      const answered = String(row.outcome || "").split("|")[1]?.trim();
      if (answered === "Answered") t.answered++;
      else if (answered) t.didntAnswer++;
      break;
    }
    case "quote_sent":
      t.quotes++;
      t.quotedTotal += quoteGroupValue(row.quote_job_value);
      break;
    case "site_visit_booked": t.siteVisits++; break;
    case "email_sent": t.emails++; break;
    case "job_won": t.jobsWon++; break;
  }
}

/** Today's activity for one company, with a per-exec breakdown. */
export async function fetchCompanyToday(companyId: string, date: string): Promise<CompanyToday> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("activities")
    .select("event_type, outcome, quote_job_value, sales_person_name")
    .eq("company_id", companyId)
    .eq("occurred_on", date)
    .limit(2000);

  const tally = emptyTally();
  const byPerson = new Map<string, DayTally>();
  for (const row of data ?? []) {
    addToTally(tally, row);
    const name = row.sales_person_name || "Team";
    if (!byPerson.has(name)) byPerson.set(name, emptyTally());
    addToTally(byPerson.get(name)!, row);
  }

  const perPerson = [...byPerson.entries()]
    .map(([name, t]) => ({ name, tally: t }))
    .sort((a, b) => (b.tally.eodUpdates + b.tally.quotes) - (a.tally.eodUpdates + a.tally.quotes));
  return { tally, perPerson };
}

/**
 * One exec's day across every active client. "Today" is evaluated in each
 * company's own timezone, matching how occurred_on is written.
 */
export async function fetchMyToday(
  execName: string,
  todayFor: (timezone: string) => string,
): Promise<MyToday> {
  const supabase = createAdminClient();
  const { data: companies } = await supabase
    .from("companies")
    .select("id, name, timezone")
    .eq("active", true)
    .order("name");

  const total = emptyTally();
  const perCompany: MyToday["perCompany"] = [];

  await Promise.all(
    (companies ?? []).map(async c => {
      const date = todayFor(c.timezone);
      const { data } = await supabase
        .from("activities")
        .select("event_type, outcome, quote_job_value")
        .eq("company_id", c.id)
        .eq("occurred_on", date)
        .eq("sales_person_name", execName)
        .limit(2000);
      if (!data || data.length === 0) return;
      const tally = emptyTally();
      for (const row of data) addToTally(tally, row);
      perCompany.push({ company: c.name, date, tally });
    }),
  );

  perCompany.sort((a, b) => (b.tally.eodUpdates + b.tally.quotes) - (a.tally.eodUpdates + a.tally.quotes));
  for (const c of perCompany) {
    total.eodUpdates += c.tally.eodUpdates;
    total.answered += c.tally.answered;
    total.didntAnswer += c.tally.didntAnswer;
    total.quotes += c.tally.quotes;
    total.quotedTotal += c.tally.quotedTotal;
    total.siteVisits += c.tally.siteVisits;
    total.emails += c.tally.emails;
    total.jobsWon += c.tally.jobsWon;
  }
  return { total, perCompany };
}

/** All active exec names across all active clients (deduped, sorted). */
export async function fetchAllExecNames(): Promise<string[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("sales_people")
    .select("name, companies!inner(active)")
    .eq("active", true)
    .eq("companies.active", true);
  return [...new Set((data ?? []).map(p => p.name))].sort();
}

export async function fetchContactHistory(
  companyId: string,
  contactId: string,
  contactName: string,
): Promise<ContactHistory | null> {
  if (!contactId && !contactName) return null;

  const supabase = createAdminClient();
  let query = supabase
    .from("activities")
    .select("occurred_on, event_type, outcome, quote_job_value, sales_person_name, ad_source, appointment_at, contact_id, contact_name, contact_address")
    .eq("company_id", companyId)
    .order("occurred_on", { ascending: false })
    .limit(200);

  // Match by GHL contact id when we have it, plus case-insensitive exact name
  // (older rows predate contact ids). Quotes stripped from the name so it
  // can't break PostgREST's or() filter syntax.
  const safeName = contactName.replace(/["\\]/g, "").trim();
  if (contactId && safeName) {
    query = query.or(`contact_id.eq.${contactId},contact_name.ilike."${safeName}"`);
  } else if (contactId) {
    query = query.eq("contact_id", contactId);
  } else {
    query = query.ilike("contact_name", safeName);
  }

  const { data } = await query;
  const rows = (data ?? []) as ActivityRow[];
  if (rows.length === 0) return null;

  // Newest row with the exact contact id wins; any named row is the fallback.
  const canonicalName =
    (contactId && rows.find(r => r.contact_id === contactId && r.contact_name?.trim())?.contact_name) ||
    rows.find(r => r.contact_name?.trim())?.contact_name ||
    "";

  const h: ContactHistory = {
    canonicalName: canonicalName.trim(),
    total: rows.length,
    firstDate: rows[rows.length - 1].occurred_on,
    lastDate: rows[0].occurred_on,
    answered: 0,
    didntAnswer: 0,
    lastStage: "",
    quotes: 0,
    quotedTotal: 0,
    siteVisits: 0,
    emails: 0,
    jobsWon: 0,
    topSource: "",
    lastSource: "",
    lastAddress: "",
    recent: [],
  };

  const sourceCounts = new Map<string, number>();
  // rows are newest-first — capture the first match of each kind.
  let lastEod5 = "";
  let lastAnySource = "";
  for (const row of rows) {
    const eodParts =
      row.event_type === "eod_update"
        ? String(row.outcome || "").split("|").map(p => p.trim())
        : null;
    const eod5 = (eodParts?.[4] || "").trim();
    if (eod5 && !lastEod5) lastEod5 = eod5;

    const source = (eod5 || row.ad_source || "").trim();
    if (source) {
      sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
      if (!lastAnySource) lastAnySource = source;
    }
    if (!h.lastAddress && row.contact_address?.trim()) {
      h.lastAddress = row.contact_address.trim();
    }
    switch (row.event_type) {
      case "eod_update": {
        const parts = eodParts || [];
        if (parts[1] === "Answered") h.answered++;
        else if (parts[1]) h.didntAnswer++;
        if (!h.lastStage && parts[0]) h.lastStage = parts[0];
        break;
      }
      case "quote_sent":
        h.quotes++;
        h.quotedTotal += quoteGroupValue(row.quote_job_value);
        break;
      case "site_visit_booked":
        h.siteVisits++;
        break;
      case "email_sent":
        h.emails++;
        break;
      case "job_won":
        h.jobsWon++;
        break;
    }
  }
  h.topSource = [...sourceCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  // Job Won lead source: EOD 5 if it exists, else most recent ad_source, else top.
  h.lastSource = lastEod5 || lastAnySource || h.topSource;

  h.recent = rows.slice(0, 8).map(row => {
    let detail = "";
    if (row.event_type === "eod_update") {
      const parts = String(row.outcome || "").split("|").map(p => p.trim());
      detail = [parts[0], parts[1], parts[2]].filter(Boolean).join(" · ");
    } else if (row.event_type === "quote_sent" || row.event_type === "job_won") {
      const v = quoteGroupValue(row.quote_job_value);
      detail = v ? `$${Math.round(v).toLocaleString()}` : "";
    } else if (row.event_type === "site_visit_booked") {
      detail = row.appointment_at ? row.appointment_at.slice(0, 10) : "";
    } else {
      detail = String(row.outcome || "").slice(0, 60);
    }
    return {
      date: row.occurred_on,
      label: EVENT_LABELS[row.event_type] ?? row.event_type,
      detail,
      person: row.sales_person_name ?? "",
    };
  });

  return h;
}
