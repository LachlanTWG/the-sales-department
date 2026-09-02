// Token-gated activity entry form, designed to be iframed inside GoHighLevel
// via a Custom Menu Link (one signed URL per client — generate with
// `node src/scripts/makeEodEntryLink.js <slug>` in the repo root). There is
// no login session here: the HMAC token in the URL pins the page to one
// company, and submissions run through the same /api/activities/manual
// dual-write funnel as the dashboard's Add Activity drawer, so entries land
// in the reports AND the dashboard. Listed in proxy.ts PUBLIC_PATHS and
// allowed to be framed via next.config.ts headers.

import type { Metadata } from "next";
import { verifyEodEntryToken } from "@/lib/eodEntryToken";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  cleanScrapedName,
  fetchAllExecNames,
  fetchCompanyToday,
  fetchContactHistory,
  fetchEodOptions,
  fetchGhlContact,
  fetchMyToday,
  fetchPendingSiteVisits,
} from "./data";
import { MeView, TabBar, TodayView } from "./views";
import { EodEntryForm } from "./EodEntryForm";
import { safeAnsweredCallbacks, safeQuotieActions, type QuotieConfig } from "./quotie";
// Force dark even if THEME_BOOT already ran (dashboard cookie is light).
const EOD_THEME_BOOT = `(function(){try{var r=document.documentElement;r.classList.add("dark");r.style.colorScheme="dark";}catch(e){}})();`;

export const metadata: Metadata = {
  title: "EOD Entry",
  robots: { index: false, follow: false },
};

/** Today's calendar date in the company's timezone (en-CA → YYYY-MM-DD). */
function todayIn(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: EOD_THEME_BOOT }} />
      <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-6">
        <p className="max-w-sm text-center text-sm text-zinc-400">{children}</p>
      </main>
    </>
  );
}

export default async function EodEntryPage({
  searchParams,
}: {
  searchParams: Promise<{
    token?: string;
    location?: string;
    contact_name?: string;
    contact_id?: string;
    tab?: string;
    exec?: string;
  }>;
}) {
  const { token, location, contact_name, contact_id, tab, exec } = await searchParams;
  const slug = token ? verifyEodEntryToken(token) : null;
  if (!token || !slug) {
    return <Notice>This entry link is missing or invalid. Ask Lachlan for a fresh link.</Notice>;
  }

  // "agency" is the browser extension's pseudo-slug: one token for the whole
  // team, with the client resolved per page view from the GHL location id in
  // the URL the exec is currently on.
  const supabase = createAdminClient();
  let query = supabase.from("companies").select("id, name, slug, timezone, active, quotie_config");
  if (slug === "agency") {
    if (!location) return <Notice>Open this from the EOD Logger extension inside GHL.</Notice>;
    query = query.eq("ghl_location_id", location);
  } else {
    query = query.eq("slug", slug);
  }
  const { data: company } = await query.single();
  if (!company || !company.active) {
    return <Notice>This client is no longer active. Ask Lachlan for a fresh link.</Notice>;
  }

  const cName = contact_name?.trim() || "";
  const cId = contact_id?.trim() || "";
  const base = { token, location, contact_name: cName || undefined, contact_id: cId || undefined };
  const activeTab = tab === "today" ? ("today" as const) : tab === "me" ? ("me" as const) : ("log" as const);
  const today = todayIn(company.timezone);

  let content: React.ReactNode;
  if (activeTab === "today") {
    const stats = await fetchCompanyToday(company.id, today);
    content = <TodayView companyName={company.name} date={today} today={stats} />;
  } else if (activeTab === "me") {
    const execNames = await fetchAllExecNames();
    const my = exec ? await fetchMyToday(exec, tz => todayIn(tz)) : null;
    content = <MeView exec={exec || ""} execNames={execNames} my={my} base={base} />;
  } else {
    const scraped = cleanScrapedName(cName);
    const { data: peopleRows } = await supabase
      .from("sales_people")
      .select("name")
      .eq("company_id", company.id)
      .eq("active", true)
      .order("name");
    const people = (peopleRows ?? []).map(p => p.name);

    const [options, history, ghl, pendingVisits] = await Promise.all([
      fetchEodOptions(company.id),
      fetchContactHistory(company.id, cId, scraped),
      fetchGhlContact(location || "", cId, people),
      fetchPendingSiteVisits(company.id, company.name, company.slug, {
        ghlLocationId: location || "",
        timeZone: company.timezone || "Australia/Sydney",
        pageContactId: cId,
        pageContactName: scraped || undefined,
        people,
      }),
    ]);
    // Name precedence: GHL API (authoritative, needs a location token) →
    // DB name for a known contact → the extension's DOM scrape (fragile,
    // junk-filtered). Junk can poison the DB via a bad submission, so the
    // API also outranks the DB.
    const displayName = ghl.name || cleanScrapedName(history?.canonicalName || "") || scraped;
    // Address: GHL Street Address first, then last address we logged for them.
    const displayAddress = ghl.address || history?.lastAddress || "";
    // Lead source: EOD 5 if it exists for this contact.
    const displaySource = history?.lastSource || history?.topSource || "";
    // Owner from GHL contact assignment → roster match.
    const defaultExec = ghl.ownerName || "";
    // Safe outcome→type projection for the Quotie action sections. Empty {}
    // for clients without a configured api_key — zero visual change.
    const quotieActions = safeQuotieActions(company.quotie_config);
    // EOD 2 (Answered?) → pipeline callback projection (no_answer / voicemail).
    const answeredCallbacks = safeAnsweredCallbacks(company.quotie_config);
    // Feature flag for the always-available task checkbox: quotieActions is
    // {} both for "no api_key" and "no mapped outcomes", so derive separately.
    const quotieEnabled = !!(company.quotie_config as QuotieConfig | null | undefined)?.api_key;
    content = (
      <EodEntryForm
        token={token}
        ghlLocationId={location || ""}
        companyName={company.name}
        people={people}
        defaultDate={today}
        contactName={displayName}
        contactId={cId}
        contactAddress={displayAddress}
        contactPhone={ghl.phone}
        contactEmail={ghl.email}
        defaultLeadSource={displaySource}
        defaultSalesPerson={defaultExec}
        options={options}
        history={history}
        pendingSiteVisits={pendingVisits}
        quotieActions={quotieActions}
        answeredCallbacks={answeredCallbacks}
        quotieEnabled={quotieEnabled}
      />
    );
  }

  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: EOD_THEME_BOOT }} />
      <main className="min-h-screen bg-zinc-950 text-zinc-100">
        <div className="mx-auto max-w-md px-5 py-4">
          <TabBar active={activeTab} base={base} />
          {content}
        </div>
      </main>
    </>
  );
}
