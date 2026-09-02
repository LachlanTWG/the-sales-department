// Quotie call-funnel model. Beta uses the sample snapshot below.
// Live wiring (Meta, pixel, Close, Cal, VSL player) plugs into the same shape.

import { businessDaysBetween } from "./dates";

export type TrackStatus = "live" | "next";
export type KpiFormat = "pct" | "number" | "currency" | "perDay";
export type KpiOwner = "ads" | "page" | "setter" | "closer";

export type FunnelStep = {
  key: string;
  label: string;
  count: number;
  ofPrev: number | null;
  target: number | null;
  cost: number | null;
  costLabel: string;
};

export type ReasonRow = { reason: string; count: number };

export type Kpi = {
  key: string;
  label: string;
  owner: KpiOwner;
  actual: number;
  target: number;
  format: KpiFormat;
};

export type Constraint = {
  key: string;
  label: string;
  owner: KpiOwner;
  actual: string;
  target: string;
  gap: string;
  detail: string;
};

export type QuotieSnapshot = {
  from: string;
  to: string;
  workingDays: number;
  hero: {
    spend: number;
    optIns: number;
    booked: number;
    bookedDirect: number;
    bookedManual: number;
    costPerBooked: number | null;
    shows: number;
    wins: number;
    cash: number;
    leadsPerDay: number;
    leadsPerDayTarget: number;
  };
  constraints: Constraint[];
  kpis: Kpi[];
  steps: FunnelStep[];
  meta: {
    spend: number;
    impressions: number;
    clicks: number;
    linkClicks: number;
    ctr: number;
    cpc: number;
    cplc: number;
    cpm: number;
    lpViews: number;
    costPerLpView: number | null;
    frequency: number;
  };
  optIn: {
    views: number;
    submits: number;
    rate: number;
    costPerView: number | null;
    costPerOptIn: number | null;
    source: string;
  };
  vsl: {
    pageViews: number;
    plays: number;
    avgWatchSec: number;
    q25: number;
    q50: number;
    q75: number;
    q100: number;
    playthroughRate: number;
    costPerPlay: number | null;
    costPerPlaythrough: number | null;
  };
  apply: {
    starts: number;
    submits: number;
    yesMaybe: number;
    no: number;
    submitRate: number;
  };
  book: {
    calendarViews: number;
    direct: number;
    manual: number;
    total: number;
    bookRate: number;
    costPerBooked: number | null;
  };
  setter: {
    name: string;
    leadsAssigned: number;
    leadsPerDay: number;
    leadsPerDayTarget: number;
    dialled: number;
    answered: number;
    conversations: number;
    qualified: number;
    bookedManual: number;
    bookedDirectTouched: number;
    disqualified: number;
    invalid: number;
    lost: number;
    answerRate: number;
    conversationRate: number;
    qualifyRate: number;
    leadToBook: number;
    cashPerLead: number | null;
    cashPerBooked: number | null;
    dqReasons: ReasonRow[];
    lostReasons: ReasonRow[];
    invalidReasons: ReasonRow[];
  };
  closer: {
    name: string;
    slotsAvailable: number;
    slotsBooked: number;
    leftoverSlots: number;
    bookedRate: number;
    showed: number;
    noShow: number;
    showRate: number;
    showTarget: number;
    liveCalls: number;
    offered: number;
    closed: number;
    closeRate: number;
    unitPrice: number;
    unitsValue: number;
    cashCollected: number;
    cashPerUnit: number;
    cashCollectedPct: number;
    cashPerLiveCall: number | null;
    avgDeal: number;
  };
  tracking: { event: string; source: string; status: TrackStatus; note: string }[];
};

function pct(n: number, d: number): number {
  return d > 0 ? n / d : 0;
}

function cost(spend: number, n: number): number | null {
  return n > 0 ? spend / n : null;
}

export function formatWatch(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(n * 1000) / 10}%`.replace(/\.0%/, "%");
}

export function formatKpi(n: number, format: KpiFormat): string {
  if (!Number.isFinite(n)) return "—";
  if (format === "pct") return formatPct(n);
  if (format === "currency") {
    if (n >= 1000) return `$${Math.round(n / 100) / 10}k`.replace(".0k", "k");
    return `$${Math.round(n)}`;
  }
  if (format === "perDay") return `${n.toFixed(1)}/day`;
  return n.toLocaleString();
}

function kpiGap(k: Kpi): number {
  if (k.format === "pct") return k.target - k.actual;
  if (k.target === 0) return 0;
  return (k.target - k.actual) / k.target;
}

/** Placeholder month for beta. Replace with live loaders once pixels + Close land. */
export function sampleQuotieSnapshot(from: string, to: string): QuotieSnapshot {
  const workingDays = Math.max(1, businessDaysBetween(from, to));
  const scale = Math.max(0.12, workingDays / 20);
  const n = (x: number) => Math.max(0, Math.round(x * scale));

  const spend = n(8400);
  const impressions = n(420_000);
  const clicks = n(6200);
  const linkClicks = n(4460);
  const lpViews = n(5400);
  const optIns = n(300);
  const vslViews = n(210);
  const vslPlays = n(168);
  const q25 = n(126);
  const q50 = n(84);
  const q75 = n(52);
  const q100 = n(31);
  const applyStarts = n(88);
  const applySubmits = n(64);
  const yesMaybe = n(51);
  const no = n(13);
  const bookedDirect = n(28);
  const bookedManual = n(16);
  const booked = bookedDirect + bookedManual;
  const shows = n(20);
  const noShow = Math.max(0, booked - shows);
  const liveCalls = n(19);
  const offered = n(17);
  const closed = Math.max(1, n(6));
  const unitPrice = 7800;
  const unitsValue = unitPrice * closed;
  const cashCollectedPct = 0.73;
  const cash = Math.round(unitsValue * cashCollectedPct);

  const leadsAssigned = optIns;
  const leadsPerDay = leadsAssigned / workingDays;
  const leadsPerDayTarget = 35;
  const dialled = n(268);
  const answered = n(94);
  const conversations = n(58);
  const qualified = n(41);
  const dq = n(14);
  const invalid = n(13);
  const lost = n(15);

  const slotsAvailable = Math.max(booked, n(80));
  const showTarget = 0.7;

  const steps: FunnelStep[] = [
    { key: "click", label: "Ad clicks", count: clicks, ofPrev: pct(clicks, impressions), target: 0.015, cost: cost(spend, clicks), costLabel: "CPC" },
    { key: "lp", label: "Opt-in views", count: lpViews, ofPrev: pct(lpViews, clicks), target: 0.85, cost: cost(spend, lpViews), costLabel: "CPLP" },
    { key: "optin", label: "Opt-ins / assigned", count: optIns, ofPrev: pct(optIns, lpViews), target: 0.08, cost: cost(spend, optIns), costLabel: "CPL" },
    { key: "vsl_view", label: "VSL page views", count: vslViews, ofPrev: pct(vslViews, optIns), target: 0.70, cost: cost(spend, vslViews), costLabel: "per VSL view" },
    { key: "vsl_play", label: "VSL plays", count: vslPlays, ofPrev: pct(vslPlays, vslViews), target: 0.75, cost: cost(spend, vslPlays), costLabel: "per play" },
    { key: "playthrough", label: "VSL 75%+", count: q75, ofPrev: pct(q75, vslPlays), target: 0.35, cost: cost(spend, q75), costLabel: "per playthrough" },
    { key: "apply", label: "Applications", count: applySubmits, ofPrev: pct(applySubmits, vslPlays), target: 0.28, cost: cost(spend, applySubmits), costLabel: "per apply" },
    { key: "book", label: "Calls booked", count: booked, ofPrev: pct(booked, applySubmits), target: 0.70, cost: cost(spend, booked), costLabel: "CPA" },
    { key: "show", label: "Shows", count: shows, ofPrev: pct(shows, booked), target: showTarget, cost: cost(spend, shows), costLabel: "per show" },
    { key: "win", label: "Closed", count: closed, ofPrev: pct(closed, shows), target: 0.20, cost: cost(spend, closed), costLabel: "CAC" },
  ];

  const kpis: Kpi[] = [
    { key: "ctr", label: "CTR", owner: "ads", actual: pct(clicks, impressions), target: 0.015, format: "pct" },
    { key: "optin_rate", label: "Opt-in rate", owner: "page", actual: pct(optIns, lpViews), target: 0.08, format: "pct" },
    { key: "leads_day", label: "Leads / day to setter", owner: "ads", actual: leadsPerDay, target: leadsPerDayTarget, format: "perDay" },
    { key: "answer", label: "Answer rate", owner: "setter", actual: pct(answered, dialled), target: 0.40, format: "pct" },
    { key: "convo", label: "Conversation rate (>120s)", owner: "setter", actual: pct(conversations, answered), target: 0.70, format: "pct" },
    { key: "qualify", label: "Qualified / conversation", owner: "setter", actual: pct(qualified, conversations), target: 0.65, format: "pct" },
    { key: "lead_book", label: "Lead → booked", owner: "setter", actual: pct(booked, leadsAssigned), target: 0.22, format: "pct" },
    { key: "playthrough", label: "VSL playthrough 75%+", owner: "page", actual: pct(q75, vslPlays), target: 0.35, format: "pct" },
    { key: "show", label: "Show rate", owner: "closer", actual: pct(shows, booked), target: showTarget, format: "pct" },
    { key: "close", label: "Close rate (of shows)", owner: "closer", actual: pct(closed, shows), target: 0.25, format: "pct" },
    { key: "cal_util", label: "Closer calendar booked", owner: "closer", actual: pct(booked, slotsAvailable), target: 0.75, format: "pct" },
    { key: "cash_unit", label: "Cash collected / unit", owner: "closer", actual: cashCollectedPct, target: 0.80, format: "pct" },
  ];

  const constraintCopy: Record<string, string> = {
    leads_day: `Setter KPI is ${leadsPerDayTarget} leads/day. Only ${leadsPerDay.toFixed(1)} are landing. Bookings and cash are capped by lead flow before skill.`,
    show: "Show rate is the closer leak. 70%+ is the line. Below that, fix confirmation + thanks-page + setter show-lock before adding spend.",
    cash_unit: "Closes are happening but cash collected per unit is light. Collect more of the setup on the call.",
    lead_book: "Assigned leads are not turning into bookings fast enough. Check answer rate, then conversation quality.",
    playthrough: "People hit play and leave. Fix the first 30 seconds of the VSL before touching ads.",
    answer: "Not enough people pick up. Calling windows + number reputation before more dials.",
  };

  const constraints: Constraint[] = kpis
    .filter(k => kpiGap(k) > 0.02)
    .sort((a, b) => kpiGap(b) - kpiGap(a))
    .map(k => ({
      key: k.key,
      label: k.label,
      owner: k.owner,
      actual: formatKpi(k.actual, k.format),
      target: formatKpi(k.target, k.format),
      gap: k.format === "pct"
        ? `${Math.round((k.target - k.actual) * 100)} pts`
        : formatKpi(k.target - k.actual, k.format),
      detail: constraintCopy[k.key] || "Below target. Hold this step before scaling the step above it.",
    }));

  return {
    from,
    to,
    workingDays,
    hero: {
      spend,
      optIns,
      booked,
      bookedDirect,
      bookedManual,
      costPerBooked: cost(spend, booked),
      shows,
      wins: closed,
      cash,
      leadsPerDay,
      leadsPerDayTarget,
    },
    constraints,
    kpis,
    steps,
    meta: {
      spend,
      impressions,
      clicks,
      linkClicks,
      ctr: pct(clicks, impressions),
      cpc: spend / clicks,
      cplc: spend / linkClicks,
      cpm: (spend / impressions) * 1000,
      lpViews,
      costPerLpView: cost(spend, lpViews),
      frequency: 2.4,
    },
    optIn: {
      views: lpViews,
      submits: optIns,
      rate: pct(optIns, lpViews),
      costPerView: cost(spend, lpViews),
      costPerOptIn: cost(spend, optIns),
      source: "meta_opt_in → Close: New Lead - AUS",
    },
    vsl: {
      pageViews: vslViews,
      plays: vslPlays,
      avgWatchSec: 138,
      q25,
      q50,
      q75,
      q100,
      playthroughRate: pct(q75, vslPlays),
      costPerPlay: cost(spend, vslPlays),
      costPerPlaythrough: cost(spend, q75),
    },
    apply: {
      starts: applyStarts,
      submits: applySubmits,
      yesMaybe,
      no,
      submitRate: pct(applySubmits, applyStarts),
    },
    book: {
      calendarViews: n(61),
      direct: bookedDirect,
      manual: bookedManual,
      total: booked,
      bookRate: pct(booked, yesMaybe),
      costPerBooked: cost(spend, booked),
    },
    setter: {
      name: "Benji",
      leadsAssigned,
      leadsPerDay,
      leadsPerDayTarget,
      dialled,
      answered,
      conversations,
      qualified,
      bookedManual,
      bookedDirectTouched: n(22),
      disqualified: dq,
      invalid,
      lost,
      answerRate: pct(answered, dialled),
      conversationRate: pct(conversations, answered),
      qualifyRate: pct(qualified, conversations),
      leadToBook: pct(bookedManual + bookedDirect, leadsAssigned),
      cashPerLead: cost(cash, leadsAssigned),
      cashPerBooked: cost(cash, booked),
      dqReasons: [
        { reason: "Can't / won't invest (NO)", count: n(6) },
        { reason: "Not the decision maker", count: n(3) },
        { reason: "Wants DIY software", count: n(2) },
        { reason: "Just browsing / no pain", count: n(2) },
        { reason: "Wrong fit (invoicing / CRM)", count: n(1) },
      ],
      lostReasons: [
        { reason: "Ghosted after conversation", count: n(6) },
        { reason: "Already using something", count: n(4) },
        { reason: "Timing — later", count: n(3) },
        { reason: "Price pushback on setter", count: n(2) },
      ],
      invalidReasons: [
        { reason: "Wrong / dead number", count: n(8) },
        { reason: "Duplicate lead", count: n(3) },
        { reason: "Not a real business", count: n(2) },
      ],
    },
    closer: {
      name: "Locky",
      slotsAvailable,
      slotsBooked: booked,
      leftoverSlots: Math.max(0, slotsAvailable - booked),
      bookedRate: pct(booked, slotsAvailable),
      showed: shows,
      noShow,
      showRate: pct(shows, booked),
      showTarget,
      liveCalls,
      offered,
      closed,
      closeRate: pct(closed, shows),
      unitPrice,
      unitsValue,
      cashCollected: cash,
      cashPerUnit: closed > 0 ? cash / closed : 0,
      cashCollectedPct,
      cashPerLiveCall: cost(cash, liveCalls),
      avgDeal: closed > 0 ? cash / closed : 0,
    },
    tracking: [
      { event: "Leads assigned / dialled / answered", source: "Close activities", status: "next", note: "Every opt-in is a setter lead" },
      { event: "Conversation (>120s)", source: "Close call duration", status: "next", note: "Connected ≠ conversation" },
      { event: "Qualified / DQ / invalid / lost + reason", source: "Close status + custom fields", status: "next", note: "Reason is required, not optional" },
      { event: "Booked manual vs direct", source: "Close + Cal", status: "next", note: "Setter-booked vs they picked a time" },
      { event: "Closer slots / show / live call", source: "Cal + Close", status: "next", note: "Availability vs booked vs sat" },
      { event: "Cash collected vs unit", source: "Invoice / Close won", status: "next", note: "% of setup taken on the call" },
      { event: "Opt-in + apply + schedule pixels", source: "Meta Pixel", status: "live", note: "Already on quotie.au" },
    ],
  };
}
