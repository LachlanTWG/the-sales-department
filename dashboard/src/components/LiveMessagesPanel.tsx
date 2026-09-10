// Shared live messages panel — renders the period tabs + per-company /
// per-team cards. Used by /me (viewer's own dashboard) and /execs/[name]
// (admin viewing any exec; exec viewing their own).
//
// Server component — pulls the data on render. Wrap with <LiveRefresh /> at
// the page level to get realtime re-render on activity changes.

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadDashboardMessages } from "@/lib/messages";
import { LiveMessage } from "@/components/LiveMessage";
import { PeriodTabs } from "@/components/PeriodTabs";
import { DateRangeBar } from "@/components/DateRangeBar";
import { lastCompletedSatFri, type Period } from "@/lib/dates";

export async function LiveMessagesPanel({
  supabase,
  period,
  targetExecName,
  targetSalesPersonIds,
  targetCompanyIds,
  isAdmin,
  basePath,
  customRange,
  today,
}: {
  supabase: SupabaseClient;
  period: Period;
  targetExecName: string | null;             // null if no exec linked (admin only)
  targetSalesPersonIds: Set<string>;
  targetCompanyIds: Set<string>;
  isAdmin: boolean;
  basePath: string;                           // for period tab links (e.g. "/me" or "/execs/Zac")
  customRange?: { from: string; to: string } | null;
  today: string;
}) {
  const messages = await loadDashboardMessages(supabase, {
    period,
    mySalesPersonIds: targetSalesPersonIds,
    myCompanyIds: targetCompanyIds,
    myDisplayName: targetExecName || "Team",
    rangeStart: customRange?.from,
    rangeEnd: customRange?.to,
  });
  const lastWeek = lastCompletedSatFri(today);
  const from = customRange?.from ?? messages.rangeStart;
  const to = customRange?.to ?? messages.rangeEnd;

  const byName = (a: { company: { name: string } }, b: { company: { name: string } }) =>
    a.company.name.localeCompare(b.company.name);
  const onRoster = messages.perCompany.filter(c => targetCompanyIds.has(c.company.id)).sort(byName);
  const offRoster = messages.perCompany.filter(c => !targetCompanyIds.has(c.company.id)).sort(byName);
  const ordered = [...onRoster, ...offRoster];
  const teamOrdered = [...messages.perCompany].filter(c => c.team).sort(byName);

  return (
    <>
      <PeriodTabs basePath={basePath} active={customRange ? null : period} />
      <div className="mt-3">
        <DateRangeBar
          action={basePath}
          from={from}
          to={to}
          today={today}
          presets={[{ label: "Last week", from: lastWeek.from, to: lastWeek.to }]}
        />
      </div>

      {targetSalesPersonIds.size > 0 && (
        <section className="mt-6">
          <SectionHeader
            title={targetExecName ? `${targetExecName}'s activity` : "Personal"}
            subtitle="Per company, scoped to this exec."
          />
          <CardRow>
            {ordered
              .filter(c => targetCompanyIds.has(c.company.id))
              .map(c => (
                <LiveMessage key={`p-${c.company.id}`} data={c.personal} variant="hero" />
              ))}
            {messages.personalTotal && (
              <LiveMessage key="p-total" data={messages.personalTotal} variant="hero" />
            )}
          </CardRow>
        </section>
      )}

      {isAdmin && (teamOrdered.length > 0 || messages.grandTotal) && (
        <section className="mt-8">
          <SectionHeader
            title="Team"
            subtitle="Every exec across every active company."
          />
          <CardRow>
            {teamOrdered.map(c => (
              <LiveMessage key={`t-${c.company.id}`} data={c.team} variant="hero" />
            ))}
            {messages.grandTotal && (
              <LiveMessage key="t-total" data={messages.grandTotal} variant="hero" />
            )}
          </CardRow>
        </section>
      )}
    </>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-3 flex items-baseline gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">{title}</h2>
      {subtitle && <span className="text-xs text-zinc-500">{subtitle}</span>}
    </div>
  );
}

function CardRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid auto-rows-fr grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
      {children}
    </div>
  );
}
