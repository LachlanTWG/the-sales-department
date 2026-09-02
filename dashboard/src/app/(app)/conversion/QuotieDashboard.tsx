import Link from "next/link";
import { formatCpc, formatCurrency } from "@/lib/format";
import {
  formatKpi,
  formatPct,
  type Kpi,
  type QuotieSnapshot,
  type ReasonRow,
} from "@/lib/quotieFunnel";
import { adsScorecard, closerScorecard, setterScorecard } from "@/lib/scorecard";
import { ScorecardGrid } from "./ScorecardGrid";

export type QuotieTab = "overview" | "ads" | "setters" | "closers";

const TAB_META: Record<QuotieTab, { title: string; path: string; blurb: string }> = {
  overview: { title: "Overview", path: "/conversion", blurb: "Constraints, KPIs, and the full funnel at a glance." },
  ads: { title: "Paid ads", path: "/conversion/ads", blurb: "Meta spend through opt-in, VSL, apply, and cost per booked." },
  setters: { title: "Setters", path: "/conversion/setters", blurb: "Dials, conversations, bookings, reasons, cash per lead." },
  closers: { title: "Closers", path: "/conversion/closers", blurb: "Calendar, show rate, live calls, cash per unit." },
};

export function QuotieDashboard({
  tab,
  snap,
  rangeLabel,
  presets,
  from,
  to,
}: {
  tab: QuotieTab;
  snap: QuotieSnapshot;
  rangeLabel: string;
  presets: { label: string; from: string; to: string }[];
  from: string;
  to: string;
}) {
  const meta = TAB_META[tab];
  const href = (next: { from: string; to: string }) =>
    `${meta.path}?from=${next.from}&to=${next.to}`;
  const top = snap.constraints.slice(0, 3);

  return (
    <div className="px-8 py-6 space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-blue-600">Quotie · call funnel</p>
          <h1 className="mt-1 text-xl font-semibold">{meta.title}</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {rangeLabel} · {snap.workingDays} working days · {meta.blurb}
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 text-xs text-blue-600">
          <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
          Beta · sample numbers
        </span>
      </header>

      <div className="flex flex-wrap gap-2 text-xs">
        {presets.map(p => (
          <Link
            key={p.label}
            href={href(p)}
            className={`rounded-md border px-2 py-1 ${
              from === p.from && to === p.to
                ? "border-blue-500 bg-blue-500 text-white"
                : "border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:text-blue-600"
            }`}
          >
            {p.label}
          </Link>
        ))}
      </div>

      {tab === "overview" && <OverviewBody snap={snap} top={top} />}
      {tab === "ads" && <AdsBody snap={snap} />}
      {tab === "setters" && <SettersBody snap={snap} />}
      {tab === "closers" && <ClosersBody snap={snap} />}
    </div>
  );
}

function OverviewBody({ snap, top }: { snap: QuotieSnapshot; top: QuotieSnapshot["constraints"] }) {
  const maxStep = Math.max(1, ...snap.steps.map(s => s.count));
  const c = snap.closer;
  return (
    <>
      <section className="grid gap-3 md:grid-cols-3">
        {top.map((x, i) => (
          <div key={x.key} className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <div className="text-[11px] font-medium uppercase tracking-wider text-amber-800">
              Constraint {i + 1} · {x.owner}
            </div>
            <div className="mt-1 text-sm font-semibold text-slate-900">{x.label}</div>
            <div className="mt-0.5 text-sm tabular-nums text-slate-800">
              {x.actual} now · {x.target} target · {x.gap} short
            </div>
            <p className="mt-2 text-xs text-slate-600">{x.detail}</p>
          </div>
        ))}
      </section>

      <section className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
        <Hero label="Ad spend" value={formatCurrency(snap.hero.spend)} />
        <Hero
          label="Cost per click"
          value={snap.meta.cpc > 0 ? formatCpc(snap.meta.cpc) : "—"}
          hint={`${snap.meta.clicks.toLocaleString()} all clicks`}
        />
        <Hero
          label="Cost per link click"
          value={snap.meta.cplc > 0 ? formatCpc(snap.meta.cplc) : "—"}
          hint={`${snap.meta.linkClicks.toLocaleString()} link clicks`}
        />
        <Hero
          label="Leads / day"
          value={snap.hero.leadsPerDay.toFixed(1)}
          hint={`KPI ${snap.hero.leadsPerDayTarget}`}
          warn={snap.hero.leadsPerDay < snap.hero.leadsPerDayTarget}
        />
        <Hero label="Booked" value={String(snap.hero.booked)} hint={`${snap.hero.bookedDirect} direct · ${snap.hero.bookedManual} manual`} />
        <Hero
          label="Cost / booked"
          value={snap.hero.costPerBooked != null ? formatCurrency(snap.hero.costPerBooked) : "—"}
        />
        <Hero
          label="Show rate"
          value={formatPct(c.showRate)}
          hint={`KPI ${formatPct(c.showTarget)}`}
          warn={c.showRate < c.showTarget}
        />
        <Hero label="Closed" value={String(snap.hero.wins)} hint={formatPct(c.closeRate) + " of shows"} />
        <Hero label="Cash collected" value={formatCurrency(snap.hero.cash)} accent />
        <Hero label="Cash / unit" value={formatPct(c.cashCollectedPct)} hint={`KPI 80%`} warn={c.cashCollectedPct < 0.8} />
      </section>

      <section>
        <h2 className="text-xs font-medium uppercase tracking-wider text-slate-500">KPI board</h2>
        <p className="mt-0.5 text-[11px] text-slate-500">
          Actual vs the line we hold. Amber = miss. Fix the top miss before scaling the step above it.
        </p>
        <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-normal">KPI</th>
                <th className="px-4 py-2 text-left font-normal">Owner</th>
                <th className="px-4 py-2 text-right font-normal">Actual</th>
                <th className="px-4 py-2 text-right font-normal">Target</th>
                <th className="px-4 py-2 text-left font-normal w-[36%]">Vs target</th>
              </tr>
            </thead>
            <tbody>
              {snap.kpis.map(k => (
                <KpiRow key={k.key} k={k} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-xs font-medium uppercase tracking-wider text-slate-500">Funnel</h2>
        <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-normal">Step</th>
                <th className="px-4 py-2 text-left font-normal w-[36%]">Volume</th>
                <th className="px-4 py-2 text-right font-normal">Count</th>
                <th className="px-4 py-2 text-right font-normal">Step %</th>
                <th className="px-4 py-2 text-right font-normal">Target</th>
                <th className="px-4 py-2 text-right font-normal">Cost</th>
              </tr>
            </thead>
            <tbody>
              {snap.steps.map(step => {
                const miss = step.target != null && step.ofPrev != null && step.ofPrev < step.target;
                return (
                  <tr key={step.key} className={`border-t border-slate-200 ${miss ? "bg-amber-50/70" : ""}`}>
                    <td className="px-4 py-2.5 font-medium text-slate-900">{step.label}</td>
                    <td className="px-4 py-2.5">
                      <div className="h-5 rounded bg-slate-100">
                        <div
                          className="h-5 rounded bg-blue-400"
                          style={{ width: `${Math.max(step.count ? 4 : 0, (step.count / maxStep) * 100)}%` }}
                        />
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{step.count.toLocaleString()}</td>
                    <td className={`px-4 py-2.5 text-right tabular-nums ${miss ? "font-medium text-amber-800" : ""}`}>
                      {step.ofPrev != null ? formatPct(step.ofPrev) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">
                      {step.target != null ? formatPct(step.target) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                      {step.cost != null ? `${formatCurrency(step.cost)} ${step.costLabel}` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function AdsBody({ snap }: { snap: QuotieSnapshot }) {
  const adsConstraints = snap.constraints.filter(x => x.owner === "ads" || x.owner === "page");
  return (
    <>
      {adsConstraints.length > 0 && (
        <section className="grid gap-3 md:grid-cols-2">
          {adsConstraints.map(x => (
            <div key={x.key} className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
              <div className="text-[11px] font-medium uppercase tracking-wider text-amber-800">{x.label}</div>
              <div className="mt-0.5 text-sm tabular-nums text-slate-800">
                {x.actual} now · {x.target} target · {x.gap} short
              </div>
              <p className="mt-2 text-xs text-slate-600">{x.detail}</p>
            </div>
          ))}
        </section>
      )}
      <p className="text-xs text-slate-500">
        One column per day including weekends — ads still spend. Amber rows are the rates and costs that show the leak. Scroll sideways for more days.
      </p>
      <ScorecardGrid title="Paid ads scorecard" card={adsScorecard(snap.from, snap.to)} />
    </>
  );
}

function SettersBody({ snap }: { snap: QuotieSnapshot }) {
  const s = snap.setter;
  const setterConstraints = snap.constraints.filter(x => x.owner === "setter" || x.key === "leads_day");
  return (
    <>
      {setterConstraints.length > 0 && (
        <section className="grid gap-3 md:grid-cols-2">
          {setterConstraints.map(x => (
            <div key={x.key} className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
              <div className="text-[11px] font-medium uppercase tracking-wider text-amber-800">{x.label}</div>
              <div className="mt-0.5 text-sm tabular-nums text-slate-800">
                {x.actual} now · {x.target} target · {x.gap} short
              </div>
              <p className="mt-2 text-xs text-slate-600">{x.detail}</p>
            </div>
          ))}
        </section>
      )}
      <p className="text-xs text-slate-500">
        {s.name} · conversation = connected &gt; 120s · amber rows are the rates that show the leak · scroll sideways for more days
      </p>
      <ScorecardGrid title="Setter scorecard" card={setterScorecard(snap.from, snap.to)} />
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <ReasonList title="DQ · reason (period)" rows={s.dqReasons} />
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <ReasonList title="Lost · reason (period)" rows={s.lostReasons} />
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <ReasonList title="Invalid (period)" rows={s.invalidReasons} />
        </div>
      </div>
    </>
  );
}

function ClosersBody({ snap }: { snap: QuotieSnapshot }) {
  const c = snap.closer;
  const closerConstraints = snap.constraints.filter(x => x.owner === "closer");
  return (
    <>
      {closerConstraints.length > 0 && (
        <section className="grid gap-3 md:grid-cols-2">
          {closerConstraints.map(x => (
            <div key={x.key} className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
              <div className="text-[11px] font-medium uppercase tracking-wider text-amber-800">{x.label}</div>
              <div className="mt-0.5 text-sm tabular-nums text-slate-800">
                {x.actual} now · {x.target} target · {x.gap} short
              </div>
              <p className="mt-2 text-xs text-slate-600">{x.detail}</p>
            </div>
          ))}
        </section>
      )}
      <p className="text-xs text-slate-500">
        {c.name} · bookings due vs live vs no-show have to add up · amber = rate rows · weekends are OFF
      </p>
      <ScorecardGrid title="Closer scorecard" card={closerScorecard(snap.from, snap.to)} />
    </>
  );
}

function KpiTable({ kpis, hideOwner }: { kpis: Kpi[]; hideOwner?: boolean }) {
  if (kpis.length === 0) return null;
  return (
    <section>
      <h2 className="text-xs font-medium uppercase tracking-wider text-slate-500">KPIs</h2>
      <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-4 py-2 text-left font-normal">KPI</th>
              {!hideOwner && <th className="px-4 py-2 text-left font-normal">Owner</th>}
              <th className="px-4 py-2 text-right font-normal">Actual</th>
              <th className="px-4 py-2 text-right font-normal">Target</th>
              <th className="px-4 py-2 text-left font-normal w-[36%]">Vs target</th>
            </tr>
          </thead>
          <tbody>
            {kpis.map(k => (
              <KpiRow key={k.key} k={k} hideOwner={hideOwner} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function KpiRow({ k, hideOwner }: { k: Kpi; hideOwner?: boolean }) {
  const miss = k.actual < k.target * 0.98;
  const ratio = k.target > 0 ? Math.min(1, k.actual / k.target) : 1;
  return (
    <tr className={`border-t border-slate-200 ${miss ? "bg-amber-50/60" : ""}`}>
      <td className="px-4 py-2 font-medium text-slate-900">{k.label}</td>
      {!hideOwner && <td className="px-4 py-2 capitalize text-slate-500">{k.owner}</td>}
      <td className={`px-4 py-2 text-right tabular-nums ${miss ? "font-semibold text-amber-900" : ""}`}>
        {formatKpi(k.actual, k.format)}
      </td>
      <td className="px-4 py-2 text-right tabular-nums text-slate-500">{formatKpi(k.target, k.format)}</td>
      <td className="px-4 py-2">
        <div className="h-2 rounded bg-slate-100">
          <div
            className={`h-2 rounded ${miss ? "bg-amber-400" : "bg-blue-400"}`}
            style={{ width: `${Math.max(6, ratio * 100)}%` }}
          />
        </div>
      </td>
    </tr>
  );
}

function Hero({
  label, value, hint, accent, warn,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
  warn?: boolean;
}) {
  return (
    <div className={`rounded-lg border bg-white px-4 py-3 shadow-sm ${warn ? "border-amber-300" : "border-slate-200"}`}>
      <div className="text-[11px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${warn ? "text-amber-800" : accent ? "text-blue-600" : "text-slate-900"}`}>
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div>}
    </div>
  );
}

function Panel({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-xs font-medium uppercase tracking-wider text-slate-700">{title}</h2>
      {hint && <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p>}
      <div className="mt-3">{children}</div>
    </div>
  );
}

function StatGrid({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-2 border-b border-slate-100 py-1">
          <dt className="text-slate-500">{k}</dt>
          <dd className="tabular-nums font-medium text-slate-900">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReasonList({ title, rows }: { title: string; rows: ReasonRow[] }) {
  const max = Math.max(1, ...rows.map(r => r.count));
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{title}</div>
      <ul className="mt-2 space-y-1.5">
        {rows.map(r => (
          <li key={r.reason}>
            <div className="flex justify-between gap-2 text-[11px]">
              <span className="truncate text-slate-600">{r.reason}</span>
              <span className="tabular-nums text-slate-900">{r.count}</span>
            </div>
            <div className="mt-0.5 h-1.5 rounded bg-slate-100">
              <div className="h-1.5 rounded bg-blue-400" style={{ width: `${(r.count / max) * 100}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
