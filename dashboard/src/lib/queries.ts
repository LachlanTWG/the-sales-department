// Server-side data access. All functions take a Supabase client that already
// has the user's session, so RLS naturally scopes results to what they can see.

import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BETA_COMPANIES, isBeta } from "./beta";
import { quoteGroupValue, todayInTz } from "./format";
import {
  mondayOf, addDaysIso, businessDaysBetween,
  bucketKey, bucketLabel, trendBucketKeys, periodRange,
  type Period, type PeriodRange,
} from "./dates";

// PostgREST caps responses at db-max-rows (1000 by default). Analytics
// windows easily exceed this; page in chunks transparently.
const PAGE_SIZE = 1000;
async function pageAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
}

export type CompanyRow = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  active: boolean;
  owner_name?: string | null;
};

export type ActivityRow = {
  id: string;
  company_id: string;
  sales_person_id: string | null;
  sales_person_name: string;
  occurred_on: string;
  event_type: string;
  contact_name: string | null;
  outcome: string | null;
  quote_job_value: string | null;
  created_at: string;
};

export type EventCounts = {
  eod_update: number;
  quote_sent: number;
  job_won: number;
  site_visit_booked: number;
  email_sent: number;
  job_won_value: number;
};

export type CompanyKpis = {
  company: CompanyRow;
  today: string;                          // YYYY-MM-DD in company TZ
  weekStart: string;                      // Monday in company TZ
  weekToDate: Record<string, EventCounts>; // including __team__
  todayCounts: EventCounts;                // team totals for today only
  lastActivityAt: string | null;
  spark: number[];                        // last 14 days, total activity count
};

function emptyCounts(): EventCounts {
  return {
    eod_update: 0, quote_sent: 0, job_won: 0,
    site_visit_booked: 0, email_sent: 0, job_won_value: 0,
  };
}

function bumpCounts(bucket: EventCounts, eventType: string, quoteJobValue: string | null) {
  if (eventType === "eod_update") bucket.eod_update++;
  else if (eventType === "quote_sent") bucket.quote_sent++;
  else if (eventType === "site_visit_booked") bucket.site_visit_booked++;
  else if (eventType === "email_sent") bucket.email_sent++;
  else if (eventType === "job_won") {
    bucket.job_won++;
    bucket.job_won_value += quoteGroupValue(quoteJobValue);
  }
}

// Calendar-date helpers live in ./dates — imported at the top.

// Memoized per request: the overview alone calls this from several loaders
// (overview, recent feed, …) that share one supabase client, so React.cache
// collapses those identical company lookups into a single round-trip.
export const listCompanies = cache(async function listCompanies(
  supabase: SupabaseClient,
): Promise<CompanyRow[]> {
  if (isBeta()) return BETA_COMPANIES;

  const { data, error } = await supabase
    .from("companies")
    .select("id, name, slug, timezone, active, owner_name")
    .eq("active", true)
    .order("name");
  if (error) throw error;
  return data || [];
});

/**
 * For each company the user can see, return this-week-to-date KPIs (per
 * active exec + team), today's team total, last activity timestamp, and a
 * 14-day activity sparkline.
 */
export async function loadCompanyKpis(supabase: SupabaseClient): Promise<CompanyKpis[]> {
  const companies = await listCompanies(supabase);
  return Promise.all(companies.map(c => loadOneCompanyKpis(supabase, c)));
}

async function loadOneCompanyKpis(
  supabase: SupabaseClient,
  company: CompanyRow,
): Promise<CompanyKpis> {
  const today = todayInTz(company.timezone);
  const weekStart = mondayOf(today);
  const sparkStart = addDaysIso(today, -13);

  // Pull 14 days of activity (covers sparkline + this week + today). Few
  // hundred rows max per company per fortnight, aggregating in JS keeps the
  // SQL simple.
  const rows = await pageAll<Pick<ActivityRow, "event_type" | "sales_person_id" | "sales_person_name" | "occurred_on" | "quote_job_value" | "created_at">>((from, to) =>
    supabase
      .from("activities")
      .select("event_type, sales_person_id, sales_person_name, occurred_on, quote_job_value, created_at")
      .eq("company_id", company.id)
      .gte("occurred_on", sparkStart)
      .lte("occurred_on", today)
      .order("created_at", { ascending: false })
      .range(from, to)
  );

  // Per-exec week-to-date counts + today team total
  const weekToDate: Record<string, EventCounts> = { __team__: emptyCounts() };
  const todayCounts: EventCounts = emptyCounts();
  let lastAt: string | null = null;

  for (const r of rows) {
    if (!lastAt || r.created_at > lastAt) lastAt = r.created_at;

    if (r.occurred_on >= weekStart && r.occurred_on <= today) {
      // Team includes everyone (owners, ad-hoc activity).
      bumpCounts(weekToDate.__team__, r.event_type, r.quote_job_value);
      // Per-exec breakdown is roster-only — skip rows without a sales_person_id
      // (owners, unknown, one-offs).
      if (r.sales_person_id) {
        const exec = (weekToDate[r.sales_person_name] ||= emptyCounts());
        bumpCounts(exec, r.event_type, r.quote_job_value);
      }
    }
    if (r.occurred_on === today) {
      bumpCounts(todayCounts, r.event_type, r.quote_job_value);
    }
  }

  // 14-day sparkline (total activity per day)
  const spark: number[] = Array(14).fill(0);
  for (const r of rows) {
    const idx = Math.floor(
      (new Date(r.occurred_on + "T00:00:00").getTime()
        - new Date(sparkStart + "T00:00:00").getTime()) / 86400000
    );
    if (idx >= 0 && idx < 14) spark[idx]++;
  }

  return { company, today, weekStart, weekToDate, todayCounts, lastActivityAt: lastAt, spark };
}

/* ─── Overview-wide aggregates ─────────────────────────────────────── */

export type OverviewTotals = {
  thisWeek: EventCounts;
  lastWeek: EventCounts;
  openQuoteCount: number;
  openQuoteValue: number;
  pendingVisitCount: number;
  staleCompanies: number;             // companies with no activity in 48h
};

export type WeeklyTrend = {
  week_start: string;
  activity_count: number;
  won_value: number;
  wins: number;
}[];

export type ExecWeeklyRank = {
  name: string;
  revenue: number;
  wins: number;
  quotes: number;
  activities: number;
  companies: { id: string; name: string; slug: string }[];
};

export type RecentEvent = {
  id: string;
  company_id: string;
  company_name: string;
  company_slug: string;
  sales_person_name: string;
  event_type: string;
  contact_name: string | null;
  outcome: string | null;
  quote_job_value: string | null;
  created_at: string;
};

export type CompanyBacklogSummary = {
  company_id: string;
  open_quotes: number;
  open_quote_value: number;
  pending_visits: number;
};

/**
 * Cross-company totals for this week + last week (for the trend arrow),
 * plus current backlog counts and stale-company count.
 */
export async function loadOverviewTotals(supabase: SupabaseClient): Promise<OverviewTotals> {
  const companies = await listCompanies(supabase);
  const activeIds = companies.map(c => c.id);
  if (activeIds.length === 0) {
    return {
      thisWeek: emptyCounts(), lastWeek: emptyCounts(),
      openQuoteCount: 0, openQuoteValue: 0, pendingVisitCount: 0, staleCompanies: 0,
    };
  }

  // Pull last 21 days of activity for active companies — enough for this
  // week + last week buckets.
  const today = todayInTz("Australia/Sydney");
  const startIso = addDaysIso(today, -20);
  const thisWeekStart = mondayOf(today);
  const lastWeekStart = addDaysIso(thisWeekStart, -7);
  const lastWeekEnd = addDaysIso(thisWeekStart, -1);

  const rows = await pageAll<{
    event_type: string;
    occurred_on: string;
    quote_job_value: string | null;
    company_id: string;
    created_at: string;
  }>((from, to) =>
    supabase
      .from("activities")
      .select("event_type, occurred_on, quote_job_value, company_id, created_at")
      .gte("occurred_on", startIso)
      .in("company_id", activeIds)
      .range(from, to),
  );

  const thisWeek = emptyCounts();
  const lastWeek = emptyCounts();
  const lastSeenByCompany = new Map<string, string>();   // company_id -> latest created_at

  for (const r of rows) {
    if (r.occurred_on >= thisWeekStart && r.occurred_on <= today) {
      bumpCounts(thisWeek, r.event_type, r.quote_job_value);
    } else if (r.occurred_on >= lastWeekStart && r.occurred_on <= lastWeekEnd) {
      bumpCounts(lastWeek, r.event_type, r.quote_job_value);
    }
    const prev = lastSeenByCompany.get(r.company_id);
    if (!prev || r.created_at > prev) lastSeenByCompany.set(r.company_id, r.created_at);
  }

  // Backlog snapshot — open quotes / pending visits (180-day lookback for
  // "open" candidates, then resolve by latest event per contact).
  const backlogSince = new Date(Date.now() - 180 * 86400_000).toISOString().slice(0, 10);
  const bgRows = await pageAll<{
    contact_id: string;
    company_id: string;
    event_type: string;
    quote_job_value: string | null;
    created_at: string;
  }>((from, to) =>
    supabase
      .from("activities")
      .select("contact_id, company_id, event_type, quote_job_value, created_at")
      .gte("occurred_on", backlogSince)
      .not("contact_id", "is", null)
      .in("company_id", activeIds)
      .order("created_at", { ascending: false })
      .range(from, to),
  );

  type Last = { event_type: string; value: number };
  const latest = new Map<string, Last>();
  const hasWin = new Map<string, boolean>();
  for (const r of bgRows) {
    const key = `${r.company_id}|${r.contact_id}`;
    if (!latest.has(key)) {
      latest.set(key, { event_type: r.event_type, value: quoteGroupValue(r.quote_job_value) });
    }
    if (r.event_type === "job_won") hasWin.set(key, true);
  }
  let openQuoteCount = 0, openQuoteValue = 0, pendingVisitCount = 0;
  for (const [key, last] of latest.entries()) {
    if (hasWin.get(key)) continue;
    if (last.event_type === "quote_sent") {
      openQuoteCount++;
      openQuoteValue += last.value;
    } else if (last.event_type === "site_visit_booked") {
      pendingVisitCount++;
    }
  }

  // Stale companies: no activity in last 48h
  const stalenessCutoff = Date.now() - 48 * 3600 * 1000;
  let staleCompanies = 0;
  for (const c of companies) {
    const last = lastSeenByCompany.get(c.id);
    if (!last || new Date(last).getTime() < stalenessCutoff) staleCompanies++;
  }

  return { thisWeek, lastWeek, openQuoteCount, openQuoteValue, pendingVisitCount, staleCompanies };
}

/**
 * Combined activity + revenue per ISO week (Mon-start) across all active
 * companies, last `weeks` weeks ending on the current week.
 */
export async function loadCombinedWeeklyTrend(
  supabase: SupabaseClient,
  weeks = 12,
): Promise<WeeklyTrend> {
  const activeIds = (await listCompanies(supabase)).map(c => c.id);
  if (activeIds.length === 0) return [];

  const todayStr = todayInTz("Australia/Sydney");
  const startIso = addDaysIso(todayStr, -(weeks * 7 + 7));      // small buffer

  const rows = await pageAll<{
    event_type: string;
    occurred_on: string;
    quote_job_value: string | null;
  }>((from, to) =>
    supabase
      .from("activities")
      .select("event_type, occurred_on, quote_job_value")
      .gte("occurred_on", startIso)
      .in("company_id", activeIds)
      .range(from, to),
  );

  const buckets = new Map<string, { activity_count: number; won_value: number; wins: number }>();
  for (const r of rows) {
    const wk = mondayOf(r.occurred_on);
    const b = buckets.get(wk) || { activity_count: 0, won_value: 0, wins: 0 };
    b.activity_count++;
    if (r.event_type === "job_won") {
      b.wins++;
      b.won_value += quoteGroupValue(r.quote_job_value);
    }
    buckets.set(wk, b);
  }

  // Always emit exactly `weeks` buckets, including zeros, ending on the
  // current week.
  const currentMonday = mondayOf(todayStr);
  const out: WeeklyTrend = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const wk = addDaysIso(currentMonday, -i * 7);
    const b = buckets.get(wk) || { activity_count: 0, won_value: 0, wins: 0 };
    out.push({ week_start: wk, ...b });
  }
  return out;
}

/**
 * Mini leaderboard for the current ISO week, roster execs only, ordered by
 * activity volume (so even pre-revenue weeks aren't all zeros).
 */
export async function loadWeekExecLeaderboard(supabase: SupabaseClient): Promise<ExecWeeklyRank[]> {
  const companies = await listCompanies(supabase);
  const activeIds = companies.map(c => c.id);
  if (activeIds.length === 0) return [];
  const companyById = new Map(companies.map(c => [c.id, c]));

  const todayStr = todayInTz("Australia/Sydney");
  const startIso = mondayOf(todayStr);

  const rows = await pageAll<{
    sales_person_name: string;
    sales_person_id: string;
    company_id: string;
    event_type: string;
    quote_job_value: string | null;
  }>((from, to) =>
    supabase
      .from("activities")
      .select("sales_person_name, sales_person_id, company_id, event_type, quote_job_value")
      .gte("occurred_on", startIso)
      .in("company_id", activeIds)
      .not("sales_person_id", "is", null)
      .range(from, to),
  );

  const byExec = new Map<string, ExecWeeklyRank>();
  for (const r of rows) {
    const name = r.sales_person_name;
    let e = byExec.get(name);
    if (!e) {
      e = { name, revenue: 0, wins: 0, quotes: 0, activities: 0, companies: [] };
      byExec.set(name, e);
    }
    e.activities++;
    if (r.event_type === "job_won") {
      e.wins++;
      e.revenue += quoteGroupValue(r.quote_job_value);
    } else if (r.event_type === "quote_sent") {
      e.quotes++;
    }
    const co = companyById.get(r.company_id);
    if (co && !e.companies.find(c => c.id === co.id)) {
      e.companies.push({ id: co.id, name: co.name, slug: co.slug });
    }
  }

  return Array.from(byExec.values())
    .sort((a, b) => b.revenue - a.revenue || b.activities - a.activities);
}

/**
 * Cross-company recent activity feed — newest first.
 */
export async function loadRecentActivityFeed(
  supabase: SupabaseClient,
  limit = 15,
): Promise<RecentEvent[]> {
  const companies = await listCompanies(supabase);
  const activeIds = companies.map(c => c.id);
  if (activeIds.length === 0) return [];
  const companyById = new Map(companies.map(c => [c.id, c]));

  const { data, error } = await supabase
    .from("activities")
    .select("id, company_id, sales_person_name, event_type, contact_name, outcome, quote_job_value, created_at")
    .in("company_id", activeIds)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(r => {
    const co = companyById.get(r.company_id);
    return {
      ...r,
      company_name: co?.name || "?",
      company_slug: co?.slug || "",
    };
  });
}

/**
 * Per-company backlog summary for the dense company cards.
 */
export async function loadCompanyBacklogMap(supabase: SupabaseClient): Promise<Map<string, CompanyBacklogSummary>> {
  const out = new Map<string, CompanyBacklogSummary>();
  const activeIds = (await listCompanies(supabase)).map(c => c.id);
  if (activeIds.length === 0) return out;

  const since = new Date(Date.now() - 180 * 86400_000).toISOString().slice(0, 10);
  const rows = await pageAll<{
    contact_id: string;
    company_id: string;
    event_type: string;
    quote_job_value: string | null;
    created_at: string;
  }>((from, to) =>
    supabase
      .from("activities")
      .select("contact_id, company_id, event_type, quote_job_value, created_at")
      .gte("occurred_on", since)
      .not("contact_id", "is", null)
      .in("company_id", activeIds)
      .order("created_at", { ascending: false })
      .range(from, to),
  );

  type Last = { event_type: string; value: number };
  const latest = new Map<string, Last>();
  const hasWin = new Map<string, boolean>();
  for (const r of rows) {
    const key = `${r.company_id}|${r.contact_id}`;
    if (!latest.has(key)) {
      latest.set(key, { event_type: r.event_type, value: quoteGroupValue(r.quote_job_value) });
    }
    if (r.event_type === "job_won") hasWin.set(key, true);
  }

  for (const id of activeIds) {
    out.set(id, { company_id: id, open_quotes: 0, open_quote_value: 0, pending_visits: 0 });
  }
  for (const [key, last] of latest.entries()) {
    if (hasWin.get(key)) continue;
    const companyId = key.split("|")[0];
    const slot = out.get(companyId);
    if (!slot) continue;
    if (last.event_type === "quote_sent") {
      slot.open_quotes++;
      slot.open_quote_value += last.value;
    } else if (last.event_type === "site_visit_booked") {
      slot.pending_visits++;
    }
  }

  return out;
}

/* ─── Period-based overview aggregator ─────────────────────────────── */

export type PeriodMetrics = {
  revenue: number;          // sum of won quote_job_value
  pipeline: number;         // open quote value (180d open contacts)
  pipelineCount: number;    // open quote count
  calls: number;            // count of eod_update (== customer actions)
  quotes: number;           // count of quote_sent events
  visits: number;           // count of site_visit_booked
  wins: number;             // count of job_won
  emails: number;           // count of email_sent
  peopleQuoted: number;     // distinct contacts with quote_sent in period
  peopleWorked: number;     // distinct contacts with any event in period
  avgDeal: number;          // revenue / wins (0 if no wins)
  closeRate: number;        // wins / quotes (0..1)
  callToQuote: number;      // quotes / calls (0..1)
};

function emptyMetrics(): PeriodMetrics {
  return {
    revenue: 0, pipeline: 0, pipelineCount: 0,
    calls: 0, quotes: 0, visits: 0, wins: 0, emails: 0,
    peopleQuoted: 0, peopleWorked: 0,
    avgDeal: 0, closeRate: 0, callToQuote: 0,
  };
}

type DistinctSets = {
  worked: Set<string>;
  quoted: Set<string>;
};

function emptyDistinct(): DistinctSets {
  return { worked: new Set(), quoted: new Set() };
}

function finalise(m: PeriodMetrics, d: DistinctSets) {
  m.peopleWorked = d.worked.size;
  m.peopleQuoted = d.quoted.size;
  m.avgDeal = m.wins > 0 ? m.revenue / m.wins : 0;
  m.closeRate = m.quotes > 0 ? m.wins / m.quotes : 0;
  m.callToQuote = m.calls > 0 ? m.quotes / m.calls : 0;
}

function bumpMetrics(m: PeriodMetrics, d: DistinctSets, r: {
  event_type: string;
  quote_job_value: string | null;
  contact_id: string | null;
}) {
  if (r.event_type === "eod_update") m.calls++;
  else if (r.event_type === "quote_sent") m.quotes++;
  else if (r.event_type === "site_visit_booked") m.visits++;
  else if (r.event_type === "email_sent") m.emails++;
  else if (r.event_type === "job_won") {
    m.wins++;
    m.revenue += quoteGroupValue(r.quote_job_value);
  }
  if (r.contact_id) {
    d.worked.add(r.contact_id);
    if (r.event_type === "quote_sent") d.quoted.add(r.contact_id);
  }
}

export type OverviewClient = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  current: PeriodMetrics;
  previous: PeriodMetrics;
  lastActivityAt: string | null;
  // Business-day denominators for per-day averages — based on the entity's
  // first activity in each window, so a new client doesn't get penalised for
  // not being active the whole period.
  currentActiveDays: number;
  previousActiveDays: number;
};

export type OverviewExec = {
  name: string;
  companies: { id: string; name: string; slug: string }[];
  current: PeriodMetrics;
  previous: PeriodMetrics;
  currentActiveDays: number;
  previousActiveDays: number;
};

export type OverviewTrendPoint = {
  key: string;
  label: string;
  revenue: number;
  wins: number;
  calls: number;
  quotes: number;
  activities: number;
};

export type WinRow = {
  id: string;
  company_id: string;
  company_name: string;
  company_slug: string;
  sales_person_name: string;
  contact_name: string | null;
  value: number;
  occurred_on: string;
  created_at: string;
};

export type SourceStat = {
  source: string;
  quotes: number;
  wins: number;
  revenue: number;
  closeRate: number;     // wins / quotes
};

export type OutcomeStat = {
  outcome: string;
  n: number;
};

/**
 * Per-open-quote detail used to build value-bucket histograms. Pipeline
 * aging (chase-list) lives in Quotie, not here, so no contact name / days
 * open are needed downstream.
 */
type PipelineItem = {
  company_id: string;
  value: number;
};

export type MatrixCell = {
  exec: string;
  company_id: string;
  revenue: number;
  activities: number;
  wins: number;
};

export type HeatmapDay = {
  date: string;
  count: number;
};

export type ProductivityRow = {
  name: string;
  activitiesPerDay: number;
  totalActivities: number;
  workingDays: number;
};

export type ValueBucket = {
  label: string;
  min: number;
  max: number | null;
  count: number;
  value: number;
};

export type OverviewByPeriod = {
  range: PeriodRange;
  totals: { current: PeriodMetrics; previous: PeriodMetrics };
  perClient: OverviewClient[];
  perExec: OverviewExec[];
  trend: OverviewTrendPoint[];
  wins: WinRow[];                       // every win in the period
  sources: SourceStat[];                // top sources by activity, with conv
  outcomes: OutcomeStat[];              // top EOD outcomes
  matrix: MatrixCell[];                 // exec × client revenue+activity
  heatmap: HeatmapDay[];                // last 90 days of activity counts
  productivity: ProductivityRow[];      // per-exec activities/business-day
  valueBuckets: ValueBucket[];          // open-quote value distribution
};

/**
 * Single pass that fetches all the data the overview needs for a given
 * period, with previous-period comparison and a 12-bucket trend chart.
 *
 * Approach: pull every row in the union of (trend window, current, previous)
 * once — that's the widest window — and aggregate in JS. Pipeline (open quote
 * value) is a separate 180-day "latest event per contact" scan because it's
 * a current-state question, not a period-bounded one.
 */
export async function loadOverviewByPeriod(
  supabase: SupabaseClient,
  period: Period,
): Promise<OverviewByPeriod> {
  const companies = await listCompanies(supabase);
  const activeIds = companies.map(c => c.id);
  const companyById = new Map(companies.map(c => [c.id, c]));

  const today = todayInTz("Australia/Sydney");
  const range = periodRange(period, today);
  const trendKeys = trendBucketKeys(period, today);

  if (activeIds.length === 0) {
    return {
      range,
      totals: { current: emptyMetrics(), previous: emptyMetrics() },
      perClient: [],
      perExec: [],
      trend: trendKeys.map(k => ({
        key: k,
        label: bucketLabel(k, range.bucketBy),
        revenue: 0, wins: 0, calls: 0, quotes: 0, activities: 0,
      })),
      wins: [],
      sources: [],
      outcomes: [],
      matrix: [],
      heatmap: [],
      productivity: [],
      valueBuckets: [],
    };
  }

  // Furthest-back date we need to pull: min of (period prev start, trend
  // window start). For trend keys we compute the earliest bucket's start
  // date by parsing the key.
  const earliestTrend = trendBucketEarliestDate(trendKeys[0], range.bucketBy);
  const fetchStart = range.prevStart < earliestTrend ? range.prevStart : earliestTrend;

  const rows = await pageAll<{
    id: string;
    company_id: string;
    sales_person_id: string | null;
    sales_person_name: string;
    event_type: string;
    outcome: string | null;
    ad_source: string | null;
    occurred_on: string;
    quote_job_value: string | null;
    contact_id: string | null;
    contact_name: string | null;
    created_at: string;
  }>((from, to) =>
    supabase
      .from("activities")
      .select("id, company_id, sales_person_id, sales_person_name, event_type, outcome, ad_source, occurred_on, quote_job_value, contact_id, contact_name, created_at")
      .gte("occurred_on", fetchStart)
      .lte("occurred_on", today)
      .in("company_id", activeIds)
      .range(from, to),
  );

  // Top-level totals (current + previous)
  const totals = {
    current: emptyMetrics(),
    previous: emptyMetrics(),
  };
  const totalsDistinct = {
    current: emptyDistinct(),
    previous: emptyDistinct(),
  };

  // Per-client buckets
  type ClientBuckets = {
    current: PeriodMetrics; previous: PeriodMetrics;
    cDistinct: DistinctSets; pDistinct: DistinctSets;
    lastActivityAt: string | null;
    firstSeenCurrent: string | null;
    firstSeenPrevious: string | null;
  };
  const perClient = new Map<string, ClientBuckets>();
  for (const c of companies) {
    perClient.set(c.id, {
      current: emptyMetrics(), previous: emptyMetrics(),
      cDistinct: emptyDistinct(), pDistinct: emptyDistinct(),
      lastActivityAt: null,
      firstSeenCurrent: null, firstSeenPrevious: null,
    });
  }

  // Per-exec buckets (roster only — sales_person_id NOT NULL)
  type ExecBuckets = {
    name: string;
    companies: Map<string, { id: string; name: string; slug: string }>;
    current: PeriodMetrics; previous: PeriodMetrics;
    cDistinct: DistinctSets; pDistinct: DistinctSets;
    firstSeenCurrent: string | null;
    firstSeenPrevious: string | null;
  };
  const perExec = new Map<string, ExecBuckets>();

  // Trend buckets (combined across all clients)
  const trendBuckets = new Map<string, OverviewTrendPoint>();
  for (const key of trendKeys) {
    trendBuckets.set(key, {
      key, label: bucketLabel(key, range.bucketBy),
      revenue: 0, wins: 0, calls: 0, quotes: 0, activities: 0,
    });
  }

  // ─── New aggregates (current period only unless noted) ──────────────
  const wins: WinRow[] = [];
  const sourceMap = new Map<string, { quotes: number; wins: number; revenue: number }>();
  const outcomeMap = new Map<string, number>();
  // Matrix key: `${execName}|${companyId}`
  const matrixMap = new Map<string, MatrixCell>();
  // Heatmap covers last 90 days regardless of period
  const heatmapMap = new Map<string, number>();
  const heatmapStart = addDaysIso(today, -89);

  // Helpers
  const cleanSource = (src: string | null) => {
    if (!src) return null;
    const t = src.trim();
    if (!t || t === "0") return null;
    if (/^\d+(\.\d+)?$/.test(t)) return null;     // pure number = bad data
    return t;
  };

  for (const r of rows) {
    const inCurrent = r.occurred_on >= range.start && r.occurred_on <= range.end;
    const inPrev = r.occurred_on >= range.prevStart && r.occurred_on <= range.prevEnd;

    if (inCurrent) {
      bumpMetrics(totals.current, totalsDistinct.current, r);
      const cb = perClient.get(r.company_id);
      if (cb) {
        bumpMetrics(cb.current, cb.cDistinct, r);
        if (!cb.firstSeenCurrent || r.occurred_on < cb.firstSeenCurrent) {
          cb.firstSeenCurrent = r.occurred_on;
        }
      }
      if (r.sales_person_id) {
        let e = perExec.get(r.sales_person_name);
        if (!e) {
          e = {
            name: r.sales_person_name, companies: new Map(),
            current: emptyMetrics(), previous: emptyMetrics(),
            cDistinct: emptyDistinct(), pDistinct: emptyDistinct(),
            firstSeenCurrent: null, firstSeenPrevious: null,
          };
          perExec.set(r.sales_person_name, e);
        }
        bumpMetrics(e.current, e.cDistinct, r);
        if (!e.firstSeenCurrent || r.occurred_on < e.firstSeenCurrent) {
          e.firstSeenCurrent = r.occurred_on;
        }
        const co = companyById.get(r.company_id);
        if (co && !e.companies.has(co.id)) {
          e.companies.set(co.id, { id: co.id, name: co.name, slug: co.slug });
        }
      }
    } else if (inPrev) {
      bumpMetrics(totals.previous, totalsDistinct.previous, r);
      const cb = perClient.get(r.company_id);
      if (cb) {
        bumpMetrics(cb.previous, cb.pDistinct, r);
        if (!cb.firstSeenPrevious || r.occurred_on < cb.firstSeenPrevious) {
          cb.firstSeenPrevious = r.occurred_on;
        }
      }
      if (r.sales_person_id) {
        let e = perExec.get(r.sales_person_name);
        if (!e) {
          e = {
            name: r.sales_person_name, companies: new Map(),
            current: emptyMetrics(), previous: emptyMetrics(),
            cDistinct: emptyDistinct(), pDistinct: emptyDistinct(),
            firstSeenCurrent: null, firstSeenPrevious: null,
          };
          perExec.set(r.sales_person_name, e);
        }
        bumpMetrics(e.previous, e.pDistinct, r);
        if (!e.firstSeenPrevious || r.occurred_on < e.firstSeenPrevious) {
          e.firstSeenPrevious = r.occurred_on;
        }
      }
    }

    // Last activity per client (uses created_at, not occurred_on — webhook
    // staleness is the question).
    const cb = perClient.get(r.company_id);
    if (cb) {
      if (!cb.lastActivityAt || r.created_at > cb.lastActivityAt) cb.lastActivityAt = r.created_at;
    }

    // Trend bucket
    const bk = bucketKey(r.occurred_on, range.bucketBy);
    const tb = trendBuckets.get(bk);
    if (tb) {
      tb.activities++;
      if (r.event_type === "eod_update") tb.calls++;
      else if (r.event_type === "quote_sent") tb.quotes++;
      else if (r.event_type === "job_won") {
        tb.wins++;
        tb.revenue += quoteGroupValue(r.quote_job_value);
      }
    }

    // Heatmap (last 90 days, regardless of selected period)
    if (r.occurred_on >= heatmapStart && r.occurred_on <= today) {
      heatmapMap.set(r.occurred_on, (heatmapMap.get(r.occurred_on) || 0) + 1);
    }

    // ─── In-period aggregates ─────────────────────────────────────────
    if (!inCurrent) continue;

    // Wins list
    if (r.event_type === "job_won") {
      const co = companyById.get(r.company_id);
      wins.push({
        id: r.id,
        company_id: r.company_id,
        company_name: co?.name || "?",
        company_slug: co?.slug || "",
        sales_person_name: r.sales_person_name,
        contact_name: r.contact_name,
        value: quoteGroupValue(r.quote_job_value),
        occurred_on: r.occurred_on,
        created_at: r.created_at,
      });
    }

    // Source attribution (skip blanks/junk)
    if (r.event_type === "quote_sent" || r.event_type === "job_won") {
      const src = cleanSource(r.ad_source);
      if (src) {
        const slot = sourceMap.get(src) || { quotes: 0, wins: 0, revenue: 0 };
        if (r.event_type === "quote_sent") slot.quotes++;
        else if (r.event_type === "job_won") {
          slot.wins++;
          slot.revenue += quoteGroupValue(r.quote_job_value);
        }
        sourceMap.set(src, slot);
      }
    }

    // Outcome distribution (EOD updates only)
    if (r.event_type === "eod_update" && r.outcome) {
      const head = r.outcome.split("|")[0].trim();
      if (head) outcomeMap.set(head, (outcomeMap.get(head) || 0) + 1);
    }

    // Matrix (exec × client). Roster execs only.
    if (r.sales_person_id) {
      const mKey = `${r.sales_person_name}|${r.company_id}`;
      const cell = matrixMap.get(mKey) || {
        exec: r.sales_person_name,
        company_id: r.company_id,
        revenue: 0,
        activities: 0,
        wins: 0,
      };
      cell.activities++;
      if (r.event_type === "job_won") {
        cell.wins++;
        cell.revenue += quoteGroupValue(r.quote_job_value);
      }
      matrixMap.set(mKey, cell);
    }
  }

  // Pipeline (open quote value + count) + per-quote items for the value-
  // bucket histogram — current state, separate scan.
  const { byCompany: pipelineByCompany, items: pipelineItems } =
    await loadOpenPipeline(supabase, activeIds);
  const totalPipeline = Array.from(pipelineByCompany.values()).reduce(
    (acc, p) => ({ count: acc.count + p.count, value: acc.value + p.value }),
    { count: 0, value: 0 },
  );

  // Finalise distinct counts + derived metrics
  finalise(totals.current, totalsDistinct.current);
  finalise(totals.previous, totalsDistinct.previous);
  totals.current.pipeline = totalPipeline.value;
  totals.current.pipelineCount = totalPipeline.count;

  for (const [companyId, cb] of perClient.entries()) {
    finalise(cb.current, cb.cDistinct);
    finalise(cb.previous, cb.pDistinct);
    const pp = pipelineByCompany.get(companyId);
    if (pp) {
      cb.current.pipeline = pp.value;
      cb.current.pipelineCount = pp.count;
    }
  }
  for (const e of perExec.values()) {
    finalise(e.current, e.cDistinct);
    finalise(e.previous, e.pDistinct);
  }

  const perClientArr: OverviewClient[] = companies.map(c => {
    const cb = perClient.get(c.id)!;
    return {
      id: c.id, name: c.name, slug: c.slug, timezone: c.timezone,
      current: cb.current, previous: cb.previous,
      lastActivityAt: cb.lastActivityAt,
      currentActiveDays: activeBusinessDays(cb.firstSeenCurrent, range.start, range.end),
      previousActiveDays: activeBusinessDays(cb.firstSeenPrevious, range.prevStart, range.prevEnd),
    };
  });
  perClientArr.sort((a, b) => b.current.revenue - a.current.revenue || b.current.calls - a.current.calls);

  const perExecArr: OverviewExec[] = Array.from(perExec.values())
    .map(e => ({
      name: e.name,
      companies: Array.from(e.companies.values()),
      current: e.current,
      previous: e.previous,
      currentActiveDays: activeBusinessDays(e.firstSeenCurrent, range.start, range.end),
      previousActiveDays: activeBusinessDays(e.firstSeenPrevious, range.prevStart, range.prevEnd),
    }))
    .sort((a, b) => b.current.revenue - a.current.revenue || b.current.calls - a.current.calls);

  const trend: OverviewTrendPoint[] = trendKeys.map(k => trendBuckets.get(k)!);

  // Wins — newest first
  wins.sort((a, b) => b.created_at.localeCompare(a.created_at));

  // Sources — top by activity, with close rate
  const sources: SourceStat[] = Array.from(sourceMap.entries())
    .map(([source, s]) => ({
      source,
      quotes: s.quotes,
      wins: s.wins,
      revenue: s.revenue,
      closeRate: s.quotes > 0 ? s.wins / s.quotes : 0,
    }))
    .sort((a, b) => (b.revenue - a.revenue) || (b.quotes - a.quotes))
    .slice(0, 8);

  // Outcomes — top by frequency
  const outcomes: OutcomeStat[] = Array.from(outcomeMap.entries())
    .map(([outcome, n]) => ({ outcome, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 10);

  // Matrix — exec × client
  const matrix: MatrixCell[] = Array.from(matrixMap.values());

  // Heatmap — full 90 days, including zero days
  const heatmap: HeatmapDay[] = [];
  for (let i = 89; i >= 0; i--) {
    const d = addDaysIso(today, -i);
    heatmap.push({ date: d, count: heatmapMap.get(d) || 0 });
  }

  // Productivity — activities per business day (Mon-Fri) within the period
  const workingDays = businessDaysBetween(range.start, range.end);
  const productivity: ProductivityRow[] = perExecArr.map(e => {
    const total = e.current.calls + e.current.quotes + e.current.visits + e.current.emails + e.current.wins;
    return {
      name: e.name,
      totalActivities: total,
      workingDays,
      activitiesPerDay: workingDays > 0 ? total / workingDays : 0,
    };
  }).sort((a, b) => b.activitiesPerDay - a.activitiesPerDay);

  // Lead-value buckets — bucket open quotes by $value
  const buckets: { label: string; min: number; max: number | null }[] = [
    { label: "<$5k",     min: 0,     max: 5_000 },
    { label: "$5k-$20k", min: 5_000, max: 20_000 },
    { label: "$20k-$50k", min: 20_000, max: 50_000 },
    { label: "$50k-$100k", min: 50_000, max: 100_000 },
    { label: "$100k+",    min: 100_000, max: null },
  ];
  const valueBuckets: ValueBucket[] = buckets.map(b => ({ ...b, count: 0, value: 0 }));
  for (const p of pipelineItems) {
    const slot = valueBuckets.find(b => p.value >= b.min && (b.max === null || p.value < b.max));
    if (slot) {
      slot.count++;
      slot.value += p.value;
    }
  }

  return {
    range, totals,
    perClient: perClientArr, perExec: perExecArr,
    trend, wins, sources, outcomes, matrix, heatmap, productivity, valueBuckets,
  };
}

/* ─── Reports archive ───────────────────────────────────────────────── */

export type ReportRow = {
  id: string;
  company_id: string;
  company_name: string;
  company_slug: string;
  sales_person_id: string | null;
  sales_person_name: string;
  report_type: "eod" | "eow" | "eom" | "eoq" | "eoy";
  period_start: string;
  period_end: string;
  formatted_text: string;
  counts: Record<string, unknown> | null;
  efficiency_rates: Record<string, unknown> | null;
  created_at: string;
};

export type ReportFilter = {
  reportType?: "eod" | "eow" | "eom" | "eoq" | "eoy";
  companyId?: string;
  salesPersonName?: string;
  limit?: number;
};

export async function loadReports(
  supabase: SupabaseClient,
  filter: ReportFilter = {},
): Promise<ReportRow[]> {
  const companies = await listCompanies(supabase);
  const companyById = new Map(companies.map(c => [c.id, c]));

  let q = supabase
    .from("reports")
    .select("id, company_id, sales_person_id, sales_person_name, report_type, period_start, period_end, formatted_text, counts, efficiency_rates, created_at")
    .order("period_end", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(filter.limit ?? 50);

  if (filter.reportType) q = q.eq("report_type", filter.reportType);
  if (filter.companyId) q = q.eq("company_id", filter.companyId);
  if (filter.salesPersonName) q = q.eq("sales_person_name", filter.salesPersonName);

  const { data, error } = await q;
  if (error) throw error;

  return (data || []).map(r => {
    const co = companyById.get(r.company_id);
    return {
      ...r,
      company_name: co?.name || "?",
      company_slug: co?.slug || "",
    };
  });
}

/**
 * Business days from an entity's first activity in the window to the end of
 * the window, clamped to [start, end]. Falls back to whole-window business
 * days if there was no activity, so a zero-activity row still has a non-zero
 * denominator (and shows 0/day cleanly).
 */
function activeBusinessDays(firstSeen: string | null, start: string, end: string): number {
  const from = firstSeen && firstSeen > start ? firstSeen : start;
  return businessDaysBetween(from, end);
}

/**
 * Open pipeline = quote_sent contacts with no subsequent job_won in the last
 * 180 days. Powers the "Pipeline $" hero, per-client pipeline counts, and the
 * value-bucket histogram. Chase-list / aging lives in Quotie — we don't
 * compute it here.
 */
async function loadOpenPipeline(
  supabase: SupabaseClient,
  activeIds: string[],
): Promise<{
  byCompany: Map<string, { count: number; value: number }>;
  items: PipelineItem[];
}> {
  const byCompany = new Map<string, { count: number; value: number }>();
  for (const id of activeIds) byCompany.set(id, { count: 0, value: 0 });
  if (activeIds.length === 0) return { byCompany, items: [] };

  const since = addDaysIso(todayInTz("Australia/Sydney"), -180);
  const rows = await pageAll<{
    contact_id: string;
    company_id: string;
    event_type: string;
    quote_job_value: string | null;
    created_at: string;
  }>((from, to) =>
    supabase
      .from("activities")
      .select("contact_id, company_id, event_type, quote_job_value, created_at")
      .gte("occurred_on", since)
      .not("contact_id", "is", null)
      .in("company_id", activeIds)
      .order("created_at", { ascending: false })
      .range(from, to),
  );

  type Last = {
    event_type: string;
    value: number;
    company_id: string;
  };
  const latest = new Map<string, Last>();
  const hasWin = new Map<string, boolean>();
  for (const r of rows) {
    const key = `${r.company_id}|${r.contact_id}`;
    if (!latest.has(key)) {
      latest.set(key, {
        event_type: r.event_type,
        value: quoteGroupValue(r.quote_job_value),
        company_id: r.company_id,
      });
    }
    if (r.event_type === "job_won") hasWin.set(key, true);
  }

  const items: PipelineItem[] = [];
  for (const [key, last] of latest.entries()) {
    if (hasWin.get(key)) continue;
    if (last.event_type !== "quote_sent") continue;
    const slot = byCompany.get(last.company_id);
    if (!slot) continue;
    slot.count++;
    slot.value += last.value;
    items.push({ company_id: last.company_id, value: last.value });
  }

  return { byCompany, items };
}

/** Helper: earliest calendar date contained in a bucket key. */
function trendBucketEarliestDate(key: string, by: Period): string {
  switch (by) {
    case "day": return key;
    case "week": return key;
    case "month": return `${key}-01`;
    case "quarter": {
      const [yr, qPart] = key.split("-Q");
      const q = parseInt(qPart, 10);
      const startMonth = (q - 1) * 3 + 1;
      return `${yr}-${String(startMonth).padStart(2, "0")}-01`;
    }
    case "year": return `${key}-01-01`;
  }
}
