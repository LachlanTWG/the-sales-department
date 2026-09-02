"use client";

// The GHL popup form (served inside the EOD Logger extension panel).
// Layout: Details (company / contact / prior history) → New Submission.
// The primary flow is the EOD call log — the same five fields as the GHL
// custom fields (Stage / Answered? / Standard Outcome / Custom Outcome /
// Contact Source), submitted as one eod_update with the outcome joined
// " | "-style so it's byte-identical to what the /webhook/ghl/eod path
// produces.
//
// Popup types are intentionally human-only: EOD update, Job won, Site visit.
// Quote sent / Email sent are automated (Quotie webhook + Gmail/Outlook OAuth sync)
// and stay available for backfill from the dashboard Activities drawer only.

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { NewActivityItem } from "@/lib/manualActivities";
import type { ContactHistory, EodOptions, PendingSiteVisit } from "./data";
import { formatAuNzDate } from "./data";
import {
  completePendingSiteVisit,
  dismissPendingSiteVisit,
  fetchQuotieTeamMembers,
  submitEodEntry,
  type EodEntryInput,
} from "./actions";
import type { QuotieTeamMember } from "./quotie";

// Site visits are logged via the pending calendar banner (not this Type selector).
const EVENT_TYPES = [
  { value: "eod_update", label: "EOD update" },
  { value: "job_won",    label: "Job won" },
] as const;

/** Blank / Unknown / Team → anyone can still pick it up. */
function isUnassignedExec(name: string | null | undefined): boolean {
  const t = (name || "").trim();
  return !t || /^unknown$/i.test(t) || /^team$/i.test(t);
}

/**
 * Pending site visits are company-wide in the DB, but each exec only sees
 * their own queue (plus unassigned). Matches roster short names and full
 * names ("Lachlan" ≡ "Lachlan Boys").
 */
function pendingBelongsToExec(p: PendingSiteVisit, me: string): boolean {
  if (isUnassignedExec(p.salesPersonName)) return true;
  const owner = (p.salesPersonName || "").trim().toLowerCase();
  const mine = (me || "").trim().toLowerCase();
  if (!mine) return false; // don't leak other execs' bookings before we know who you are
  if (owner === mine) return true;
  const ownerFirst = owner.split(/\s+/)[0] || "";
  const mineFirst = mine.split(/\s+/)[0] || "";
  if (ownerFirst && mineFirst && ownerFirst === mineFirst) return true;
  if (owner.startsWith(mine + " ") || mine.startsWith(owner + " ")) return true;
  return false;
}

type EventType = (typeof EVENT_TYPES)[number]["value"];

type Item = {
  contact_name: string;
  contact_id: string;
  contact_address: string;
  outcome: string;
  ad_source: string;
  quote_job_value: string;
  appointment_at: string;
  quote_number: string;
  split_commission: boolean;
  half_commission_charge: boolean;
};

const emptyItem = (
  contactName = "",
  contactAddress = "",
  adSource = "",
  contactId = "",
): Item => ({
  contact_name: contactName,
  contact_id: contactId,
  contact_address: contactAddress,
  outcome: "",
  ad_source: adSource,
  quote_job_value: "",
  appointment_at: "",
  quote_number: "",
  split_commission: false,
  half_commission_charge: false,
});

const FALLBACK_OPTIONS: EodOptions = { stages: [], outcomes: [], sources: [] };

// Display-only short labels for the EOD 1 stage buttons. The submitted VALUES
// stay the long-form DEFAULT_STAGES strings — GHL pipeline workflows branch on
// string equality against them (see data.ts DEFAULT_STAGES) — so only the
// button text is shortened. Unknown (learned) stages render their full name.
const STAGE_SHORT_LABELS: Record<string, string> = {
  "New Leads": "New Lead",
  "Pre-Quote Follow Up": "Pre Quote",
  "Post Quote Follow Up": "Post Quote",
};

/** YYYY-MM-DD `days` from now, in local time. */
function isoInDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function EodEntryForm({
  token,
  ghlLocationId = "",
  companyName,
  people,
  defaultDate,
  contactName = "",
  contactId = "",
  contactAddress = "",
  contactPhone = "",
  contactEmail = "",
  defaultLeadSource = "",
  defaultSalesPerson = "",
  options = FALLBACK_OPTIONS,
  history = null,
  pendingSiteVisits = [],
  quotieActions = {},
  quotieEnabled = false,
}: {
  token: string;
  ghlLocationId?: string;
  companyName: string;
  people: string[];
  defaultDate: string;
  contactName?: string;
  contactId?: string;
  /** Prefill from GHL Street Address (or last logged address). */
  contactAddress?: string;
  contactPhone?: string;
  contactEmail?: string;
  /** Prefill from most recent EOD 5 / contact source for this contact. */
  defaultLeadSource?: string;
  /** GHL contact owner / assignee matched to roster. */
  defaultSalesPerson?: string;
  options?: EodOptions;
  history?: ContactHistory | null;
  pendingSiteVisits?: PendingSiteVisit[];
  /** EOD 3 outcome → Quotie action kind. Empty {} disables the feature. */
  quotieActions?: Record<string, "task" | "site_visit" | "callback">;
  /** Company has a Quotie api_key — enables the always-available task checkbox. */
  quotieEnabled?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const [pipelineNote, setPipelineNote] = useState<string | null>(null);
  const [pipelineOk, setPipelineOk] = useState<boolean>(false);
  const [quotieResult, setQuotieResult] = useState<{ ok: boolean; detail?: string } | null>(null);
  const [quotieKindDone, setQuotieKindDone] = useState<"task" | "site_visit" | "callback" | null>(null);
  const [openPendings, setOpenPendings] = useState<PendingSiteVisit[]>(pendingSiteVisits);
  const [activePending, setActivePending] = useState<PendingSiteVisit | null>(null);
  const [svRough, setSvRough] = useState("");
  const [svIdealStart, setSvIdealStart] = useState("");
  const [svComment, setSvComment] = useState("");
  /** Two-step delete: first click shows Confirm on the Delete slot. */
  const [confirmDeletePending, setConfirmDeletePending] = useState(false);

  // Device identity for the pending queue (who *I* am) — independent of the
  // contact's GHL owner. Without this, opening Zac's contact made Lachlan see
  // Zac's site-visit log form.
  const [viewerExec, setViewerExec] = useState(() => {
    if (typeof window === "undefined") return "";
    try {
      const stored = localStorage.getItem("eod-exec") || "";
      return stored && people.includes(stored) ? stored : "";
    } catch {
      return "";
    }
  });

  const initialSales =
    (defaultSalesPerson && people.includes(defaultSalesPerson) ? defaultSalesPerson : "") ||
    people[0] ||
    "";
  const [salesPerson, setSalesPerson] = useState(initialSales);

  // Only show pendings assigned to this device's exec (or unassigned).
  // Deliberately uses viewerExec from localStorage — NOT the contact's GHL
  // owner / form salesPerson, which can be Zac while Lachlan is looking.
  const myPendings = useMemo(
    () => openPendings.filter(p => pendingBelongsToExec(p, viewerExec)),
    [openPendings, viewerExec],
  );

  // Each exec's browser remembers who they are: pick your name once and every
  // popup on this device defaults to you, across all clients (as long as
  // you're on that client's roster). Read after hydration — localStorage
  // isn't available during SSR.
  useEffect(() => {
    try {
      const stored = localStorage.getItem("eod-exec");
      if (stored && people.includes(stored)) {
        setViewerExec(stored); // eslint-disable-line react-hooks/set-state-in-effect
      }
    } catch { /* storage unavailable (rare iframe modes) — keep default */ }

    // Prefill the form's sales person from GHL contact owner when present;
    // otherwise fall back to this device's remembered exec. Viewer identity
    // for the pending queue stays on localStorage (above), not GHL owner.
    if (defaultSalesPerson && people.includes(defaultSalesPerson)) {
      setSalesPerson(defaultSalesPerson);
      return;
    }
    try {
      const stored = localStorage.getItem("eod-exec");
      if (stored && people.includes(stored)) setSalesPerson(stored);
    } catch { /* ignore */ }
  }, [defaultSalesPerson, people]);

  // Auto-open the site-visit log form when THIS contact has a pending booking
  // that belongs to the current exec (never auto-open someone else's).
  useEffect(() => {
    if (activePending || myPendings.length === 0) return;
    const matchById = contactId
      ? myPendings.find(p => p.contactId && p.contactId === contactId)
      : null;
    const matchByName = contactName
      ? myPendings.find(
          p => p.contactName && p.contactName.toLowerCase() === contactName.toLowerCase(),
        )
      : null;
    // Only auto-open for the open contact — never a lone company-wide pending
    // for a different lead (that used to surface Zac's booking on Lachlan).
    const first = matchById || matchByName || null;
    if (first) applyPending(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId, contactName, myPendings.length, viewerExec]);

  // If the active form is someone else's booking (e.g. viewer just corrected
  // their name), drop it so it doesn't stay open under the wrong exec.
  useEffect(() => {
    if (!activePending) return;
    if (!pendingBelongsToExec(activePending, viewerExec)) {
      setActivePending(null);
    }
  }, [activePending, viewerExec]);

  function chooseSalesPerson(name: string) {
    setSalesPerson(name);
    if (name) {
      setViewerExec(name);
      try {
        localStorage.setItem("eod-exec", name);
      } catch { /* ignore */ }
    }
  }
  const [date, setDate] = useState(defaultDate);
  const [eventType, setEventType] = useState<EventType>("eod_update");

  // EOD call-log fields (the five GHL custom fields).
  const [eodName, setEodName] = useState(contactName);
  const [stage, setStage] = useState(history?.lastStage || options.stages[0] || "");
  const [answered, setAnswered] = useState("");
  const [stdOutcome, setStdOutcome] = useState("");
  const [customOutcome, setCustomOutcome] = useState("");
  const [source, setSource] = useState(defaultLeadSource || history?.topSource || "");

  // ── Quotie action state (only relevant when quotieActions[stdOutcome] set) ──
  const quotieKind = quotieActions[stdOutcome];
  // Site visit
  const [qsvEnabled, setQsvEnabled] = useState(true);
  const [qsvDate, setQsvDate] = useState(() => isoInDays(1));
  const [qsvTime, setQsvTime] = useState("");
  const [qsvAddress, setQsvAddress] = useState(contactAddress || "");
  const [qsvGhlAppt, setQsvGhlAppt] = useState(true);
  const [qsvRough, setQsvRough] = useState("");
  const [qsvIdealStart, setQsvIdealStart] = useState("");
  const [qsvDetails, setQsvDetails] = useState("");
  // Team member picker — null means not yet fetched; [] means fetched but empty (hide picker).
  const [qsvTeam, setQsvTeam] = useState("");
  const [qsvTeamTouched, setQsvTeamTouched] = useState(false);
  const [qsvTeamMembers, setQsvTeamMembers] = useState<QuotieTeamMember[] | null>(null);
  const [qsvTeamDefaults, setQsvTeamDefaults] = useState<Record<string, string>>({});
  const teamFetchedRef = useRef(false);
  // Task — outcome-independent: lives in the sticky bottom bar, available for
  // any outcome. Defaults off, but auto-ticks when the outcome maps to a task
  // (unless the exec has manually toggled it this session).
  const [qtaskEnabled, setQtaskEnabled] = useState(false);
  const [qtaskTitle, setQtaskTitle] = useState("");
  const [qtaskDue, setQtaskDue] = useState("");
  const [qtaskNotes, setQtaskNotes] = useState("");
  const userTouchedTask = useRef(false);
  const [quotieTaskDone, setQuotieTaskDone] = useState(false);

  useEffect(() => {
    if (userTouchedTask.current) return;
    // Auto-tick the sticky-bar checkbox for outcomes that map to a task or a
    // pipeline callback (e.g. Requires Quoting → Add to Quotie pipeline).
    const kind = quotieActions[stdOutcome];
    if (kind === "task" || kind === "callback") setQtaskEnabled(true);
  }, [stdOutcome, quotieActions]);

  // Lazy-fetch team members once when the site-visit section becomes active.
  useEffect(() => {
    if (quotieKind !== "site_visit" || !qsvEnabled) return;
    if (qsvTeamMembers !== null) return;
    if (teamFetchedRef.current) return;
    teamFetchedRef.current = true;
    fetchQuotieTeamMembers({ token, ghl_location_id: ghlLocationId }).then(res => {
      setQsvTeamMembers(res.members);
      setQsvTeamDefaults(res.defaults);
      if (!qsvTeamTouched) {
        setQsvTeam(res.defaults[salesPerson] ?? "");
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quotieKind, qsvEnabled]);

  // When salesPerson changes, recompute the default team member (unless exec touched it).
  useEffect(() => {
    if (qsvTeamTouched) return;
    if (qsvTeamMembers === null) return;
    setQsvTeam(qsvTeamDefaults[salesPerson] ?? "");
  }, [salesPerson, qsvTeamTouched, qsvTeamMembers, qsvTeamDefaults]);

  // Multi-row items for the non-EOD event types. Address + lead source are
  // prefilled from GHL Street Address / EOD 5 when available.
  const [items, setItems] = useState<Item[]>([
    emptyItem(contactName, contactAddress, defaultLeadSource, contactId),
  ]);

  function patchItem(i: number, patch: Partial<Item>) {
    setItems(list => list.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }
  function addItem() {
    setItems(list => [...list, emptyItem(contactName, contactAddress, defaultLeadSource, contactId)]);
  }
  function removeItem(i: number) { setItems(list => list.filter((_, idx) => idx !== i)); }

  function applyPending(p: PendingSiteVisit) {
    // Fill sparse pending rows from the open contact / GHL page context.
    const enriched: PendingSiteVisit = {
      ...p,
      contactId: p.contactId || contactId || "",
      contactName: p.contactName || contactName || "",
      contactPhone: p.contactPhone || contactPhone || "",
      contactEmail: p.contactEmail || contactEmail || "",
      contactAddress:
        (!p.contactAddress || /^12 example st$/i.test(p.contactAddress)
          ? contactAddress
          : p.contactAddress) || "",
      salesPersonName:
        (p.salesPersonName && !/^unknown$/i.test(p.salesPersonName)
          ? p.salesPersonName
          : "") ||
        defaultSalesPerson ||
        p.salesPersonName ||
        "",
    };
    setActivePending(enriched);
    if (enriched.salesPersonName && people.includes(enriched.salesPersonName)) {
      chooseSalesPerson(enriched.salesPersonName);
    } else if (enriched.salesPersonName && !/^unknown$/i.test(enriched.salesPersonName)) {
      setSalesPerson(enriched.salesPersonName);
    } else if (defaultSalesPerson && people.includes(defaultSalesPerson)) {
      chooseSalesPerson(defaultSalesPerson);
    }
    setSvRough(""); // always manual — never prefill
    setSvIdealStart("");
    setSvComment("");
    setConfirmDeletePending(false);
    setError(null);
    setSavedCount(null);
    setPipelineNote(null);
  }

  function cancelPendingLog() {
    setActivePending(null);
    setSvRough("");
    setSvIdealStart("");
    setSvComment("");
    setConfirmDeletePending(false);
  }

  function submitPendingSiteVisit(e: React.FormEvent) {
    e.preventDefault();
    if (!activePending) return;
    setError(null);
    setSavedCount(null);
    setPipelineNote(null);
    setPipelineOk(false);
    setConfirmDeletePending(false);

    if (activePending.vertical === "roofing") {
      if (!svRough.trim()) {
        setError("Rough job value is required for roofing site visits");
        return;
      }
    }

    startTransition(async () => {
      const res = await completePendingSiteVisit({
        token,
        ghl_location_id: ghlLocationId,
        pending_id: activePending.id,
        sales_person: salesPerson,
        occurred_on: activePending.bookedOn || defaultDate,
        contact_name: activePending.contactName,
        contact_id: activePending.contactId,
        contact_phone: activePending.contactPhone,
        contact_email: activePending.contactEmail,
        contact_address: activePending.contactAddress,
        // Display (AU) for Slack only; machine ISO for DB insert.
        appointment_display: activePending.appointmentDisplay || activePending.appointmentRaw,
        appointment_at:
          activePending.appointmentLocal ||
          // Prefer raw machine wall-clock from GHL ("2026-07-31 15:30:00")
          (activePending.appointmentRaw && /^\d{4}-\d{2}-\d{2}/.test(activePending.appointmentRaw)
            ? activePending.appointmentRaw
            : ""),
        booked_on: activePending.bookedOn || defaultDate,
        vertical: activePending.vertical,
        rough_job_value: svRough,
        ideal_start_date: svIdealStart,
        details_comment: svComment,
        previous_quotes: activePending.previousQuotes,
      });
      if (!res.ok) { setError(res.error); return; }
      setSavedCount(res.count);
      setPipelineNote(res.pipeline ?? null);
      setPipelineOk(res.pipelineOk ?? false);
      setOpenPendings(list => list.filter(x => x.id !== activePending.id));
      setActivePending(null);
      setSvRough("");
      setSvIdealStart("");
      setSvComment("");
      setConfirmDeletePending(false);
    });
  }

  /** Dismiss a pending visit Jesse (etc.) booked by mistake — no Slack, no activity. */
  function deletePendingSiteVisit() {
    if (!activePending) return;
    if (!confirmDeletePending) {
      setConfirmDeletePending(true);
      setError(null);
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await dismissPendingSiteVisit({
        token,
        ghl_location_id: ghlLocationId,
        pending_id: activePending.id,
      });
      if (!res.ok) {
        setError(res.error);
        setConfirmDeletePending(false);
        return;
      }
      setOpenPendings(list => list.filter(x => x.id !== activePending.id));
      setActivePending(null);
      setSvRough("");
      setSvIdealStart("");
      setSvComment("");
      setConfirmDeletePending(false);
      // Reuse the green status banner: count 0 means dismissed, not logged.
      setSavedCount(0);
      setPipelineNote("Site visit removed from queue");
      setPipelineOk(true);
    });
  }

  function submit(payloadItems: NewActivityItem[], evType: EventType) {
    // Site visit + callback are outcome-mapped (server re-resolves the type);
    // the plain task is independent (sticky-bar checkbox) and rides along in
    // quotie_task regardless of outcome.
    let quotie: EodEntryInput["quotie"];
    if (evType === "eod_update" && quotieKind === "site_visit" && qsvEnabled) {
      quotie = {
        type: "site_visit",
        date: qsvDate,
        time: qsvTime.trim() || undefined,
        address: qsvAddress.trim() || undefined,
        create_ghl_appointment: qsvGhlAppt,
        rough_job_value: qsvRough.trim() || undefined,
        ideal_start: qsvIdealStart.trim() || undefined,
        details: qsvDetails.trim() || undefined,
        ghl_assigned_user_id: qsvTeam || undefined,
      };
    } else if (evType === "eod_update" && quotieKind === "callback" && qtaskEnabled) {
      // The sticky-bar checkbox doubles as "Add to Quotie pipeline" here. The
      // notes field carries the free-text EOD detail into the attempt history.
      quotie = {
        type: "callback",
        notes: qtaskNotes.trim() || undefined,
      };
    }

    // Independent task path — skipped when the outcome maps to a callback, since
    // the same checkbox is driving the callback above (don't double up).
    const quotie_task: EodEntryInput["quotie_task"] =
      evType === "eod_update" && quotieEnabled && qtaskEnabled && quotieKind !== "callback"
        ? {
            title: qtaskTitle.trim() || undefined,
            notes: qtaskNotes.trim() || undefined,
            due_date: qtaskDue.trim() || undefined,
          }
        : undefined;

    const input: EodEntryInput = {
      token,
      ghl_location_id: ghlLocationId,
      sales_person: salesPerson,
      occurred_on: date,
      event_type: evType,
      items: payloadItems,
      eod_fields:
        evType === "eod_update"
          ? { stage, answered, std_outcome: stdOutcome }
          : undefined,
      quotie,
      quotie_task,
    };
    startTransition(async () => {
      const res = await submitEodEntry(input);
      if (!res.ok) { setError(res.error); return; }
      setSavedCount(res.count);
      setPipelineNote(res.pipeline ?? null);
      setPipelineOk(res.pipelineOk ?? false);
      setQuotieResult(res.quotie_result ?? null);
      setQuotieKindDone(input.quotie?.type ?? (input.quotie_task ? "task" : null));
      setQuotieTaskDone(!!input.quotie_task);
      if (evType === "eod_update") {
        // Keep stage + source (same contact, likely same context next time);
        // clear the per-call outcomes.
        setAnswered("");
        setStdOutcome("");
        setCustomOutcome("");
      } else {
        setItems([emptyItem(contactName, contactAddress, defaultLeadSource, contactId)]);
      }
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSavedCount(null);
    setPipelineNote(null);
    setPipelineOk(false);
    setQuotieResult(null);
    setQuotieKindDone(null);

    if (eventType === "eod_update") {
      if (!answered) { setError("Tap Answered or Didn't Answer"); return; }
      // Same join as the GHL webhook: parts trimmed, " | " separator, empties kept.
      const outcome = [stage, answered, stdOutcome, customOutcome, source]
        .map(s => s.trim())
        .join(" | ");
      submit(
        [{
          contact_name: eodName,
          contact_id: contactId && eodName.trim() === contactName.trim() ? contactId : "",
          outcome,
          ad_source: source,
        }],
        "eod_update",
      );
      return;
    }

    if (eventType === "job_won") {
      for (const it of items) {
        if (!it.quote_job_value.trim()) {
          setError("Job value is required (incl. GST)");
          return;
        }
        if (!it.quote_number.trim()) {
          setError("Quote number is required — it goes on the commission sheet");
          return;
        }
      }
    }

    const payloadItems: NewActivityItem[] = items.map(it => ({
      ...it,
      contact_id:
        it.contact_id?.trim() ||
        (contactId && it.contact_name.trim() === contactName.trim() ? contactId : ""),
    }));
    submit(payloadItems, eventType);
  }

  const rowLabel = eventType === "job_won" ? "Job" : "Entry";

  return (
    <div>
        {/* ── Details ─────────────────────────────────────────────── */}
        <div className="mb-4 border-b border-zinc-800 pb-3">
          <div className="flex items-baseline justify-between">
            <div className="text-base font-semibold text-zinc-100">{companyName}</div>
            <div className="text-[11px] text-zinc-500">{date}</div>
          </div>
          {contactName && (
            <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-sky-900/60 bg-sky-950/40 px-2.5 py-0.5 text-[11px] text-sky-300">
              {contactName}
            </div>
          )}
        </div>

        {(contactName || contactId) && <HistoryCard history={history} />}

        {myPendings.length > 0 && !activePending && (
          <PendingVisitsBanner
            pendings={myPendings}
            contactId={contactId}
            activeId={null}
            onLog={applyPending}
          />
        )}

        {activePending && (
          <form className="mb-4 space-y-3.5 rounded-lg border border-amber-800/60 bg-amber-950/20 p-3" onSubmit={submitPendingSiteVisit}>
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-medium uppercase tracking-wider text-amber-300/90">
                Log site visit · {activePending.vertical === "roofing" ? "Roofing" : "Solar"}
              </div>
              <button type="button" onClick={cancelPendingLog} className="text-[11px] text-zinc-500 hover:text-zinc-300">
                Cancel
              </button>
            </div>

            <div className="space-y-1.5 rounded border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-[12px] text-zinc-300">
              <AutoRow label="Lead" value={activePending.contactName || "—"} />
              <AutoRow label="Phone" value={activePending.contactPhone || "—"} />
              <AutoRow label="Email" value={activePending.contactEmail || "—"} />
              <AutoRow label="Location" value={activePending.contactAddress || "—"} />
              <AutoRow
                label="Visit time"
                value={activePending.appointmentDisplay || activePending.appointmentRaw || "—"}
              />
              <AutoRow
                label="Booked on"
                value={
                  activePending.bookedOnDisplay ||
                  formatAuNzDate(activePending.bookedOn) ||
                  activePending.bookedOn ||
                  "—"
                }
              />
            </div>

            <Field label="Sales person">
              <select value={salesPerson} onChange={e => chooseSalesPerson(e.target.value)} className={inputClass}>
                {people.map(p => <option key={p} value={p}>{p}</option>)}
                {salesPerson && !people.includes(salesPerson) && (
                  <option value={salesPerson}>{salesPerson}</option>
                )}
                <option value="">— team —</option>
              </select>
            </Field>

            {/* Previous quotes — always shown (roofing + solar) */}
            <div className="rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2">
              <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                Previous quotes
              </div>
              {activePending.previousQuotes.length === 0 ? (
                <p className="mt-1 text-[12px] text-zinc-500">
                  No previous quote has been sent.
                </p>
              ) : (
                <ul className="mt-1.5 space-y-1">
                  {activePending.previousQuotes.map((q, i) => (
                    <li key={i} className="text-[12px] text-zinc-300">
                      {q.number ? (
                        <span className="text-zinc-400">#{q.number} · </span>
                      ) : null}
                      ${String(q.value).replace(/[$,]/g, "")}
                      {q.date ? ` · ${formatAuNzDate(q.date) || q.date}` : ""}
                      {q.person ? ` · ${q.person}` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {activePending.vertical === "roofing" ? (
              <>
                <Field label="Rough job value (incl. GST)" hint="Required — dollars, no symbols.">
                  <input
                    type="text"
                    inputMode="decimal"
                    required
                    value={svRough}
                    onChange={e => setSvRough(e.target.value)}
                    className={inputClass}
                    placeholder="e.g. 12000"
                  />
                </Field>
                <Field label="Ideal start date">
                  <select
                    value={svIdealStart}
                    onChange={e => setSvIdealStart(e.target.value)}
                    className={inputClass}
                  >
                    <option value="">— select —</option>
                    <option value="ASAP">ASAP</option>
                    <option value="0-30 days">0-30 days</option>
                    <option value="30-90 days">30-90 days</option>
                    <option value="90 days+">90 days+</option>
                    <option value="Not sure">Not sure</option>
                  </select>
                </Field>
                <Field label="Details / comment" hint="Single line.">
                  <input
                    type="text"
                    value={svComment}
                    onChange={e => setSvComment(e.target.value)}
                    className={inputClass}
                    placeholder="Anything the crew should know"
                  />
                </Field>
              </>
            ) : (
              <Field label="Comment" hint="Optional — notes for the Slack summary.">
                <input
                  type="text"
                  value={svComment}
                  onChange={e => setSvComment(e.target.value)}
                  className={inputClass}
                  placeholder="Anything worth noting"
                />
              </Field>
            )}

            {error && (
              <div className="rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">
                {error}
              </div>
            )}

            {confirmDeletePending && (
              <p className="text-[11px] text-red-300/90">
                Remove this booking from the queue? It won’t be logged to Slack.
              </p>
            )}

            <div className="grid grid-cols-4 gap-2">
              <button
                type="submit"
                disabled={pending}
                className="col-span-3 rounded bg-emerald-600/90 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
              >
                {pending && !confirmDeletePending ? "Sending…" : "Log site visit → Slack"}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={deletePendingSiteVisit}
                className={
                  confirmDeletePending
                    ? "col-span-1 rounded bg-red-600 px-2 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
                    : "col-span-1 rounded border border-red-900/60 bg-red-950/40 px-2 py-2 text-sm font-medium text-red-300 hover:border-red-700 hover:bg-red-950/70 disabled:opacity-50"
                }
              >
                {pending && confirmDeletePending
                  ? "…"
                  : confirmDeletePending
                    ? "Confirm"
                    : "Delete"}
              </button>
            </div>
          </form>
        )}

        {/* ── New Submission ─────────────────────────────────────── */}
        <form className="space-y-3.5" onSubmit={handleSubmit}>
          <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            New submission
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Sales person">
              <select value={salesPerson} onChange={e => chooseSalesPerson(e.target.value)} className={inputClass}>
                {people.map(p => <option key={p} value={p}>{p}</option>)}
                <option value="">— team —</option>
              </select>
            </Field>
            <Field label="Date">
              <input type="date" required value={date} onChange={e => setDate(e.target.value)} className={inputClass} />
            </Field>
          </div>

          <Field label="Type">
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Type">
              {EVENT_TYPES.map(t => (
                <button
                  key={t.value}
                  type="button"
                  role="radio"
                  aria-checked={eventType === t.value}
                  onClick={() => setEventType(t.value)}
                  className={
                    eventType === t.value
                      ? "rounded border border-emerald-600 bg-emerald-600/20 px-2 py-2 text-center text-xs font-medium text-emerald-300 sm:text-sm"
                      : "rounded border border-zinc-800 bg-zinc-900 px-2 py-2 text-center text-xs text-zinc-400 hover:border-zinc-600 sm:text-sm"
                  }
                >
                  {t.label}
                </button>
              ))}
            </div>
          </Field>

          {eventType === "eod_update" ? (
            <>
              <Field label="Contact name">
                <input type="text" value={eodName} onChange={e => setEodName(e.target.value)} className={inputClass} />
              </Field>

              <Field label="EOD 1 · Stage">
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ...options.stages,
                    ...(stage && !options.stages.includes(stage) ? [stage] : []),
                  ].map(s => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setStage(s)}
                      className={
                        stage === s
                          ? "rounded border border-sky-600 bg-sky-600/20 px-3 py-2 text-sm font-medium text-sky-300"
                          : "rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-400 hover:border-zinc-600"
                      }
                    >
                      {STAGE_SHORT_LABELS[s] ?? s}
                    </button>
                  ))}
                </div>
              </Field>

              <Field label="EOD 2 · Answered?">
                <div className="grid grid-cols-2 gap-2">
                  {["Answered", "Didn't Answer"].map(a => (
                    <button
                      key={a}
                      type="button"
                      onClick={() => setAnswered(a)}
                      className={
                        answered === a
                          ? a === "Answered"
                            ? "rounded border border-emerald-600 bg-emerald-600/20 px-3 py-2 text-sm font-medium text-emerald-300"
                            : "rounded border border-amber-600 bg-amber-600/20 px-3 py-2 text-sm font-medium text-amber-300"
                          : "rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-400 hover:border-zinc-600"
                      }
                    >
                      {a}
                    </button>
                  ))}
                </div>
              </Field>

              <Field label="EOD 3 · Standard outcome">
                <select value={stdOutcome} onChange={e => setStdOutcome(e.target.value)} className={inputClass}>
                  <option value="">—</option>
                  {options.outcomes.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </Field>

              {quotieKind === "site_visit" && (
                <div className="space-y-3 rounded-lg border border-sky-900/60 bg-sky-950/20 p-3">
                  <label className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-sky-300/90">
                      Book site visit in Quotie
                    </span>
                    <input
                      type="checkbox"
                      checked={qsvEnabled}
                      onChange={e => setQsvEnabled(e.target.checked)}
                      className="rounded border-zinc-600 bg-zinc-900"
                    />
                  </label>
                  {qsvEnabled && (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="Date">
                          <input
                            type="date"
                            value={qsvDate}
                            onChange={e => setQsvDate(e.target.value)}
                            className={inputClass}
                          />
                        </Field>
                        <Field label="Time" hint="Optional.">
                          <input
                            type="time"
                            value={qsvTime}
                            onChange={e => setQsvTime(e.target.value)}
                            className={inputClass}
                          />
                        </Field>
                      </div>
                      <Field label="Address" hint="Prefilled from the contact — edit if needed.">
                        <input
                          type="text"
                          value={qsvAddress}
                          onChange={e => setQsvAddress(e.target.value)}
                          className={inputClass}
                        />
                      </Field>
                      <Field label="Rough job value" hint="Optional — dollars, no symbols.">
                        <input
                          type="text"
                          inputMode="decimal"
                          value={qsvRough}
                          onChange={e => setQsvRough(e.target.value)}
                          className={inputClass}
                          placeholder="e.g. 12000"
                        />
                      </Field>
                      <Field label="Ideal start date">
                        <select
                          value={qsvIdealStart}
                          onChange={e => setQsvIdealStart(e.target.value)}
                          className={inputClass}
                        >
                          <option value="">— select —</option>
                          <option value="ASAP">ASAP</option>
                          <option value="0-30 days">0-30 days</option>
                          <option value="30-90 days">30-90 days</option>
                          <option value="90 days+">90 days+</option>
                          <option value="Not sure">Not sure</option>
                        </select>
                      </Field>
                      <Field label="Details" hint="Optional.">
                        <textarea
                          value={qsvDetails}
                          onChange={e => setQsvDetails(e.target.value)}
                          rows={2}
                          className={inputClass}
                          placeholder="Anything discussed on the call — access, scope, expectations…"
                        />
                      </Field>
                      {qsvTeamMembers !== null && qsvTeamMembers.length > 0 && (
                        <Field label="Team member" hint="Who the GHL appointment is assigned to.">
                          <select
                            value={qsvTeam}
                            onChange={e => { setQsvTeam(e.target.value); setQsvTeamTouched(true); }}
                            className={inputClass}
                          >
                            <option value="">Calendar default</option>
                            {qsvTeamMembers.map(m => (
                              <option key={m.id} value={m.id}>
                                {m.name ?? m.id}{m.is_primary ? " · primary" : ""}
                              </option>
                            ))}
                          </select>
                        </Field>
                      )}
                      <label className="flex items-start gap-2 text-xs text-zinc-300">
                        <input
                          type="checkbox"
                          checked={qsvGhlAppt}
                          onChange={e => setQsvGhlAppt(e.target.checked)}
                          className="mt-0.5 rounded border-zinc-600 bg-zinc-900"
                        />
                        <span className="font-medium text-zinc-200">Also create GHL calendar appointment</span>
                      </label>
                    </>
                  )}
                </div>
              )}

              <Field label="EOD 4 · Custom outcome" hint="Optional — anything worth remembering.">
                <input
                  type="text"
                  value={customOutcome}
                  onChange={e => setCustomOutcome(e.target.value)}
                  className={inputClass}
                />
              </Field>

              <Field label="EOD 5 · Contact source">
                <select value={source} onChange={e => setSource(e.target.value)} className={inputClass}>
                  <option value="">—</option>
                  {options.sources.map(s => <option key={s} value={s}>{s}</option>)}
                  {source && !options.sources.includes(source) && <option value={source}>{source}</option>}
                </select>
              </Field>
            </>
          ) : (
            <>
              <div className="space-y-3">
                {items.map((it, i) => (
                  <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                        {rowLabel} {items.length > 1 ? i + 1 : ""}
                      </span>
                      {items.length > 1 && (
                        <button type="button" onClick={() => removeItem(i)} className="text-[11px] text-zinc-500 hover:text-red-300">
                          Remove
                        </button>
                      )}
                    </div>

                    <div className="space-y-3">
                      <Field label="Contact name">
                        <input type="text" value={it.contact_name} onChange={e => patchItem(i, { contact_name: e.target.value })} className={inputClass} />
                      </Field>

                      {eventType === "job_won" && (
                        <>
                          <Field
                            label="Job value (incl. GST)"
                            hint="Dollars, no symbols. Used for commission calc."
                          >
                            <input
                              type="text"
                              inputMode="decimal"
                              value={it.quote_job_value}
                              onChange={e => patchItem(i, { quote_job_value: e.target.value })}
                              className={inputClass}
                              placeholder="e.g. 12000"
                            />
                          </Field>
                          <Field
                            label="Quote number"
                            hint="Required for the commission / WHMCS description."
                          >
                            <input
                              type="text"
                              value={it.quote_number}
                              onChange={e => patchItem(i, { quote_number: e.target.value })}
                              className={inputClass}
                              placeholder="e.g. 4521"
                            />
                          </Field>
                          <div className="space-y-2 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                            <label className="flex items-start gap-2 text-xs text-zinc-300">
                              <input
                                type="checkbox"
                                checked={it.half_commission_charge}
                                onChange={e => patchItem(i, { half_commission_charge: e.target.checked })}
                                className="mt-0.5 rounded border-zinc-600 bg-zinc-900"
                              />
                              <span>
                                <span className="font-medium text-zinc-200">50% commission charge</span>
                                <span className="mt-0.5 block text-[11px] text-zinc-500">
                                  Full schedule on job value, then charge half (no salesman / Quotie process win).
                                </span>
                              </span>
                            </label>
                            <label className="flex items-start gap-2 text-xs text-zinc-300">
                              <input
                                type="checkbox"
                                checked={it.split_commission}
                                onChange={e => patchItem(i, { split_commission: e.target.checked })}
                                className="mt-0.5 rounded border-zinc-600 bg-zinc-900"
                              />
                              <span>
                                <span className="font-medium text-zinc-200">50/50 exec split</span>
                                <span className="mt-0.5 block text-[11px] text-zinc-500">
                                  Split SE share with the other exec on this client. Can combine with 50% charge.
                                </span>
                              </span>
                            </label>
                          </div>
                          <Field
                            label="Address"
                            hint={contactAddress ? "Prefill from GHL Street Address — edit if needed." : "Optional. Prefills from GHL when available."}
                          >
                            <input type="text" value={it.contact_address} onChange={e => patchItem(i, { contact_address: e.target.value })} className={inputClass} />
                          </Field>
                          <Field
                            label="Lead source"
                            hint={defaultLeadSource ? "Prefill from EOD 5 — edit if needed." : "Optional. Prefills from EOD 5 when logged."}
                          >
                            <input type="text" value={it.ad_source} onChange={e => patchItem(i, { ad_source: e.target.value })} className={inputClass} placeholder="e.g. Facebook Ad Form" />
                          </Field>
                        </>
                      )}

                    </div>
                  </div>
                ))}

                <button
                  type="button"
                  onClick={addItem}
                  className="w-full rounded border border-dashed border-zinc-700 px-3 py-2 text-xs text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
                >
                  + Add another {rowLabel.toLowerCase()}
                </button>
              </div>
            </>
          )}

          {quotieEnabled && eventType === "eod_update" && qtaskEnabled && (
            <div className="space-y-3 rounded-lg border border-sky-900/60 bg-sky-950/20 p-3">
              <span className="block text-[11px] font-medium uppercase tracking-wider text-sky-300/90">
                {quotieKind === "callback" ? "Quotie pipeline" : "Quotie task"}
              </span>
              {quotieKind === "callback" ? (
                <p className="text-[11px] leading-relaxed text-sky-200/70">
                  Drops this lead into Quotie&apos;s Requires Quoting column with a Create Quote button. Add any detail for the attempt history below.
                </p>
              ) : (
              <>
              <Field label="Title" hint="Leave blank to auto-title from the outcome.">
                <input
                  type="text"
                  value={qtaskTitle}
                  onChange={e => setQtaskTitle(e.target.value)}
                  className={inputClass}
                  placeholder={eodName.trim() ? `Task for ${eodName.trim()}` : "Task title"}
                />
              </Field>
              <Field label="Due date">
                <div className="mb-2 grid grid-cols-3 gap-2">
                  {[
                    { label: "Tomorrow", days: 1 },
                    { label: "3 days", days: 3 },
                    { label: "1 week", days: 7 },
                  ].map(q => {
                    const val = isoInDays(q.days);
                    return (
                      <button
                        key={q.label}
                        type="button"
                        onClick={() => setQtaskDue(val)}
                        className={
                          qtaskDue === val
                            ? "rounded border border-emerald-600 bg-emerald-600/20 px-2 py-1.5 text-center text-xs font-medium text-emerald-300"
                            : "rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-center text-xs text-zinc-400 hover:border-zinc-600"
                        }
                      >
                        {q.label}
                      </button>
                    );
                  })}
                </div>
                <input
                  type="date"
                  value={qtaskDue}
                  onChange={e => setQtaskDue(e.target.value)}
                  className={inputClass}
                />
              </Field>
              </>
              )}
              <Field label="Notes" hint="Optional.">
                <textarea
                  value={qtaskNotes}
                  onChange={e => setQtaskNotes(e.target.value)}
                  rows={2}
                  className={inputClass}
                />
              </Field>
            </div>
          )}

          {/* Sticky action bar — pinned to the popup bottom so Log it (and the
              task checkbox) are always reachable without scrolling. Banners
              live here too so submit feedback is visible without scrolling. */}
          <div className="sticky bottom-0 space-y-2 border-t border-zinc-800 bg-zinc-950 pb-2 pt-3 shadow-[0_-8px_16px_-8px_rgba(0,0,0,0.8)]">
            {error && (
              <div className="rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">
                {error}
              </div>
            )}

            {savedCount !== null && !error && (
              <div className="rounded border border-emerald-900/50 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300">
                {savedCount === 0 ? (
                  pipelineNote || "Done."
                ) : (
                  <>
                    Saved {savedCount === 1 ? "1 activity" : `${savedCount} activities`}. It&apos;s in the reports + dashboard.
                    {pipelineNote && pipelineOk && (
                      <span className="mt-0.5 block text-emerald-400">Pipeline: {pipelineNote} ✓</span>
                    )}
                    {pipelineNote && !pipelineOk && (
                      <span className="mt-0.5 block text-amber-300/90">Pipeline not moved: {pipelineNote}</span>
                    )}
                    {quotieResult && quotieResult.ok && (
                      <span className="mt-0.5 block text-sky-300">
                        ✓ {quotieKindDone === "site_visit"
                          ? (quotieTaskDone ? "Site visit + task created in Quotie" : "Site visit booked in Quotie")
                          : quotieKindDone === "callback"
                            ? "Added to Quotie pipeline"
                            : "Task created in Quotie"}
                        {quotieResult.detail ? ` · ${quotieResult.detail}` : ""}
                      </span>
                    )}
                    {quotieResult && !quotieResult.ok && (
                      <span className="mt-0.5 block text-amber-300/90">
                        ⚠ Quotie: {quotieResult.detail || "action not created"}
                      </span>
                    )}
                  </>
                )}
              </div>
            )}

            <div className="flex items-center justify-between gap-3">
              {quotieEnabled && eventType === "eod_update" ? (
                <label className="flex min-w-0 items-center gap-2 text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    checked={qtaskEnabled}
                    onChange={e => {
                      userTouchedTask.current = true;
                      setQtaskEnabled(e.target.checked);
                    }}
                    className="rounded border-zinc-600 bg-zinc-900"
                  />
                  <span className="truncate font-medium text-zinc-200">
                    {quotieKind === "callback" ? "Add to Quotie pipeline" : "Also create a Quotie task"}
                  </span>
                </label>
              ) : (
                <span />
              )}
              <button
                type="submit"
                disabled={pending}
                className="shrink-0 rounded bg-emerald-600/90 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
              >
                {pending ? "Saving…" : "Log it"}
              </button>
            </div>
          </div>
        </form>
    </div>
  );
}

function AutoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-20 shrink-0 text-[10px] font-medium uppercase tracking-wider text-zinc-500">{label}</span>
      <span className="min-w-0 break-words text-zinc-200">{value}</span>
    </div>
  );
}

function PendingVisitsBanner({
  pendings,
  contactId,
  activeId,
  onLog,
}: {
  pendings: PendingSiteVisit[];
  contactId: string;
  activeId: string | null;
  onLog: (p: PendingSiteVisit) => void;
}) {
  // Prefer the contact we're looking at, then newest.
  const ordered = [...pendings].sort((a, b) => {
    const aMatch = contactId && a.contactId === contactId ? 0 : 1;
    const bMatch = contactId && b.contactId === contactId ? 0 : 1;
    if (aMatch !== bMatch) return aMatch - bMatch;
    return (b.createdAt || "").localeCompare(a.createdAt || "");
  });

  return (
    <div className="mb-4 rounded-lg border border-amber-800/60 bg-amber-950/30 p-3">
      <div className="text-[11px] font-medium uppercase tracking-wider text-amber-300/90">
        {pendings.length === 1
          ? "1 site visit waiting for details"
          : `${pendings.length} site visits waiting for details`}
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-amber-200/70">
        Booked in GHL — confirm auto fields, add {pendings[0]?.vertical === "roofing" ? "rough value / start / notes" : "comment"}, then Log to Slack.
      </p>
      <ul className="mt-2 space-y-2">
        {ordered.map(p => {
          const isActive = activeId === p.id;
          const forThisContact = contactId && p.contactId === contactId;
          return (
            <li
              key={p.id}
              className={
                isActive
                  ? "rounded border border-amber-600/70 bg-amber-900/30 px-2.5 py-2"
                  : "rounded border border-zinc-800 bg-zinc-950/40 px-2.5 py-2"
              }
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-zinc-100">
                    {p.contactName || "Unknown contact"}
                    {forThisContact && (
                      <span className="ml-1.5 text-[10px] font-normal text-sky-400">this contact</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11px] text-zinc-400">
                    {p.appointmentDisplay || p.appointmentRaw || "Time TBC"}
                    {p.salesPersonName ? ` · ${p.salesPersonName}` : ""}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onLog(p)}
                  className="shrink-0 rounded border border-amber-700/60 bg-amber-900/40 px-2.5 py-1 text-[11px] font-medium text-amber-200 hover:border-amber-500"
                >
                  Log details
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function HistoryCard({ history }: { history: ContactHistory | null }) {
  const [expanded, setExpanded] = useState(false);

  if (!history) {
    return (
      <div className="mb-4 rounded-lg border border-zinc-800 bg-zinc-900/30 px-3 py-2 text-[11px] text-zinc-500">
        First contact — no previous activity on record.
      </div>
    );
  }

  const bits: string[] = [];
  if (history.answered + history.didntAnswer > 0) {
    bits.push(`${history.answered} answered / ${history.didntAnswer} didn't`);
  }
  if (history.quotes > 0) {
    bits.push(`${history.quotes} quote${history.quotes > 1 ? "s" : ""}${history.quotedTotal ? ` ($${Math.round(history.quotedTotal).toLocaleString()})` : ""}`);
  }
  if (history.siteVisits > 0) bits.push(`${history.siteVisits} site visit${history.siteVisits > 1 ? "s" : ""}`);
  if (history.emails > 0) bits.push(`${history.emails} email${history.emails > 1 ? "s" : ""}`);
  if (history.jobsWon > 0) bits.push(`${history.jobsWon} job${history.jobsWon > 1 ? "s" : ""} won 🎉`);

  return (
    <div className="mb-4 rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
          Previous contact · {history.total}× since {shortDate(history.firstDate)}
        </span>
        <span className="text-[11px] text-zinc-500">{expanded ? "▾ hide" : "▸ show"}</span>
      </button>

      <div className="mt-1.5 text-[12px] leading-relaxed text-zinc-300">
        Last touched {shortDate(history.lastDate)}
        {history.lastStage ? ` · ${history.lastStage}` : ""}
        {bits.length > 0 ? ` · ${bits.join(" · ")}` : ""}
      </div>

      {expanded && (
        <ul className="mt-2 space-y-1 border-t border-zinc-800 pt-2">
          {history.recent.map((r, i) => (
            <li key={i} className="flex gap-2 text-[11px] text-zinc-400">
              <span className="shrink-0 tabular-nums text-zinc-500">{shortDate(r.date)}</span>
              <span className="shrink-0 text-zinc-300">{r.label}</span>
              <span className="truncate">{r.detail}</span>
              {r.person && <span className="ml-auto shrink-0 text-zinc-500">{r.person}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "2026-05-18" → "18 May" (or "18 May 25" when not the current year). */
function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const thisYear = new Date().getFullYear();
  return `${d} ${months[m - 1]}${y !== thisYear ? ` ${String(y).slice(2)}` : ""}`;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-medium uppercase tracking-wider text-zinc-400">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint && <p className="mt-1 text-[10px] text-zinc-500">{hint}</p>}
    </label>
  );
}

const inputClass =
  "w-full rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600";
