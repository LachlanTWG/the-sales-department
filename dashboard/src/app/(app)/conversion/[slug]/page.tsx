import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getViewer, requireAppAccess, gateCompanySlug } from "@/lib/viewer";
import { listCompanies } from "@/lib/queries";
import { loadConversionSnapshot, loadPaidAttribution, EVENT_LABEL } from "@/lib/conversion";
import { formatCpc, formatCurrency, todayInTz } from "@/lib/format";
import { mondayOf, addDaysIso, shortDate } from "@/lib/dates";
import { isBeta } from "@/lib/beta";
import { addManualSpendForm, saveAdAccountForm, syncMetaSpendForm } from "../actions";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function ConversionClientPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const viewer = await getViewer();
  requireAppAccess(viewer);
  const { slug } = await params;
  if (isBeta()) {
    const q = await searchParams;
    const u = new URLSearchParams();
    if (q.from) u.set("from", q.from);
    if (q.to) u.set("to", q.to);
    const qs = u.toString();
    redirect(qs ? `/conversion?${qs}` : "/conversion");
  }
  const q = await searchParams;
  const supabase = await createClient();
  const company = await gateCompanySlug(viewer, supabase, slug);
  if (!company) notFound();

  const today = todayInTz(company.timezone);
  const monthStart = `${today.slice(0, 8)}01`;
  let from = DATE_RE.test(q.from || "") ? q.from! : monthStart;
  let to = DATE_RE.test(q.to || "") ? q.to! : today;
  if (from > to) [from, to] = [to, from];

  const companies = await listCompanies(supabase);
  const [snap, paid] = await Promise.all([
    loadConversionSnapshot(supabase, {
      from,
      to,
      companyId: company.id,
      companyName: company.name,
      companySlug: company.slug,
    }),
    loadPaidAttribution(supabase, { companyId: company.id, from, to }),
  ]);
  const canManageAds = !isBeta() && (viewer.isAdmin || viewer.isConversion);

  const maxFunnel = Math.max(1, ...snap.funnel.map(f => f.count));
  const rangeLabel = from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`;
  const href = (next: { from?: string; to?: string; slug?: string }) => {
    const u = new URLSearchParams();
    u.set("from", next.from ?? from);
    u.set("to", next.to ?? to);
    return `/conversion/${next.slug ?? slug}?${u}`;
  };
  const presets = [
    { label: "Today", from: today, to: today },
    { label: "This week", from: mondayOf(today), to: today },
    { label: "This month", from: monthStart, to: today },
    { label: "Last 30 days", from: addDaysIso(today, -29), to: today },
  ];

  return (
    <div className="px-8 py-6 space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href={`/conversion?from=${from}&to=${to}`} className="text-xs text-slate-500 hover:text-blue-700">
            ← All clients
          </Link>
          <h1 className="mt-1 text-xl font-semibold">{company.name}</h1>
          <p className="mt-0.5 text-sm text-slate-500">Conversion · {rangeLabel}</p>
        </div>
        {companies.length > 1 && (
          <div className="flex max-w-xl flex-wrap justify-end gap-1">
            {companies.map(c => (
              <Link
                key={c.id}
                href={href({ slug: c.slug })}
                className={`rounded-md border px-2 py-1 text-xs ${
                  c.slug === slug
                    ? "border-blue-600 bg-blue-600 text-white"
                    : "border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:text-blue-700"
                }`}
              >
                {c.name}
              </Link>
            ))}
          </div>
        )}
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
        <Hero label="Ad spend" value={formatCurrency(paid.spend)} hint={paid.connected ? "Meta sync" : "Add spend or connect Meta"} />
        <Hero
          label="Cost per click"
          value={paid.cpc != null ? formatCpc(paid.cpc) : "—"}
          hint={paid.clicks > 0 ? `${paid.clicks.toLocaleString()} all clicks` : "Needs Meta clicks"}
        />
        <Hero
          label="Cost per link click"
          value={paid.cplc != null ? formatCpc(paid.cplc) : "—"}
          hint={paid.linkClicks > 0 ? `${paid.linkClicks.toLocaleString()} link clicks` : "Re-sync Meta for link clicks"}
        />
        <Hero label="Leads" value={String(paid.leads)} hint={paid.cpl != null ? `${formatCurrency(paid.cpl)} CPL` : "First-touch"} />
        <Hero label="Wins" value={String(paid.wins)} hint={paid.cpa != null ? `${formatCurrency(paid.cpa)} CPA` : "First-touch"} />
        <Hero label="ROAS" value={paid.roas != null ? `${paid.roas.toFixed(2)}x` : "—"} hint={formatCurrency(paid.wonValue) + " won"} />
      </section>

      <section>
        <h2 className="text-xs font-medium uppercase tracking-wider text-slate-500">Paid attribution · first touch</h2>
        <p className="mt-1 text-xs text-slate-500">
          Wins and leads attributed to the contact&apos;s first source/campaign. Spend from Meta or a manual line.
        </p>
        <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-normal">Campaign / source</th>
                <th className="px-4 py-2 text-right font-normal">Spend</th>
                <th className="px-4 py-2 text-right font-normal">Clicks</th>
                <th className="px-4 py-2 text-right font-normal">CPC</th>
                <th className="px-4 py-2 text-right font-normal">Link clicks</th>
                <th className="px-4 py-2 text-right font-normal">CPLC</th>
                <th className="px-4 py-2 text-right font-normal">Leads</th>
                <th className="px-4 py-2 text-right font-normal">CPL</th>
                <th className="px-4 py-2 text-right font-normal">Quotes</th>
                <th className="px-4 py-2 text-right font-normal">Wins</th>
                <th className="px-4 py-2 text-right font-normal">CPA</th>
                <th className="px-4 py-2 text-right font-normal">Won $</th>
                <th className="px-4 py-2 text-right font-normal">ROAS</th>
              </tr>
            </thead>
            <tbody>
              {paid.campaigns.length === 0 ? (
                <tr>
                  <td colSpan={13} className="px-4 py-8 text-center text-slate-500">No attributed events in this range.</td>
                </tr>
              ) : (
                paid.campaigns.map(r => (
                  <tr key={r.key} className="border-t border-slate-200">
                    <td className="px-4 py-2 text-slate-800">{r.label}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(r.spend)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.clicks || "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500">{r.cpc != null ? formatCpc(r.cpc) : "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.linkClicks || "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500">{r.cplc != null ? formatCpc(r.cplc) : "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.leads}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500">{r.cpl != null ? formatCurrency(r.cpl) : "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.quotes}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.wins}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500">{r.cpa != null ? formatCurrency(r.cpa) : "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(r.wonValue)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.roas != null ? `${r.roas.toFixed(2)}x` : "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {canManageAds && (
        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-medium text-slate-900">Meta connection</h2>
            <p className="mt-1 text-xs text-slate-500">
              Pixel + ad account for this client. Token stays on the server. Sync pulls campaign spend into the table above.
            </p>
            <form action={saveAdAccountForm} className="mt-3 grid gap-2">
              <input type="hidden" name="companyId" value={company.id} />
              <input type="hidden" name="slug" value={slug} />
              <input name="pixelId" defaultValue={paid.pixelId || ""} placeholder="Pixel ID" className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm" />
              <input name="adAccountId" defaultValue={(paid.adAccountId || "").replace(/^act_/, "")} placeholder="Ad account ID (act_…)" className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm" />
              <input name="accessToken" type="password" placeholder={paid.connected ? "Token saved — paste to replace" : "Meta system user token"} className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm" />
              <div className="flex gap-2">
                <button type="submit" className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">Save</button>
              </div>
            </form>
            <form action={syncMetaSpendForm} className="mt-2">
              <input type="hidden" name="companyId" value={company.id} />
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="from" value={from} />
              <input type="hidden" name="to" value={to} />
              <button type="submit" className="text-xs text-slate-500 hover:text-blue-700">
                Sync Meta spend for this range
              </button>
            </form>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-medium text-slate-900">Manual spend</h2>
            <p className="mt-1 text-xs text-slate-500">Use until Meta is connected, or for spend that isn&apos;t in Ads Manager.</p>
            <form action={addManualSpendForm} className="mt-3 grid gap-2 sm:grid-cols-3">
              <input type="hidden" name="companyId" value={company.id} />
              <input type="hidden" name="slug" value={slug} />
              <input type="date" name="spendOn" defaultValue={to} required className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm" />
              <input name="campaignName" placeholder="Campaign name" className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm" />
              <input name="spend" type="number" step="0.01" min="0" placeholder="Spend $" required className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm" />
              <button type="submit" className="rounded-md border border-slate-200 px-3 py-2 text-xs text-slate-700 hover:border-blue-400 hover:text-blue-700 sm:col-span-3">
                Add spend line
              </button>
            </form>
          </div>
        </section>
      )}

      <section>
        <h2 className="text-xs font-medium uppercase tracking-wider text-slate-500">Funnel</h2>
        <div className="mt-3 grid gap-2">
          {snap.funnel.map(step => (
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
        <h2 className="text-xs font-medium uppercase tracking-wider text-slate-500">By source</h2>
        <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-normal">Source</th>
                <th className="px-4 py-2 text-right font-normal">Leads</th>
                <th className="px-4 py-2 text-right font-normal">Quotes</th>
                <th className="px-4 py-2 text-right font-normal">Wins</th>
                <th className="px-4 py-2 text-right font-normal">Won $</th>
              </tr>
            </thead>
            <tbody>
              {snap.sources.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-slate-500">No events in this range.</td>
                </tr>
              ) : (
                snap.sources.map(s => (
                  <tr key={s.source} className="border-t border-slate-200">
                    <td className="px-4 py-2 text-slate-800">{s.source}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{s.leads}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{s.quotes}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{s.wins}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-blue-700">{formatCurrency(s.wonValue)}</td>
                  </tr>
                ))
              )}
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
                <th className="px-4 py-2 text-left font-normal">Contact</th>
                <th className="px-4 py-2 text-left font-normal">Source</th>
              </tr>
            </thead>
            <tbody>
              {snap.recent.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-slate-500">Nothing logged yet.</td>
                </tr>
              ) : (
                snap.recent.map(r => (
                  <tr key={r.id} className="border-t border-slate-200">
                    <td className="px-4 py-2 text-slate-500 whitespace-nowrap">{r.occurred_on}</td>
                    <td className="px-4 py-2 text-slate-800">{EVENT_LABEL[r.event] || r.event}</td>
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
