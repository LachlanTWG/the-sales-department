// /activities — filterable table of activity rows with inline edit/delete.
//
// RLS scopes what each viewer can see. Admin: all rows. Exec: own rows only.
// Edits + deletes go through server actions in ./actions.ts (also RLS-checked).

import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getViewer } from "@/lib/viewer";
import { listCompanies } from "@/lib/queries";
import { ActivityRow } from "./ActivityRow";
import { AddActivityButton } from "./AddActivityButton";
import { Filters } from "./Filters";
import { addDaysIso } from "@/lib/dates";
import { todayInTz, SYDNEY_TZ } from "@/lib/format";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

type SearchParams = {
  company?: string;
  person?: string;
  type?: string;
  from?: string;
  to?: string;
  q?: string;
  page?: string;
};

export default async function ActivitiesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const today = todayInTz(SYDNEY_TZ);
  const defaultFrom = addDaysIso(today, -14);

  const filters = {
    company: sp.company || "",
    person:  sp.person  || "",
    type:    sp.type    || "",
    from:    sp.from    || defaultFrom,
    to:      sp.to      || today,
    q:       sp.q       || "",
  };
  const page = Math.max(1, parseInt(sp.page || "1", 10));

  const viewer = await getViewer();
  const supabase = await createClient();

  // Viewer's own sales_person_ids — used to gate the "Edit" button on the
  // UI side (RLS is the real gate, but this prevents a confused exec from
  // clicking Edit on a row they can't actually save).
  const { data: mineRows } = await supabase
    .from("sales_people")
    .select("id, company_id")
    .eq("user_id", viewer.user.id);
  const mySalesPersonIds = new Set((mineRows || []).map(r => r.id as string));

  // Reference data for filters + edit drawer.
  const companies = await listCompanies(supabase);
  const { data: peopleRows } = await supabase
    .from("sales_people")
    .select("id, name, company_id")
    .order("name");
  const salesPeople = (peopleRows || []) as { id: string; name: string; company_id: string }[];

  // Build the query. RLS handles admin vs exec automatically.
  // Inactive clients (paused / offboarded) stay out of every exec surface.
  const activeIds = companies.map(c => c.id);
  let q = supabase
    .from("activities")
    .select("id, company_id, sales_person_id, sales_person_name, occurred_on, event_type, contact_name, contact_address, outcome, quote_job_value, appointment_at", { count: "exact" })
    .gte("occurred_on", filters.from)
    .lte("occurred_on", filters.to)
    .in("company_id", activeIds.length ? activeIds : ["00000000-0000-0000-0000-000000000000"])
    .order("occurred_on", { ascending: false })
    .order("created_at", { ascending: false });

  if (filters.company) q = q.eq("company_id", filters.company);
  if (filters.person)  q = q.eq("sales_person_id", filters.person);
  if (filters.type)    q = q.eq("event_type", filters.type);
  if (filters.q) {
    const or = searchOrFilter(filters.q, companies, salesPeople);
    if (or) q = q.or(or);
  }

  const from = (page - 1) * PAGE_SIZE;
  const to   = from + PAGE_SIZE - 1;
  const { data: rows, count, error } = await q.range(from, to);

  if (error) throw error;

  const companyById = new Map(companies.map(c => [c.id, c.name]));
  const totalPages = Math.max(1, Math.ceil((count || 0) / PAGE_SIZE));

  // Clients the viewer may add activities to: admins → all; execs → own roster.
  const addableCompanies = (viewer.isAdmin
    ? companies
    : companies.filter(c => viewer.companyIds.includes(c.id))
  ).map(c => ({ id: c.id, name: c.name, ownerName: c.owner_name ?? null }));

  return (
    <div className="px-6 py-6 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Activities</h1>
          <p className="mt-0.5 text-sm text-zinc-500">
            {viewer.seesAll
              ? "All activity rows across every active client."
              : "Activity on the clients you can access."}{" "}
            {viewer.canWriteSales
              ? "Edit or delete to correct mistakes; changes are saved directly to the database."
              : "Read-only."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500">
            {count?.toLocaleString() ?? 0} match{count === 1 ? "" : "es"}
          </span>
          {viewer.canWriteSales && (
          <AddActivityButton
            companies={addableCompanies}
            salesPeople={salesPeople}
            isAdmin={viewer.isAdmin}
            mySalesPersonIds={[...mySalesPersonIds]}
            defaultDate={today}
          />
          )}
        </div>
      </header>

      <div className="mt-5">
        <Filters companies={companies.map(c => ({ id: c.id, name: c.name }))} salesPeople={salesPeople} defaults={filters} />
      </div>

      <div className="mt-4 overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900/60 text-[10px] uppercase tracking-wider text-zinc-500">
            <tr>
              <th className="px-3 py-2 text-left font-normal">Date</th>
              <th className="hidden px-3 py-2 text-left font-normal md:table-cell">Company</th>
              <th className="hidden px-3 py-2 text-left font-normal sm:table-cell">Sales person</th>
              <th className="px-3 py-2 text-left font-normal">Type</th>
              <th className="px-3 py-2 text-left font-normal">Contact</th>
              <th className="hidden px-3 py-2 text-left font-normal lg:table-cell">Outcome</th>
              <th className="hidden px-3 py-2 text-left font-normal sm:table-cell">Value</th>
              <th className="px-2 py-2 text-right font-normal">Edit</th>
            </tr>
          </thead>
          <tbody>
            {(rows || []).length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-sm text-zinc-500">
                  No activities match the filters.
                </td>
              </tr>
            )}
            {(rows || []).map(row => {
              const canEdit = viewer.isAdmin || (row.sales_person_id ? mySalesPersonIds.has(row.sales_person_id) : false);
              return (
                <ActivityRow
                  key={row.id}
                  row={row}
                  companyName={companyById.get(row.company_id) || "—"}
                  companies={addableCompanies}
                  salesPeople={salesPeople}
                  canEdit={canEdit}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <Pager page={page} totalPages={totalPages} searchParams={sp} />
      )}
    </div>
  );
}

// PostgREST or() values: strip chars that break the filter grammar or act
// as LIKE wildcards. Quote numbers are not their own column — they sit in
// outcome (pipe-delimited on quote_sent, "Quote 7544 …" on emails).
function sanitiseSearch(raw: string): string {
  return raw.replace(/[%_,"'\\()]/g, " ").replace(/\s+/g, " ").trim();
}

function searchOrFilter(
  raw: string,
  companies: { id: string; name: string }[],
  salesPeople: { id: string; name: string }[],
): string | null {
  const needle = sanitiseSearch(raw);
  if (!needle) return null;
  const like = `"%${needle}%"`;
  const lower = needle.toLowerCase();
  const clauses = [
    `contact_name.ilike.${like}`,
    `contact_address.ilike.${like}`,
    `sales_person_name.ilike.${like}`,
    `outcome.ilike.${like}`,
  ];
  const companyIds = companies.filter(c => c.name.toLowerCase().includes(lower)).map(c => c.id);
  if (companyIds.length) clauses.push(`company_id.in.(${companyIds.join(",")})`);
  const personIds = salesPeople.filter(p => p.name.toLowerCase().includes(lower)).map(p => p.id);
  if (personIds.length) clauses.push(`sales_person_id.in.(${personIds.join(",")})`);
  return clauses.join(",");
}

function Pager({
  page,
  totalPages,
  searchParams,
}: {
  page: number;
  totalPages: number;
  searchParams: SearchParams;
}) {
  function href(p: number) {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) {
      if (v && k !== "page") u.set(k, String(v));
    }
    u.set("page", String(p));
    return `/activities?${u.toString()}`;
  }
  return (
    <div className="mt-4 flex items-center justify-between text-xs text-zinc-500">
      <div>
        Page <span className="text-zinc-300">{page}</span> of {totalPages}
      </div>
      <div className="flex gap-1">
        {page > 1 && (
          <Link href={href(page - 1)} className="rounded border border-zinc-800 px-2 py-1 hover:border-zinc-700 hover:text-zinc-200">
            ← Prev
          </Link>
        )}
        {page < totalPages && (
          <Link href={href(page + 1)} className="rounded border border-zinc-800 px-2 py-1 hover:border-zinc-700 hover:text-zinc-200">
            Next →
          </Link>
        )}
      </div>
    </div>
  );
}
