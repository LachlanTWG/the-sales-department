// Move (or create) a contact's opportunity in the location's EOD pipeline.
// Port of dashboard/src/app/eod-entry/ghlPipeline.ts for the Railway Node
// server — Quotie Quote Sent and GHL Job Won webhooks need the same ladder
// the EOD popup already runs on Vercel.
//
// Requires GHL_LOCATION_TOKENS JSON with View/Edit Opportunities +
// pipelines.readonly per location.

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

function normalise(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normaliseName(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function locationToken(locationId) {
  try {
    const tokens = JSON.parse(process.env.GHL_LOCATION_TOKENS || '{}');
    return tokens[locationId] || null;
  } catch {
    return null;
  }
}

/** First numeric tier from a job-value string ("$12,500" or "5000|6000"). */
function parseMonetaryValue(raw) {
  if (raw == null || raw === '') return null;
  const first = String(raw)
    .split('|')[0]
    .replace(/[$,\s]/g, '')
    .trim();
  if (!first) return null;
  const n = Number(first);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Prefer an explicit contact_id; otherwise look up a unique exact-name match.
 */
async function resolveGhlContactId({ locationId, contactId, contactName }) {
  const existing = String(contactId || '').trim();
  if (existing) return { contactId: existing };

  const loc = String(locationId || '').trim();
  const name = String(contactName || '').trim();
  if (!loc || !name) return { contactId: null, reason: 'no linked GHL contact' };

  const token = locationToken(loc);
  if (!token) return { contactId: null, reason: 'no API token for this location' };

  let contacts = [];
  try {
    const res = await fetch(`${GHL_BASE}/contacts/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Version: GHL_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ locationId: loc, page: 1, pageLimit: 20, query: name }),
    });
    if (res.status === 401 || res.status === 403) {
      return { contactId: null, reason: 'token missing contact search scope' };
    }
    if (!res.ok) return { contactId: null, reason: "couldn't search GHL contacts" };
    const body = await res.json();
    contacts = body?.contacts ?? [];
  } catch (e) {
    return { contactId: null, reason: `GHL unreachable: ${e.message}` };
  }

  const target = normaliseName(name);
  const fullName = (c) =>
    normaliseName([c.firstName, c.lastName].filter(Boolean).join(' ') || c.name || '');

  const exact = contacts.filter((c) => fullName(c) === target);
  if (exact.length === 1) return { contactId: exact[0].id };
  if (exact.length > 1) {
    return {
      contactId: null,
      reason: `multiple GHL contacts named "${name}" — open the contact in GHL first`,
    };
  }
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

// ─── Pipeline + stage resolution ────────────────────────────────────

const pipelineCache = new Map();

const WON_STAGES = [
  'Accepted',
  'Accepted - Needs Scheduling*',
  'Deposit Paid / Job Won',
  'Verbal Confirmation',
];

// Popup EOD 3 is a single "Not Ready Yet - Pre-Quote"; hyphen-less "Pre Quote"
// still matches via the notready* prefix. HDK's stage is "Not Ready for Site Visit".
const NOT_READY_PRE = [
  'Not Ready Yet - Pre-Quote',
  'Not Ready Yet',
  'Not Ready for Site Visit',
  'Not Yet Ready',
];
const NOT_READY_POST = [
  'Not Ready Yet - Post-Quote',
  'Not Ready Yet - Post Quote',
  'Not Ready Yet - Follow Up List',
  'Added to PQS Follow Up List',
];
const DAY_LADDER = ['Inbound Lead', 'Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5'];

async function getEodPipeline(locationId, token) {
  const cached = pipelineCache.get(locationId);
  if (cached) return cached;

  const res = await fetch(`${GHL_BASE}/opportunities/pipelines?locationId=${locationId}`, {
    headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION },
  });
  if (res.status === 401 || res.status === 403) return 'unauthorized';
  if (!res.ok) return null;
  const body = await res.json();
  const pipelines = body?.pipelines ?? [];

  const eod = pipelines.find((p) =>
    (p.stages || []).some((s) => normalise(s.name) === 'day1'),
  );
  if (!eod) return null;
  const pipeline = {
    id: eod.id,
    stages: (eod.stages || []).map((s) => ({
      id: s.id,
      name: s.name,
      norm: normalise(s.name),
    })),
  };
  pipelineCache.set(locationId, pipeline);
  return pipeline;
}

function findStage(stages, candidates) {
  for (const c of candidates) {
    const norm = normalise(c.endsWith('*') ? c.slice(0, -1) : c);
    const hit = c.endsWith('*')
      ? stages.find((s) => s.norm.startsWith(norm))
      : stages.find((s) => s.norm === norm);
    if (hit) return hit;
  }
  return null;
}

function targetStageFor(stages, current, input) {
  const out = normalise(input.stdOutcome);
  const to = (stage, status = 'open') => (stage ? { stage, status } : null);

  if (out && out !== 'didntanswer' && out !== 'answered') {
    if (out.startsWith('lost')) return to(findStage(stages, ['Lost']), 'lost');
    if (out.startsWith('abandoned')) return to(findStage(stages, ['Abandoned']), 'abandoned');
    if (out.startsWith('dq') || out.startsWith('disqualified')) {
      return to(findStage(stages, ['Disqualified']), 'abandoned');
    }
    if (out.startsWith('passedonto')) {
      return to(findStage(stages, [input.stdOutcome + '*', 'Passed Onto*']));
    }
    if (out.startsWith('notagoodtime')) {
      return to(findStage(stages, ['Not a Good Time to Talk']));
    }
    if (out.startsWith('notready') || out.startsWith('notyetready')) {
      const postQuote = normalise(input.stage).includes('post');
      return to(findStage(stages, postQuote ? NOT_READY_POST : NOT_READY_PRE));
    }
    if (out === 'requiresquoting') return to(findStage(stages, ['Requires Quoting']));
    if (out === 'quotesent') return to(findStage(stages, ['Quote Sent']));
    if (out === 'verbalconfirmation') return to(findStage(stages, ['Verbal Confirmation']));
    if (out === 'sitevisitbooked') {
      return to(findStage(stages, ['Site Visit Booked', 'Site Visit']));
    }
    if (out === 'jobwon' || out === 'dealclosed') {
      return to(findStage(stages, WON_STAGES), 'won');
    }
    return to(findStage(stages, [input.stdOutcome]));
  }

  if (out === 'didntanswer' || normalise(input.answered) === 'didntanswer') {
    if (!current) return to(findStage(stages, ['Day 1']));
    const idx = DAY_LADDER.findIndex((n) => normalise(n) === current.norm);
    if (idx === -1 || idx === DAY_LADDER.length - 1) return null;
    return to(findStage(stages, [DAY_LADDER[idx + 1]]));
  }

  return null;
}

async function findOpportunity(locationId, token, contactId, pipelineId) {
  const res = await fetch(
    `${GHL_BASE}/opportunities/search?location_id=${locationId}&contact_id=${encodeURIComponent(contactId)}&limit=20`,
    { headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION } },
  );
  if (!res.ok) return null;
  const body = await res.json();
  const opps = body?.opportunities ?? [];
  const inPipeline = opps.filter((o) => o.pipelineId === pipelineId);
  const open = inPipeline.filter((o) => (o.status || 'open') === 'open');
  const pick = (open.length > 0 ? open : inPipeline).sort((a, b) =>
    (b.createdAt || '').localeCompare(a.createdAt || ''),
  )[0];
  if (!pick) return null;
  const mv = pick.monetaryValue;
  const monetaryValue =
    mv == null || mv === '' ? null : Number.isFinite(Number(mv)) ? Number(mv) : null;
  return {
    id: pick.id,
    pipelineStageId: pick.pipelineStageId,
    status: pick.status || 'open',
    monetaryValue,
  };
}

function formatValueNote(value) {
  if (value == null || !Number.isFinite(value)) return '';
  return ` · value $${Math.round(value).toLocaleString('en-AU')}`;
}

/**
 * Move or create the contact's EOD-pipeline opportunity for a standard outcome.
 * @param {{ locationId: string, contactId: string, contactName?: string, stage?: string, answered?: string, stdOutcome: string, monetaryValue?: number|null }} input
 */
async function moveEodOpportunity(input) {
  const locationId = String(input.locationId || '').trim();
  let contactId = String(input.contactId || '').trim();
  const contactName = String(input.contactName || '').trim();

  if (!locationId) return { ok: false, reason: 'no linked GHL contact' };

  if (!contactId && contactName) {
    const resolved = await resolveGhlContactId({ locationId, contactId: '', contactName });
    if (resolved.contactId) contactId = resolved.contactId;
    else return { ok: false, reason: resolved.reason };
  }
  if (!contactId) return { ok: false, reason: 'no linked GHL contact' };

  const token = locationToken(locationId);
  if (!token) return { ok: false, reason: 'no API token for this location' };

  const monetaryValue =
    input.monetaryValue != null && Number.isFinite(input.monetaryValue)
      ? input.monetaryValue
      : null;
  const isWin =
    normalise(input.stdOutcome) === 'jobwon' || normalise(input.stdOutcome) === 'dealclosed';

  let pipeline;
  try {
    pipeline = await getEodPipeline(locationId, token);
  } catch {
    return { ok: false, reason: "couldn't read the location's pipelines" };
  }
  if (pipeline === 'unauthorized') {
    return { ok: false, reason: 'token missing the opportunity/pipeline scopes' };
  }
  if (!pipeline) {
    return { ok: false, reason: 'no EOD pipeline (with a Day 1 stage) in this location' };
  }

  let opp;
  try {
    opp = await findOpportunity(locationId, token, contactId, pipeline.id);
  } catch {
    return { ok: false, reason: "couldn't search opportunities" };
  }

  const stageInput = {
    stage: input.stage || '',
    answered: input.answered || '',
    stdOutcome: input.stdOutcome || '',
  };
  const current = opp
    ? pipeline.stages.find((s) => s.id === opp.pipelineStageId) || null
    : null;
  let target = targetStageFor(pipeline.stages, current, stageInput);

  if (!target && isWin) {
    const fallback = current || findStage(pipeline.stages, ['Day 1', ...WON_STAGES]);
    if (fallback) target = { stage: fallback, status: 'won' };
  }

  if (!target && monetaryValue == null) {
    return { ok: true, moved: 'no stage change for this outcome' };
  }

  if (!target && monetaryValue != null && opp) {
    try {
      const res = await fetch(`${GHL_BASE}/opportunities/${opp.id}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          Version: GHL_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          pipelineId: pipeline.id,
          pipelineStageId: opp.pipelineStageId,
          status: isWin ? 'won' : opp.status,
          monetaryValue,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, reason: `GHL ${res.status}: ${text.slice(0, 120)}` };
      }
    } catch (e) {
      return { ok: false, reason: `GHL unreachable: ${e.message}` };
    }
    const statusBit = isWin && opp.status !== 'won' ? ' · marked won' : '';
    return { ok: true, moved: `value updated${statusBit}${formatValueNote(monetaryValue)}` };
  }

  if (!target) return { ok: true, moved: 'no stage change for this outcome' };

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

  const putBody = {
    pipelineId: pipeline.id,
    pipelineStageId: target.stage.id,
    status: target.status,
  };
  if (monetaryValue != null) putBody.monetaryValue = monetaryValue;

  try {
    const res = opp
      ? await fetch(`${GHL_BASE}/opportunities/${opp.id}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            Version: GHL_VERSION,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(putBody),
        })
      : await fetch(`${GHL_BASE}/opportunities/`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Version: GHL_VERSION,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            locationId,
            contactId,
            pipelineId: pipeline.id,
            pipelineStageId: target.stage.id,
            name: contactName || 'EOD Lead',
            status: target.status,
            ...(monetaryValue != null ? { monetaryValue } : {}),
          }),
        });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, reason: `GHL ${res.status}: ${text.slice(0, 120)}` };
    }
  } catch (e) {
    return { ok: false, reason: `GHL unreachable: ${e.message}` };
  }

  const statusNote =
    target.status !== 'open'
      ? ` · marked ${target.status}`
      : opp && opp.status !== 'open'
        ? ' · re-opened'
        : '';
  const verb = !opp
    ? `created at ${target.stage.name}`
    : sameStage
      ? `kept at ${target.stage.name}`
      : `moved to ${target.stage.name}`;
  return { ok: true, moved: verb + statusNote + formatValueNote(monetaryValue) };
}

module.exports = {
  moveEodOpportunity,
  resolveGhlContactId,
  parseMonetaryValue,
};
