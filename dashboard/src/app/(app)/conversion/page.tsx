// Conversion-lead home: every assigned client on one screen.
// /conversion/[slug] is the per-client drill-down (spend, Meta, events).

import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getViewer, requireAppAccess } from "@/lib/viewer";
import { isBeta } from "@/lib/beta";
import { EVENT_LABEL, loadConversionPortfolio } from "@/lib/conversion";
import { formatCpc, formatCurrency, SYDNEY_TZ, todayInTz } from "@/lib/format";
import { mondayOf, addDaysIso, shortDate } from "@/lib/dates";
import { LiveBadge } from "../LiveBadge";
import { QuotieDashboard } from "./QuotieDashboard";
import { loadQuotieRange } from "./quotieRange";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function ConversionHomePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const viewer = await getViewer();
  requireAppAccess(viewer);
  const q = await searchParams;
  const supabase = await createClient();

  const today = todayInTz(SYDNEY_TZ);
  const monthStart = `${today.slice(0, 8)}01`;
  let from = DATE_RE.test(q.from || "") ? q.from! : monthStart;
  let to = DATE_RE.test(q.to || "") ? q.to! : today;
  if (from > to) [from, to] = [to, from];

  const rangeLabel = from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`;
  const presets = [
    { label: "Today", from: today, to: today },
    { label: "This week", from: mondayOf(today), to: today },
    { label: "This month", from: monthStart, to: today },
    { label: "Last 30 days", from: addDaysIso(today, -29), to: today },
  ];

  if (isBeta()) {
    const beta = loadQuotieRange(q);
    return (
      <QuotieDashboard
        tab="overview"
        snap={beta.snap}
        rangeLabel={beta.rangeLabel}
        presets={beta.presets}
        from={beta.from}
        to={beta.to}
      />
    );
  }

  const portfolio = await loadConversionPortfolio(supabase, { from, to });
  const href = (next: { from?: string; to?: string }) => {
    const u = new URLSearchParams();
    u.set("from", next.from ?? from);
    u.set("to", next.to ?? to);
    return `/conversion?${u}`;
  };
  const clientHref = (slug: string) => `/conversion/${slug}?from=${from}&to=${to}`;

  const unconnected = portfolio.clients.filter(c => !c.paid.connected);
  const noSpend = portfolio.clients.filter(c => c.paid.spend === 0);
  const maxFunnel = Math.max(1, ...portfolio.funnel.map(f => f.count));
  const title = viewer.isConversion ? "My dashboard" : "Conversion";

  if (portfolio.clients.length === 0) {
    return (
      <div className="px-8 py-6">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-slate-500">
          No clients on this account. Ask Lachlan to grant you Conversion access on each book you run.
        </p>
      </div>
    );
  }

  return (
    <div className="px-8 py-6 space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {rangeLabel} · {portfolio.clients.length} {portfolio.clients.length === 1 ? "client" : "clients"}
          </p>
        </div>
        <LiveBadge />
      </header>

      <div className="flex flex-wrap gap-2 text-xs">
        {presets.map(p => (
          <Link
            key={p.label}
            href={href(p)}
            className={`rounded-md border px-2 py-1 ${
              from === p.from && to === p.to
                ? "border-blue-600 bg-blue-600 text-white"
                : "border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:text-blue-700"
            }`}
          >
            {p.label}
          </Link>
        ))}
      </div>

      <section className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        <Hero label="Ad spend" value={formatCurrency(portfolio.totals.spend)} hint="Meta + manual" />
        <Hero
          label="Cost per click"
          value={portfolio.totals.cpc != null ? formatCpc(portfolio.totals.cpc) : "—"}
          hint={portfolio.totals.clicks > 0 ? `${portfolio.totals.clicks.toLocaleString()} all clicks` : "Needs Meta clicks"}
        />
        <Hero
          label="Cost per link click"
          value={portfolio.totals.cplc != null ? formatCpc(portfolio.totals.cplc) : "—"}
          hint={portfolio.totals.linkClicks > 0 ? `${portfolio.totals.linkClicks.toLocaleString()} link clicks` : "Re-sync Meta for link clicks"}
        />
        <Hero
          label="Leads"
          value={String(portfolio.totals.leads)}
          hint={portfolio.totals.cpl != null ? `${formatCurrency(portfolio.totals.cpl)} CPL` : "First-touch"}
        />
        <Hero
          label="Wins"
          value={String(portfolio.totals.wins)}
          hint={portfolio.totals.cpa != null ? `${formatCurrency(portfolio.totals.cpa)} CPA` : "First-touch"}
        />
        <Hero
          label="ROAS"
          value={portfolio.totals.roas != null ? `${portfolio.totals.roas.toFixed(2)}x` : "—"}
          hint={formatCurrency(portfolio.totals.wonValue) + " won"}
        />
      </section>

      {(unconnected.length > 0 || noSpend.length > 0) && (
        <section className="grid gap-3 md:grid-cols-2">
          {unconnected.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
              <div className="text-xs font-medium uppercase tracking-wider text-amber-800">
                Meta not connected · {unconnected.length}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {unconnected.map(c => (
                  <Link
                    key={c.companyId}
                    href={clientHref(c.companySlug)}
                    className="rounded border border-amber-200 bg-white px-2 py-0.5 text-xs text-amber-800 hover:border-amber-400"
                  >
                    {c.companyName}
                  </Link>
                ))}
              </div>
            </div>
          )}
          {noSpend.length > 0 && (
            <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
              <div className="text-xs font-medium uppercase tracking-wider text-slate-500">
                No spend this range · {noSpend.length}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {noSpend.map(c => (
                  <Link
                    key={c.companyId}
                    href={clientHref(c.companySlug)}
                    className="rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-600 hover:border-blue-300 hover:text-blue-700"
                  >
                    {c.companyName}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      <section>
        <h2 className="text-xs font-medium uppercase tracking-wider text-slate-500">Funnel · all clients</h2>
        <div className="mt-3 grid gap-2">
          {portfolio.funnel.map(step => (
            <div key={step.event} className="flex items-center gap-3">
              <div className="w-28 shrink-0 text-xs text-slate-500">{step.label}</div>
              <div className="h-7 flex-1 rounded bg-slate-100">
                <div
                  className="h-7 rounded bg-blue-600"
                  style={{ width: `${Math.max(step.count ? 4 : 0, (step.count / maxFunnel) * 100)}%` }}
                />
              </div>
              <div className="w-12 shrink-0 text-right text-sm tabular-nums text-slate-800">{step.count}</div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-xs font-medium uppercase tracking-wider text-slate-500">Clients</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {portfolio.clients.map(c => {
              const leadCount = c.funnel.find(f => f.event === "lead_in")?.count || 0;
              const quoteCount = c.funnel.find(f => f.event === "quote_sent")?.count || 0;
              const winCount = c.funnel.find(f => f.event === "won")?.count || 0;
              return (
                <Link
                  key={c.companyId}
                  href={clientHref(c.companySlug)}
                  className="block rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm transition-colors hover:border-blue-300 hover:shadow"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-slate-900">{c.companyName}</div>
                      <div className="mt-0.5 text-[11px] text-slate-500">
                        Studio {c.studioPublished} live
                        {c.studioDraft > 0 ? ` · ${c.studioDraft} draft` : ""}
                      </div>
                    </div>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${
                        c.paid.connected
                          ? "bg-blue-50 text-blue-700"
                          : "bg-slate-100 text-slate-500"
                      }`}
                    >
                      {c.paid.connected ? "Meta" : "No Meta"}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-4 gap-2 text-center">
                    <Mini label="Spend" value={formatCurrency(c.paid.spend)} />
                    <Mini label="Leads" value={String(c.paid.leads)} />
                    <Mini label="Wins" value={String(c.paid.wins)} />
                    <Mini label="ROAS" value={c.paid.roas != null ? `${c.paid.roas.toFixed(1)}x` : "—"} accent />
                  </div>
                  <div className="mt-2 text-[11px] text-slate-500">
                    {c.paid.cpc != null ? `${formatCpc(c.paid.cpc)} CPC` : "No CPC"}
                    {" · "}
                    {c.paid.cplc != null ? `${formatCpc(c.paid.cplc)} CPLC` : "No CPLC"}
                    {" · "}
                    {c.paid.cpl != null ? `${formatCurrency(c.paid.cpl)} CPL` : "No CPL"}
                    {" · "}
                    {c.paid.cpa != null ? `${formatCurrency(c.paid.cpa)} CPA` : "No CPA"}
                    {" · "}
                    {leadCount}/{quoteCount}/{winCount} lead/quote/won
                  </div>
                </Link>
              );
            })}
        </div>
      </section>

      <section>
        <h2 className="text-xs font-medium uppercase tracking-wider text-slate-500">By client</h2>
        <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-normal">Client</th>
                <th className="px-4 py-2 text-right font-normal">Spend</th>
                <th className="px-4 py-2 text-right font-normal">CPC</th>
                <th className="px-4 py-2 text-right font-normal">CPLC</th>
                <th className="px-4 py-2 text-right font-normal">Leads</th>
                <th className="px-4 py-2 text-right font-normal">CPL</th>
                <th className="px-4 py-2 text-right font-normal">Quotes</th>
                <th className="px-4 py-2 text-right font-normal">Wins</th>
                <th className="px-4 py-2 text-right font-normal">CPA</th>
                <th className="px-4 py-2 text-right font-normal">Won $</th>
                <th className="px-4 py-2 text-right font-normal">ROAS</th>
                <th className="px-3 py-2 text-right font-normal"><span className="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody>
              {portfolio.clients.map(c => (
                <tr key={c.companyId} className="group border-t border-slate-200 hover:bg-blue-50/50">
                  <td className="px-4 py-2.5">
                    <Link href={clientHref(c.companySlug)} className="font-medium text-slate-900 hover:text-blue-700 hover:underline">
                      {c.companyName}
                    </Link>
                    {!c.paid.connected && <div className="text-[10px] text-amber-700">Meta not connected</div>}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-800">{formatCurrency(c.paid.spend)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">
                    {c.paid.cpc != null ? formatCpc(c.paid.cpc) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">
                    {c.paid.cplc != null ? formatCpc(c.paid.cplc) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{c.paid.leads}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">
                    {c.paid.cpl != null ? formatCurrency(c.paid.cpl) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{c.paid.quotes}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{c.paid.wins}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">
                    {c.paid.cpa != null ? formatCurrency(c.paid.cpa) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-blue-700">{formatCurrency(c.paid.wonValue)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {c.paid.roas != null ? `${c.paid.roas.toFixed(2)}x` : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <Link
                      href={clientHref(c.companySlug)}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-[11px] text-slate-600 hover:border-blue-400 hover:text-blue-700"
                    >
                      Open →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-xs font-medium uppercase tracking-wider text-slate-500">Recent events</h2>
        <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-normal">When</th>
                <th className="px-4 py-2 text-left font-normal">Event</th>
                <th className="px-4 py-2 text-left font-normal">Client</th>
                <th className="px-4 py-2 text-left font-normal">Contact</th>
                <th className="px-4 py-2 text-left font-normal">Source</th>
              </tr>
            </thead>
            <tbody>
              {portfolio.recent.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-slate-500">Nothing logged yet.</td>
                </tr>
              ) : (
                portfolio.recent.map(r => (
                  <tr key={r.id} className="border-t border-slate-200">
                    <td className="px-4 py-2 text-slate-500 whitespace-nowrap">{r.occurred_on}</td>
                    <td className="px-4 py-2 text-slate-800">{EVENT_LABEL[r.event] || r.event}</td>
                    <td className="px-4 py-2">
                      {r.companySlug ? (
                        <Link href={clientHref(r.companySlug)} className="text-slate-700 hover:text-blue-700">
                          {r.companyName}
                        </Link>
                      ) : (
                        <span className="text-slate-500">{r.companyName}</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-slate-700">{r.contact_name || "—"}</td>
                    <td className="px-4 py-2 text-slate-500">{r.source || "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Hero({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="text-[11px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div>}
    </div>
  );
}

function Mini({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className={`text-sm font-semibold tabular-nums ${accent ? "text-blue-700" : "text-slate-900"}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
    </div>
  );
}
