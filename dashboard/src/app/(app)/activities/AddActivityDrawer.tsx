"use client";

// Drawer for adding activities by hand — e.g. when the Quotie "Quote Sent"
// automation didn't fire and a quote needs backfilling. Submits via the
// createManualActivities server action, which routes through the same
// sheet + Postgres dual-write the webhooks use (so the entry shows up in BOTH
// the Slack/ClickUp reports and this dashboard).
//
// "Multiple quotes, one entry": the company / person / date / type are shared
// across the submission; you add one row per quote and they're each saved as a
// separate activity, so the report maths stay correct.

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createManualActivities } from "./actions";
import type { NewActivityItem } from "@/lib/manualActivities";

// Backfill-only surface. Day-to-day Email sent / Quote sent should come from
// mailbox OAuth sync (Gmail/Outlook) and Quotie — these exist when automation misses.
const EVENT_TYPES = [
  { value: "quote_sent",        label: "Quote sent (backfill)" },
  { value: "job_won",           label: "Job won" },
  { value: "site_visit_booked", label: "Site visit booked" },
  { value: "email_sent",        label: "Email sent (backfill)" },
  { value: "eod_update",        label: "EOD update" },
] as const;

type EventType = (typeof EVENT_TYPES)[number]["value"];

export type CompanyOption = { id: string; name: string };
export type SalesPersonOption = { id: string; name: string; company_id: string };

type Item = {
  contact_name: string;
  contact_address: string;
  outcome: string;
  ad_source: string;
  quote_job_value: string;
  appointment_at: string;
  quote_number: string;
  split_commission: boolean;
  half_commission_charge: boolean;
};

const emptyItem = (): Item => ({
  contact_name: "",
  contact_address: "",
  outcome: "",
  ad_source: "",
  quote_job_value: "",
  appointment_at: "",
  quote_number: "",
  split_commission: false,
  half_commission_charge: false,
});

export function AddActivityDrawer({
  onClose,
  companies,
  salesPeople,
  isAdmin,
  mySalesPersonIds,
  defaultDate,
}: {
  onClose: () => void;
  companies: CompanyOption[];
  salesPeople: SalesPersonOption[];
  isAdmin: boolean;
  mySalesPersonIds: string[];
  defaultDate: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const peopleFor = (companyId: string) => {
    const all = salesPeople.filter(p => p.company_id === companyId);
    return isAdmin ? all : all.filter(p => mySalesPersonIds.includes(p.id));
  };
  const defaultPerson = (companyId: string) => peopleFor(companyId)[0]?.id ?? "";

  const firstCompany = companies[0]?.id ?? "";
  const [companyId, setCompanyId] = useState(firstCompany);
  const [salesPersonId, setSalesPersonId] = useState(defaultPerson(firstCompany));
  const [date, setDate] = useState(defaultDate);
  const [eventType, setEventType] = useState<EventType>("quote_sent");
  const [items, setItems] = useState<Item[]>([emptyItem()]);

  const companyPeople = useMemo(() => peopleFor(companyId), [companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  function chooseCompany(id: string) {
    setCompanyId(id);
    setSalesPersonId(defaultPerson(id));
  }

  function patchItem(i: number, patch: Partial<Item>) {
    setItems(list => list.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }
  function addItem() { setItems(list => [...list, emptyItem()]); }
  function removeItem(i: number) { setItems(list => list.filter((_, idx) => idx !== i)); }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!companyId) { setError("Pick a client"); return; }
    if (eventType === "job_won") {
      for (const it of items) {
        if (!it.quote_job_value.trim()) {
          setError("Job value is required (incl. GST)");
          return;
        }
        if (!it.quote_number.trim()) {
          setError("Quote number is required for job won (commission sheet)");
          return;
        }
      }
    }
    startTransition(async () => {
      const payloadItems: NewActivityItem[] = items.map(it => ({
        contact_name: it.contact_name,
        contact_address: it.contact_address,
        outcome: it.outcome,
        ad_source: it.ad_source,
        quote_job_value: it.quote_job_value,
        appointment_at: it.appointment_at,
        quote_number: it.quote_number,
        split_commission: it.split_commission,
        half_commission_charge: it.half_commission_charge,
      }));
      const res = await createManualActivities({
        company_id: companyId,
        sales_person_id: salesPersonId || null,
        occurred_on: date,
        event_type: eventType,
        items: payloadItems,
      });
      if (!res.ok) { setError(res.error); return; }
      router.refresh();
      onClose();
    });
  }

  const rowLabel = eventType === "quote_sent" ? "Quote"
    : eventType === "job_won" ? "Job"
    : eventType === "site_visit_booked" ? "Site visit"
    : eventType === "email_sent" ? "Email"
    : "Entry";

  return (
    <div className="fixed inset-0 z-40 flex items-stretch justify-end bg-black/60" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-zinc-800 px-5 py-4">
          <div>
            <div className="text-sm text-zinc-500">Add activity</div>
            <div className="mt-0.5 text-base font-semibold text-zinc-100">Manual entry</div>
            <div className="mt-1 text-[11px] text-zinc-500">
              Saved to the reports <span className="text-zinc-400">and</span> this dashboard.
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded border border-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
          >
            Close
          </button>
        </div>

        <form className="flex-1 space-y-4 px-5 py-5" onSubmit={handleSubmit}>
          <Field label="Client">
            <select value={companyId} onChange={e => chooseCompany(e.target.value)} className={inputClass}>
              {companies.length === 0 && <option value="">— no clients —</option>}
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>

          <Field label="Sales person" hint={isAdmin ? "Empty = team (no exec attribution)." : "You can only add under your own name."}>
            <select value={salesPersonId} onChange={e => setSalesPersonId(e.target.value)} className={inputClass}>
              {isAdmin && <option value="">— (no exec / team) —</option>}
              {companyPeople.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              {companyPeople.length === 0 && <option value="">— none on this client —</option>}
            </select>
          </Field>

          <Field label="Date">
            <input type="date" required value={date} onChange={e => setDate(e.target.value)} className={inputClass} />
          </Field>

          <Field label="Event type">
            <select value={eventType} onChange={e => setEventType(e.target.value as EventType)} className={inputClass}>
              {EVENT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>

          {eventType === "quote_sent" && (
            <p className="rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-[11px] leading-relaxed text-zinc-400">
              Each row below is one quote. For a single quote with several options/tiers,
              put the values in the Value box separated by <code className="text-zinc-300">|</code> — they&apos;re averaged.
            </p>
          )}

          <div className="space-y-3">
            {items.map((it, i) => (
              <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                    {rowLabel} {items.length > 1 ? i + 1 : ""}
                  </span>
                  {items.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeItem(i)}
                      className="text-[11px] text-zinc-500 hover:text-red-300"
                    >
                      Remove
                    </button>
                  )}
                </div>

                <div className="space-y-3">
                  <Field label="Contact name">
                    <input
                      type="text"
                      value={it.contact_name}
                      onChange={e => patchItem(i, { contact_name: e.target.value })}
                      className={inputClass}
                    />
                  </Field>

                  {(eventType === "quote_sent" || eventType === "job_won") && (
                    <Field
                      label={eventType === "quote_sent" ? "Quote value(s)" : "Job value (incl. GST)"}
                      hint={eventType === "quote_sent" ? "Dollars, no symbols. Tiers separated by | (e.g. 1200|3500)." : "Dollars, no symbols. Used for commission calc."}
                    >
                      <input
                        type="text"
                        inputMode="decimal"
                        value={it.quote_job_value}
                        onChange={e => patchItem(i, { quote_job_value: e.target.value })}
                        className={inputClass}
                        placeholder={eventType === "quote_sent" ? "e.g. 4500 or 4500|6200" : "e.g. 12000"}
                      />
                    </Field>
                  )}

                  {eventType === "job_won" && (
                    <>
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
                            <span className="font-medium text-zinc-200">Team split</span>
                            <span className="mt-0.5 block text-[11px] text-zinc-500">
                              Split SE share equally across the roster on this client (2- or 3-person teams). Can combine with 50% charge.
                            </span>
                          </span>
                        </label>
                      </div>
                    </>
                  )}

                  {eventType === "site_visit_booked" && (
                    <Field label="Appointment date/time">
                      <input
                        type="datetime-local"
                        value={it.appointment_at}
                        onChange={e => patchItem(i, { appointment_at: e.target.value })}
                        className={inputClass}
                      />
                    </Field>
                  )}

                  {eventType === "email_sent" && (
                    <Field label="Subject">
                      <input
                        type="text"
                        value={it.outcome}
                        onChange={e => patchItem(i, { outcome: e.target.value })}
                        className={inputClass}
                      />
                    </Field>
                  )}

                  {eventType === "eod_update" && (
                    <Field label="Outcome" hint="Pipe-delimited: leadType | answer | action | notes | source">
                      <input
                        type="text"
                        value={it.outcome}
                        onChange={e => patchItem(i, { outcome: e.target.value })}
                        className={`${inputClass} font-mono text-[12px]`}
                      />
                    </Field>
                  )}

                  {(eventType === "quote_sent" || eventType === "job_won" || eventType === "site_visit_booked") && (
                    <Field label="Address" hint="Optional.">
                      <input
                        type="text"
                        value={it.contact_address}
                        onChange={e => patchItem(i, { contact_address: e.target.value })}
                        className={inputClass}
                      />
                    </Field>
                  )}

                  {(eventType === "quote_sent" || eventType === "job_won" || eventType === "eod_update") && (
                    <Field label="Lead source" hint="Optional.">
                      <input
                        type="text"
                        value={it.ad_source}
                        onChange={e => patchItem(i, { ad_source: e.target.value })}
                        className={inputClass}
                        placeholder="e.g. Facebook Ad Form"
                      />
                    </Field>
                  )}

                  {eventType === "site_visit_booked" && (
                    <Field label="Comment" hint="Optional.">
                      <input
                        type="text"
                        value={it.outcome}
                        onChange={e => patchItem(i, { outcome: e.target.value })}
                        className={inputClass}
                      />
                    </Field>
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

          {error && (
            <div className="rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-zinc-800 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              className="rounded border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:border-zinc-700 hover:text-zinc-200 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending || companies.length === 0}
              className="rounded bg-emerald-600/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
            >
              {pending ? "Saving…" : `Add ${items.length > 1 ? items.length + " activities" : "activity"}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
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
