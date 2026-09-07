"use client";

// The interactive calendar surface. The server hands us every visit in the
// visible grid (already bucketed into Sydney `dayKey` + `timeLabel`), so day
// selection and the detail drawer are pure client state — no refetch when you
// click around within a month. Prev/next/view changes are server <Link>s
// (handled by the page) because they change which data is loaded.

import { useState } from "react";
import { addDaysIso } from "@/lib/dates";
import { EditDrawer, type ActivityRowForEdit, type CompanyOption, type SalesPersonOption } from "../activities/EditDrawer";

export type CalendarVisit = {
  id: string;
  companyId: string;
  companyName: string;
  salesPersonId: string | null;
  salesPersonName: string;
  execName: string;               // resolved display name (id→name join, else denormalized)
  canEdit: boolean;               // viewer may edit this row (admin or owns it)
  contactName: string;
  contactAddress: string;
  contactId: string | null;
  adSource: string;
  outcome: string;
  quoteJobValue: string;
  appointmentAt: string | null;
  occurredOn: string;
  dayKey: string;
  timeLabel: string;              // Sydney time (the unified view)
  localTimeLabel: string | null;  // time in the company's own tz, when it differs
  localCity: string | null;       // e.g. "Perth"
  scheduled: boolean;
  sortMs: number;
  virtual?: boolean;
};

const DAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAY_HEADERS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function ymd(dateStr: string): { dow: number; day: number; month: number } {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return { dow: dt.getUTCDay(), day: dt.getUTCDate(), month: m };
}
function longHeading(dateStr: string): string {
  const { dow, day, month } = ymd(dateStr);
  return `${DAYS_LONG[dow]} ${day} ${MONTHS_LONG[month - 1]}`;
}

function daysInRange(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = start;
  while (cur <= end) { out.push(cur); cur = addDaysIso(cur, 1); }
  return out;
}

export function SiteVisitsCalendar({
  view,
  gridStart,
  gridEnd,
  periodStart,
  periodEnd,
  today,
  visits,
  companies,
  salesPeople,
}: {
  view: "month" | "week";
  gridStart: string;
  gridEnd: string;
  periodStart: string;
  periodEnd: string;
  today: string;
  visits: CalendarVisit[];
  companies: CompanyOption[];
  salesPeople: SalesPersonOption[];
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<CalendarVisit | null>(null);

  // Bucket visits by day.
  const byDay = new Map<string, CalendarVisit[]>();
  for (const v of visits) {
    const arr = byDay.get(v.dayKey);
    if (arr) arr.push(v); else byDay.set(v.dayKey, [v]);
  }

  const days = daysInRange(gridStart, gridEnd);
  const weeks: string[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));

  const selectedVisits = selected ? (byDay.get(selected) || []) : [];

  const maxChips = view === "week" ? 8 : 3;

  return (
    <>
      <div className="overflow-hidden rounded-xl border border-zinc-800">
        {/* Weekday header */}
        <div className="grid grid-cols-[repeat(7,minmax(0,1fr))_3.25rem] border-b border-zinc-800 bg-zinc-900/50 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
          {WEEKDAY_HEADERS.map(d => (
            <div key={d} className="px-2 py-2 text-center">{d}</div>
          ))}
          <div className="px-2 py-2 text-center text-zinc-600">Wk</div>
        </div>

        {/* Weeks */}
        {weeks.map((week, wi) => {
          const weekTotal = week.reduce((s, d) => s + (byDay.get(d)?.length || 0), 0);
          return (
            <div
              key={wi}
              className={`grid grid-cols-[repeat(7,minmax(0,1fr))_3.25rem] ${wi < weeks.length - 1 ? "border-b border-zinc-800" : ""}`}
            >
              {week.map(day => {
                const dayVisits = byDay.get(day) || [];
                const { day: dnum } = ymd(day);
                const inPeriod = day >= periodStart && day <= periodEnd;
                const isToday = day === today;
                const isSelected = day === selected;
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => setSelected(day)}
                    className={`group flex flex-col gap-1 border-r border-zinc-800/70 p-1.5 text-left align-top transition-colors last:border-r-0 ${
                      view === "week" ? "min-h-[14rem]" : "min-h-[6.5rem]"
                    } ${inPeriod ? "" : "bg-zinc-950/60"} ${
                      isSelected ? "bg-sky-950/30 ring-1 ring-inset ring-sky-700/50" : "hover:bg-zinc-900/50"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs tabular-nums ${
                          isToday ? "bg-sky-600 font-semibold text-white" : inPeriod ? "text-zinc-300" : "text-zinc-600"
                        }`}
                      >
                        {dnum}
                      </span>
                      {dayVisits.length > 0 && (
                        <span className="rounded bg-zinc-800 px-1.5 text-[10px] font-medium tabular-nums text-zinc-300">
                          {dayVisits.length}
                        </span>
                      )}
                    </div>

                    <div className="flex flex-col gap-0.5">
                      {dayVisits.slice(0, maxChips).map(v => (
                        <span
                          key={v.id}
                          className={`truncate rounded px-1 py-0.5 text-[11px] leading-tight ${
                            v.virtual
                              ? "bg-violet-950/50 text-violet-200/90"
                              : v.scheduled
                                ? "bg-sky-950/50 text-sky-200/90"
                                : "bg-amber-950/40 text-amber-200/90"
                          }`}
                          title={`${v.timeLabel} Sydney${v.localTimeLabel ? ` · ${v.localTimeLabel} ${v.localCity}` : ""} · ${v.contactName}${v.execName ? ` · ${v.execName}` : ""}${v.virtual ? " · Virtual" : ""}`}
                        >
                          <span className="tabular-nums opacity-70">{v.timeLabel}</span> {v.contactName}
                          {v.virtual ? <span className="ml-0.5 text-[10px] opacity-70">V</span> : null}
                        </span>
                      ))}
                      {dayVisits.length > maxChips && (
                        <span className="px-1 text-[10px] text-zinc-500">+{dayVisits.length - maxChips} more</span>
                      )}
                    </div>
                  </button>
                );
              })}
              {/* Week total */}
              <div className="flex items-center justify-center border-l border-zinc-800/70 text-sm tabular-nums text-zinc-500">
                {weekTotal > 0 ? weekTotal : <span className="text-zinc-700">·</span>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Day detail drawer */}
      {selected && (
        <DayDrawer
          day={selected}
          visits={selectedVisits}
          onClose={() => setSelected(null)}
          onEdit={setEditing}
        />
      )}

      {/* Edit drawer (reuses the Activities editor) — stacks above the day panel */}
      {editing && (
        <EditDrawer
          row={toEditRow(editing)}
          companies={companies}
          salesPeople={salesPeople}
          canDelete={editing.canEdit}
          currentCompanyName={editing.companyName}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function toEditRow(v: CalendarVisit): ActivityRowForEdit {
  return {
    id: v.id,
    occurred_on: v.occurredOn,
    sales_person_id: v.salesPersonId,
    sales_person_name: v.salesPersonName,
    event_type: "site_visit_booked",
    contact_name: v.contactName,
    contact_address: v.contactAddress,
    outcome: v.outcome,
    quote_job_value: v.quoteJobValue,
    appointment_at: v.appointmentAt,
    company_id: v.companyId,
  };
}

function DayDrawer({ day, visits, onClose, onEdit }: { day: string; visits: CalendarVisit[]; onClose: () => void; onEdit: (v: CalendarVisit) => void }) {
  const scheduled = visits.filter(v => v.scheduled).length;
  const tbc = visits.length - scheduled;
  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true">
      {/* Overlay */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      {/* Panel */}
      <div className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl">
        <div className="flex items-start justify-between border-b border-zinc-800 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">{longHeading(day)}</h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              {visits.length} site visit{visits.length === 1 ? "" : "s"}
              {visits.filter(x => x.virtual).length > 0 && (
                <span className="text-violet-400/80"> · {visits.filter(x => x.virtual).length} virtual</span>
              )}
              {tbc > 0 && <span className="text-amber-400/80"> · {tbc} time TBC</span>}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {visits.length === 0 ? (
            <div className="py-16 text-center text-sm text-zinc-500">No site visits booked this day.</div>
          ) : (
            <ul className="flex flex-col gap-3">
              {visits.map(v => <VisitCard key={v.id} v={v} onEdit={onEdit} />)}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export function VisitSearchResults({
  query,
  visits,
  capped,
  companies,
  salesPeople,
}: {
  query: string;
  visits: CalendarVisit[];
  capped: boolean;
  companies: CompanyOption[];
  salesPeople: SalesPersonOption[];
}) {
  const [editing, setEditing] = useState<CalendarVisit | null>(null);

  const groups: { day: string; visits: CalendarVisit[] }[] = [];
  for (const v of visits) {
    const last = groups[groups.length - 1];
    if (last && last.day === v.dayKey) last.visits.push(v);
    else groups.push({ day: v.dayKey, visits: [v] });
  }

  return (
    <>
      {visits.length === 0 ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 px-5 py-16 text-center text-sm text-zinc-500">
          No site visits match “{query}”.
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {capped && (
            <p className="text-xs text-amber-400/80">
              Showing the {visits.length} most recent matches. Narrow the search if the visit you want isn’t here.
            </p>
          )}
          {groups.map(g => (
            <section key={g.day}>
              <h2 className="mb-2 text-sm font-medium text-zinc-300">{longHeading(g.day)}</h2>
              <ul className="flex flex-col gap-3">
                {g.visits.map(v => (
                  <VisitCard key={v.id} v={v} onEdit={setEditing} emphasizeExec />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {editing && (
        <EditDrawer
          row={toEditRow(editing)}
          companies={companies}
          salesPeople={salesPeople}
          canDelete={editing.canEdit}
          currentCompanyName={editing.companyName}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function VisitCard({ v, onEdit, emphasizeExec }: { v: CalendarVisit; onEdit: (v: CalendarVisit) => void; emphasizeExec?: boolean }) {
  const mapsHref = v.contactAddress
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.contactAddress)}`
    : null;
  return (
    <li className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex items-center justify-between gap-2">
        {/* Time(s): unified Sydney time, plus the visit's own local time when it differs */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={`rounded px-1.5 py-0.5 text-xs font-medium tabular-nums ${
              v.scheduled ? "bg-sky-950/60 text-sky-200" : "bg-amber-950/50 text-amber-200"
            }`}
          >
            {v.timeLabel}
            {v.localTimeLabel && <span className="ml-1 font-normal text-sky-300/60">Sydney</span>}
          </span>
          {v.virtual && (
            <span className="rounded bg-violet-950/60 px-1.5 py-0.5 text-xs font-medium text-violet-200">
              Virtual
            </span>
          )}
          {v.localTimeLabel && (
            <span className="rounded bg-emerald-950/50 px-1.5 py-0.5 text-xs font-medium tabular-nums text-emerald-200">
              {v.localTimeLabel} <span className="font-normal text-emerald-300/60">{v.localCity}</span>
            </span>
          )}
        </div>
        <span className="truncate text-xs text-zinc-500">{v.companyName}</span>
      </div>

      <div className="mt-2 text-sm font-medium text-zinc-100">{v.contactName}</div>

      {v.contactAddress ? (
        <a
          href={mapsHref!}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-0.5 block text-sm text-sky-400/90 hover:text-sky-300 hover:underline"
        >
          {v.contactAddress}
        </a>
      ) : (
        <div className="mt-0.5 text-sm text-zinc-600">No address on file</div>
      )}

      <div className="mt-2 flex items-end justify-between gap-2">
        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
          <div className="flex gap-1">
            <dt className="text-zinc-600">Exec:</dt>
            <dd className={emphasizeExec ? "font-medium text-zinc-100" : "text-zinc-400"}>{v.execName}</dd>
          </div>
          {v.adSource && (
            <div className="flex gap-1">
              <dt className="text-zinc-600">Source:</dt>
              <dd className="text-zinc-400">{v.adSource}</dd>
            </div>
          )}
        </dl>
        {v.canEdit && (
          <button
            type="button"
            onClick={() => onEdit(v)}
            className="shrink-0 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-600 hover:text-zinc-100"
          >
            Edit
          </button>
        )}
      </div>
    </li>
  );
}
