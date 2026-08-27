// Ingest Edge Function — Phase 1 of the Railway → Supabase migration.
//
// Ports the webhook layer of src/server.js to Deno, writing POSTGRES ONLY
// (no Google Sheets). Routes (after the /ingest prefix) mirror the Node
// server so senders only change the base URL:
//   POST /webhook/ghl/eod         GHL EOD Update
//   POST /webhook/ghl             (legacy alias of the above)
//   POST /webhook/ghl/job-won     GHL Job Won
//   POST /webhook/ghl/site-visit  GHL Site Visit Booked
//   POST /webhook/quote           Make.com / Quotie Quote Sent
//   POST /webhook/email           Make.com Email Sent
//   POST /api/activities/manual   Dashboard manual entry (batch)
//   GET  /health                  Liveness + DB reachability
//
// Auth: WEBHOOK_SECRET as `Authorization: Bearer <secret>` or `?token=`.
// FAIL-CLOSED: if the secret isn't configured, every non-health route
// returns 503 (senders retry; nothing is silently accepted). Deployed with
// verify_jwt disabled (config.toml) — external senders can't mint Supabase
// JWTs; the shared secret is the gate, same as the Node server.
//
// ?dryrun=1 on any webhook route: parse + resolve but DO NOT insert; returns
// the would-be activities row. Used by the replay-parity harness.
//
// All parsing logic lives in core.mjs (runtime-agnostic, shared verbatim
// with the Node parity harness — proven against 1,197 real payloads).

import { createClient } from "npm:@supabase/supabase-js@2";
import { brotliDecompressSync } from "node:zlib";
import {
  decodeBodyText,
  buildGHLEodActivity,
  buildGHLJobWonActivity,
  buildGHLSiteVisitActivity,
  buildQuoteActivity,
  buildEmailActivity,
  buildManualActivity,
  toInsertRow,
} from "./core.mjs";

// Supabase's edge runtime exposes waitUntil for post-response work.
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET");
// Sales Exec Invoicing — optional. When set, Job Won manual entries also
// write commission sheet rows (no GHL custom fields required).
const COMMISSION_WEBHOOK_URL = (Deno.env.get("COMMISSION_WEBHOOK_URL") || "").trim();

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// ─── Lookup caches (warm-instance scope, short TTL so roster edits land) ──
// Misses bust the cache and refetch once: a just-added company/exec must
// never 404 or fall to sales_person_id=NULL because of a stale cache.
type Company = { id: string; name: string; timezone: string; ghl_location_id: string | null };
type RosterEntry = { id: string; name: string; active: boolean };
const TTL_MS = 5 * 60 * 1000;
let companiesCache: { at: number; rows: Company[] } | null = null;
const rosterCache = new Map<string, { at: number; rows: RosterEntry[] }>();

async function getCompanies(fresh = false): Promise<Company[]> {
  if (!fresh && companiesCache && Date.now() - companiesCache.at < TTL_MS) return companiesCache.rows;
  const { data, error } = await supabase
    .from("companies")
    .select("id, name, timezone, ghl_location_id")
    .eq("active", true); // inactive clients stop ingesting, like removal from COMPANIES_JSON did
  if (error) throw new Error(`companies lookup: ${error.message}`);
  companiesCache = { at: Date.now(), rows: data as Company[] };
  return companiesCache.rows;
}

async function findCompany(pred: (c: Company) => boolean): Promise<Company | null> {
  let company = (await getCompanies()).find(pred) ?? null;
  if (!company) company = (await getCompanies(true)).find(pred) ?? null; // bust-on-miss
  return company;
}

async function getRoster(companyId: string, fresh = false): Promise<RosterEntry[]> {
  const hit = rosterCache.get(companyId);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.rows;
  const { data, error } = await supabase
    .from("sales_people")
    .select("id, name, active")
    .eq("company_id", companyId);
  if (error) throw new Error(`sales_people lookup: ${error.message}`);
  const rows = data as RosterEntry[];
  rosterCache.set(companyId, { at: Date.now(), rows });
  return rows;
}

async function resolveSalesPersonId(companyId: string, personName: string): Promise<string | null> {
  if (!personName || personName === "Team") return null;
  let match = (await getRoster(companyId)).find((p) => p.name === personName);
  if (!match) match = (await getRoster(companyId, true)).find((p) => p.name === personName); // bust-on-miss
  return match?.id ?? null;
}

// ─── Body parsing (decompress + tolerant JSON, mirrors parseBody) ────
async function parseBody(req: Request): Promise<Record<string, unknown>> {
  const encoding = (req.headers.get("content-encoding") || "").toLowerCase();
  const raw = new Uint8Array(await req.arrayBuffer());

  let text: string;
  if (encoding === "gzip" || encoding === "deflate") {
    try {
      const ds = new DecompressionStream(encoding as "gzip" | "deflate");
      const stream = new Blob([raw]).stream().pipeThrough(ds);
      text = await new Response(stream).text();
    } catch {
      text = new TextDecoder().decode(raw); // mirror Node: fall back to raw on error
    }
  } else if (encoding === "br") {
    try {
      text = new TextDecoder().decode(brotliDecompressSync(raw));
    } catch {
      text = new TextDecoder().decode(raw);
    }
  } else {
    text = new TextDecoder().decode(raw);
  }
  return decodeBodyText(text) as Record<string, unknown>;
}

// ─── Helpers ─────────────────────────────────────────────────────────
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Best-effort: push a Job Won to Sales Exec Invoicing. Never throws. */
async function reportJobWonToCommission(
  companyName: string,
  entry: Record<string, unknown>,
): Promise<{ ok: boolean; skipped?: boolean; status?: number; error?: string }> {
  if (!COMMISSION_WEBHOOK_URL) return { ok: true, skipped: true };
  const quoteRaw = String(entry.quoteJobValue ?? "");
  const quoteValue = quoteRaw.split("|")[0].trim();
  const payload = {
    company_name: companyName,
    exec_name: String(entry.salesPerson ?? ""),
    full_name: String(entry.contactName ?? ""),
    address: String(entry.contactAddress ?? ""),
    quote_value_incl_gst: quoteValue,
    quote_number: String(entry.quoteNumber ?? "").trim(),
    split_commission: Boolean(entry.splitCommission),
    half_commission_charge: Boolean(entry.halfCommissionCharge),
  };
  try {
    const res = await fetch(COMMISSION_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      console.error(
        `[commission] ${companyName} / ${payload.exec_name} / ${payload.quote_number} → ${res.status}: ${text.slice(0, 300)}`,
      );
      return { ok: false, status: res.status, error: text.slice(0, 300) };
    }
    console.log(
      `[commission] ${companyName} / ${payload.exec_name} / ${payload.full_name} / $${payload.quote_value_incl_gst} / #${payload.quote_number}`,
    );
    return { ok: true, status: res.status };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    console.error(`[commission] request failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

// Audit a /webhook/* request. body is persisted ONLY on failures so a lost
// activity is always replayable from webhook_events (the sheet copy is gone).
function auditWebhookEvent(
  path: string, method: string, status: number, ip: string | null,
  error: string | null, body: unknown = null,
) {
  const p = supabase.from("webhook_events")
    .insert({ path, method, status, ip, body: body ?? null, error })
    .then(({ error: e }) => {
      if (e) console.error(`[webhook_events] insert failed (${path}): ${e.message}`);
    });
  // The worker can be torn down right after the response — waitUntil keeps
  // the audit insert alive. Falls back to a floating promise locally.
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime) EdgeRuntime.waitUntil(p as Promise<unknown>);
}

type BuiltActivity = NonNullable<ReturnType<typeof buildGHLEodActivity>["activity"]>;

async function insertActivity(
  activity: BuiltActivity,
  companyId: string,
  rawPayload: unknown,
): Promise<{ error?: string }> {
  const salesPersonId = await resolveSalesPersonId(companyId, activity.salesPersonName);
  const row = toInsertRow(activity, { companyId, salesPersonId, rawPayload });
  // upsert+ignoreDuplicates mirrors Node's ON CONFLICT DO NOTHING. No-op
  // today (source_row_id is null → NULLS DISTINCT) but keeps backfills with
  // a real source_row_id idempotent.
  const { error } = await supabase
    .from("activities")
    .upsert(row, { onConflict: "company_id,source,source_row_id", ignoreDuplicates: true });
  return error ? { error: error.message } : {};
}

// ─── Server ──────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const url = new URL(req.url);
  // Path arrives as /ingest/<route>; strip the function-name prefix.
  const pathname = url.pathname.replace(/^\/ingest/, "") || "/";
  const ip = req.headers.get("x-forwarded-for");
  const dryrun = url.searchParams.get("dryrun") === "1";
  const isWebhookPath = pathname.startsWith("/webhook");

  try {
    // Health (no auth, like the Node server's /health + /health/db)
    if (pathname === "/" || pathname === "/health") {
      const { error } = await supabase.from("companies").select("id", { head: true, count: "exact" });
      if (error) return json(503, { status: "error", db: "unreachable" });
      return json(200, { status: "ok", db: "ok" });
    }

    // Auth gate — FAIL CLOSED when the secret isn't configured. 503 (not
    // 401/200) so senders retry instead of dropping data on a misdeploy.
    if (!WEBHOOK_SECRET) {
      console.error(`[503] ${req.method} ${pathname} — WEBHOOK_SECRET not configured`);
      if (isWebhookPath) auditWebhookEvent(pathname, req.method, 503, ip, "WEBHOOK_SECRET not configured");
      return json(503, { error: "Service not configured" });
    }
    const authHeader = req.headers.get("authorization");
    const queryToken = url.searchParams.get("token");
    if (authHeader !== `Bearer ${WEBHOOK_SECRET}` && queryToken !== WEBHOOK_SECRET) {
      console.warn(`[401] ${req.method} ${pathname} from ${ip ?? "?"}`);
      // Deliberately audited even under ?dryrun=1 — unauthorized probes
      // should never have a stealth mode.
      if (isWebhookPath) auditWebhookEvent(pathname, req.method, 401, ip, "Unauthorized");
      return json(401, { error: "Unauthorized" });
    }

    const body = await parseBody(req);

    // Wraps a route result: audits /webhook/* and returns the response.
    const respond = (status: number, payload: Record<string, unknown>, auditError: string | null = null, auditBody: unknown = null) => {
      if (isWebhookPath && !dryrun) {
        auditWebhookEvent(
          pathname, req.method, status, ip,
          auditError ?? (status >= 400 ? JSON.stringify(payload).slice(0, 500) : null),
          auditBody,
        );
      }
      return json(status, payload);
    };

    // Shared: resolve company from GHL location.id
    async function resolveGHLCompany(): Promise<Company | Response> {
      const locationId = (body as { location?: { id?: string } }).location?.id;
      if (!locationId) return respond(400, { error: "Missing location.id" });
      const company = await findCompany((c) => c.ghl_location_id === locationId);
      if (!company) {
        console.log(`[GHL] Unknown location: ${locationId}`);
        // Persist the body: an unmapped location is recoverable config drift,
        // and GHL won't retry. Replayable once the mapping is fixed.
        return respond(404, { error: `No company for location ${locationId}` }, null, body);
      }
      return company;
    }

    // Shared: resolve company by name (quote / email / manual routes)
    async function resolveCompanyByName(name: string): Promise<Company | null> {
      const target = String(name || "").toLowerCase();
      return await findCompany((c) => c.name.toLowerCase() === target);
    }

    // Shared tail for the GHL + quote/email routes: insert (or dryrun) and respond.
    async function finish(
      company: Company,
      built: { skip?: boolean; reason?: string; activity?: BuiltActivity },
      okPayload: Record<string, unknown>,
      label: string,
    ): Promise<Response> {
      if (built.skip || !built.activity) {
        console.log(`[${label}] skipped: ${built.reason}`);
        return respond(200, { status: "skipped", reason: built.reason });
      }
      const activity = built.activity;
      if (dryrun) {
        const salesPersonId = await resolveSalesPersonId(company.id, activity.salesPersonName);
        return json(200, { status: "dryrun", row: toInsertRow(activity, { companyId: company.id, salesPersonId, rawPayload: null }) });
      }
      const { error } = await insertActivity(activity, company.id, body);
      if (error) {
        // 200 to the sender (no retry storms — Node behaved the same), but
        // audited as a 500 WITH the payload so the activity is replayable
        // and the health page counts it as a failure. Generic body: raw
        // Postgres errors don't belong in sender logs.
        console.error(`[${label}] insert error ${company.name}: ${error}`);
        return respond(200, { status: "error" }, `insert failed: ${error.slice(0, 400)}`, body);
      }
      console.log(`[${label}] ${company.name} / ${activity.salesPersonName}`);
      return respond(200, { ...okPayload, salesPerson: activity.salesPersonName });
    }

    // ─── GHL routes ────────────────────────────────────────────────────
    if (pathname === "/webhook/ghl/eod" || pathname === "/webhook/ghl") {
      const company = await resolveGHLCompany();
      if (company instanceof Response) return company;
      const roster = await getRoster(company.id);
      const built = buildGHLEodActivity(body, company.timezone, roster);
      return await finish(company, built, { status: "logged", type: "eod", company: company.name }, "GHL EOD");
    }

    if (pathname === "/webhook/ghl/job-won") {
      const company = await resolveGHLCompany();
      if (company instanceof Response) return company;
      const roster = await getRoster(company.id);
      const built = buildGHLJobWonActivity(body, company.timezone, roster);
      return await finish(company, built, {
        status: "logged", type: "job-won", company: company.name,
        value: built.activity?.quoteJobValue ?? "",
      }, "GHL JOB WON");
    }

    if (pathname === "/webhook/ghl/site-visit") {
      const company = await resolveGHLCompany();
      if (company instanceof Response) return company;
      const roster = await getRoster(company.id);
      const built = buildGHLSiteVisitActivity(body, company.timezone, roster);
      return await finish(company, built, { status: "logged", type: "site-visit", company: company.name }, "GHL SITE VISIT");
    }

    // ─── Make.com / Quotie routes ──────────────────────────────────────
    if (pathname === "/webhook/quote") {
      const companyName = String((body as { companyName?: string }).companyName ?? "");
      const company = await resolveCompanyByName(companyName);
      if (!company) return respond(404, { error: `Company "${companyName}" not found` }, null, body);
      const built = buildQuoteActivity(body, company.timezone);
      return await finish(company, built, { status: "logged", type: "quote", company: company.name }, "QUOTE");
    }

    if (pathname === "/webhook/email") {
      const companyName = String((body as { companyName?: string }).companyName ?? "");
      const company = await resolveCompanyByName(companyName);
      if (!company) return respond(404, { error: `Company "${companyName}" not found` }, null, body);
      const built = buildEmailActivity(body, company.timezone);
      return await finish(company, built, {
        status: "logged", type: "email", company: company.name,
        date: built.activity?.occurredOn ?? "", contact: built.activity?.contactName ?? "",
      }, "EMAIL");
    }

    // ─── Dashboard manual entry (batch, atomic) ────────────────────────
    if (pathname === "/api/activities/manual" && req.method === "POST") {
      const manualBody = body as { companyName?: string; activities?: Record<string, unknown>[] };
      const company = await resolveCompanyByName(String(manualBody.companyName ?? ""));
      if (!company) return json(404, { error: `Company "${manualBody.companyName}" not found` });

      const entries = Array.isArray(manualBody.activities) ? manualBody.activities : [];
      if (entries.length === 0) return json(400, { error: "No activities provided" });

      const builts: BuiltActivity[] = [];
      for (const e of entries) {
        if (!e || !/^\d{4}-\d{2}-\d{2}$/.test(String(e.date ?? ""))) {
          return json(400, { error: "Each activity needs a valid date (YYYY-MM-DD)" });
        }
        const built = buildManualActivity(e);
        if (built.skip || !built.activity) return json(400, { error: built.reason });
        builts.push(built.activity);
      }

      // Resolve each distinct person once, then ONE atomic batch insert —
      // a partial failure can't strand half the rows for a duplicating retry.
      const idByName = new Map<string, string | null>();
      for (const a of builts) {
        if (!idByName.has(a.salesPersonName)) {
          idByName.set(a.salesPersonName, await resolveSalesPersonId(company.id, a.salesPersonName));
        }
      }
      // Persist the sheet-shaped entry (incl. splitCommission / halfCommissionCharge)
      // so TWA Conversion can derive team-split / 50% charge without a mass backfill.
      const rows = builts.map((a, i) => toInsertRow(a, {
        companyId: company.id,
        salesPersonId: idByName.get(a.salesPersonName) ?? null,
        rawPayload: { ...(entries[i] || {}), via: "dashboard" },
      }));
      if (dryrun) return json(200, { status: "dryrun", rows });

      const { error } = await supabase.from("activities").insert(rows);
      if (error) {
        console.error(`[MANUAL] insert error ${company.name}: ${error.message}`);
        return json(500, { error: `Insert failed: ${error.message}` });
      }

      // Job Won → Sales Exec Invoicing commission sheets (best-effort).
      const commissionResults = [];
      for (const e of entries) {
        if (e && e.eventType === "Job Won") {
          commissionResults.push(await reportJobWonToCommission(company.name, e));
        }
      }

      console.log(`[MANUAL] ${company.name} — ${entries.length} activit${entries.length === 1 ? "y" : "ies"}`);
      return json(200, {
        status: "logged",
        company: company.name,
        count: entries.length,
        commissions: commissionResults.length,
      });
    }

    // Unknown path: audit /webhook/* misses (catches senders pointed at an
    // unported route during cutover), mirroring the Node res.end hook.
    if (isWebhookPath) return respond(404, { error: "Not found" });
    return json(404, { error: "Not found" });
  } catch (e) {
    // A thrown lookup (DB outage) must still leave a trace + JSON response.
    const msg = String((e as Error)?.message ?? e).slice(0, 500);
    console.error(`[500] ${req.method} ${pathname}: ${msg}`);
    if (isWebhookPath) auditWebhookEvent(pathname, req.method, 500, ip, msg);
    return json(500, { error: "Internal error" });
  }
});
