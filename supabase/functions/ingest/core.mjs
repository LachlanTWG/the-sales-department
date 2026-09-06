// Runtime-agnostic webhook parsing core — the verbatim port of the parsing
// logic in src/server.js. Pure JS, no Deno/Node APIs, so the SAME code runs
// in the Edge Function (Deno) and in the Node replay-parity harness
// (src/scripts/replayIngestParity.mjs). Keep this file dependency-free.
//
// Parity contract: given the same webhook body + roster, every builder here
// must produce the same activity fields the Node server produced. Verified
// by replaying activities.raw_payload rows — see the harness.

// ─── Sales-person name canonicalisation ──────────────────────────────
// Different sources name our execs differently (GHL short names, Quotie full
// names). The sales_people roster uses short names.
export const PERSON_NAME_CANONICAL = {
  'lachlan boys': 'Lachlan',
  'buzz brady':   'Buzz',
  'zac russell':  'Zac',
  'benji boys':   'Benji',
  'max brady':    'Max',
};

export function canonicalisePersonName(name) {
  if (!name) return name;
  const key = String(name).trim().toLowerCase();
  return PERSON_NAME_CANONICAL[key] || name;
}

// ─── Outcome normalisation ───────────────────────────────────────────
export const OUTCOME_ALIASES = {
  'Not Ready to Proceed w. Job': 'Not Ready Yet - Post Quote',
  'Not Ready Yet - Pre Quote': 'Not Ready Yet - Pre-Quote',
  'Not Ready for Site Visit': 'Not Ready Yet - Pre-Quote',
  'Rescheduled Site Visit': 'Not Ready Yet - Pre-Quote',
  'Rough Figures Sent': 'Requires Quoting',
  'Disqualified - Extent of Works': 'DQ - Extent of Works',
  'Disqualified - Out of Service Area': 'DQ - Out of Service Area',
  'Disqualified - Wrong Contact/Number': 'DQ - Wrong Contact / Spam',
  'Disqualified - Price': 'DQ - Price',
  'Disqualified - Lead Looking for Work': 'DQ - Lead Looking for Work',
};

export function normalizeOutcome(val) {
  return OUTCOME_ALIASES[val] || val;
}

// ─── Malformed-body recovery ─────────────────────────────────────────
// Escape literal newlines/control chars inside JSON string values so
// JSON.parse won't choke (Make.com can send unescaped newlines in fields).
export function sanitizeJsonString(text) {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { result += ch; escaped = false; continue; }
    if (ch === '\\' && inString) { result += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; result += ch; continue; }
    if (inString && ch === '\n') { result += '\\n'; continue; }
    if (inString && ch === '\r') { result += '\\r'; continue; }
    result += ch;
  }
  return result;
}

// Last-resort extractor: pull simple "key":"value" string pairs out of a body
// whose JSON is broken. Misses the broken field but recovers everything else.
export function bestEffortExtract(text) {
  const out = {};
  const re = /"([a-zA-Z_][a-zA-Z0-9_]*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) out[m[1]] = m[2];
  return out;
}

// Decode a body string into an object using the same fallback chain the Node
// server uses: strict JSON → newline-sanitised JSON → regex extraction → {}.
export function decodeBodyText(text) {
  try { return JSON.parse(text); } catch { /* try next */ }
  try { return JSON.parse(sanitizeJsonString(text)); } catch { /* try next */ }
  const extracted = bestEffortExtract(text);
  if (Object.keys(extracted).length > 0) return extracted;
  return {};
}

// ─── GHL field extraction ────────────────────────────────────────────
// GHL sends custom fields as [{ id, key, value, field_value }] nested at
// unpredictable depths; key is snake_case ("eod_1___stage") for display name
// "EOD 1 - Stage".
export function findGHLCustomField(obj, fieldName) {
  const arrays = [];
  function collectCustomFields(o, visited = new Set()) {
    if (!o || typeof o !== 'object' || visited.has(o)) return;
    visited.add(o);
    if (Array.isArray(o)) {
      for (const item of o) collectCustomFields(item, visited);
      return;
    }
    if (o.customFields && Array.isArray(o.customFields)) arrays.push(o.customFields);
    if (o.customData && Array.isArray(o.customData)) arrays.push(o.customData);
    for (const val of Object.values(o)) {
      if (val && typeof val === 'object') collectCustomFields(val, visited);
    }
  }
  collectCustomFields(obj);

  const normalised = fieldName.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const arr of arrays) {
    for (const entry of arr) {
      if (!entry || typeof entry !== 'object') continue;
      const entryKey = (entry.key || entry.name || entry.fieldKey || entry.field_key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (entryKey === normalised) {
        const v = entry.field_value ?? entry.fieldValue ?? entry.value ?? '';
        if (v !== '' && v !== null && v !== undefined) return v;
      }
    }
  }
  return undefined;
}

// Extract a field value by key from anywhere in the body (GHL nests fields
// inconsistently).
export function deepFindField(obj, fieldName, visited = new Set()) {
  if (!obj || typeof obj !== 'object' || visited.has(obj)) return undefined;
  visited.add(obj);
  if (obj[fieldName] !== undefined && obj[fieldName] !== null && obj[fieldName] !== '') return obj[fieldName];
  for (const val of Object.values(obj)) {
    if (Array.isArray(val)) {
      for (const item of val) {
        const found = deepFindField(item, fieldName, visited);
        if (found !== undefined) return found;
      }
    } else if (val && typeof val === 'object') {
      const found = deepFindField(val, fieldName, visited);
      if (found !== undefined) return found;
    }
  }
  if (visited.size <= 1) {
    const ghlVal = findGHLCustomField(obj, fieldName);
    if (ghlVal !== undefined) return ghlVal;
  }
  return undefined;
}

// ─── Shared helpers ──────────────────────────────────────────────────

/** Today (YYYY-MM-DD) in the company's timezone. `now` injectable for tests. */
export function companyToday(tz, now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: tz || 'Australia/Sydney' });
}

/**
 * Resolve the sales person from a GHL payload against the company roster.
 * roster: [{ name, active }] from sales_people.
 * Mirrors resolveGHLSalesPerson in src/server.js.
 */
export function resolveGHLSalesPerson(body, roster) {
  const assignedTo = String(body.customData?.assigned_to || body.assigned_to || body.owner || body.user?.firstName || '');
  const assignedFirst = assignedTo.split(' ')[0].toLowerCase();
  const activePeople = (roster || []).filter(p => p.active);
  const match = activePeople.find(p =>
    p.name.split(' ')[0].toLowerCase() === assignedFirst
  );
  return match?.name || assignedTo || 'Unknown';
}

// Sheet-era eventType labels → DB enum values (kept for the manual endpoint,
// whose dashboard caller still sends sheet labels).
export const EVENT_TYPE_TO_DB = {
  'EOD Update': 'eod_update',
  'Job Won': 'job_won',
  'Site Visit Booked': 'site_visit_booked',
  'Quote Sent': 'quote_sent',
  'Email Sent': 'email_sent',
};

// ─── Activity builders (one per webhook route) ───────────────────────
// Each returns { skip?, reason? } or { activity } where activity carries the
// same field names logActivity's buildDbParams produced for Postgres.

const s = (v) => (v === undefined || v === null) ? '' : String(v);

/** /webhook/ghl/eod (and legacy /webhook/ghl) */
export function buildGHLEodActivity(body, tz, roster, now = new Date()) {
  const eod1 = s(deepFindField(body, 'EOD 1 - Stage') || '');
  const eod2 = s(deepFindField(body, 'EOD 2 - Answered?') || '');
  const eod3 = s(normalizeOutcome(deepFindField(body, 'EOD 3 - Standard Outcome') || ''));
  const eod4 = s(deepFindField(body, 'EOD 4 - Custom Outcome') || '');
  const eod5 = s(deepFindField(body, 'EOD 5 - Contact Source') || '');

  if (!eod1 && !eod2 && !eod3) {
    return { skip: true, reason: 'No EOD fields populated' };
  }

  const salesPersonName = resolveGHLSalesPerson(body, roster);
  const outcome = [eod1, eod2, eod3, eod4, eod5].map(x => x.trim()).join(' | ');
  const contactName = s(deepFindField(body, 'full_name') || body.contactName || body.contact_name || '');

  return {
    activity: {
      occurredOn: companyToday(tz, now),
      salesPersonName,
      contactName,
      eventType: 'eod_update',
      outcome,
      adSource: eod5,
      quoteJobValue: '',
      contactAddress: s(deepFindField(body, 'address1') || ''),
      contactId: s(deepFindField(body, 'contact_id') || body.id || ''),
      appointmentAt: '',
      source: 'ghl',
    },
  };
}

/** /webhook/ghl/job-won */
export function buildGHLJobWonActivity(body, tz, roster, now = new Date()) {
  const salesPersonName = resolveGHLSalesPerson(body, roster);
  const value = deepFindField(body, 'Job Won Value - incl. GST')
    || deepFindField(body, 'Job Won Quote Value ($) - Entered ')
    || deepFindField(body, 'Job Won Quote Value ($) - Entered')
    || body.lead_value || '';
  const comment = s(deepFindField(body, 'Job Won Client Comment - Entered') || '');
  const source = s(deepFindField(body, 'EOD 5 - Contact Source') || '');

  return {
    activity: {
      occurredOn: companyToday(tz, now),
      salesPersonName,
      contactName: s(deepFindField(body, 'full_name') || body.contactName || body.contact_name || ''),
      eventType: 'job_won',
      outcome: comment,
      adSource: source,
      quoteJobValue: String(value),
      contactAddress: s(deepFindField(body, 'address1') || ''),
      contactId: s(deepFindField(body, 'contact_id') || body.id || ''),
      appointmentAt: '',
      source: 'ghl',
    },
  };
}

function collectVisitLabels(body) {
  if (!body || typeof body !== 'object') return [];
  const cal = body.calendar && typeof body.calendar === 'object' ? body.calendar : {};
  const appt = body.appointment && typeof body.appointment === 'object' ? body.appointment : {};
  const custom = body.customData && typeof body.customData === 'object' ? body.customData : {};
  return [
    cal.name, cal.title, cal.calendarName, cal.calendar_name, cal.calendarTitle,
    appt.title, appt.name, appt.calendarName, appt.calendar_name,
    body.title, body.calendarName, body.calendar_name,
    body.appointmentTitle, body.appointment_title, body.appointmentName,
    custom.calendar_name, custom.calendarName, custom.title, custom.appointment_title,
  ].map(v => String(v || '').trim()).filter(Boolean);
}

export function isVirtualVisitPayload(body) {
  return collectVisitLabels(body).some(label => /virtual/i.test(label));
}

export function visitKindFromPayload(body) {
  return isVirtualVisitPayload(body) ? 'virtual' : 'in_person';
}

/** /webhook/ghl/site-visit */
export function buildGHLSiteVisitActivity(body, tz, roster, now = new Date()) {
  const salesPersonName = resolveGHLSalesPerson(body, roster);
  const comment = s(deepFindField(body, 'Site Visit Booked - Comment') || '');
  const appointmentDT = s(deepFindField(body, 'Appointment Date Time') || deepFindField(body, 'Appointment Date Time - Automated') || '');

  return {
    activity: {
      occurredOn: companyToday(tz, now),
      salesPersonName,
      contactName: s(deepFindField(body, 'full_name') || ''),
      eventType: 'site_visit_booked',
      outcome: comment,
      adSource: '',
      quoteJobValue: '',
      contactAddress: s(deepFindField(body, 'address1') || ''),
      contactId: s(deepFindField(body, 'contact_id') || body.id || ''),
      appointmentAt: appointmentDT,
      visitKind: visitKindFromPayload(body),
      source: 'ghl',
    },
  };
}

/** Fields for pending_site_visits (popup queue) from a GHL calendar webhook. */
export function buildPendingSiteVisit(body, tz, roster, now = new Date()) {
  const cal = (body && body.calendar && typeof body.calendar === 'object') ? body.calendar : {};
  const appointmentDisplay = s(
    deepFindField(body, 'Appointment Date Time')
    || deepFindField(body, 'Appointment Date Time - Automated')
    || cal.startTime
    || '',
  );
  const appointmentStart = s(
    cal.startTime || deepFindField(body, 'Appointment Start Time - Automated') || '',
  );
  const contactName = s(
    deepFindField(body, 'full_name')
    || body.full_name
    || body.contactName
    || body.contact_name
    || [body.firstName || body.first_name, body.lastName || body.last_name].filter(Boolean).join(' ')
    || '',
  );
  const contactId = s(
    deepFindField(body, 'contact_id') || body.contact_id || body.contactId || body.id || '',
  );
  return {
    contactId: contactId || null,
    contactName: contactName || null,
    contactAddress: s(deepFindField(body, 'address1') || body.address1 || body.full_address || cal.address || body.address || '') || null,
    contactPhone: s(body.phone || deepFindField(body, 'phone') || '') || null,
    contactEmail: s(body.email || deepFindField(body, 'email') || '') || null,
    salesPersonName: resolveGHLSalesPerson(body, roster) || null,
    appointmentRaw: appointmentDisplay || appointmentStart || null,
    appointmentDisplay: appointmentDisplay || appointmentStart || null,
    appointmentAt: appointmentStart || null,
    bookedOn: companyToday(tz, now),
    visitKind: visitKindFromPayload(body),
    source: 'ghl',
    rawPayload: body,
  };
}

/** /webhook/quote — Make.com / Quotie. Caller resolves company by body.companyName. */
export function buildQuoteActivity(body, tz, now = new Date()) {
  const salesPerson = canonicalisePersonName(body.salesPerson);
  const rawValue = String(body.quoteValue || '');
  const cleanValues = rawValue.split('|').map(v => v.replace(/[$,\s]/g, '').trim()).filter(Boolean);
  const quoteJobValue = cleanValues.join('|');

  return {
    activity: {
      occurredOn: companyToday(tz, now),
      salesPersonName: salesPerson || 'Unknown',
      contactName: s(body.contactName || ''),
      eventType: 'quote_sent',
      outcome: '',
      adSource: s(body.source || ''),
      quoteJobValue,
      contactAddress: s(body.contactAddress || ''),
      contactId: s(body.contactId || ''),
      appointmentAt: '',
      source: 'quotie',
    },
  };
}

/** /webhook/email — Make.com (Gmail / Outlook watch). */
export function buildEmailActivity(body, tz, now = new Date()) {
  const salesPerson = canonicalisePersonName(body.salesPerson);
  let emailDate = body.date || companyToday(tz, now);
  if (String(emailDate).includes('T')) {
    emailDate = String(emailDate).split('T')[0];
  }

  return {
    activity: {
      occurredOn: emailDate,
      salesPersonName: salesPerson || 'Unknown',
      contactName: s(body.contactName || body.recipientEmail || body.to || ''),
      eventType: 'email_sent',
      outcome: s(body.subject || ''),
      adSource: '',
      quoteJobValue: '',
      contactAddress: '',
      contactId: '',
      appointmentAt: '',
      source: 'make',
    },
  };
}

/**
 * /api/activities/manual — one entry from the dashboard's payload shape
 * ({ date, salesPerson, eventType (sheet label), contactName, outcome,
 *    adSource, quoteJobValue, contactAddress, contactId, appointmentDateTime }).
 */
export function buildManualActivity(entry) {
  const eventType = EVENT_TYPE_TO_DB[entry.eventType];
  if (!eventType) return { skip: true, reason: `Invalid eventType: ${entry.eventType}` };
  return {
    activity: {
      occurredOn: entry.date,
      salesPersonName: entry.salesPerson || 'Unknown',
      contactName: s(entry.contactName || ''),
      eventType,
      outcome: s(entry.outcome || ''),
      adSource: s(entry.adSource || ''),
      quoteJobValue: s(entry.quoteJobValue || ''),
      contactAddress: s(entry.contactAddress || ''),
      contactId: s(entry.contactId || ''),
      appointmentAt: s(entry.appointmentDateTime || ''),
      visitKind: entry.visitKind === 'virtual' ? 'virtual' : (eventType === 'site_visit_booked' ? 'in_person' : null),
      source: 'manual',
    },
  };
}

// Flip a reversed "Last, First" contact name to "First Last" (single clean
// comma only) — some GHL automations (e.g. Bolton's) send names reversed.
// Mirrors the Node helper in src/sheets/logActivity.js so both ingest paths agree.
function flipReversedName(name) {
  if (!name) return name;
  const parts = String(name).split(',');
  if (parts.length !== 2) return name;
  const last = parts[0].trim(), first = parts[1].trim();
  if (!last || !first) return name;
  return `${first} ${last}`;
}

/**
 * Map a built activity to the activities-table insert row. Empty strings
 * become NULLs exactly like buildDbParams (`data.x || null`) did in Node.
 */
export function toInsertRow(activity, { companyId, salesPersonId, rawPayload }) {
  return {
    company_id: companyId,
    sales_person_id: salesPersonId,
    sales_person_name: activity.salesPersonName || 'Unknown',
    occurred_on: activity.occurredOn,
    occurred_at: null,
    event_type: activity.eventType,
    contact_name: flipReversedName(activity.contactName) || null,
    contact_id: activity.contactId || null,
    contact_address: activity.contactAddress || null,
    outcome: activity.outcome || null,
    ad_source: activity.adSource || null,
    quote_job_value: activity.quoteJobValue || null,
    appointment_at: activity.appointmentAt || null,
    source: activity.source,
    source_row_id: null,
    raw_payload: rawPayload ?? null,
    visit_kind: activity.eventType === 'site_visit_booked'
      ? (activity.visitKind === 'virtual' ? 'virtual' : 'in_person')
      : null,
  };
}
