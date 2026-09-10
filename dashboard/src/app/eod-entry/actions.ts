"use server";

// Submission path for the GHL-embedded /eod-entry form. Mirrors
// createManualActivities (activities/actions.ts) but authorises via the
// signed company token instead of a Supabase session: the token pins the
// company, and the sales person is checked against that company's roster
// with the service-role client. The backend endpoint trusts this server via
// WEBHOOK_SECRET, so every field must be validated HERE.

import { verifyEodEntryToken } from "@/lib/eodEntryToken";
import { createAdminClient } from "@/lib/supabase/admin";
import { isVirtualVisitPayload } from "@/lib/visitKind";
import {
  moveEodOpportunity,
  parseMonetaryValue,
  resolveGhlContactId,
} from "./ghlPipeline";
import {
  ALLOWED_EVENT_TYPES,
  buildSheetActivities,
  isIsoDate,
  isMeaningful,
  postManualActivities,
  type EventType,
  type NewActivityItem,
} from "@/lib/manualActivities";
import {
  createQuotieCallback,
  createQuotieSiteVisit,
  createQuotieTask,
  getQuotieTeamMembers,
  resolveAnsweredCallback,
  resolveQuotieAction,
  type QuotieConfig,
  type QuotieTeamMember,
} from "./quotie";
import { fetchPreviousQuotes, type PreviousQuote } from "./data";

export type EodEntryInput = {
  token: string;
  ghl_location_id?: string; // required with the "agency" token (browser extension)
  sales_person: string; // roster name, or "" = team (no exec attribution)
  occurred_on: string;  // YYYY-MM-DD
  event_type: EventType;
  items: NewActivityItem[];
  // EOD call-log values, discrete — used to mirror onto the GHL contact's
  // custom fields so the location's pipeline workflow fires.
  eod_fields?: { stage: string; answered: string; std_outcome: string };
  /** When logging a site visit that came from a GHL calendar pending row. */
  pending_site_visit_id?: string;
  /**
   * Optional Quotie action to fire alongside an eod_update. The client picks
   * the section (task / site_visit) from safeQuotieActions, but the server
   * NEVER trusts `type` — it re-resolves from quotie_config. All other fields
   * are user-editable form values.
   */
  quotie?: {
    type: "task" | "site_visit" | "callback";
    title?: string;
    notes?: string;
    due_date?: string;
    /** When-to-call-back ISO for callback_requested (Not a Good Time). */
    callback_date?: string;
    date?: string;
    time?: string;
    address?: string;
    create_ghl_appointment?: boolean;
    rough_job_value?: string;
    ideal_start?: string;
    details?: string;
    ghl_assigned_user_id?: string;
    /** Gate the Slack-summary leg for site-visit bookings. Activity + Quotie always run. Defaults true. */
    send_slack?: boolean;
  };
  /**
   * Independent Quotie task — fires for any eod_update regardless of outcome
   * mapping (the sticky-bar "Also create a Quotie task" checkbox). Only needs
   * quotie_config.api_key; coexists with a site-visit `quotie` action.
   */
  quotie_task?: {
    title?: string;
    notes?: string;
    due_date?: string;
  };
  /**
   * On/off request for the EOD 2 (Answered?) no-answer pipeline callback.
   * Presence = the exec left the "Add to Quotie pipeline" checkbox ticked. The
   * server still re-resolves the actual outcome from eod_fields.answered — the
   * client never supplies the outcome, only the notes + the on switch.
   */
  quotie_answered_callback?: {
    notes?: string;
  };
};

export type EodEntryResult =
  | {
      ok: true;
      count: number;
      pipeline?: string;
      pipelineOk?: boolean; // pipeline: what happened ("moved to X") or a skip/fail reason
      quotie_result?: { ok: boolean; detail?: string };
    }
  | { ok: false; error: string };

/** Postgres-safe appointment timestamp from local/ISO-ish strings. */
function toMachineAppointmentAt(
  appointmentAt?: string,
  appointmentDisplay?: string,
): string {
  const candidates = [appointmentAt, appointmentDisplay].map(s => String(s || "").trim()).filter(Boolean);
  for (const s of candidates) {
    // Already ISO / datetime-local: 2026-07-31T15:30 or 2026-07-31 15:30:00
    const m = s.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})(?::(\d{2}))?/);
    if (m) return `${m[1]}T${m[2]}:${m[3] || "00"}`;
    // Skip human AU strings like 31/07/2026 3:30 PM
    if (/\d{1,2}\/\d{1,2}\/\d{4}/.test(s)) continue;
    if (/\b(am|pm)\b/i.test(s) && !/^\d{4}-\d{2}-\d{2}/.test(s)) continue;
  }
  return "";
}

/**
 * Extract the GHL appointment id from a pending_site_visits.raw_payload.
 * The GHL calendar webhook stores the appointment id at
 * raw_payload.calendar.appointmentId (e.g. 'ti0PKiP7l8iA4y16NOFm'), with a
 * fallback custom-field key 'Appointment ID - Automated'. Null-safe; returns
 * undefined when neither is present. Works for existing pending rows too — no
 * webhook or schema change needed.
 */
function ghlAppointmentIdFromRawPayload(rawPayload: unknown): string | undefined {
  if (!rawPayload || typeof rawPayload !== "object") return undefined;
  const p = rawPayload as Record<string, unknown>;
  const calendar = p.calendar;
  const fromCalendar =
    calendar && typeof calendar === "object"
      ? (calendar as Record<string, unknown>).appointmentId
      : undefined;
  const fromField = p["Appointment ID - Automated"];
  const id = (fromCalendar ?? fromField);
  const s = typeof id === "string" ? id.trim() : id != null ? String(id).trim() : "";
  return s || undefined;
}

/** api-callbacks callback_reason line for the lead's attempt history. */
function callbackReasonFor(outcome: string, stdOutcome: string): string {
  switch (outcome) {
    case "requires_quoting": return "Requires quoting (EOD log)";
    case "callback_requested": return "Not a good time — parked (EOD log)";
    case "no_answer": return "No answer (EOD log)";
    case "voicemail": return "Left voicemail (EOD log)";
    case "lost": return `Lost — ${stdOutcome || "DQ"} (EOD log)`;
    default: return "EOD log";
  }
}

/** Human success detail for the quotie_result banner. noop = quiet no-op. */
function callbackDetailFor(
  outcome: string,
  noop: boolean | undefined,
  warnings: string[] | undefined,
): string | undefined {
  if (noop) return "no existing lead — nothing to move";
  const label =
    outcome === "requires_quoting" ? "Pipeline: added to Requires Quoting"
    : outcome === "callback_requested" ? "Pipeline: parked (call back)"
    : outcome === "no_answer" ? "Pipeline: logged no-answer"
    : outcome === "voicemail" ? "Pipeline: logged voicemail"
    : outcome === "lost" ? "Pipeline: moved to Lost"
    : "Pipeline updated";
  const parts = [label];
  if (warnings?.length) parts.push(warnings.join("; "));
  return parts.join(" · ");
}

export type CompleteSiteVisitInput = {
  token: string;
  ghl_location_id?: string;
  pending_id: string;
  sales_person: string;
  occurred_on: string; // booking-set date YYYY-MM-DD
  contact_name: string;
  contact_id?: string;
  contact_phone?: string;
  contact_email?: string;
  contact_address?: string;
  appointment_display?: string;
  appointment_at?: string; // datetime-local if any
  booked_on?: string;
  vertical: "roofing" | "solar";
  rough_job_value?: string;
  ideal_start_date?: string;
  details_comment?: string;
  previous_quotes?: { date: string; value: string; person: string; number?: string }[];
  visit_kind?: "in_person" | "virtual";
  /** Gate the Slack-summary leg only. Activity log + Quotie always run. Defaults true. */
  send_slack?: boolean;
};

/**
 * The single site-visit booking flow, shared by BOTH entry points:
 *   - completePendingSiteVisit (the pending-calendar banner "Log" button)
 *   - submitEodEntry's EOD-3 "Book Site Visit" outcome
 *
 * Every booking runs the same four legs, each independently toggled by an
 * EXPLICIT flag (never inferred inside the function) so the caller's intent is
 * always visible at the call-site:
 *   a. logActivity     — insert the site_visit_booked activity (postManualActivities)
 *   b. sendSlack        — Slack booking summary via NODE_SERVICE_URL /api/site-visit-summary
 *   c. createQuotie     — Quotie booking via createQuotieSiteVisit (needs quotie_config)
 *   d. resolvePending   — resolve the matching pending_site_visits row so a booking
 *                         handled here never resurfaces in the pending banner
 *
 * Never-throw idiom: a failure in any leg is caught, recorded, and never fails
 * the other legs or the caller's submit. Each leg reports ok/detail back so the
 * caller can compose its own result banner.
 */
type SiteVisitLegResult = { ran: boolean; ok: boolean; detail?: string };

type HandleSiteVisitBookedInput = {
  companyId: string;
  companyName: string;
  salesPersonName: string; // resolved roster name, or "Team"

  // Booking details (shared shape both callers already have).
  occurredOn: string; // YYYY-MM-DD — the log/booking date
  contactName: string;
  contactId?: string;
  contactPhone?: string;
  contactEmail?: string;
  contactAddress?: string;
  appointmentDisplay?: string;
  appointmentAt?: string; // ISO-ish / datetime-local
  bookedOn?: string;
  vertical: "roofing" | "solar";
  /** In-person vs virtual visit (Lockie's visit-kind feature) — threaded into the activity + Slack summary. */
  visitKind?: "in_person" | "virtual";
  roughJobValue?: string;
  idealStartDate?: string;
  detailsComment?: string;
  previousQuotes?: { date: string; value: string; person: string; number?: string }[];

  // ── Explicit per-leg toggles + their inputs ──────────────────────────
  logActivity: boolean;
  sendSlack: boolean;

  createQuotie: boolean;
  quotieConfig?: QuotieConfig | null;
  /**
   * When linking a GHL-originated booking (pending path), pass the GHL
   * appointment id so Quotie LINKS to the existing appointment instead of
   * creating a new one. Undefined → Quotie creates the appointment
   * (create_ghl_appointment gate below still applies).
   */
  ghlAppointmentId?: string;
  /** Whether Quotie should create a GHL appointment (only relevant when NOT linking). */
  createGhlAppointment?: boolean;
  quotieAssignTo?: string;
  quotieGhlAssignedUserId?: string;
  quotieTime?: string;

  resolvePending: boolean;
  /** Direct pending row id when the caller already knows it (banner path). */
  pendingId?: string;
};

type HandleSiteVisitBookedResult = {
  activity: SiteVisitLegResult;
  slack: SiteVisitLegResult;
  quotie: SiteVisitLegResult;
  pending: SiteVisitLegResult;
};

async function handleSiteVisitBooked(
  supabase: ReturnType<typeof createAdminClient>,
  input: HandleSiteVisitBookedInput,
): Promise<HandleSiteVisitBookedResult> {
  const result: HandleSiteVisitBookedResult = {
    activity: { ran: false, ok: true },
    slack: { ran: false, ok: true },
    quotie: { ran: false, ok: true },
    pending: { ran: false, ok: true },
  };

  // ── a. Activity log ───────────────────────────────────────────────────
  if (input.logActivity) {
    result.activity.ran = true;
    try {
      const outcomeBits =
        input.vertical === "roofing"
          ? [
              input.roughJobValue ? `Rough $${String(input.roughJobValue).replace(/[$,\s]/g, "")}` : "",
              input.idealStartDate ? `Start ${input.idealStartDate}` : "",
              input.detailsComment?.trim() || "",
            ]
          : [input.detailsComment?.trim() || ""];
      const outcome = outcomeBits.filter(Boolean).join(" · ");

      const items: NewActivityItem[] = [
        {
          contact_name: input.contactName,
          contact_id: input.contactId,
          contact_address: input.contactAddress,
          appointment_at: input.appointmentAt || "",
          outcome,
          ad_source: "",
          ...(input.visitKind ? { visit_kind: input.visitKind } : {}),
        },
      ];
      if (!isMeaningful(items[0])) {
        result.activity = { ran: true, ok: false, detail: "Contact name is required" };
      } else {
        const activities = buildSheetActivities(
          input.occurredOn,
          "site_visit_booked",
          input.salesPersonName,
          items,
        );
        // DB/sheet need a parseable timestamp — NEVER the AU display string.
        const machineAppt = toMachineAppointmentAt(input.appointmentAt, input.appointmentDisplay);
        if (machineAppt) activities[0].appointmentDateTime = machineAppt;

        const posted = await postManualActivities(input.companyName, activities);
        result.activity = posted.ok
          ? { ran: true, ok: true }
          : { ran: true, ok: false, detail: posted.error };
      }
    } catch (e) {
      result.activity = { ran: true, ok: false, detail: (e as Error).message };
    }
  }

  // ── b. Slack booking summary ──────────────────────────────────────────
  if (input.sendSlack) {
    result.slack.ran = true;
    const base = process.env.NODE_SERVICE_URL;
    const secret = process.env.WEBHOOK_SECRET;
    if (!base) {
      result.slack = { ran: true, ok: false, detail: "Slack summary not sent (service not configured)" };
    } else {
      try {
        const res = await fetch(new URL("/api/site-visit-summary", base).toString(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
          },
          body: JSON.stringify({
            companyName: input.companyName,
            salesPerson: input.salesPersonName,
            contactName: input.contactName,
            contactPhone: input.contactPhone || "",
            contactEmail: input.contactEmail || "",
            contactAddress: input.contactAddress || "",
            appointmentDisplay: input.appointmentDisplay || input.appointmentAt || "",
            appointmentAt: input.appointmentAt || "",
            bookedOn: input.bookedOn || input.occurredOn,
            vertical: input.vertical,
            roughJobValue: input.roughJobValue || "",
            idealStartDate: input.idealStartDate || "",
            detailsComment: input.detailsComment || "",
            previousQuotes: input.previousQuotes || [],
            ...(input.visitKind ? { visitKind: input.visitKind } : {}),
          }),
          cache: "no-store",
        });
        if (res.ok) {
          result.slack = { ran: true, ok: true };
        } else {
          const t = await res.text().catch(() => "");
          console.error("[handleSiteVisitBooked] slack", res.status, t.slice(0, 200));
          result.slack = { ran: true, ok: false, detail: `Slack summary not sent (${res.status})` };
        }
      } catch (e) {
        console.error("[handleSiteVisitBooked] slack", (e as Error).message);
        result.slack = { ran: true, ok: false, detail: "Slack summary not sent" };
      }
    }
  }

  // ── c. Quotie booking ─────────────────────────────────────────────────
  if (input.createQuotie && input.quotieConfig?.api_key) {
    result.quotie.ran = true;
    try {
      // Linking an existing GHL-originated appointment → never create a new one.
      const linking = Boolean(input.ghlAppointmentId?.trim());
      const res = await createQuotieSiteVisit(input.quotieConfig, {
        date: input.occurredOn,
        time: input.quotieTime,
        contact_name: input.contactName,
        contact_phone: input.contactPhone,
        contact_email: input.contactEmail,
        ghl_contact_id: input.contactId,
        address: input.contactAddress,
        salesPersonName: input.salesPersonName,
        assign_to: input.quotieAssignTo,
        create_ghl_appointment: linking ? false : (input.createGhlAppointment ?? true),
        rough_job_value: input.roughJobValue,
        ideal_start: input.idealStartDate,
        details: input.detailsComment,
        ghl_assigned_user_id: input.quotieGhlAssignedUserId,
        ghl_appointment_id: input.ghlAppointmentId,
      });
      if (res.ok) {
        const parts: string[] = [];
        if (res.ghl?.status === "created") {
          const assignee = res.ghl.assigned_user_name || res.ghl.assigned_user_id;
          if (assignee) parts.push(`GHL appt → ${assignee}`);
        }
        if (res.warnings?.length) parts.push(res.warnings.join("; "));
        result.quotie = { ran: true, ok: true, detail: parts.join("; ") || undefined };
      } else {
        result.quotie = { ran: true, ok: false, detail: res.error };
      }
    } catch (e) {
      result.quotie = { ran: true, ok: false, detail: (e as Error).message };
    }
  }

  // ── d. Resolve the matching pending row ───────────────────────────────
  // Closes the double-handling loop: a booking handled here can never
  // resurface in the pending banner. Prefer a known pending id; otherwise
  // best-effort match on contact + appointment time.
  if (input.resolvePending) {
    result.pending.ran = true;
    try {
      const patch: Record<string, unknown> = { resolved_at: new Date().toISOString() };
      // The banner path also persists the manually-filled summary fields.
      if (input.pendingId?.trim()) {
        patch.rough_job_value = input.roughJobValue || null;
        patch.ideal_start_date = input.idealStartDate || null;
        patch.details_comment = input.detailsComment || null;
        patch.vertical = input.vertical;
        patch.summary_sent_at = result.slack.ok && result.slack.ran ? new Date().toISOString() : null;
      }

      let q = supabase
        .from("pending_site_visits")
        .update(patch)
        .eq("company_id", input.companyId)
        .is("resolved_at", null);

      if (input.pendingId?.trim()) {
        q = q.eq("id", input.pendingId.trim());
      } else {
        // Pre-resolve any open pending row for this contact + appointment time
        // so an EOD-3-handled booking never resurfaces in the banner. Match on
        // contact (id when known, else name) and the parsed appointment instant.
        q = q.is("dismissed_at", null);
        if (input.contactId?.trim()) {
          q = q.eq("contact_id", input.contactId.trim());
        } else if (input.contactName?.trim()) {
          q = q.eq("contact_name", input.contactName.trim());
        } else {
          // Nothing to match on — skip rather than resolving unrelated rows.
          result.pending = { ran: true, ok: true, detail: "no match key" };
          return result;
        }
        const machineAppt = toMachineAppointmentAt(input.appointmentAt, input.appointmentDisplay);
        if (machineAppt) q = q.eq("appointment_at", machineAppt);
      }

      const { error } = await q;
      if (error) {
        console.error("[handleSiteVisitBooked] resolve pending:", error.message);
        result.pending = { ran: true, ok: false, detail: error.message };
      } else {
        result.pending = { ran: true, ok: true };
      }
    } catch (e) {
      console.error("[handleSiteVisitBooked] resolve pending:", (e as Error).message);
      result.pending = { ran: true, ok: false, detail: (e as Error).message };
    }
  }

  return result;
}

/** Log a pending calendar booking: dual-write activity + Slack summary. */
export async function completePendingSiteVisit(
  input: CompleteSiteVisitInput,
): Promise<EodEntryResult> {
  const slug = verifyEodEntryToken(input.token || "");
  if (!slug) return { ok: false, error: "This entry link is no longer valid" };
  if (!input.pending_id?.trim()) return { ok: false, error: "Missing pending visit" };
  if (!isIsoDate(input.occurred_on)) return { ok: false, error: "Date must be YYYY-MM-DD" };

  const supabase = createAdminClient();
  let query = supabase.from("companies").select("id, name, slug, active, quotie_config");
  if (slug === "agency") {
    if (!input.ghl_location_id) return { ok: false, error: "Missing GHL location" };
    query = query.eq("ghl_location_id", input.ghl_location_id);
  } else {
    query = query.eq("slug", slug);
  }
  const { data: company } = await query.single();
  if (!company || !company.active) return { ok: false, error: "Client not found" };

  let salesPersonName = "Team";
  if (input.sales_person) {
    const { data: person } = await supabase
      .from("sales_people")
      .select("name")
      .eq("company_id", company.id)
      .eq("name", input.sales_person)
      .eq("active", true)
      .maybeSingle();
    if (!person) return { ok: false, error: "That sales person isn't on this client's roster" };
    salesPersonName = person.name;
  }

  // Pending row carries visit_kind + the raw GHL payload (virtual detection).
  const { data: pendingRow } = await supabase
    .from("pending_site_visits")
    .select("visit_kind, raw_payload")
    .eq("id", input.pending_id.trim())
    .eq("company_id", company.id)
    .maybeSingle();
  const visitKind: "in_person" | "virtual" =
    input.visit_kind === "virtual"
    || pendingRow?.visit_kind === "virtual"
    || isVirtualVisitPayload(pendingRow?.raw_payload)
      ? "virtual"
      : "in_person";

  // Fail fast on the one hard requirement (contact name) before the shared
  // handler — keeps the caller-facing error identical to the old flow.
  if (!isMeaningful({ contact_name: input.contact_name, contact_id: input.contact_id, contact_address: input.contact_address, appointment_at: input.appointment_at, outcome: "x" })) {
    return { ok: false, error: "Contact name is required" };
  }

  // Pull the GHL appointment id off the pending row's stored calendar webhook
  // body (fetched above) so Quotie LINKS to the existing appointment instead
  // of creating a duplicate. Best-effort — a lookup miss just means Quotie
  // records the visit without linking (still create_ghl_appointment: false).
  const ghlAppointmentId = ghlAppointmentIdFromRawPayload(pendingRow?.raw_payload);

  const legs = await handleSiteVisitBooked(supabase, {
    companyId: company.id,
    companyName: company.name,
    salesPersonName,
    occurredOn: input.occurred_on,
    contactName: input.contact_name,
    contactId: input.contact_id,
    contactPhone: input.contact_phone,
    contactEmail: input.contact_email,
    contactAddress: input.contact_address,
    appointmentDisplay: input.appointment_display,
    appointmentAt: input.appointment_at,
    bookedOn: input.booked_on,
    vertical: input.vertical,
    visitKind,
    roughJobValue: input.rough_job_value,
    idealStartDate: input.ideal_start_date,
    detailsComment: input.details_comment,
    previousQuotes: input.previous_quotes,
    // Pending-banner path: log activity + Slack (as before) AND now also push
    // to Quotie. The booking already exists in GHL (calendar-originated), so we
    // pass its appointment id (from raw_payload.calendar.appointmentId) for
    // Quotie to LINK to, and NEVER create a duplicate GHL appointment.
    logActivity: true,
    sendSlack: input.send_slack !== false, // default true; checkbox gates this leg only
    createQuotie: true,
    quotieConfig: company.quotie_config as QuotieConfig | null | undefined,
    ghlAppointmentId,
    createGhlAppointment: false,
    resolvePending: true,
    pendingId: input.pending_id.trim(),
  });

  // Preserve the old caller contract: the activity leg is the hard gate.
  if (!legs.activity.ok) {
    return { ok: false, error: legs.activity.detail || "Could not log the site visit" };
  }

  const pipeline = legs.slack.ok ? "Slack summary sent" : (legs.slack.detail || "Logged (Slack summary not sent)");
  return {
    ok: true,
    count: 1,
    pipeline,
    pipelineOk: legs.slack.ok,
    quotie_result: legs.quotie.ran ? { ok: legs.quotie.ok, detail: legs.quotie.detail } : undefined,
  };
}

/**
 * Previous quotes for a pending visit that wasn't the open contact on first
 * paint (those skip live GHL so the popup can render). Called when the exec
 * taps Log on a different booking.
 */
export async function loadPreviousQuotes(input: {
  token: string;
  ghl_location_id?: string;
  contact_id?: string;
  contact_name?: string;
}): Promise<PreviousQuote[]> {
  const slug = verifyEodEntryToken(input.token || "");
  if (!slug) return [];
  const contactId = (input.contact_id || "").trim();
  const contactName = (input.contact_name || "").trim();
  if (!contactId && !contactName) return [];

  const supabase = createAdminClient();
  let query = supabase.from("companies").select("id, active");
  if (slug === "agency") {
    if (!input.ghl_location_id) return [];
    query = query.eq("ghl_location_id", input.ghl_location_id);
  } else {
    query = query.eq("slug", slug);
  }
  const { data: company } = await query.maybeSingle();
  if (!company || !company.active) return [];

  return fetchPreviousQuotes(company.id, contactId, contactName, {
    ghlLocationId: input.ghl_location_id,
  });
}

/**
 * Remove a pending site visit from the EOD popup queue without logging it.
 * Soft-dismiss (sets dismissed_at) so it no longer surfaces in the banner.
 */
export async function dismissPendingSiteVisit(input: {
  token: string;
  ghl_location_id?: string;
  pending_id: string;
}): Promise<EodEntryResult> {
  const slug = verifyEodEntryToken(input.token || "");
  if (!slug) return { ok: false, error: "This entry link is no longer valid" };
  if (!input.pending_id?.trim()) return { ok: false, error: "Missing pending visit" };

  const supabase = createAdminClient();
  let query = supabase.from("companies").select("id, name, slug, active");
  if (slug === "agency") {
    if (!input.ghl_location_id) return { ok: false, error: "Missing GHL location" };
    query = query.eq("ghl_location_id", input.ghl_location_id);
  } else {
    query = query.eq("slug", slug);
  }
  const { data: company } = await query.single();
  if (!company || !company.active) return { ok: false, error: "Client not found" };

  const { data: updated, error } = await supabase
    .from("pending_site_visits")
    .update({ dismissed_at: new Date().toISOString() })
    .eq("id", input.pending_id.trim())
    .eq("company_id", company.id)
    .is("resolved_at", null)
    .is("dismissed_at", null)
    .select("id");

  if (error) {
    console.error("[dismissPendingSiteVisit]", error.message);
    return { ok: false, error: "Could not delete that site visit" };
  }
  if (!updated?.length) {
    return { ok: false, error: "That site visit is already gone" };
  }

  return { ok: true, count: 0 };
}

export async function submitEodEntry(input: EodEntryInput): Promise<EodEntryResult> {
  const slug = verifyEodEntryToken(input.token || "");
  if (!slug) return { ok: false, error: "This entry link is no longer valid" };

  // Popup is human-only. Quote/email automation uses other ingest paths;
  // dashboard Activities drawer still accepts full ALLOWED_EVENT_TYPES.
  const POPUP_EVENT_TYPES: EventType[] = [
    "eod_update",
    "job_won",
    "site_visit_booked",
  ];
  if (!POPUP_EVENT_TYPES.includes(input.event_type)) {
    return { ok: false, error: "Invalid event type for this form" };
  }
  if (!ALLOWED_EVENT_TYPES.includes(input.event_type)) {
    return { ok: false, error: "Invalid event type" };
  }
  if (!isIsoDate(input.occurred_on)) {
    return { ok: false, error: "Date must be YYYY-MM-DD" };
  }

  const supabase = createAdminClient();
  let query = supabase.from("companies").select("id, name, active, ghl_location_id, quotie_config");
  if (slug === "agency") {
    if (!input.ghl_location_id) return { ok: false, error: "Missing GHL location" };
    query = query.eq("ghl_location_id", input.ghl_location_id);
  } else {
    query = query.eq("slug", slug);
  }
  const { data: company } = await query.single();
  if (!company || !company.active) return { ok: false, error: "Client not found" };

  // Prefer the location from the extension URL; fall back to the company's
  // stored GHL location (company-slug entry links often omit ?location=).
  const locationId = (input.ghl_location_id || company.ghl_location_id || "").trim();

  let salesPersonName = "Team";
  if (input.sales_person) {
    const { data: person } = await supabase
      .from("sales_people")
      .select("name")
      .eq("company_id", company.id)
      .eq("name", input.sales_person)
      .eq("active", true)
      .maybeSingle();
    if (!person) return { ok: false, error: "That sales person isn't on this client's roster" };
    salesPersonName = person.name;
  }

  const items = (input.items || []).filter(isMeaningful);
  if (items.length === 0) {
    return { ok: false, error: "Add at least one entry (a contact name or value)" };
  }

  // Free-typed names (e.g. Direct Phone Call without opening the contact in
  // GHL) arrive without contact_id. Resolve a unique exact-name match so the
  // activity is linked and the opportunity create/move path can run.
  if (locationId && (input.event_type === "eod_update" || input.event_type === "job_won")) {
    for (const it of items) {
      if (it.contact_id?.trim()) continue;
      if (!it.contact_name?.trim()) continue;
      const resolved = await resolveGhlContactId({
        locationId,
        contactId: it.contact_id,
        contactName: it.contact_name,
      });
      if (resolved.contactId) it.contact_id = resolved.contactId;
    }
  }

  const activities = buildSheetActivities(input.occurred_on, input.event_type, salesPersonName, items);
  const posted = await postManualActivities(company.name, activities);
  if (!posted.ok) return posted;

  // Clear the calendar "to-log" card once the exec has submitted details.
  if (input.event_type === "site_visit_booked" && input.pending_site_visit_id) {
    const pendingId = input.pending_site_visit_id.trim();
    if (pendingId) {
      const { error: resolveErr } = await supabase
        .from("pending_site_visits")
        .update({ resolved_at: new Date().toISOString() })
        .eq("id", pendingId)
        .eq("company_id", company.id)
        .is("resolved_at", null);
      if (resolveErr) {
        console.error("[eod-entry] resolve pending site visit:", resolveErr.message);
      }
    }
  }

  // Activity is logged; now move (or create) the contact's opportunity in
  // the GHL EOD pipeline. Failure here never fails the submission — the
  // reason is surfaced as a note instead.
  let pipeline: string | undefined;
  let pipelineOk: boolean | undefined;
  if (input.event_type === "eod_update" && input.eod_fields) {
    const withContact = items.find(it => it.contact_id?.trim()) || items[0];
    const contactName =
      withContact?.contact_name?.trim() || items[0]?.contact_name?.trim() || "";
    const contactId = withContact?.contact_id?.trim() || "";
    if (!contactId) {
      // Name lookup already ran above — re-run only for a precise error note.
      const resolved = await resolveGhlContactId({
        locationId,
        contactId: "",
        contactName,
      });
      pipelineOk = false;
      pipeline = resolved.contactId == null
        ? resolved.reason
        : "no linked GHL contact";
    } else {
      const moved = await moveEodOpportunity({
        locationId,
        contactId,
        contactName,
        stage: input.eod_fields.stage,
        answered: input.eod_fields.answered,
        stdOutcome: input.eod_fields.std_outcome,
      });
      pipelineOk = moved.ok;
      pipeline = moved.ok ? (moved.moved || "updated") : moved.reason;
    }
  } else if (input.event_type === "job_won") {
    // Job Won must close the GHL opportunity and write the deal value so
    // pipeline reporting (won rate, revenue) matches the Activity Log.
    // contact_id is already name-resolved above when missing.
    const notes: string[] = [];
    let anyOk = false;
    let attempted = 0;
    for (const it of items) {
      const contactId = it.contact_id?.trim() || "";
      if (!contactId) {
        notes.push("no linked GHL contact");
        continue;
      }
      attempted++;
      const monetaryValue = parseMonetaryValue(it.quote_job_value);
      const moved = await moveEodOpportunity({
        locationId,
        contactId,
        contactName: it.contact_name?.trim() || "",
        stage: "",
        answered: "",
        stdOutcome: "Job Won",
        monetaryValue,
      });
      if (moved.ok) {
        anyOk = true;
        if (moved.moved) notes.push(moved.moved);
      } else {
        notes.push(moved.reason);
      }
    }
    pipelineOk = attempted > 0 && anyOk;
    pipeline = [...new Set(notes)].join("; ")
      || (attempted === 0 ? "no linked GHL contact" : "opportunity not updated");
  }

  // Quotie push — the site visit fires from the outcome mapping (unchanged);
  // the task fires independently from quotie_task (no outcome required). A
  // Quotie failure must NEVER fail the EOD submit, so every path here folds
  // into quotie_result and swallows its own errors.
  let quotie_result: { ok: boolean; detail?: string } | undefined;
  const quotieConfig = company.quotie_config as QuotieConfig | null | undefined;

  // Contact context: prefer the item that resolved to a GHL contact id.
  const withContact = items.find(it => it.contact_id?.trim()) || items[0];
  const quotieContactName =
    withContact?.contact_name?.trim() || items[0]?.contact_name?.trim() || "";
  const quotieGhlContactId = withContact?.contact_id?.trim() || undefined;

  // ── Site-visit path (outcome-gated, unchanged semantics) ──────────────
  let visitRes: { ok: boolean; detail?: string } | null = null;
  if (
    input.quotie &&
    input.event_type === "eod_update" &&
    input.eod_fields &&
    quotieConfig?.api_key
  ) {
    const stdOutcome = input.eod_fields.std_outcome || "";
    // NEVER trust the client's `type` — re-resolve server-side.
    const action = resolveQuotieAction(stdOutcome, quotieConfig);
    if (!action) {
      visitRes = { ok: false, detail: "no Quotie action for this outcome" };
    } else if (action.type !== input.quotie.type) {
      // Client/server disagree (config changed mid-session) — skip, don't guess.
      visitRes = { ok: false, detail: "Quotie action changed — reload and retry" };
    } else if (action.type === "callback") {
      // Pipeline callback — moves the Quotie lead into the matching column.
      // notes carries the free-text EOD detail; the label is outcome-specific.
      const outcome = action.outcome || "requires_quoting";
      const res = await createQuotieCallback(quotieConfig, {
        outcome,
        ghl_contact_id: quotieGhlContactId,
        notes: input.quotie.notes,
        salesPersonName,
        assign_to: action.assign_to,
        callback_reason: callbackReasonFor(outcome, stdOutcome),
        callback_date: outcome === "callback_requested" ? input.quotie.callback_date : undefined,
      });
      if (res.ok) {
        visitRes = { ok: true, detail: callbackDetailFor(outcome, res.noop, res.warnings) };
      } else {
        visitRes = { ok: false, detail: res.error };
      }
    } else if (action.type === "site_visit") {
      // EOD-3 "Book Site Visit": route through the shared booking handler so
      // this path does everything the pending-banner path does — previously it
      // ONLY pushed the Quotie visit (no site_visit_booked activity, no Slack,
      // no pending pre-resolve). The outer eod_update activity was already
      // logged above; this leg ADDS the site_visit_booked activity + Slack, and
      // pre-resolves any matching pending row so the booking can't resurface in
      // the banner (closes the double-handling loop).
      const svAppointmentAt =
        input.quotie.date
          ? `${input.quotie.date}${input.quotie.time ? `T${input.quotie.time}` : ""}`
          : input.quotie.time
            ? `${input.occurred_on}T${input.quotie.time}`
            : "";
      const legs = await handleSiteVisitBooked(supabase, {
        companyId: company.id,
        companyName: company.name,
        salesPersonName,
        occurredOn: input.quotie.date || input.occurred_on,
        contactName: quotieContactName,
        contactId: quotieGhlContactId,
        contactAddress: input.quotie.address,
        appointmentAt: svAppointmentAt,
        vertical: "roofing",
        roughJobValue: input.quotie.rough_job_value,
        idealStartDate: input.quotie.ideal_start,
        detailsComment: input.quotie.details,
        // EOD-3 path now ALSO logs the site_visit_booked activity + Slack.
        logActivity: true,
        sendSlack: input.quotie.send_slack !== false, // default true; checkbox gates this leg only
        createQuotie: true,
        quotieConfig,
        // EOD-3 books a NEW visit — honour the form's create-appointment toggle.
        ghlAppointmentId: undefined,
        createGhlAppointment: input.quotie.create_ghl_appointment ?? true,
        quotieAssignTo: action.assign_to,
        quotieGhlAssignedUserId: input.quotie.ghl_assigned_user_id,
        quotieTime: input.quotie.time,
        resolvePending: true,
      });
      const parts: string[] = [];
      if (legs.quotie.detail) parts.push(legs.quotie.detail);
      if (!legs.activity.ok && legs.activity.detail) parts.push(`log: ${legs.activity.detail}`);
      if (!legs.slack.ok && legs.slack.detail) parts.push(legs.slack.detail);
      visitRes = {
        ok: legs.quotie.ran ? legs.quotie.ok : legs.activity.ok,
        detail: parts.join("; ") || undefined,
      };
    } else {
      // Legacy: an old client sent quotie.type === 'task' (new clients send
      // quotie_task instead). Keep it working across a deploy boundary.
      const template = action.titleTemplate || "Follow up with {contact}";
      const resolvedTitle = template.replace(/\{contact\}/g, quotieContactName || "contact");
      const title = input.quotie.title?.trim() || resolvedTitle;
      const res = await createQuotieTask(quotieConfig, {
        title,
        notes: input.quotie.notes,
        due_date: input.quotie.due_date,
        salesPersonName,
        assign_to: action.assign_to,
        ghl_contact_id: quotieGhlContactId,
      });
      visitRes = { ok: res.ok, detail: res.ok ? res.warnings?.join("; ") : res.error };
    }
  }

  // ── EOD 2 no-answer path (Answered? step, independent of EOD 3) ───────
  // The no-answer / voicemail signal lives on EOD 2, so it fires even with no
  // EOD 3 outcome. Skipped when the EOD 3 outcome already resolved to its own
  // callback action above (never double-post the same contact). Re-resolved
  // server-side from eod_fields — the client only requests it via a flag.
  if (
    !visitRes &&
    input.quotie_answered_callback &&
    input.event_type === "eod_update" &&
    input.eod_fields &&
    quotieConfig?.api_key
  ) {
    const outcomeAction = resolveQuotieAction(input.eod_fields.std_outcome || "", quotieConfig);
    const eod3IsCallback = outcomeAction?.type === "callback";
    const answeredOutcome = resolveAnsweredCallback(input.eod_fields.answered || "", quotieConfig);
    if (answeredOutcome && !eod3IsCallback) {
      const res = await createQuotieCallback(quotieConfig, {
        outcome: answeredOutcome,
        ghl_contact_id: quotieGhlContactId,
        notes: input.quotie_answered_callback.notes,
        salesPersonName,
        callback_reason: callbackReasonFor(answeredOutcome, input.eod_fields.std_outcome || ""),
      });
      visitRes = res.ok
        ? { ok: true, detail: callbackDetailFor(answeredOutcome, res.noop, res.warnings) }
        : { ok: false, detail: res.error };
    }
  }

  // ── Task path (outcome-independent) ───────────────────────────────────
  let taskRes: { ok: boolean; detail?: string } | null = null;
  if (input.quotie_task && input.event_type === "eod_update" && quotieConfig?.api_key) {
    // Title: client-provided → outcome template (when the outcome happens to
    // map to a task action) → plain fallback.
    const outcomeAction = input.eod_fields
      ? resolveQuotieAction(input.eod_fields.std_outcome || "", quotieConfig)
      : null;
    const taskAction = outcomeAction?.type === "task" ? outcomeAction : null;
    const template = taskAction?.titleTemplate || "Follow up with {contact}";
    const title =
      input.quotie_task.title?.trim() ||
      template.replace(/\{contact\}/g, quotieContactName || "contact");
    const res = await createQuotieTask(quotieConfig, {
      title,
      notes: input.quotie_task.notes,
      due_date: input.quotie_task.due_date,
      salesPersonName,
      assign_to: taskAction?.assign_to,
      ghl_contact_id: quotieGhlContactId,
    });
    taskRes = { ok: res.ok, detail: res.ok ? res.warnings?.join("; ") : res.error };
  }

  // ── Combine results ───────────────────────────────────────────────────
  if (visitRes && taskRes) {
    const parts = [
      visitRes.detail ? `visit: ${visitRes.detail}` : "",
      taskRes.detail ? `task: ${taskRes.detail}` : "",
    ].filter(Boolean);
    quotie_result = { ok: visitRes.ok && taskRes.ok, detail: parts.join("; ") || undefined };
  } else if (visitRes) {
    quotie_result = visitRes;
  } else if (taskRes) {
    quotie_result = taskRes;
  }

  return { ...posted, pipeline, pipelineOk, quotie_result };
}

/**
 * Fetch the GHL calendar team members for the site-visit team-member picker.
 * Returns members stripped to { id, name, is_primary } — quotie_auth_id and
 * raw user_map values must never reach the browser (quotie.ts header comment).
 * Never throws; on any auth/config failure returns { ok: true, members: [], defaults: {} }
 * so the picker is simply hidden rather than erroring.
 */
export async function fetchQuotieTeamMembers(input: {
  token: string;
  ghl_location_id?: string;
}): Promise<{ ok: boolean; members: QuotieTeamMember[]; defaults: Record<string, string> }> {
  try {
    const slug = verifyEodEntryToken(input.token || "");
    if (!slug) return { ok: true, members: [], defaults: {} };

    const supabase = createAdminClient();
    let query = supabase.from("companies").select("id, active, quotie_config");
    if (slug === "agency") {
      if (!input.ghl_location_id) return { ok: true, members: [], defaults: {} };
      query = query.eq("ghl_location_id", input.ghl_location_id);
    } else {
      query = query.eq("slug", slug);
    }
    const { data: company } = await query.single();
    if (!company || !company.active) return { ok: true, members: [], defaults: {} };

    const config = company.quotie_config as QuotieConfig | null | undefined;
    if (!config?.api_key) return { ok: true, members: [], defaults: {} };

    const result = await getQuotieTeamMembers(config);
    if (!result.ok) return { ok: false, members: [], defaults: {} };

    // Build the defaults map: roster name → ghl_user_id, via user_map auth_id lookup.
    const defaults: Record<string, string> = {};
    for (const [rosterName, authId] of Object.entries(config.user_map ?? {})) {
      const match = result.members.find(m => m.quotie_auth_id === authId);
      if (match) defaults[rosterName] = match.ghl_user_id;
    }

    // Strip quotie_auth_id before sending to client.
    const members: QuotieTeamMember[] = result.members.map(m => ({
      id: m.ghl_user_id,
      name: m.name,
      is_primary: m.is_primary,
    }));

    return { ok: true, members, defaults };
  } catch {
    return { ok: false, members: [], defaults: {} };
  }
}
