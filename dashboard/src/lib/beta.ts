// Local-only conversion sandbox. Flip on with TSD_BETA=1 in dashboard/.env.local.
// Never set this on Vercel — production must keep real auth + data.

import type { User } from "@supabase/supabase-js";
import type { Viewer } from "./viewer";
import type { CompanyRow } from "./queries";
import type {
  ConversionEventRow,
  ConversionPortfolio,
  ConversionSnapshot,
  PaidAttribution,
} from "./conversion";

const FUNNEL: { event: string; label: string }[] = [
  { event: "lead_in", label: "Leads" },
  { event: "vsl_view", label: "VSL views" },
  { event: "vsl_complete", label: "VSL completes" },
  { event: "call", label: "Calls" },
  { event: "quote_sent", label: "Quotes" },
  { event: "site_visit", label: "Site visits" },
  { event: "won", label: "Won" },
];

export function isBeta(): boolean {
  return process.env.TSD_BETA === "1" || process.env.NEXT_PUBLIC_TSD_BETA === "1";
}

export const BETA_COMPANIES: CompanyRow[] = [
  { id: "beta-quotie", name: "Quotie", slug: "quotie", timezone: "Australia/Sydney", active: true },
];

export function betaViewer(): Viewer {
  const user = {
    id: "beta-benji",
    email: "benji@tradiewebguys.com.au",
    app_metadata: {},
    user_metadata: { full_name: "Benji" },
    aud: "authenticated",
    created_at: "2026-01-01T00:00:00.000Z",
  } as User;

  return {
    user,
    role: "conversion",
    isAdmin: false,
    isViewer: false,
    isTwg: false,
    isConversion: true,
    isClient: false,
    isLeader: false,
    salesPersonName: "Benji",
    companyIds: BETA_COMPANIES.map(c => c.id),
    memberships: BETA_COMPANIES.map(c => ({ companyId: c.id, access: "conversion" as const })),
    seesAll: false,
    canManageUsers: false,
    canSeeHealth: false,
    canSeeExecs: true,
    canWriteSales: false,
    theme: "dark",
  };
}

export function betaCompany(slug: string): {
  id: string; name: string; slug: string; timezone: string; owner_name: string | null;
} | null {
  const c = BETA_COMPANIES.find(x => x.slug === slug);
  if (!c) return null;
  return { id: c.id, name: c.name, slug: c.slug, timezone: c.timezone, owner_name: null };
}

type ClientSeed = {
  id: string;
  slug: string;
  name: string;
  connected: boolean;
  spend: number;
  leads: number;
  quotes: number;
  wins: number;
  wonValue: number;
  funnel: number[];
  studioPublished: number;
  studioDraft: number;
};

const SEEDS: ClientSeed[] = [
  { id: "beta-quotie", slug: "quotie", name: "Quotie", connected: true, spend: 8400, leads: 380, quotes: 72, wins: 7, wonValue: 47600, funnel: [380, 290, 240, 168, 72, 59, 7], studioPublished: 2, studioDraft: 1 },
];

function paidFromSeed(s: ClientSeed): PaidAttribution {
  const clicks = Math.round(s.spend / 1.35);
  const linkClicks = Math.round(clicks * 0.72);
  return {
    spend: s.spend,
    clicks,
    linkClicks,
    leads: s.leads,
    quotes: s.quotes,
    wins: s.wins,
    wonValue: s.wonValue,
    cpc: clicks > 0 ? s.spend / clicks : null,
    cplc: linkClicks > 0 ? s.spend / linkClicks : null,
    cpl: s.leads > 0 && s.spend > 0 ? s.spend / s.leads : null,
    cpa: s.wins > 0 && s.spend > 0 ? s.spend / s.wins : null,
    roas: s.spend > 0 ? s.wonValue / s.spend : null,
    campaigns: [
      {
        key: `${s.slug}-prospecting`,
        label: "Prospecting",
        spend: Math.round(s.spend * 0.65),
        clicks: Math.round(clicks * 0.62),
        linkClicks: Math.round(linkClicks * 0.62),
        leads: Math.round(s.leads * 0.7),
        quotes: Math.round(s.quotes * 0.6),
        wins: Math.max(0, s.wins - 1),
        wonValue: Math.round(s.wonValue * 0.7),
        cpc: null,
        cplc: null,
        cpl: null,
        cpa: null,
        roas: null,
      },
      {
        key: `${s.slug}-retarget`,
        label: "Retargeting",
        spend: s.spend - Math.round(s.spend * 0.65),
        clicks: clicks - Math.round(clicks * 0.62),
        linkClicks: linkClicks - Math.round(linkClicks * 0.62),
        leads: s.leads - Math.round(s.leads * 0.7),
        quotes: s.quotes - Math.round(s.quotes * 0.6),
        wins: Math.min(1, s.wins),
        wonValue: s.wonValue - Math.round(s.wonValue * 0.7),
        cpc: null,
        cplc: null,
        cpl: null,
        cpa: null,
        roas: null,
      },
    ].map(r => ({
      ...r,
      cpc: r.clicks > 0 && r.spend > 0 ? r.spend / r.clicks : null,
      cplc: r.linkClicks > 0 && r.spend > 0 ? r.spend / r.linkClicks : null,
      cpl: r.leads > 0 && r.spend > 0 ? r.spend / r.leads : null,
      cpa: r.wins > 0 && r.spend > 0 ? r.spend / r.wins : null,
      roas: r.spend > 0 ? r.wonValue / r.spend : null,
    })),
    connected: s.connected,
    pixelId: s.connected ? "1234567890" : null,
    adAccountId: s.connected ? "act_111" : null,
  };
}

function funnelFromSeed(s: ClientSeed): ConversionSnapshot["funnel"] {
  return FUNNEL.map((step, i) => ({
    event: step.event,
    label: step.label,
    count: s.funnel[i] || 0,
  }));
}

function recentFor(s: ClientSeed, from: string): (ConversionEventRow & { companyName: string; companySlug: string })[] {
  const names = ["Sam Kelly", "Jordan Lee", "Priya Nair", "Chris Walsh"];
  const events = ["lead_in", "quote_sent", "won", "call"] as const;
  return events.map((event, i) => ({
    id: `${s.id}-${event}`,
    company_id: s.id,
    contact_id: `beta-${s.slug}-${i}`,
    contact_name: names[i % names.length],
    event,
    source: i % 2 === 0 ? "Facebook" : "Google",
    campaign: i % 2 === 0 ? "Prospecting" : "Retargeting",
    occurred_on: from,
    occurred_at: `${from}T0${8 + i}:12:00.000Z`,
    sales_person_name: "Benji",
    value: event === "won" ? Math.round(s.wonValue / Math.max(1, s.wins)) : null,
    companyName: s.name,
    companySlug: s.slug,
  }));
}

export function betaPortfolio(opts: { from: string; to: string }): ConversionPortfolio {
  const clients = SEEDS.map(s => ({
    companyId: s.id,
    companyName: s.name,
    companySlug: s.slug,
    funnel: funnelFromSeed(s),
    paid: paidFromSeed(s),
    studioPublished: s.studioPublished,
    studioDraft: s.studioDraft,
  })).sort((a, b) => b.paid.spend - a.paid.spend || b.paid.wonValue - a.paid.wonValue);

  const spend = clients.reduce((n, c) => n + c.paid.spend, 0);
  const clicks = clients.reduce((n, c) => n + c.paid.clicks, 0);
  const linkClicks = clients.reduce((n, c) => n + c.paid.linkClicks, 0);
  const leads = clients.reduce((n, c) => n + c.paid.leads, 0);
  const quotes = clients.reduce((n, c) => n + c.paid.quotes, 0);
  const wins = clients.reduce((n, c) => n + c.paid.wins, 0);
  const wonValue = clients.reduce((n, c) => n + c.paid.wonValue, 0);
  const funnelCounts = new Map<string, number>();
  for (const c of clients) {
    for (const step of c.funnel) {
      funnelCounts.set(step.event, (funnelCounts.get(step.event) || 0) + step.count);
    }
  }

  return {
    from: opts.from,
    to: opts.to,
    totals: {
      spend, clicks, linkClicks, leads, quotes, wins, wonValue,
      cpc: clicks > 0 && spend > 0 ? spend / clicks : null,
      cplc: linkClicks > 0 && spend > 0 ? spend / linkClicks : null,
      cpl: leads > 0 && spend > 0 ? spend / leads : null,
      cpa: wins > 0 && spend > 0 ? spend / wins : null,
      roas: spend > 0 ? wonValue / spend : null,
    },
    funnel: FUNNEL.map(step => ({
      event: step.event,
      label: step.label,
      count: funnelCounts.get(step.event) || 0,
    })),
    clients,
    recent: SEEDS.flatMap(s => recentFor(s, opts.to)).slice(0, 12),
  };
}

export function betaSnapshot(opts: {
  from: string; to: string; companyId: string; companyName: string; companySlug: string;
}): ConversionSnapshot {
  const s = SEEDS.find(x => x.id === opts.companyId || x.slug === opts.companySlug);
  if (!s) {
    return {
      ...opts,
      funnel: FUNNEL.map(step => ({ event: step.event, label: step.label, count: 0 })),
      sources: [],
      recent: [],
    };
  }
  return {
    ...opts,
    funnel: funnelFromSeed(s),
    sources: [
      { source: "Facebook", leads: Math.round(s.leads * 0.7), quotes: Math.round(s.quotes * 0.6), wins: Math.max(0, s.wins - 1), wonValue: Math.round(s.wonValue * 0.7) },
      { source: "Google", leads: s.leads - Math.round(s.leads * 0.7), quotes: s.quotes - Math.round(s.quotes * 0.6), wins: Math.min(1, s.wins), wonValue: s.wonValue - Math.round(s.wonValue * 0.7) },
    ],
    recent: recentFor(s, opts.to),
  };
}

export function betaPaid(companyId: string): PaidAttribution {
  const s = SEEDS.find(x => x.id === companyId);
  if (!s) {
    return {
      spend: 0, clicks: 0, linkClicks: 0, leads: 0, quotes: 0, wins: 0, wonValue: 0,
      cpc: null, cplc: null, cpl: null, cpa: null, roas: null, campaigns: [],
      connected: false, pixelId: null, adAccountId: null,
    };
  }
  return paidFromSeed(s);
}
