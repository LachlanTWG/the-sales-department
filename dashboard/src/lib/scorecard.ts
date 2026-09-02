// Day-by-day scorecard (spreadsheet layout). Beta fills sample daily inputs
// so rates and leaks are visible. Live Close/Cal will replace the generator.

import { addDaysIso, daysBetweenIso, weekdayShort } from "./dates";

export type CellKind = "int" | "pct" | "money" | "time" | "check" | "label";

export type ScoreCell = number | boolean | null;

export type ScoreRow = {
  key: string;
  label: string;
  kind: CellKind;
  highlight?: boolean;
  group?: boolean;
  total?: "sum" | "avg";
  cells: ScoreCell[];
};

export type ScoreDay = {
  date: string;
  weekday: string;
  dayNum: string;
  month: string;
  weekend: boolean;
  off: boolean;
};

export type Scorecard = {
  days: ScoreDay[];
  rows: ScoreRow[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function daysIn(from: string, to: string): string[] {
  const n = Math.max(0, daysBetweenIso(from, to));
  const out: string[] = [];
  for (let i = 0; i <= n; i++) out.push(addDaysIso(from, i));
  return out.slice(0, 45);
}

function seed(date: string, salt: number): number {
  let h = salt;
  for (let i = 0; i < date.length; i++) h = (h * 33 + date.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000;
}

function pick(date: string, salt: number, min: number, max: number): number {
  return min + Math.round(seed(date, salt) * (max - min));
}

function lift(n: number, bias: number): number {
  if (!bias) return n;
  return Math.max(0, Math.round(n * (1 + bias)));
}

export type ScoreGenOpts = { salt?: number; bias?: number };

function rate(n: number, d: number): number | null {
  return d > 0 ? n / d : null;
}

function dayMeta(date: string): ScoreDay {
  const weekday = weekdayShort(date);
  const weekend = weekday === "Sat" || weekday === "Sun";
  const [, m, d] = date.split("-");
  return {
    date,
    weekday,
    dayNum: String(parseInt(d, 10)),
    month: MONTHS[parseInt(m, 10) - 1],
    weekend,
    off: weekend,
  };
}

function row(key: string, label: string, kind: CellKind, cells: ScoreCell[], extra: Partial<ScoreRow> = {}): ScoreRow {
  return { key, label, kind, cells, ...extra };
}

function group(key: string, label: string, n: number): ScoreRow {
  return { key, label, kind: "label", group: true, cells: Array(n).fill(null) };
}

export function setterScorecard(from: string, to: string, opts?: ScoreGenOpts): Scorecard {
  const salt = opts?.salt ?? 0;
  const bias = opts?.bias ?? 0;
  const dates = daysIn(from, to);
  const days = dates.map(dayMeta);

  const worked: ScoreCell[] = [];
  const talkMin: ScoreCell[] = [];
  const assigned: ScoreCell[] = [];
  const dialled: ScoreCell[] = [];
  const answered: ScoreCell[] = [];
  const convos: ScoreCell[] = [];
  const qualified: ScoreCell[] = [];
  const bookedManual: ScoreCell[] = [];
  const bookedDirect: ScoreCell[] = [];
  const dq: ScoreCell[] = [];
  const invalid: ScoreCell[] = [];
  const lost: ScoreCell[] = [];

  for (const d of days) {
    if (d.off) {
      worked.push(false);
      talkMin.push(0);
      assigned.push(0); dialled.push(0); answered.push(0); convos.push(0);
      qualified.push(0); bookedManual.push(0); bookedDirect.push(0);
      dq.push(0); invalid.push(0); lost.push(0);
      continue;
    }
    const a = lift(pick(d.date, 1 + salt, 12, 18), bias);
    const di = Math.min(a, lift(pick(d.date, 2 + salt, 10, 16), bias));
    const an = Math.min(di, lift(pick(d.date, 3 + salt, 3, 7), bias));
    const cv = Math.min(an, lift(pick(d.date, 4 + salt, 2, 5), bias));
    const q = Math.min(cv, lift(pick(d.date, 5 + salt, 1, 4), bias));
    const bm = Math.min(q, lift(pick(d.date, 6 + salt, 0, 2), bias));
    const bd = lift(pick(d.date, 7 + salt, 0, 2), bias);
    worked.push(true);
    talkMin.push(lift(pick(d.date, 8 + salt, 90, 220), bias));
    assigned.push(a);
    dialled.push(di);
    answered.push(an);
    convos.push(cv);
    qualified.push(q);
    bookedManual.push(bm);
    bookedDirect.push(bd);
    dq.push(pick(d.date, 9 + salt, 0, 2));
    invalid.push(pick(d.date, 10 + salt, 0, 2));
    lost.push(pick(d.date, 11 + salt, 0, 2));
  }

  const n = days.length;
  const zip = (fn: (i: number) => ScoreCell) => Array.from({ length: n }, (_, i) => fn(i));

  return {
    days,
    rows: [
      group("g-ops", "Inputs", n),
      row("worked", "Worked today?", "check", worked),
      row("talk", "Available dialling time", "time", talkMin),
      row("assigned", "Leads assigned", "int", assigned),
      row("dialled", "Contacts dialled", "int", dialled),
      row("answered", "Contacts answered", "int", answered),
      row("convos", "Conversations (>120s)", "int", convos),
      row("qualified", "Qualified answers", "int", qualified),
      row("book_m", "Booked · manual", "int", bookedManual),
      row("book_d", "Booked · direct", "int", bookedDirect),
      row("dq", "Disqualified", "int", dq),
      row("invalid", "Invalid", "int", invalid),
      row("lost", "Lost", "int", lost),
      group("g-rates", "Rates", n),
      row("ans_r", "Answer rate", "pct", zip(i => rate(num(answered[i]), num(dialled[i]))), { highlight: true }),
      row("con_r", "Conversation / answered", "pct", zip(i => rate(num(convos[i]), num(answered[i]))), { highlight: true }),
      row("qual_r", "Qualified / conversation", "pct", zip(i => rate(num(qualified[i]), num(convos[i]))), { highlight: true }),
      row("book_r", "Lead → booked", "pct", zip(i => rate(num(bookedManual[i]) + num(bookedDirect[i]), num(assigned[i]))), { highlight: true }),
    ],
  };
}

export function closerScorecard(from: string, to: string, opts?: ScoreGenOpts): Scorecard {
  const salt = opts?.salt ?? 0;
  const bias = opts?.bias ?? 0;
  const dates = daysIn(from, to);
  const days = dates.map(dayMeta);

  const worked: ScoreCell[] = [];
  const slots: ScoreCell[] = [];
  const due: ScoreCell[] = [];
  const live: ScoreCell[] = [];
  const noShow: ScoreCell[] = [];
  const resched: ScoreCell[] = [];
  const cancel: ScoreCell[] = [];
  const missedLate: ScoreCell[] = [];
  const missedDbl: ScoreCell[] = [];
  const talkMin: ScoreCell[] = [];
  const finDq: ScoreCell[] = [];
  const fear: ScoreCell[] = [];
  const partner: ScoreCell[] = [];
  const logistics: ScoreCell[] = [];
  const qualified: ScoreCell[] = [];
  const offers: ScoreCell[] = [];
  const units: ScoreCell[] = [];
  const deposits: ScoreCell[] = [];
  const pif: ScoreCell[] = [];
  const cashUnit: ScoreCell[] = [];
  const cashDep: ScoreCell[] = [];

  for (const d of days) {
    if (d.off) {
      for (const arr of [worked, slots, due, live, noShow, resched, cancel, missedLate, missedDbl, talkMin, finDq, fear, partner, logistics, qualified, offers, units, deposits, pif, cashUnit, cashDep]) {
        arr.push(arr === worked ? false : 0);
      }
      continue;
    }
    const dueN = Math.max(1, lift(pick(d.date, 21 + salt, 2, 5), bias));
    // Thursday-ish no-show spike so the leak is visible in the grid
    const spike = d.weekday === "Thu" || d.weekday === "Tue";
    const ns = Math.min(dueN, pick(d.date, 22 + salt, spike ? 2 : 0, spike ? 3 : 1));
    const rs = Math.min(dueN - ns, pick(d.date, 23 + salt, 0, 1));
    const cn = Math.min(dueN - ns - rs, pick(d.date, 24 + salt, 0, 1));
    const late = pick(d.date, 25 + salt, 0, 1);
    const liveN = Math.max(0, dueN - ns - rs - cn);
    const qual = liveN > 0 ? Math.max(1, Math.min(liveN, pick(d.date, 26 + salt, 1, Math.max(1, liveN)))) : 0;
    const off = qual > 0 ? Math.max(1, Math.min(qual, pick(d.date, 27 + salt, 1, qual))) : 0;
    const un = off > 0 && seed(d.date, 28 + salt) > (0.5 - bias) ? 1 : 0;
    const dep = off > 0 && un === 0 && seed(d.date, 29 + salt) > 0.8 ? 1 : 0;
    const pifN = off > 0 && un === 0 && dep === 0 && seed(d.date, 30 + salt) > 0.75 ? 1 : 0;

    worked.push(true);
    slots.push(4);
    due.push(dueN);
    live.push(liveN);
    noShow.push(ns);
    resched.push(rs);
    cancel.push(cn);
    missedLate.push(late);
    missedDbl.push(0);
    talkMin.push(liveN * pick(d.date, 31 + salt, 35, 50));
    finDq.push(pick(d.date, 32 + salt, 0, liveN > 0 && seed(d.date, 32 + salt) > 0.7 ? 1 : 0));
    fear.push(pick(d.date, 33 + salt, 0, liveN > 0 && seed(d.date, 33 + salt) > 0.75 ? 1 : 0));
    partner.push(pick(d.date, 34 + salt, 0, liveN > 0 && seed(d.date, 34 + salt) > 0.8 ? 1 : 0));
    logistics.push(pick(d.date, 35 + salt, 0, liveN > 0 && seed(d.date, 35 + salt) > 0.85 ? 1 : 0));
    qualified.push(qual);
    offers.push(off);
    units.push(un);
    deposits.push(dep);
    pif.push(pifN);
    cashUnit.push(un * 7800);
    cashDep.push(dep * 2500);
  }

  const n = days.length;
  const zip = (fn: (i: number) => ScoreCell) => Array.from({ length: n }, (_, i) => fn(i));
  const booked = zip(i => num(due[i]) + num(resched[i])); // set confirmed in period vs due
  const notClosed = zip(i => Math.max(0, num(live[i]) - num(units[i]) - num(deposits[i]) - num(pif[i])));
  const cash = zip(i => num(cashUnit[i]) + num(cashDep[i]) + num(pif[i]) * 7800);
  const sold = zip(i => num(units[i]) + num(deposits[i]) + num(pif[i]));

  const valid = zip(i => {
    if (!days[i] || days[i].off) return true;
    const accounted = num(live[i]) + num(noShow[i]) + num(resched[i]) + num(cancel[i]);
    return accounted === num(due[i]);
  });

  return {
    days,
    rows: [
      group("g-day", "Day", n),
      row("worked", "Worked today? or OFF?", "check", worked),
      row("slots", "Available slots", "int", slots),
      row("due", "Meetings booked", "int", due),
      row("set", "Total bookings set (confirmed)", "int", booked),
      row("live", "Live calls sat", "int", live),
      row("noshow", "No shows", "int", noShow),
      row("resched", "Reschedules · prospect confirmed", "int", resched),
      row("cancel", "Cancels · prospect confirmed", "int", cancel),
      row("late", "Missed · last call ran overtime", "int", missedLate),
      row("dbl", "Missed · double booked", "int", missedDbl),
      row("valid", "Does it add up?", "check", valid),
      row("talk", "Talk time", "time", talkMin),
      group("g-show", "Show / utilisation", n),
      row("show_all", "Show rate · total bookings", "pct", zip(i => rate(num(live[i]), num(due[i]))), { highlight: true }),
      row("show_ex", "Show rate · ex closer-missed", "pct", zip(i => rate(num(live[i]), num(due[i]) - num(missedLate[i]) - num(missedDbl[i]))), { highlight: true }),
      row("noshow_r", "No-show %", "pct", zip(i => rate(num(noShow[i]), num(due[i])))),
      row("resched_r", "Reschedule %", "pct", zip(i => rate(num(resched[i]), num(due[i])))),
      row("cancel_r", "Cancel %", "pct", zip(i => rate(num(cancel[i]), num(due[i])))),
      row("late_r", "Missed because late %", "pct", zip(i => rate(num(missedLate[i]), num(due[i])))),
      row("util", "Slot utilisation · live calls", "pct", zip(i => rate(num(live[i]), num(slots[i]))), { highlight: true }),
      group("g-obj", "Not closed / objections", n),
      row("notclosed", "Not closed", "int", notClosed),
      row("findq", "Financial DQ", "int", finDq),
      row("fear", "Uncertainty / fear", "int", fear),
      row("partner", "Partner objection", "int", partner),
      row("logi", "Logistical finance", "int", logistics),
      row("findq_r", "Financial DQ rate", "pct", zip(i => rate(num(finDq[i]), num(live[i]))), { highlight: true }),
      row("fear_r", "Uncertainty rate", "pct", zip(i => rate(num(fear[i]), num(live[i])))),
      row("partner_r", "Partner objection rate", "pct", zip(i => rate(num(partner[i]), num(live[i])))),
      row("logi_r", "Logistical finance rate", "pct", zip(i => rate(num(logistics[i]), num(live[i])))),
      group("g-close", "Close", n),
      row("qual", "Qualified live calls", "int", qualified),
      row("offers", "Offers made", "int", offers),
      row("qual_r", "Qualified live call rate", "pct", zip(i => rate(num(qualified[i]), num(live[i]))), { highlight: true }),
      row("offer_r", "Offer rate", "pct", zip(i => rate(num(offers[i]), num(live[i]))), { highlight: true }),
      row("units", "Units sold (access given)", "int", units),
      row("dep", "Deposits (no access)", "int", deposits),
      row("pif", "PIFs", "int", pif),
      row("dep_r", "Deposit (no access) %", "pct", zip(i => rate(num(deposits[i]), num(sold[i])))),
      row("pif_r", "PIF rate", "pct", zip(i => rate(num(pif[i]), num(sold[i])))),
      row("close_book", "Close rate · total bookings", "pct", zip(i => rate(num(sold[i]), num(due[i]))), { highlight: true }),
      row("close_live", "Close rate · live calls", "pct", zip(i => rate(num(sold[i]), num(live[i]))), { highlight: true }),
      row("close_qual", "Close rate · qualified live", "pct", zip(i => rate(num(sold[i]), num(qualified[i]))), { highlight: true }),
      row("close_off", "Offer to close", "pct", zip(i => rate(num(sold[i]), num(offers[i]))), { highlight: true }),
      group("g-cash", "Cash", n),
      row("cash", "Total cash collected", "money", cash, { highlight: true }),
      row("cash_dep", "Collected · deposits", "money", cashDep),
      row("cash_unit", "Collected · units (access)", "money", cashUnit),
      row("avg_sale", "Avg cash per sale", "money", zip(i => rate(num(cash[i]), num(sold[i]))), { highlight: true }),
      row("cash_live", "Cash per live call", "money", zip(i => rate(num(cash[i]), num(live[i]))), { highlight: true }),
      row("cash_due", "Cash per booking due", "money", zip(i => rate(num(cash[i]), num(due[i]))), { highlight: true }),
    ],
  };
}

export function adsScorecard(from: string, to: string, opts?: ScoreGenOpts): Scorecard {
  const salt = opts?.salt ?? 0;
  const dates = daysIn(from, to);
  const days = dates.map(d => ({ ...dayMeta(d), off: false }));

  const spend: ScoreCell[] = [];
  const imps: ScoreCell[] = [];
  const clicks: ScoreCell[] = [];
  const lpViews: ScoreCell[] = [];
  const optInViews: ScoreCell[] = [];
  const optIns: ScoreCell[] = [];
  const vslViews: ScoreCell[] = [];
  const plays: ScoreCell[] = [];
  const q75: ScoreCell[] = [];
  const applyStarts: ScoreCell[] = [];
  const applySubmits: ScoreCell[] = [];
  const bookedDirect: ScoreCell[] = [];
  const bookedManual: ScoreCell[] = [];

  for (const d of days) {
    const weekend = d.weekend;
    const spendN = Math.round(pick(d.date, 40 + salt, weekend ? 180 : 320, weekend ? 320 : 520));
    const impN = spendN * pick(d.date, 41 + salt, 48, 72);
    const clickN = Math.max(1, Math.round(impN * (pick(d.date, 42 + salt, 12, 18) / 1000)));
    const lpN = Math.min(clickN, Math.round(clickN * (pick(d.date, 43 + salt, 82, 94) / 100)));
    const optViewN = Math.min(lpN, Math.round(lpN * (pick(d.date, 44 + salt, 88, 98) / 100)));
    const optN = Math.max(0, Math.round(optViewN * (pick(d.date, 45 + salt, 5, 10) / 100)));
    const vslN = Math.min(optN, Math.round(optN * (pick(d.date, 46 + salt, 65, 82) / 100)));
    const playN = Math.min(vslN, Math.round(vslN * (pick(d.date, 47 + salt, 70, 88) / 100)));
    const q75N = Math.min(playN, Math.round(playN * (pick(d.date, 48 + salt, 28, 42) / 100)));
    const startN = Math.min(playN, Math.round(playN * (pick(d.date, 49 + salt, 35, 55) / 100)));
    const submitN = Math.min(startN, Math.round(startN * (pick(d.date, 50 + salt, 62, 82) / 100)));
    const dirN = Math.min(submitN, pick(d.date, 51 + salt, 0, Math.max(1, Math.round(submitN * 0.45))));
    const manN = Math.min(Math.max(0, submitN - dirN), pick(d.date, 52 + salt, 0, 2));

    spend.push(spendN);
    imps.push(impN);
    clicks.push(clickN);
    lpViews.push(lpN);
    optInViews.push(optViewN);
    optIns.push(optN);
    vslViews.push(vslN);
    plays.push(playN);
    q75.push(q75N);
    applyStarts.push(startN);
    applySubmits.push(submitN);
    bookedDirect.push(dirN);
    bookedManual.push(manN);
  }

  const n = days.length;
  const zip = (fn: (i: number) => ScoreCell) => Array.from({ length: n }, (_, i) => fn(i));
  const booked = zip(i => num(bookedDirect[i]) + num(bookedManual[i]));

  return {
    days,
    rows: [
      group("g-meta", "Meta", n),
      row("spend", "Ad spend", "money", spend, { highlight: true }),
      row("imps", "Impressions", "int", imps),
      row("clicks", "Clicks (all)", "int", clicks),
      row("ctr", "Click-through rate", "pct", zip(i => rate(num(clicks[i]), num(imps[i]))), { highlight: true }),
      row("cpc", "Cost per click", "money", zip(i => rate(num(spend[i]), num(clicks[i]))), { highlight: true, total: "avg" }),
      row("link_clicks", "Link clicks", "int", zip(i => Math.round(num(clicks[i]) * 0.72))),
      row("cplc", "Cost per link click", "money", zip(i => {
        const lc = Math.round(num(clicks[i]) * 0.72);
        return rate(num(spend[i]), lc);
      }), { highlight: true, total: "avg" }),
      row("cpm", "Cost per 1,000 impressions", "money", zip(i => num(imps[i]) > 0 ? (num(spend[i]) / num(imps[i])) * 1000 : null), { total: "avg" }),
      row("lp", "Landing page views", "int", lpViews),
      row("cplp", "Cost per landing page view", "money", zip(i => rate(num(spend[i]), num(lpViews[i]))), { total: "avg" }),
      group("g-optin", "Opt-in", n),
      row("opt_v", "Opt-in page views", "int", optInViews),
      row("optins", "Opt-ins", "int", optIns, { highlight: true }),
      row("opt_r", "Opt-in rate", "pct", zip(i => rate(num(optIns[i]), num(optInViews[i]))), { highlight: true }),
      row("cpo", "Cost per opt-in", "money", zip(i => rate(num(spend[i]), num(optIns[i]))), { highlight: true, total: "avg" }),
      group("g-vsl", "VSL", n),
      row("vsl_v", "VSL page views", "int", vslViews),
      row("plays", "VSL plays", "int", plays),
      row("q75", "VSL playthrough (75%+)", "int", q75),
      row("play_r", "Playthrough rate", "pct", zip(i => rate(num(q75[i]), num(plays[i]))), { highlight: true }),
      row("cpp", "Cost per VSL play", "money", zip(i => rate(num(spend[i]), num(plays[i]))), { total: "avg" }),
      row("cppt", "Cost per playthrough", "money", zip(i => rate(num(spend[i]), num(q75[i]))), { total: "avg" }),
      group("g-book", "Apply + book", n),
      row("starts", "Form starts", "int", applyStarts),
      row("submits", "Form submits", "int", applySubmits),
      row("book_d", "Direct bookings", "int", bookedDirect),
      row("book_m", "Manual bookings", "int", bookedManual),
      row("booked", "Meetings booked", "int", booked, { highlight: true }),
      row("book_r", "Opt-in to booked rate", "pct", zip(i => rate(num(booked[i]), num(optIns[i]))), { highlight: true }),
      row("cpb", "Cost per booked call", "money", zip(i => rate(num(spend[i]), num(booked[i]))), { highlight: true, total: "avg" }),
    ],
  };
}

function num(v: ScoreCell): number {
  return typeof v === "number" ? v : 0;
}

export function scorecardRow(card: Scorecard, key: string): ScoreRow | undefined {
  return card.rows.find(r => r.key === key);
}

export function scorecardSum(card: Scorecard, key: string): number {
  const cells = scorecardRow(card, key)?.cells ?? [];
  return cells.reduce<number>((a, c) => a + (typeof c === "number" ? c : 0), 0);
}

export function scorecardTrueCount(card: Scorecard, key: string): number {
  const cells = scorecardRow(card, key)?.cells ?? [];
  return cells.filter(c => c === true).length;
}

export function rowTotal(row: ScoreRow): ScoreCell {
  if (row.group || row.kind === "label") return null;
  if (row.kind === "check") {
    const ons = row.cells.filter(c => c === true).length;
    return ons;
  }
  if (row.kind === "pct" || row.total === "avg") {
    const vals = row.cells.filter((c): c is number => typeof c === "number");
    if (vals.length === 0) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  if (row.kind === "money" || row.kind === "int" || row.kind === "time") {
    return row.cells.reduce<number>((a, c) => a + (typeof c === "number" ? c : 0), 0);
  }
  return null;
}
