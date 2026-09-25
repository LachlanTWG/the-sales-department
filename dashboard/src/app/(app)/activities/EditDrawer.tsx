"use client";

// Edit drawer for a single activity row. Submits via server actions (see
// ./actions.ts). RLS enforces who can edit what at the database layer; this
// component just exposes the fields.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { commitEodOutcome } from "@/lib/eodOutcome";
import { editActivity, deleteActivity } from "./actions";
import { OutcomeFields } from "./OutcomeFields";

const EVENT_TYPES = [
  { value: "eod_update",        label: "EOD update" },
  { value: "quote_sent",        label: "Quote sent" },
  { value: "site_visit_booked", label: "Site visit booked" },
  { value: "email_sent",        label: "Email sent" },
  { value: "job_won",           label: "Job won" },
] as const;

export type ActivityRowForEdit = {
  id: string;
  occurred_on: string;
  sales_person_id: string | null;
  sales_person_name: string;
  event_type: string;
  contact_name: string | null;
  contact_address: string | null;
  outcome: string | null;
  quote_job_value: string | null;
  appointment_at: string | null;
  company_id: string;
};

export type CompanyOption = { id: string; name: string; ownerName?: string | null };
export type SalesPersonOption = { id: string; name: string; company_id: string };

export function EditDrawer({
  row,
  onClose,
  companies,
  salesPeople,
  canDelete,
  currentCompanyName,
}: {
  row: ActivityRowForEdit;
  onClose: () => void;
  companies: CompanyOption[];
  salesPeople: SalesPersonOption[];
  canDelete: boolean;
  currentCompanyName?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [form, setForm] = useState({
    company_id: row.company_id,
    occurred_on: row.occurred_on,
    sales_person_id: row.sales_person_id || "",
    event_type: row.event_type,
    outcome: row.outcome || "",
    contact_name: row.contact_name || "",
    contact_address: row.contact_address || "",
    quote_job_value: row.quote_job_value || "",
    appointment_at: row.appointment_at ? row.appointment_at.slice(0, 16) : "",
  });

  const companyOptions = companies.some(c => c.id === row.company_id)
    ? companies
    : [{ id: row.company_id, name: currentCompanyName || "Current company" }, ...companies];
  const companyPeople = salesPeople.filter(sp => sp.company_id === form.company_id);
  const selectedCompany = companyOptions.find(c => c.id === form.company_id);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const eod = form.event_type === "eod_update"
      ? commitEodOutcome(form.outcome, {
          ownerName: selectedCompany?.ownerName,
          companyName: selectedCompany?.name || currentCompanyName,
        })
      : null;
    startTransition(async () => {
      const res = await editActivity({
        id: row.id,
        company_id: form.company_id,
        occurred_on: form.occurred_on,
        sales_person_id: form.sales_person_id || null,
        event_type: form.event_type as ActivityRowForEdit["event_type"] as "eod_update" | "quote_sent" | "site_visit_booked" | "email_sent" | "job_won",
        outcome: eod ? eod.outcome : form.outcome,
        ad_source: eod ? (eod.source || null) : undefined,
        contact_name: form.contact_name,
        contact_address: form.contact_address,
        quote_job_value: form.quote_job_value,
        appointment_at: form.appointment_at,
      });
      if (!res.ok) { setError(res.error); return; }
      router.refresh();
      onClose();
    });
  }

  function handleDelete() {
    setError(null);
    startTransition(async () => {
      const res = await deleteActivity(row.id);
      if (!res.ok) { setError(res.error); return; }
      router.refresh();
      onClose();
    });
  }

  return (
    <div className="fixed inset-0 z-40 flex items-stretch justify-end bg-black/60" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-zinc-800 px-5 py-4">
          <div>
            <div className="text-sm text-zinc-500">Edit activity</div>
            <div className="mt-0.5 truncate text-base font-semibold text-zinc-100">
              {row.contact_name || "—"}
            </div>
            <div className="mt-0.5 text-xs text-zinc-500">id: {row.id.slice(0, 8)}…</div>
          </div>
          <button
            onClick={onClose}
            className="rounded border border-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
          >
            Close
          </button>
        </div>

        <form className="flex-1 space-y-4 px-5 py-5" onSubmit={handleSubmit}>
          <Field label="Company" hint="Changing company clears the sales person — pick someone on the new client.">
            <select
              value={form.company_id}
              onChange={e => setForm(f => ({ ...f, company_id: e.target.value, sales_person_id: "" }))}
              className={inputClass}
            >
              {companyOptions.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>

          <Field label="Date">
            <input
              type="date"
              required
              value={form.occurred_on}
              onChange={e => setForm(f => ({ ...f, occurred_on: e.target.value }))}
              className={inputClass}
            />
          </Field>

          <Field label="Sales person" hint="Empty = team-only (no exec attribution).">
            <select
              value={form.sales_person_id}
              onChange={e => setForm(f => ({ ...f, sales_person_id: e.target.value }))}
              className={inputClass}
            >
              <option value="">— (no exec / team) —</option>
              {companyPeople.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {row.sales_person_name && !form.sales_person_id && companyPeople.length === 0 && (
              <p className="mt-1 text-[11px] text-zinc-500">
                Current name: <span className="text-zinc-300">{row.sales_person_name}</span> (no roster match)
              </p>
            )}
          </Field>

          <Field label="Event type">
            <select
              value={form.event_type}
              onChange={e => setForm(f => ({ ...f, event_type: e.target.value }))}
              className={inputClass}
            >
              {EVENT_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </Field>

          <Field label="Contact name">
            <input
              type="text"
              value={form.contact_name}
              onChange={e => setForm(f => ({ ...f, contact_name: e.target.value }))}
              className={inputClass}
            />
          </Field>

          <Field label="Contact address">
            <input
              type="text"
              value={form.contact_address}
              onChange={e => setForm(f => ({ ...f, contact_address: e.target.value }))}
              className={inputClass}
            />
          </Field>

          {form.event_type === "eod_update" ? (
            <OutcomeFields
              value={form.outcome}
              onChange={outcome => setForm(f => ({ ...f, outcome }))}
              ownerName={selectedCompany?.ownerName}
              companyName={selectedCompany?.name || currentCompanyName}
              inputClass={inputClass}
            />
          ) : (
            <Field label="Outcome">
              <input
                type="text"
                value={form.outcome}
                onChange={e => setForm(f => ({ ...f, outcome: e.target.value }))}
                className={inputClass}
              />
            </Field>
          )}

          <Field label="Quote / job value" hint="Pipe-delimited dollars, no symbols (e.g. 1200|3500).">
            <input
              type="text"
              value={form.quote_job_value}
              onChange={e => setForm(f => ({ ...f, quote_job_value: e.target.value }))}
              className={inputClass}
            />
          </Field>

          <Field label="Appointment date/time" hint="Only relevant for site visits.">
            <input
              type="datetime-local"
              value={form.appointment_at}
              onChange={e => setForm(f => ({ ...f, appointment_at: e.target.value }))}
              className={inputClass}
            />
          </Field>

          {error && (
            <div className="rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between border-t border-zinc-800 pt-4">
            {canDelete ? (
              confirmingDelete ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-400">Delete this row?</span>
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={pending}
                    className="rounded border border-red-900/50 bg-red-950/20 px-3 py-1.5 text-xs text-red-300 hover:border-red-800 hover:bg-red-900/30 disabled:opacity-50"
                  >
                    {pending ? "Deleting…" : "Confirm delete"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(false)}
                    disabled={pending}
                    className="rounded border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:border-zinc-700 hover:text-zinc-200 disabled:opacity-50"
                  >
                    No
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  disabled={pending}
                  className="rounded border border-red-900/50 bg-red-950/20 px-3 py-1.5 text-xs text-red-300 hover:border-red-800 hover:bg-red-900/30 disabled:opacity-50"
                >
                  Delete row
                </button>
              )
            ) : <span />}
            <div className="flex items-center gap-2">
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
                disabled={pending}
                className="rounded bg-emerald-600/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
              >
                {pending ? "Saving…" : "Save"}
              </button>
            </div>
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
