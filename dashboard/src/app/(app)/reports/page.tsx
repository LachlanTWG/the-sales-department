import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getViewer } from "@/lib/viewer";
import { listCompanies } from "@/lib/queries";
import { loadBacklog } from "@/lib/analytics";
import { loadCompanyLiveReports, type CompanyLiveReport, type ReportFormat } from "@/lib/messages";
import { formatCurrency, todayInTz, SYDNEY_TZ } from "@/lib/format";
import { mondayOf, shiftPeriodAnchor, lastCompletedSatFri } from "@/lib/dates";
import { LiveRefresh } from "@/components/LiveRefresh";

export const dynamic = "force-dynamic";

const FORMATS: { key: ReportFormat; label: string; hint: string }[] = [
  { key: "summary", label: "Summary", hint: "Performance report: calls, revenue pipeline, jobs won, lead sources, attrition." },
  { key: "detailed", label: "Detailed", hint: "EOD-style breakdown with per-contact names, quote lines and the full site-visit list." },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string; from?: string; to?: string; format?: string }>;
}) {
  const params = await searchParams;
  const viewer = await getViewer();
  const supabase = await createClient();
  const canSeeTeam = viewer.seesAll;

  const today = todayInTz(SYDNEY_TZ);
  const [y, m] = today.split("-").map(Number);
  const monthStart = `${today.slice(0, 8)}01`;

  // Range: custom from/to, defaulting to the current month-to-date.
  let from = DATE_RE.test(params.from || "") ? params.from! : monthStart;
  let to = DATE_RE.test(params.to || "") ? params.to! : today;
  if (from > to) [from, to] = [to, from];

  const format: ReportFormat = params.format === "detailed" ? "detailed" : "summary";
  const companyFilter = params.company || "";

  const companies = await listCompanies(supabase);
  const selectedCompany = companies.find(c => c.slug === companyFilter);
  const targetCompanies = selectedCompany ? [selectedCompany] : companies;

  // Live reports — computed straight from `activities` for the chosen range.
  // 100% Postgres: no Google Sheets, no stored snapshots.
  const liveReports = (await Promise.all(
    targetCompanies.map(c => loadCompanyLiveReports(supabase, { companyId: c.id, start: from, end: to, format })),
  )).filter((r): r is CompanyLiveReport => r !== null);

  // Backlog data alongside (RLS-scoped automatically)
  const { openQuotes, pendingVisits } = await loadBacklog(supabase);
  const filteredOpenQuotes = selectedCompany
    ? openQuotes.filter(q => q.company_id === selectedCompany.id)
    : openQuotes;
  const filteredPendingVisits = selectedCompany
    ? pendingVisits.filter(v => v.company_id === selectedCompany.id)
    : pendingVisits;
  const openValue = filteredOpenQuotes.reduce((s, q) => s + q.last_event_value, 0);

  // Quick-range presets (each preserves the current company + format).
  const qStart = `${y}-${pad2((Math.ceil(m / 3) - 1) * 3 + 1)}-01`;
  const prevMonthAnchor = shiftPeriodAnchor("month", today, -1);
  const prevMonthLast = `${prevMonthAnchor.slice(0, 8)}${pad2(new Date(Date.UTC(y, m - 1, 0)).getUTCDate())}`;
  const lastWeek = lastCompletedSatFri(today);
  const presets: { label: string; from: string; to: string }[] = [
    { label: "Today", from: today, to: today },
    { label: "This week", from: mondayOf(today), to: today },
    { label: "Last week", from: lastWeek.from, to: lastWeek.to },
    { label: "This month", from: monthStart, to: today },
    { label: "Last month", from: prevMonthAnchor, to: prevMonthLast },
    { label: "This quarter", from: qStart, to: today },
    { label: "This year", from: `${y}-01-01`, to: today },
  ];

  const rangeLabel = from === to ? prettyDate(from) : `${prettyDate(from)} – ${prettyDate(to)}`;

  return (
    <div className="px-8 py-6 space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Reports</h1>
          <p className="mt-0.5 text-sm text-zinc-500">
            Computed live from the activity database — no Google Sheets, no snapshots. Edits and
            deletions are reflected immediately.{" "}
            {canSeeTeam ? "All clients." : "Your reports only."}
          </p>
        </div>
        <LiveRefresh fetchedAtIso={new Date().toISOString()} />
      </header>

      {/* Filters — a single GET form so the whole thing is server-rendered. */}
      <form key={`${from}-${to}-${companyFilter}-${format}`} action="/reports" method="get" className="flex flex-wrap items-end gap-3">
        <Field label="Client">
          <select name="company" defaultValue={companyFilter} className={selectClass}>
            <option value="">All clients</option>
            {companies.map(c => (
              <option key={c.id} value={c.slug}>{c.name}</option>
            ))}
          </select>
        </Field>
        <Field label="From">
          <input type="date" name="from" defaultValue={from} max={today} className={inputClass} />
        </Field>
        <Field label="To">
          <input type="date" name="to" defaultValue={to} max={today} className={inputClass} />
        </Field>
        <Field label="Summarise as">
          <select name="format" defaultValue={format} className={selectClass}>
            {FORMATS.map(f => (
              <option key={f.key} value={f.key}>{f.label}</option>
            ))}
          </select>
        </Field>
        <button
          type="submit"
          className="rounded-md border border-zinc-700 bg-zinc-800 px-4 py-1.5 text-xs font-medium text-zinc-100 hover:bg-zinc-700"
        >
          Apply
        </button>
      </form>

      {/* Quick ranges */}
      <div className="flex flex-wrap items-center gap-2">
        {presets.map(p => {
          const active = p.from === from && p.to === to;
          return (
            <Link
              key={p.label}
              href={buildHref({ company: companyFilter, from: p.from, to: p.to, format })}
              className={`rounded-md border px-3 py-1.5 text-xs transition-colors ${
                active
                  ? "border-zinc-600 bg-zinc-800 text-zinc-100"
                  : "border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {p.label}
            </Link>
          );
        })}
        <span className="ml-1 text-[11px] text-zinc-500">
          Showing {rangeLabel} · {FORMATS.find(f => f.key === format)?.label}
        </span>
      </div>

      {/* Live reports */}
      <section className="space-y-6">
        {liveReports.length === 0 && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-6 py-10 text-center text-sm text-zinc-500">
            No companies visible.
          </div>
        )}
        {liveReports.map(report => {
          const people = canSeeTeam
            ? report.people
            : report.people.filter(p => p.name === viewer.salesPersonName);
          const cards = [
            ...(canSeeTeam && report.team ? [report.team] : []),
            ...people,
          ];
          const anyActivity = cards.some(c => c.hasActivity);
          return (
            <div key={report.company.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-5">
              <div className="flex items-baseline justify-between">
                <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-300">
                  {report.company.name} · {rangeLabel}
                </h2>
                <span className="text-[11px] text-zinc-500">live from activity data</span>
              </div>

              {!anyActivity ? (
                <div className="mt-4 text-sm text-zinc-500">
                  No activity recorded for this range.
                </div>
              ) : (
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  {cards.map(c => (
                    <div key={c.name} className="rounded border border-zinc-800 bg-zinc-950/40 p-4">
                      <div className="mb-2 flex items-baseline justify-between">
                        {c.name === "Team" ? (
                          <span className="text-[10px] uppercase tracking-wider text-zinc-500">{c.name}</span>
                        ) : (
                          <Link
                            href={`/execs/${encodeURIComponent(c.name)}?from=${from}&to=${to}`}
                            className="text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
                          >
                            {c.name}
                          </Link>
                        )}
                        {!c.hasActivity && <span className="text-[10px] text-zinc-600">no activity</span>}
                      </div>
                      {c.hasActivity ? (
                        <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-zinc-200">
                          {c.message}
                        </pre>
                      ) : (
                        <div className="text-xs text-zinc-600">No activity for {c.name} in this range.</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </section>

      {/* Backlog summary */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-300">
            Backlog {selectedCompany ? `· ${selectedCompany.name}` : ""}
          </h2>
          <Link href="/backlog" className="text-xs text-zinc-500 hover:text-zinc-300">Open full backlog →</Link>
        </div>
        <div className="mt-4 grid gap-3 grid-cols-3">
          <Stat label="Open quotes" value={filteredOpenQuotes.length} />
          <Stat label="Open quote value" value={formatCurrency(openValue)} accent />
          <Stat label="Pending site visits" value={filteredPendingVisits.length} />
        </div>
        {filteredOpenQuotes.length > 0 && (
          <div className="mt-4 max-h-48 overflow-y-auto divide-y divide-zinc-800">
            {filteredOpenQuotes.slice(0, 10).map(q => (
              <div key={`${q.company_id}-${q.contact_id}`} className="flex items-center justify-between gap-3 py-1.5 text-xs">
                <div className="min-w-0 flex-1 truncate">
                  <span className="text-zinc-200">{q.contact_name || "—"}</span>
                  <span className="text-zinc-500"> · {q.company_name} · {q.sales_person_name}</span>
                </div>
                <div className="shrink-0 text-right">
                  <span className="tabular-nums text-emerald-400">{formatCurrency(q.last_event_value)}</span>
                  <span className="ml-2 tabular-nums text-zinc-500">{q.days_open}d</span>
                </div>
              </div>
            ))}
            {filteredOpenQuotes.length > 10 && (
              <div className="py-1.5 text-center text-[11px] text-zinc-600">… +{filteredOpenQuotes.length - 10} more</div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

const selectClass = "rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs text-zinc-100 focus:border-zinc-600 focus:outline-none";
const inputClass = "rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs text-zinc-100 focus:border-zinc-600 focus:outline-none";

function pad2(n: number) { return String(n).padStart(2, "0"); }

/** "2026-06-01" → "1 Jun 2026" */
function prettyDate(dateStr: string): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [yy, mm, dd] = dateStr.split("-").map(Number);
  return `${dd} ${months[mm - 1]} ${yy}`;
}

function buildHref(opts: { company: string; from: string; to: string; format: string }): string {
  const params = new URLSearchParams();
  if (opts.company) params.set("company", opts.company);
  params.set("from", opts.from);
  params.set("to", opts.to);
  params.set("format", opts.format);
  return `/reports?${params.toString()}`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</span>
      {children}
    </label>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2">
      <div className={`text-lg font-semibold tabular-nums ${accent ? "text-emerald-400" : "text-zinc-100"}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
    </div>
  );
}
