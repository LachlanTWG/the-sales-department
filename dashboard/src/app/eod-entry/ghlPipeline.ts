// After the popup logs an EOD call, move the contact's opportunity in the
// location's EOD pipeline directly via the Opportunities API. This replaces
// the retired custom-field nudge (EOD 1–5 fields + "Contact Changed"
// workflows are deleted from GHL) — the outcome→stage ladder that lived in
// each location's workflow now lives here.
//
// When the contact has no opportunity in the EOD pipeline yet, one is
// created at the target stage (e.g. Requires Quoting). When the form
// submits without a contact_id (free-typed name / Direct Phone Call), we
// resolve the contact by exact name match in GHL first so create/move still
// runs.
//
// Job Won entries also land here: stage → Accepted (or client equivalent),
// status → won, and monetaryValue set from the logged job value so GHL
// pipeline reporting stays in sync with the Activity Log.
//
// Requires the location's Private Integration token to have View/Edit
// Opportunities + pipelines.readonly (plus the existing contact scopes).

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normaliseName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function locationToken(locationId: string): string | null {
  try {
    const tokens = JSON.parse(process.env.GHL_LOCATION_TOKENS || "{}");
    return tokens[locationId] || null;
  } catch {
    return null;
  }
}

/** First numeric tier from a job-value string ("$12,500" or "5000|6000"). */
export function parseMonetaryValue(raw: string | number | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const first = String(raw)
    .split("|")[0]
    .replace(/[$,\s]/g, "")
    .trim();
  if (!first) return null;
  const n = Number(first);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Prefer an explicit contact_id; otherwise look up a unique exact-name match
 * in the location so free-typed EOD logs (e.g. Direct Phone Call) can still
 * create/move the opportunity.
 */
export async function resolveGhlContactId(input: {
  locationId: string;
  contactId?: string | null;
  contactName?: string | null;
}): Promise<{ contactId: string } | { contactId: null; reason: string }> {
  const existing = input.contactId?.trim() || "";
  if (existing) return { contactId: existing };

  const locationId = input.locationId?.trim() || "";
  const name = input.contactName?.trim() || "";
  if (!locationId) return { contactId: null, reason: "no linked GHL contact" };
  if (!name) return { contactId: null, reason: "no linked GHL contact" };

  const token = locationToken(locationId);
  if (!token) return { contactId: null, reason: "no API token for this location" };

  let contacts: { id: string; firstName?: string; lastName?: string; name?: string }[] = [];
  try {
    const res = await fetch(`${GHL_BASE}/contacts/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Version: GHL_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ locationId, page: 1, pageLimit: 20, query: name }),
      cache: "no-store",
    });
    if (res.status === 401 || res.status === 403) {
      return { contactId: null, reason: "token missing contact search scope" };
    }
    if (!res.ok) {
      return { contactId: null, reason: "couldn't search GHL contacts" };
    }
    const body = await res.json();
    contacts = body?.contacts ?? [];
  } catch (e) {
    return { contactId: null, reason: `GHL unreachable: ${(e as Error).message}` };
  }

  const target = normaliseName(name);
  const fullName = (c: { firstName?: string; lastName?: string; name?: string }) =>
    normaliseName(
      [c.firstName, c.lastName].filter(Boolean).join(" ") || c.name || "",
    );

  const exact = contacts.filter(c => fullName(c) === target);
  if (exact.length === 1) return { contactId: exact[0].id };
  if (exact.length > 1) {
    return {
      contactId: null,
      reason: `multiple GHL contacts named "${name}" — open the contact in GHL first`,
    };
  }
  // Single fuzzy hit only (query returned one person) — safe to attach.
  if (contacts.length === 1) return { contactId: contacts[0].id };
  if (contacts.length === 0) {
    return {
      contactId: null,
      reason: `no GHL contact found for "${name}" — open the contact in GHL first`,
    };
  }
  return {
    contactId: null,
    reason: `ambiguous GHL match for "${name}" — open the contact in GHL first`,
  };
}

// ─── EOD pipeline + stage resolution (cached per server instance) ────

type Stage = { id: string; name: string; norm: string };
type Pipeline = { id: string; stages: Stage[] };

const pipelineCache = new Map<string, Pipeline>();

const WON_STAGES = [
  "Accepted",
  "Accepted - Needs Scheduling*",
  "Deposit Paid / Job Won",
  "Verbal Confirmation",
];

// The EOD pipeline is the one carrying the day ladder — every client's
// "Sales Engine" (HDK: "Sales Pipeline") has a literal "Day 1" stage, and
// no other pipeline does.
async function getEodPipeline(locationId: string, token: string): Promise<Pipeline | "unauthorized" | null> {
  const cached = pipelineCache.get(locationId);
  if (cached) return cached;

  const res = await fetch(`${GHL_BASE}/opportunities/pipelines?locationId=${locationId}`, {
    headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION },
    cache: "no-store",
  });
  if (res.status === 401 || res.status === 403) return "unauthorized";
  if (!res.ok) return null;
  const body = await res.json();
  const pipelines: { id: string; stages?: { id: string; name: string }[] }[] = body?.pipelines ?? [];

  const eod = pipelines.find(p => (p.stages || []).some(s => normalise(s.name) === "day1"));
  if (!eod) return null;
  const pipeline: Pipeline = {
    id: eod.id,
    stages: (eod.stages || []).map(s => ({ id: s.id, name: s.name, norm: normalise(s.name) })),
  };
  pipelineCache.set(locationId, pipeline);
  return pipeline;
}

// First stage matching a candidate list. Candidates ending in "*" are
// prefix matches (e.g. Bolton's "Passed Onto Jed, Whats Doing?").
function findStage(stages: Stage[], candidates: string[]): Stage | null {
  for (const c of candidates) {
    const norm = normalise(c.endsWith("*") ? c.slice(0, -1) : c);
    const hit = c.endsWith("*")
      ? stages.find(s => s.norm.startsWith(norm))
      : stages.find(s => s.norm === norm);
    if (hit) return hit;
  }
  return null;
}

// ─── Outcome → stage ladder ─────────────────────────────────────────
//
// Stage names drift per client, so every target is a candidate list, most
// specific first. Pre/post "Not Ready Yet" variants cover Bolton ("Not
// Ready Yet" / "Not Ready Yet - Post Quote"), HDK ("Not Ready for Site
// Visit" / "Not Ready Yet - Follow Up List") and the canonical shape.
// Popup EOD 3 is a single "Not Ready Yet - Pre-Quote" (hyphen-less "Pre Quote"
// is folded at the dropdown); the notready* prefix still matches both.
const NOT_READY_PRE = ["Not Ready Yet - Pre-Quote", "Not Ready Yet", "Not Ready for Site Visit", "Not Yet Ready"];
const NOT_READY_POST = ["Not Ready Yet - Post-Quote", "Not Ready Yet - Post Quote", "Not Ready Yet - Follow Up List", "Added to PQS Follow Up List"];
const DAY_LADDER = ["Inbound Lead", "Day 1", "Day 2", "Day 3", "Day 4", "Day 5"];

function targetStageFor(
  stages: Stage[],
  current: Stage | null,
  input: { stage: string; answered: string; stdOutcome: string },
): { stage: Stage; status: OppStatus } | null {
  const out = normalise(input.stdOutcome);
  // Every non-terminal move carries status "open" so a revived dead lead
  // (e.g. Requires Quoting on a previously Lost contact) is re-opened.
  const to = (stage: Stage | null, status: OppStatus = "open") => (stage ? { stage, status } : null);

  if (out && out !== "didntanswer" && out !== "answered") {
    if (out.startsWith("lost")) return to(findStage(stages, ["Lost"]), "lost");
    if (out.startsWith("abandoned")) return to(findStage(stages, ["Abandoned"]), "abandoned");
    // GHL has no "disqualified" status — DQ stays distinct via its STAGE and
    // maps to "abandoned" so junk leads don't drag win rates (won/(won+lost)).
    if (out.startsWith("dq") || out.startsWith("disqualified")) return to(findStage(stages, ["Disqualified"]), "abandoned");
    if (out.startsWith("passedonto")) return to(findStage(stages, [input.stdOutcome + "*", "Passed Onto*"]));
    if (out.startsWith("notagoodtime")) return to(findStage(stages, ["Not a Good Time to Talk"]));
    if (out.startsWith("notready") || out.startsWith("notyetready")) {
      const postQuote = normalise(input.stage).includes("post");
      return to(findStage(stages, postQuote ? NOT_READY_POST : NOT_READY_PRE));
    }
    if (out === "requiresquoting") return to(findStage(stages, ["Requires Quoting"]));
    if (out === "quotesent") return to(findStage(stages, ["Quote Sent"]));
    if (out === "verbalconfirmation") return to(findStage(stages, ["Verbal Confirmation"]));
    if (out === "sitevisitbooked") return to(findStage(stages, ["Site Visit Booked", "Site Visit"]));
    if (out === "jobwon" || out === "dealclosed") return to(findStage(stages, WON_STAGES), "won");
    // Client-specific outcome that names a stage directly (e.g. ECE's
    // "Waiting on Photos") — move only on an exact stage-name match.
    return to(findStage(stages, [input.stdOutcome]));
  }

  // No standard outcome: a ring-out advances the day ladder. Only from a
  // ladder stage — a no-answer on a post-quote follow-up must not reset the
  // opportunity back into the ladder. No opportunity yet → Day 1.
  if (out === "didntanswer" || normalise(input.answered) === "didntanswer") {
    if (!current) return to(findStage(stages, ["Day 1"]));
    const idx = DAY_LADDER.findIndex(n => normalise(n) === current.norm);
    if (idx === -1 || idx === DAY_LADDER.length - 1) return null; // not on the ladder, or parked at Day 5
    return to(findStage(stages, [DAY_LADDER[idx + 1]]));
  }

  return null;
}

// ─── Opportunity lookup / move ──────────────────────────────────────

export type OppStatus = "open" | "won" | "lost" | "abandoned";

async function findOpportunity(
  locationId: string,
  token: string,
  contactId: string,
  pipelineId: string,
): Promise<{ id: string; pipelineStageId: string; status: OppStatus; monetaryValue?: number | null } | null> {
  const res = await fetch(
    `${GHL_BASE}/opportunities/search?location_id=${locationId}&contact_id=${encodeURIComponent(contactId)}&limit=20`,
    { headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION }, cache: "no-store" },
  );
  if (!res.ok) return null;
  const body = await res.json();
  const opps: {
    id: string;
    pipelineId: string;
    pipelineStageId: string;
    status?: string;
    createdAt?: string;
    monetaryValue?: number | string | null;
  }[] = body?.opportunities ?? [];
  const inPipeline = opps.filter(o => o.pipelineId === pipelineId);
  // Prefer open opps (the live deal). Fall back to most recent any-status so
  // a re-logged Job Won can still patch value/status on an already-won card.
  const open = inPipeline.filter(o => (o.status || "open") === "open");
  const pick = (open.length > 0 ? open : inPipeline)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))[0];
  if (!pick) return null;
  const mv = pick.monetaryValue;
  const monetaryValue =
    mv == null || mv === "" ? null : Number.isFinite(Number(mv)) ? Number(mv) : null;
  return {
    id: pick.id,
    pipelineStageId: pick.pipelineStageId,
    status: (pick.status as OppStatus) || "open",
    monetaryValue,
  };
}

export type PipelinePushResult = { ok: true; moved?: string } | { ok: false; reason: string };

function formatValueNote(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  return ` · value $${Math.round(value).toLocaleString("en-AU")}`;
}

export async function moveEodOpportunity(input: {
  locationId: string;
  contactId: string;
  contactName?: string;
  stage: string;      // EOD 1 — lead type (New Lead / Pre- / Post-Quote Follow Up)
  answered: string;   // EOD 2
  stdOutcome: string; // EOD 3
  /** When set (Job Won), written to GHL opportunity.monetaryValue. */
  monetaryValue?: number | null;
}): Promise<PipelinePushResult> {
  const { locationId, contactId } = input;
  if (!locationId || !contactId) return { ok: false, reason: "no linked GHL contact" };
  const token = locationToken(locationId);
  if (!token) return { ok: false, reason: "no API token for this location" };

  const monetaryValue =
    input.monetaryValue != null && Number.isFinite(input.monetaryValue)
      ? input.monetaryValue
      : null;
  const isWin =
    normalise(input.stdOutcome) === "jobwon" ||
    normalise(input.stdOutcome) === "dealclosed";

  let pipeline: Pipeline | "unauthorized" | null;
  try {
    pipeline = await getEodPipeline(locationId, token);
  } catch {
    return { ok: false, reason: "couldn't read the location's pipelines" };
  }
  if (pipeline === "unauthorized") return { ok: false, reason: "token missing the opportunity/pipeline scopes" };
  if (!pipeline) return { ok: false, reason: "no EOD pipeline (with a Day 1 stage) in this location" };

  let opp: { id: string; pipelineStageId: string; status: OppStatus; monetaryValue?: number | null } | null;
  try {
    opp = await findOpportunity(locationId, token, contactId, pipeline.id);
  } catch {
    return { ok: false, reason: "couldn't search opportunities" };
  }

  const current = opp ? pipeline.stages.find(s => s.id === opp!.pipelineStageId) || null : null;
  let target = targetStageFor(pipeline.stages, current, input);

  // Job Won with no matching stage name: still mark status won (keep current
  // stage, or create on Day 1) so value + win rate stay correct.
  if (!target && isWin) {
    const fallback = current || findStage(pipeline.stages, ["Day 1", ...WON_STAGES]);
    if (fallback) target = { stage: fallback, status: "won" };
  }

  if (!target && monetaryValue == null) {
    return { ok: true, moved: "no stage change for this outcome" };
  }

  // Value-only patch when we have no stage target but do have a value + opp.
  if (!target && monetaryValue != null && opp) {
    try {
      const res = await fetch(`${GHL_BASE}/opportunities/${opp.id}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION, "Content-Type": "application/json" },
        body: JSON.stringify({
          pipelineId: pipeline.id,
          pipelineStageId: opp.pipelineStageId,
          status: isWin ? "won" : opp.status,
          monetaryValue,
        }),
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, reason: `GHL ${res.status}: ${text.slice(0, 120)}` };
      }
    } catch (e) {
      return { ok: false, reason: `GHL unreachable: ${(e as Error).message}` };
    }
    const statusBit = isWin && opp.status !== "won" ? " · marked won" : "";
    return { ok: true, moved: `value updated${statusBit}${formatValueNote(monetaryValue)}` };
  }

  if (!target) {
    return { ok: true, moved: "no stage change for this outcome" };
  }

  const sameStage = !!current && current.id === target.stage.id;
  const sameStatus = !!opp && opp.status === target.status;
  const sameValue =
    monetaryValue == null ||
    (opp?.monetaryValue != null && Number(opp.monetaryValue) === monetaryValue);
  if (sameStage && sameStatus && sameValue) {
    return {
      ok: true,
      moved: `already at ${target.stage.name}${formatValueNote(monetaryValue)}`,
    };
  }

  const putBody: Record<string, unknown> = {
    pipelineId: pipeline.id,
    pipelineStageId: target.stage.id,
    status: target.status,
  };
  if (monetaryValue != null) putBody.monetaryValue = monetaryValue;

  try {
    const res = opp
      ? await fetch(`${GHL_BASE}/opportunities/${opp.id}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION, "Content-Type": "application/json" },
          body: JSON.stringify(putBody),
          cache: "no-store",
        })
      : await fetch(`${GHL_BASE}/opportunities/`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION, "Content-Type": "application/json" },
          body: JSON.stringify({
            locationId,
            contactId,
            pipelineId: pipeline.id,
            pipelineStageId: target.stage.id,
            name: input.contactName || "EOD Lead",
            status: target.status,
            ...(monetaryValue != null ? { monetaryValue } : {}),
          }),
          cache: "no-store",
        });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, reason: `GHL ${res.status}: ${text.slice(0, 120)}` };
    }
  } catch (e) {
    return { ok: false, reason: `GHL unreachable: ${(e as Error).message}` };
  }

  // Banner text: name the stage, plus the status when it's noteworthy —
  // a terminal/won marking, or a dead lead coming back to life.
  const statusNote = target.status !== "open" ? ` · marked ${target.status}`
    : opp && opp.status !== "open" ? " · re-opened"
    : "";
  const verb = !opp ? `created at ${target.stage.name}`
    : sameStage ? `kept at ${target.stage.name}`
    : `moved to ${target.stage.name}`;
  return { ok: true, moved: verb + statusNote + formatValueNote(monetaryValue) };
}
