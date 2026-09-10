"use client";

// Shared site-visit field section — used by both entry points:
//
//   1. Pending-banner "Log site visit" form (activePending !== null)
//      · Previous quotes, sales-person select, vertical fields, sendSlack checkbox
//      · Date/time are read-only (shown in parent's AutoRow card)
//      · GHL appointment already exists → no create-GHL checkbox
//
//   2. EOD-3 "Book Site Visit" outcome section (quotieKind === "site_visit")
//      · Date / time / address / team-member / create-GHL checkbox are rendered
//        by the PARENT (EodEntryForm), which passes them as children via the
//        `extraFields` slot. The shared fields rendered here are the vertical
//        fields + sendSlack checkbox.
//
// `sendSlack` defaults true on every mount (no localStorage persistence).

import type { PreviousQuote } from "./data";
import { formatAuNzDate } from "./data";

// Zinc inputClass — matches the rest of the EOD form.
const inputClass =
  "w-full rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600";

// ─── Sub-components ────────────────────────────────────────────────────────

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-medium uppercase tracking-wider text-zinc-400">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint && <p className="mt-1 text-[10px] text-zinc-500">{hint}</p>}
    </label>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────

export type SiteVisitSectionProps = {
  /** "roofing" renders rough-value/ideal-start/details; "solar" renders comment. */
  vertical: "roofing" | "solar";

  // ── Vertical fields ──────────────────────────────────────────────────
  /** Roofing only. */
  rough: string;
  onRoughChange: (v: string) => void;
  /**
   * Whether rough job value is required (HTML `required` attr + hint text).
   * Pending-banner path: true (roofing). EOD-3 path: false (optional).
   */
  roughRequired?: boolean;
  /** Roofing only. */
  idealStart: string;
  onIdealStartChange: (v: string) => void;
  /** Shared "Details / comment" — roofing or solar. */
  comment: string;
  onCommentChange: (v: string) => void;

  // ── Send-Slack checkbox (NEW) ────────────────────────────────────────
  /** Controlled — parent initialises to `true` and resets to `true` on open. */
  sendSlack: boolean;
  onSendSlackChange: (v: boolean) => void;

  // ── Optional: previous quotes (pending-banner path) ──────────────────
  previousQuotes?: PreviousQuote[];
  quotesLoading?: boolean;

  // ── Optional: sales-person select (pending-banner path) ──────────────
  salesPerson?: string;
  people?: string[];
  onSalesPersonChange?: (name: string) => void;

  // ── Optional: extra fields slot (EOD-3 path) ─────────────────────────
  /** Rendered above the vertical fields. Use for date/time/address/team/GHL. */
  extraFields?: React.ReactNode;
};

// ─── Component ────────────────────────────────────────────────────────────

export function SiteVisitSection({
  vertical,
  rough,
  onRoughChange,
  roughRequired = false,
  idealStart,
  onIdealStartChange,
  comment,
  onCommentChange,
  sendSlack,
  onSendSlackChange,
  previousQuotes,
  quotesLoading,
  salesPerson,
  people,
  onSalesPersonChange,
  extraFields,
}: SiteVisitSectionProps) {
  const showPrevQuotes = previousQuotes !== undefined;
  const showSalesPerson = salesPerson !== undefined && people !== undefined && onSalesPersonChange !== undefined;

  return (
    <>
      {/* Sales person — pending-banner path only */}
      {showSalesPerson && (
        <Field label="Sales person">
          <select
            value={salesPerson}
            onChange={e => onSalesPersonChange!(e.target.value)}
            className={inputClass}
          >
            {people!.map(p => <option key={p} value={p}>{p}</option>)}
            {salesPerson && !people!.includes(salesPerson) && (
              <option value={salesPerson}>{salesPerson}</option>
            )}
            <option value="">— team —</option>
          </select>
        </Field>
      )}

      {/* Previous quotes — pending-banner path only */}
      {showPrevQuotes && (
        <div className="rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2">
          <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            Previous quotes
          </div>
          {quotesLoading && previousQuotes!.length === 0 ? (
            <p className="mt-1 text-[12px] text-zinc-500">
              Loading previous quotes…
            </p>
          ) : previousQuotes!.length === 0 ? (
            <p className="mt-1 text-[12px] text-zinc-500">
              No previous quote has been sent.
            </p>
          ) : (
            <ul className="mt-1.5 space-y-1">
              {previousQuotes!.map((q, i) => (
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
      )}

      {/* Extra fields slot — EOD-3 path (date/time/address/team/GHL checkbox) */}
      {extraFields}

      {/* Vertical-specific fields */}
      {vertical === "roofing" ? (
        <>
          <Field
            label="Rough job value (incl. GST)"
            hint={roughRequired ? "Required — dollars, no symbols." : "Optional — dollars, no symbols."}
          >
            <input
              type="text"
              inputMode="decimal"
              required={roughRequired}
              value={rough}
              onChange={e => onRoughChange(e.target.value)}
              className={inputClass}
              placeholder="e.g. 12000"
            />
          </Field>
          <Field label="Ideal start date">
            <select
              value={idealStart}
              onChange={e => onIdealStartChange(e.target.value)}
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
              value={comment}
              onChange={e => onCommentChange(e.target.value)}
              className={inputClass}
              placeholder="Anything the crew should know"
            />
          </Field>
        </>
      ) : (
        <Field label="Comment" hint="Optional — notes for the Slack summary.">
          <input
            type="text"
            value={comment}
            onChange={e => onCommentChange(e.target.value)}
            className={inputClass}
            placeholder="Anything worth noting"
          />
        </Field>
      )}

      {/* Send Slack checkbox — default checked every open, no sticky memory */}
      <label className="flex items-start gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={sendSlack}
          onChange={e => onSendSlackChange(e.target.checked)}
          className="mt-0.5 rounded border-zinc-600 bg-zinc-900"
        />
        <span>
          <span className="font-medium text-zinc-200">Send Slack summary</span>
          <span className="mt-0.5 block text-[11px] text-zinc-500">
            Post the booking details to Slack. Activity log and Quotie booking always run.
          </span>
        </span>
      </label>
    </>
  );
}
