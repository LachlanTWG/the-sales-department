// /visits — Site Visits calendar. Month or week view of booked site visits;
// click a day to drill into every visit that day. Search looks up a contact /
// address / exec across all dates (not just the visible month) so you can
// tell who booked a visit. Reads site_visit_booked activities live
// (RLS-scoped); no dedicated table. Defaults to the viewer's own visits,
// with filters for a specific exec / company. Search with no person filter
// expands to everyone.

import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getViewer, requireRosterOrAdmin } from "@/lib/viewer";
import { listCompanies } from "@/lib/queries";
import { todayInTz, SYDNEY_TZ } from "@/lib/format";
import { mondayOf, addDaysIso, monthLabel, shortDate } from "@/lib/dates";
import { loadSiteVisits, searchSiteVisits, type SiteVisit } from "@/lib/siteVisits";
import { SiteVisitsCalendar, VisitSearchResults, type CalendarVisit } from "./SiteVisitsCalendar";

export const dynamic = "force-dynamic";

type View = "month" | "week";
type SearchParams = {
  view?: string;
  date?: string;
  person?: string;
  company?: string;
  q?: string;
};

function pad2(n: number) { return String(n).padStart(2, "0"); }

/** Last calendar day of the month containing `dateStr`. */
function monthEndOf(dateStr: string): string {
  const [y, m] = dateStr.split("-").map(Number);
  const nextMonthStart = m === 12 ? `${y + 1}-01-01` : `${y}-${pad2(m + 1)}-01`;
  return addDaysIso(nextMonthStart, -1);
}
/** First day of the previous / next month relative to `dateStr`. */
function shiftMonth(dateStr: string, dir: -1 | 1): string {
  const [y, m] = dateStr.split("-").map(Number);
  const total = y * 12 + (m - 1) + dir;
  return `${Math.floor(total / 12)}-${pad2((total % 12) + 1)}-01`;
}

export default async function VisitsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const view: View = sp.view === "week" ? "week" : "month";

  const viewer = await getViewer();
  requireRosterOrAdmin(viewer);
  const supabase = await createClient();

  // Who am I (for the "My visits" default scope)
  const { data: mineRows } = await supabase
    .from("sales_people")
    .select("id")
    .eq("user_id", viewer.user.id);
  const mySalesPersonIds = (mineRows || []).map(r => r.id as string);
  const isRoster = mySalesPersonIds.length > 0;

  const today = todayInTz(SYDNEY_TZ);
  const anchor = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;

  // Resolve the visible grid + the period it represents.
  let gridStart: string, gridEnd: string, periodStart: string, periodEnd: string, title: string;
  let prevDate: string, nextDate: string;
  if (view === "week") {
    periodStart = mondayOf(anchor);
    periodEnd = addDaysIso(periodStart, 6);
    gridStart = periodStart;
    gridEnd = periodEnd;
    title = `${shortDate(periodStart)} – ${shortDate(periodEnd)}`;
    prevDate = addDaysIso(periodStart, -7);
    nextDate = addDaysIso(periodStart, 7);
  } else {
    const monthStart = `${anchor.slice(0, 7)}-01`;
    periodStart = monthStart;
    periodEnd = monthEndOf(monthStart);
    gridStart = mondayOf(monthStart);
    gridEnd = addDaysIso(mondayOf(periodEnd), 6);
    title = monthLabel(monthStart);
    prevDate = shiftMonth(monthStart, -1);
    nextDate = shiftMonth(monthStart, 1);
  }

  // Scope: person filter → ids; default = mine (roster) or everyone (pure admin).
  // Search is the "whose visit is this?" path, so an unset person filter
  // expands to everyone — otherwise you'd only ever find your own bookings.
  const personParam = sp.person || "";
  const companyParam = sp.company || "";
  const qParam = (sp.q || "").trim();
  const searching = qParam.length > 0;
  let scopeIds: string[] | null;
  if (personParam === "all") scopeIds = null;
  else if (personParam) scopeIds = [personParam];
  else scopeIds = searching ? null : (isRoster ? mySalesPersonIds : null);
  const searchExpandedToEveryone = searching && !personParam && isRoster;

  // Companies first (React.cache'd, cheap) — the loader needs each client's tz
  // to correct appointment times before bucketing.
  const companies = await listCompanies(supabase);
  const companyById = new Map(companies.map(c => [c.id, c.name] as const));
  const companyTzById = new Map(companies.map(c => [c.id, c.timezone] as const));

  const { data: peopleRows } = await supabase.from("sales_people").select("id, name, company_id").order("name");
  const salesPeople = (peopleRows || []) as { id: string; name: string; company_id: string }[];
  const personById = new Map(salesPeople.map(p => [p.id, p.name] as const));

  const loaded = searching
    ? await searchSiteVisits(supabase, {
        query: qParam,
        salesPersonIds: scopeIds,
        companyId: companyParam || undefined,
        companyTzById,
        companies,
        salesPeople,
      })
    : { visits: await loadSiteVisits(supabase, { gridStart, gridEnd, salesPersonIds: scopeIds, companyId: companyParam || undefined, companyTzById }), capped: false };
  const visits = loaded.visits;
  const searchCapped = loaded.capped;

  const periodVisits = visits.filter(v => v.dayKey >= periodStart && v.dayKey <= periodEnd);
  const totalCount = searching ? visits.length : periodVisits.length;
  const tbcCount = (searching ? visits : periodVisits).filter(v => !v.scheduled).length;
  const virtualCount = (searching ? visits : periodVisits).filter(v => v.virtual).length;

  // Preserve filters across nav/view links.
  function href(overrides: Partial<SearchParams>) {
    const u = new URLSearchParams();
    const merged: SearchParams = { view, date: anchor, person: personParam, company: companyParam, q: qParam, ...overrides };
    if (merged.view && merged.view !== "month") u.set("view", merged.view);
    if (merged.date && merged.date !== today) u.set("date", merged.date);
    if (merged.person) u.set("person", merged.person);
    if (merged.company) u.set("company", merged.company);
    if (merged.q) u.set("q", merged.q);
    const qs = u.toString();
    return qs ? `/visits?${qs}` : "/visits";
  }

  const segBtn = (active: boolean) =>
    `px-3 py-1.5 text-xs font-medium transition-colors ${
      active ? "bg-zinc-800 text-zinc-50" : "text-zinc-400 hover:text-zinc-200"
    }`;
  const navBtn = "rounded border border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300 hover:border-zinc-700 hover:text-zinc-100";

  return (
    <div className="px-6 py-6 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Site visits</h1>
          <p className="mt-0.5 text-sm text-zinc-500">
            {searching
              ? searchExpandedToEveryone
                ? `Matches for “${qParam}” across everyone’s booked site visits.`
                : `Matches for “${qParam}”.`
              : personParam === "all"
                ? "All booked site visits."
                : personParam
                  ? `${salesPeople.find(p => p.id === personParam)?.name || "Exec"}'s booked site visits.`
                  : isRoster ? "Your booked site visits." : "All booked site visits."}
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold tabular-nums text-zinc-100">{totalCount}{searchCapped ? "+" : ""}</div>
          <div className="text-xs text-zinc-500">
            {searching
              ? `match${totalCount === 1 ? "" : "es"}`
              : `visit${totalCount === 1 ? "" : "s"} · ${title}`}
            {virtualCount > 0 && <span className="text-violet-400/80"> · {virtualCount} virtual</span>}
            {tbcCount > 0 && <span className="text-amber-400/80"> · {tbcCount} time TBC</span>}
          </div>
        </div>
      </header>

      {/* Controls */}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        {!searching && (
          <>
            {/* View toggle */}
            <div className="inline-flex overflow-hidden rounded-lg border border-zinc-800">
              <Link href={href({ view: "month" })} className={segBtn(view === "month")}>Month</Link>
              <Link href={href({ view: "week" })} className={segBtn(view === "week")}>Week</Link>
            </div>

            {/* Date nav */}
            <div className="flex items-center gap-1.5">
              <Link href={href({ date: prevDate })} className={navBtn} aria-label="Previous">←</Link>
              <Link href={href({ date: today })} className={navBtn}>Today</Link>
              <Link href={href({ date: nextDate })} className={navBtn} aria-label="Next">→</Link>
              <span className="ml-1 text-sm font-medium text-zinc-200">{title}</span>
            </div>
          </>
        )}

        {/* Filters + search */}
        <form action="/visits" method="get" className={`${searching ? "" : "ml-auto"} flex flex-wrap items-center gap-2`}>
          <input type="hidden" name="view" value={view} />
          <input type="hidden" name="date" value={anchor} />
          <input
            type="search"
            name="q"
            defaultValue={qParam}
            placeholder="Search contact, address, exec…"
            aria-label="Search site visits"
            className={`${selectClass} w-56`}
          />
          <select
            name="person"
            defaultValue={searchExpandedToEveryone ? "all" : personParam}
            className={selectClass}
          >
            {isRoster && <option value="">My visits</option>}
            <option value="all">Everyone</option>
            {salesPeople.map(p => (
              <option key={p.id} value={p.id}>
                {p.name} ({companyById.get(p.company_id) ?? "?"})
              </option>
            ))}
          </select>
          <select name="company" defaultValue={companyParam} className={selectClass}>
            <option value="">All companies</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button type="submit" className="rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-100 hover:bg-zinc-700">
            Search
          </button>
          {searching && (
            <Link href={href({ q: "" })} className="text-xs text-zinc-400 hover:text-zinc-200">
              Clear
            </Link>
          )}
        </form>
      </div>

      {/* Search results or calendar */}
      <div className="mt-5">
        {searching ? (
          <VisitSearchResults
            query={qParam}
            capped={searchCapped}
            companies={(viewer.seesAll
              ? companies
              : companies.filter(c => viewer.companyIds.includes(c.id))
            ).map(c => ({ id: c.id, name: c.name }))}
            salesPeople={salesPeople}
            visits={visits.map(v => decorateVisit(v, { companyById, personById, viewerIsAdmin: viewer.isAdmin, mySalesPersonIds }))}
          />
        ) : (
          <SiteVisitsCalendar
            view={view}
            gridStart={gridStart}
            gridEnd={gridEnd}
            periodStart={periodStart}
            periodEnd={periodEnd}
            today={today}
            companies={(viewer.seesAll
              ? companies
              : companies.filter(c => viewer.companyIds.includes(c.id))
            ).map(c => ({ id: c.id, name: c.name }))}
            salesPeople={salesPeople}
            visits={visits.map(v => decorateVisit(v, { companyById, personById, viewerIsAdmin: viewer.isAdmin, mySalesPersonIds }))}
          />
        )}
      </div>
    </div>
  );
}

function decorateVisit(
  v: SiteVisit,
  opts: {
    companyById: Map<string, string>;
    personById: Map<string, string>;
    viewerIsAdmin: boolean;
    mySalesPersonIds: string[];
  },
): CalendarVisit {
  return {
    ...v,
    companyName: opts.companyById.get(v.companyId) ?? "—",
    // Prefer the live id→name join so a freshly reassigned exec shows
    // correctly even before the denormalized column catches up.
    execName: (v.salesPersonId && opts.personById.get(v.salesPersonId)) || v.salesPersonName,
    canEdit: opts.viewerIsAdmin || (!!v.salesPersonId && opts.mySalesPersonIds.includes(v.salesPersonId)),
  };
}

const selectClass =
  "rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 focus:border-zinc-600 focus:outline-none";
