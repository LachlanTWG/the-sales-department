"use server";

// Submission path for the GHL-embedded /eod-entry form. Mirrors
// createManualActivities (activities/actions.ts) but authorises via the
// signed company token instead of a Supabase session: the token pins the
// company, and the sales person is checked against that company's roster
// with the service-role client. The backend endpoint trusts this server via
// WEBHOOK_SECRET, so every field must be validated HERE.

import { verifyEodEntryToken } from "@/lib/eodEntryToken";
import { createAdminClient } from "@/lib/supabase/admin";
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
};

/** Log a pending calendar booking: dual-write activity + Slack summary. */
export async function completePendingSiteVisit(
  input: CompleteSiteVisitInput,
): Promise<EodEntryResult> {
  const slug = verifyEodEntryToken(input.token || "");
  if (!slug) return { ok: false, error: "This entry link is no longer valid" };
  if (!input.pending_id?.trim()) return { ok: false, error: "Missing pending visit" };
  if (!isIsoDate(input.occurred_on)) return { ok: false, error: "Date must be YYYY-MM-DD" };

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

  // Compact outcome for the activity log / EOD reports (Slack gets the full summary).
  const outcomeBits =
    input.vertical === "roofing"
      ? [
          input.rough_job_value ? `Rough $${String(input.rough_job_value).replace(/[$,\s]/g, "")}` : "",
          input.ideal_start_date ? `Start ${input.ideal_start_date}` : "",
          input.details_comment?.trim() || "",
        ]
      : [input.details_comment?.trim() || ""];
  const outcome = outcomeBits.filter(Boolean).join(" · ");

  const items: NewActivityItem[] = [
    {
      contact_name: input.contact_name,
      contact_id: input.contact_id,
      contact_address: input.contact_address,
      appointment_at: input.appointment_at || "",
      outcome,
      ad_source: "",
    },
  ];
  if (!isMeaningful(items[0])) {
    return { ok: false, error: "Contact name is required" };
  }

  const activities = buildSheetActivities(
    input.occurred_on,
    "site_visit_booked",
    salesPersonName,
    items,
  );
  // DB/sheet need a parseable timestamp — NEVER the AU display string
  // (e.g. "31/07/2026 3:30 PM" blows up Postgres). Prefer ISO-ish
  // appointment_at; fall back to raw display only if it looks machine-safe.
  const machineAppt = toMachineAppointmentAt(
    input.appointment_at,
    input.appointment_display,
  );
  if (machineAppt) {
    activities[0].appointmentDateTime = machineAppt;
  }
  const posted = await postManualActivities(company.name, activities);
  if (!posted.ok) return posted;

  // Slack booking summary on the client's EOD channel.
  let slackOk = false;
  const base = process.env.NODE_SERVICE_URL;
  const secret = process.env.WEBHOOK_SECRET;
  if (base) {
    try {
      const res = await fetch(new URL("/api/site-visit-summary", base).toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify({
          companyName: company.name,
          salesPerson: salesPersonName,
          contactName: input.contact_name,
          contactPhone: input.contact_phone || "",
          contactEmail: input.contact_email || "",
          contactAddress: input.contact_address || "",
          appointmentDisplay: input.appointment_display || input.appointment_at || "",
          appointmentAt: input.appointment_at || "",
          bookedOn: input.booked_on || input.occurred_on,
          vertical: input.vertical,
          roughJobValue: input.rough_job_value || "",
          idealStartDate: input.ideal_start_date || "",
          detailsComment: input.details_comment || "",
          previousQuotes: input.previous_quotes || [],
        }),
        cache: "no-store",
      });
      slackOk = res.ok;
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        console.error("[completePendingSiteVisit] slack", res.status, t.slice(0, 200));
      }
    } catch (e) {
      console.error("[completePendingSiteVisit] slack", (e as Error).message);
    }
  }

  const { error: resolveErr } = await supabase
    .from("pending_site_visits")
    .update({
      resolved_at: new Date().toISOString(),
      rough_job_value: input.rough_job_value || null,
      ideal_start_date: input.ideal_start_date || null,
      details_comment: input.details_comment || null,
      vertical: input.vertical,
      summary_sent_at: slackOk ? new Date().toISOString() : null,
    })
    .eq("id", input.pending_id.trim())
    .eq("company_id", company.id)
    .is("resolved_at", null);
  if (resolveErr) {
    console.error("[completePendingSiteVisit] resolve:", resolveErr.message);
  }

  return {
    ...posted,
    pipeline: slackOk ? "Slack summary sent" : "Logged (Slack summary not sent)",
    pipelineOk: slackOk,
  };
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
      const res = await createQuotieSiteVisit(quotieConfig, {
        date: input.quotie.date || input.occurred_on,
        time: input.quotie.time,
        contact_name: quotieContactName,
        ghl_contact_id: quotieGhlContactId,
        address: input.quotie.address,
        salesPersonName,
        assign_to: action.assign_to,
        create_ghl_appointment: input.quotie.create_ghl_appointment ?? true,
        rough_job_value: input.quotie.rough_job_value,
        ideal_start: input.quotie.ideal_start,
        details: input.quotie.details,
        ghl_assigned_user_id: input.quotie.ghl_assigned_user_id,
      });
      if (res.ok) {
        const parts: string[] = [];
        // Prepend GHL appointment assignee when the appointment was created.
        if (res.ghl?.status === "created") {
          const assignee = res.ghl.assigned_user_name || res.ghl.assigned_user_id;
          if (assignee) parts.push(`GHL appt → ${assignee}`);
        }
        if (res.warnings?.length) parts.push(res.warnings.join("; "));
        visitRes = { ok: true, detail: parts.join("; ") || undefined };
      } else {
        visitRes = { ok: false, detail: res.error };
      }
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
