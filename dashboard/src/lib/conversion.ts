import type { SupabaseClient } from "@supabase/supabase-js";
import { betaPaid, betaPortfolio, betaSnapshot, isBeta } from "./beta";
import { listCompanies } from "./queries";
import { createAdminClient } from "./supabase/admin";

export const FUNNEL_EVENTS = [
  "lead_in",
  "vsl_view",
  "vsl_complete",
  "call",
  "quote_sent",
  "site_visit",
  "won",
] as const;

export const EVENT_LABEL: Record<string, string> = {
  lead_in: "Leads",
  vsl_view: "VSL views",
  vsl_complete: "VSL completes",
  call: "Calls",
  quote_sent: "Quotes",
  site_visit: "Site visits",
  won: "Won",
  lost: "Lost",
  email: "Emails",
};

export type ConversionEventRow = {
  id: string;
  company_id: string;
  contact_id: string | null;
  contact_name: string | null;
  event: string;
  source: string | null;
  campaign: string | null;
  occurred_on: string;
  occurred_at: string;
  sales_person_name: string | null;
  value: number | null;
};

export type ConversionSnapshot = {
  from: string;
  to: string;
  companyId: string;
  companyName: string;
  companySlug: string;
  funnel: { event: string; label: string; count: number }[];
  sources: { source: string; leads: number; quotes: number; wins: number; wonValue: number }[];
  recent: (ConversionEventRow & { companyName: string })[];
};

function snapshotFromRows(
  rows: ConversionEventRow[],
  meta: { from: string; to: string; companyId: string; companyName: string; companySlug: string },
): ConversionSnapshot {
  const funnelCounts = new Map<string, number>();
  const sourceMap = new Map<string, { leads: number; quotes: number; wins: number; wonValue: number }>();

  for (const r of rows) {
    funnelCounts.set(r.event, (funnelCounts.get(r.event) || 0) + 1);
    const src = (r.source || "").trim() || "Unattributed";
    const bucket = sourceMap.get(src) || { leads: 0, quotes: 0, wins: 0, wonValue: 0 };
    if (r.event === "lead_in") bucket.leads++;
    if (r.event === "quote_sent") bucket.quotes++;
    if (r.event === "won") {
      bucket.wins++;
      bucket.wonValue += Number(r.value) || 0;
    }
    sourceMap.set(src, bucket);
  }

  const sources = [...sourceMap.entries()]
    .map(([source, v]) => ({ source, ...v }))
    .sort((a, b) => b.leads + b.quotes + b.wins - (a.leads + a.quotes + a.wins));

  return {
    ...meta,
    funnel: FUNNEL_EVENTS.map(event => ({
      event,
      label: EVENT_LABEL[event],
      count: funnelCounts.get(event) || 0,
    })),
    sources,
    recent: rows.slice(0, 40).map(r => ({
      ...r,
      companyName: meta.companyName,
    })),
  };
}

export async function loadConversionSnapshot(
  supabase: SupabaseClient,
  opts: { from: string; to: string; companyId: string; companyName: string; companySlug: string },
): Promise<ConversionSnapshot> {
  if (isBeta()) return betaSnapshot(opts);

  const { data, error } = await supabase
    .from("conversion_events")
    .select("id, company_id, contact_id, contact_name, event, source, campaign, occurred_on, occurred_at, sales_person_name, value")
    .eq("company_id", opts.companyId)
    .gte("occurred_on", opts.from)
    .lte("occurred_on", opts.to)
    .order("occurred_at", { ascending: false })
    .limit(4000);
  if (error) throw error;
  return snapshotFromRows((data || []) as ConversionEventRow[], opts);
}

export async function loadConversionByCompany(
  supabase: SupabaseClient,
  opts: { from: string; to: string },
): Promise<ConversionSnapshot[]> {
  const companies = await listCompanies(supabase);
  const { data, error } = await supabase
    .from("conversion_events")
    .select("id, company_id, contact_id, contact_name, event, source, campaign, occurred_on, occurred_at, sales_person_name, value")
    .gte("occurred_on", opts.from)
    .lte("occurred_on", opts.to)
    .order("occurred_at", { ascending: false })
    .limit(8000);
  if (error) throw error;
  const rows = (data || []) as ConversionEventRow[];
  const byCompany = new Map<string, ConversionEventRow[]>();
  for (const r of rows) {
    const list = byCompany.get(r.company_id) || [];
    list.push(r);
    byCompany.set(r.company_id, list);
  }
  return companies.map(c =>
    snapshotFromRows(byCompany.get(c.id) || [], {
      from: opts.from,
      to: opts.to,
      companyId: c.id,
      companyName: c.name,
      companySlug: c.slug,
    }),
  );
}

export type PaidCampaignRow = {
  key: string;
  label: string;
  spend: number;
  clicks: number;
  linkClicks: number;
  leads: number;
  quotes: number;
  wins: number;
  wonValue: number;
  cpc: number | null;
  cplc: number | null;
  cpl: number | null;
  cpa: number | null;
  roas: number | null;
};

export type PaidAttribution = {
  spend: number;
  clicks: number;
  linkClicks: number;
  leads: number;
  quotes: number;
  wins: number;
  wonValue: number;
  cpc: number | null;
  cplc: number | null;
  cpl: number | null;
  cpa: number | null;
  roas: number | null;
  campaigns: PaidCampaignRow[];
  connected: boolean;
  pixelId: string | null;
  adAccountId: string | null;
};

type TouchRow = {
  contact_id: string | null;
  contact_name: string | null;
  event: string;
  source: string | null;
  campaign: string | null;
  utm_campaign: string | null;
  campaign_id: string | null;
  occurred_at: string;
  value: number | null;
};

function contactKey(r: { contact_id: string | null; contact_name: string | null }) {
  if (r.contact_id) return `id:${r.contact_id}`;
  const name = (r.contact_name || "").trim().toLowerCase();
  return name ? `name:${name}` : "";
}

function campaignLabel(r: {
  utm_campaign?: string | null;
  campaign?: string | null;
  source?: string | null;
  campaign_id?: string | null;
}) {
  return (r.utm_campaign || r.campaign || r.source || "").trim() || "Unattributed";
}

type SpendRow = {
  campaign_id: string | null;
  campaign_name: string | null;
  spend: number | string;
  clicks?: number | string | null;
  link_clicks?: number | string | null;
};
type AdAccountRow = {
  pixel_id: string | null;
  meta_ad_account_id: string | null;
  meta_access_token?: string | null;
};

function paidFromRows(
  rows: TouchRow[],
  spendRows: SpendRow[],
  acct: AdAccountRow | null,
  from: string,
  to: string,
): PaidAttribution {
  const firstTouch = new Map<string, { label: string; campaignId: string | null }>();
  for (const r of rows) {
    const key = contactKey(r);
    if (!key || firstTouch.has(key)) continue;
    firstTouch.set(key, { label: campaignLabel(r), campaignId: r.campaign_id });
  }

  const buckets = new Map<string, PaidCampaignRow>();
  const bump = (label: string, campaignId: string | null) => {
    const key = (campaignId || label).toLowerCase();
    const row = buckets.get(key) || {
      key, label, spend: 0, clicks: 0, linkClicks: 0, leads: 0, quotes: 0, wins: 0, wonValue: 0,
      cpc: null, cplc: null, cpl: null, cpa: null, roas: null,
    };
    buckets.set(key, row);
    return row;
  };

  for (const r of rows) {
    if (r.occurred_at.slice(0, 10) < from || r.occurred_at.slice(0, 10) > to) continue;
    const key = contactKey(r);
    const touch = (key && firstTouch.get(key)) || { label: campaignLabel(r), campaignId: r.campaign_id };
    const row = bump(touch.label, touch.campaignId);
    if (r.event === "lead_in") row.leads++;
    if (r.event === "quote_sent") row.quotes++;
    if (r.event === "won") {
      row.wins++;
      row.wonValue += Number(r.value) || 0;
    }
  }

  let spendTotal = 0;
  let clicksTotal = 0;
  let linkClicksTotal = 0;
  for (const s of spendRows) {
    const spend = Number(s.spend) || 0;
    const clicks = Number(s.clicks) || 0;
    const linkClicks = Number(s.link_clicks) || 0;
    spendTotal += spend;
    clicksTotal += clicks;
    linkClicksTotal += linkClicks;
    const label = (s.campaign_name || s.campaign_id || "Unattributed").trim();
    const id = s.campaign_id || null;
    const match =
      (id && [...buckets.values()].find(b => b.key === id.toLowerCase())) ||
      [...buckets.values()].find(b => b.label.toLowerCase() === label.toLowerCase()) ||
      bump(label, id);
    match.spend += spend;
    match.clicks += clicks;
    match.linkClicks += linkClicks;
    if (id && match.label === "Unattributed") match.label = label;
  }

  const campaigns = [...buckets.values()]
    .map(r => ({
      ...r,
      cpc: r.clicks > 0 ? r.spend / r.clicks : null,
      cplc: r.linkClicks > 0 ? r.spend / r.linkClicks : null,
      cpl: r.leads > 0 ? r.spend / r.leads : null,
      cpa: r.wins > 0 ? r.spend / r.wins : null,
      roas: r.spend > 0 ? r.wonValue / r.spend : null,
    }))
    .sort((a, b) => b.spend - a.spend || b.wonValue - a.wonValue || b.leads - a.leads);

  const leads = campaigns.reduce((s, r) => s + r.leads, 0);
  const quotes = campaigns.reduce((s, r) => s + r.quotes, 0);
  const wins = campaigns.reduce((s, r) => s + r.wins, 0);
  const wonValue = campaigns.reduce((s, r) => s + r.wonValue, 0);

  return {
    spend: spendTotal,
    clicks: clicksTotal,
    linkClicks: linkClicksTotal,
    leads,
    quotes,
    wins,
    wonValue,
    cpc: clicksTotal > 0 ? spendTotal / clicksTotal : null,
    cplc: linkClicksTotal > 0 ? spendTotal / linkClicksTotal : null,
    cpl: leads > 0 ? spendTotal / leads : null,
    cpa: wins > 0 ? spendTotal / wins : null,
    roas: spendTotal > 0 ? wonValue / spendTotal : null,
    campaigns,
    connected: !!(acct?.meta_access_token && acct?.meta_ad_account_id),
    pixelId: acct?.pixel_id || null,
    adAccountId: acct?.meta_ad_account_id || null,
  };
}

export async function loadPaidAttribution(
  supabase: SupabaseClient,
  opts: { companyId: string; from: string; to: string },
): Promise<PaidAttribution> {
  if (isBeta()) return betaPaid(opts.companyId);

  const admin = createAdminClient();
  const [{ data: events, error: eErr }, { data: spendRows, error: sErr }, { data: acct }] = await Promise.all([
    supabase
      .from("conversion_events")
      .select("contact_id, contact_name, event, source, campaign, utm_campaign, campaign_id, occurred_at, value")
      .eq("company_id", opts.companyId)
      .order("occurred_at", { ascending: true })
      .limit(8000),
    supabase
      .from("ad_spend")
      .select("campaign_id, campaign_name, spend, clicks, link_clicks")
      .eq("company_id", opts.companyId)
      .gte("spend_on", opts.from)
      .lte("spend_on", opts.to),
    admin
      .from("company_ad_accounts")
      .select("pixel_id, meta_ad_account_id, meta_access_token")
      .eq("company_id", opts.companyId)
      .maybeSingle(),
  ]);
  if (eErr) throw eErr;
  if (sErr) throw sErr;

  return paidFromRows(
    (events || []) as TouchRow[],
    (spendRows || []) as SpendRow[],
    (acct || null) as AdAccountRow | null,
    opts.from,
    opts.to,
  );
}

export type ConversionClientRow = {
  companyId: string;
  companyName: string;
  companySlug: string;
  funnel: ConversionSnapshot["funnel"];
  paid: PaidAttribution;
  studioPublished: number;
  studioDraft: number;
};

export type ConversionPortfolio = {
  from: string;
  to: string;
  totals: Pick<PaidAttribution, "spend" | "clicks" | "linkClicks" | "leads" | "quotes" | "wins" | "wonValue" | "cpc" | "cplc" | "cpl" | "cpa" | "roas">;
  funnel: ConversionSnapshot["funnel"];
  clients: ConversionClientRow[];
  recent: (ConversionEventRow & { companyName: string; companySlug: string })[];
};

const PAGE = 1000;
async function pageAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

/** All assigned clients + rolled-up paid metrics for the conversion-lead home. */
export async function loadConversionPortfolio(
  supabase: SupabaseClient,
  opts: { from: string; to: string },
): Promise<ConversionPortfolio> {
  if (isBeta()) return betaPortfolio(opts);

  const companies = await listCompanies(supabase);
  const ids = companies.map(c => c.id);
  const emptyTotals = {
    spend: 0, clicks: 0, linkClicks: 0, leads: 0, quotes: 0, wins: 0, wonValue: 0,
    cpc: null as number | null, cplc: null as number | null, cpl: null as number | null, cpa: null as number | null, roas: null as number | null,
  };
  if (ids.length === 0) {
    return {
      from: opts.from,
      to: opts.to,
      totals: emptyTotals,
      funnel: FUNNEL_EVENTS.map(event => ({ event, label: EVENT_LABEL[event], count: 0 })),
      clients: [],
      recent: [],
    };
  }

  const admin = createAdminClient();
  const [touchByCompany, spendRows, accts, studioRows, rangeRows] = await Promise.all([
    Promise.all(ids.map(async id => {
      const { data, error } = await supabase
        .from("conversion_events")
        .select("contact_id, contact_name, event, source, campaign, utm_campaign, campaign_id, occurred_at, value")
        .eq("company_id", id)
        .order("occurred_at", { ascending: true })
        .limit(8000);
      if (error) throw error;
      return [id, (data || []) as TouchRow[]] as const;
    })).then(pairs => new Map(pairs)),
    pageAll<SpendRow & { company_id: string }>((from, to) =>
      supabase
        .from("ad_spend")
        .select("company_id, campaign_id, campaign_name, spend, clicks, link_clicks")
        .in("company_id", ids)
        .gte("spend_on", opts.from)
        .lte("spend_on", opts.to)
        .range(from, to),
    ),
    admin
      .from("company_ad_accounts")
      .select("company_id, pixel_id, meta_ad_account_id, meta_access_token")
      .in("company_id", ids)
      .then(r => {
        if (r.error) throw r.error;
        return r.data || [];
      }),
    supabase
      .from("studio_pages")
      .select("company_id, status")
      .in("company_id", ids)
      .then(r => {
        if (r.error) throw r.error;
        return r.data || [];
      }),
    pageAll<ConversionEventRow>((from, to) =>
      supabase
        .from("conversion_events")
        .select("id, company_id, contact_id, contact_name, event, source, campaign, occurred_on, occurred_at, sales_person_name, value")
        .in("company_id", ids)
        .gte("occurred_on", opts.from)
        .lte("occurred_on", opts.to)
        .order("occurred_at", { ascending: false })
        .range(from, to),
    ),
  ]);
  const spendByCompany = new Map<string, SpendRow[]>();
  for (const r of spendRows) {
    const list = spendByCompany.get(r.company_id) || [];
    list.push(r);
    spendByCompany.set(r.company_id, list);
  }
  const acctByCompany = new Map(accts.map(a => [a.company_id as string, a as AdAccountRow]));
  const studioByCompany = new Map<string, { published: number; draft: number }>();
  for (const r of studioRows) {
    const cur = studioByCompany.get(r.company_id) || { published: 0, draft: 0 };
    if (r.status === "published") cur.published++;
    else cur.draft++;
    studioByCompany.set(r.company_id, cur);
  }

  const clients: ConversionClientRow[] = companies.map(c => {
    const snap = snapshotFromRows(rangeRows.filter(r => r.company_id === c.id), {
      from: opts.from,
      to: opts.to,
      companyId: c.id,
      companyName: c.name,
      companySlug: c.slug,
    });
    const studio = studioByCompany.get(c.id) || { published: 0, draft: 0 };
    return {
      companyId: c.id,
      companyName: c.name,
      companySlug: c.slug,
      funnel: snap.funnel,
      paid: paidFromRows(
        touchByCompany.get(c.id) || [],
        spendByCompany.get(c.id) || [],
        acctByCompany.get(c.id) || null,
        opts.from,
        opts.to,
      ),
      studioPublished: studio.published,
      studioDraft: studio.draft,
    };
  });
  clients.sort((a, b) =>
    b.paid.spend - a.paid.spend || b.paid.wonValue - a.paid.wonValue || a.companyName.localeCompare(b.companyName),
  );

  const spend = clients.reduce((s, c) => s + c.paid.spend, 0);
  const clicks = clients.reduce((s, c) => s + c.paid.clicks, 0);
  const linkClicks = clients.reduce((s, c) => s + c.paid.linkClicks, 0);
  const leads = clients.reduce((s, c) => s + c.paid.leads, 0);
  const quotes = clients.reduce((s, c) => s + c.paid.quotes, 0);
  const wins = clients.reduce((s, c) => s + c.paid.wins, 0);
  const wonValue = clients.reduce((s, c) => s + c.paid.wonValue, 0);
  const funnelCounts = new Map<string, number>();
  for (const c of clients) {
    for (const step of c.funnel) {
      funnelCounts.set(step.event, (funnelCounts.get(step.event) || 0) + step.count);
    }
  }

  const companyById = new Map(companies.map(c => [c.id, c]));
  const recent = rangeRows.slice(0, 25).map(r => {
    const co = companyById.get(r.company_id);
    return { ...r, companyName: co?.name || "—", companySlug: co?.slug || "" };
  });

  return {
    from: opts.from,
    to: opts.to,
    totals: {
      spend,
      clicks,
      linkClicks,
      leads,
      quotes,
      wins,
      wonValue,
      cpc: clicks > 0 ? spend / clicks : null,
      cplc: linkClicks > 0 ? spend / linkClicks : null,
      cpl: leads > 0 ? spend / leads : null,
      cpa: wins > 0 ? spend / wins : null,
      roas: spend > 0 ? wonValue / spend : null,
    },
    funnel: FUNNEL_EVENTS.map(event => ({
      event,
      label: EVENT_LABEL[event],
      count: funnelCounts.get(event) || 0,
    })),
    clients,
    recent,
  };
}
