const { appendRows } = require('./writeSheet');
const db = require('../db');

// Some GHL automations (e.g. Bolton's) send contact names reversed as
// "Last, First". Flip a clean single-comma name to "First Last" at ingest so
// every downstream surface (sheet, DB, reports, dashboard) is correct. Names
// without exactly one comma, or with an empty side, are left untouched.
function flipReversedName(name) {
  if (!name) return name;
  const parts = String(name).split(',');
  if (parts.length !== 2) return name;
  const last = parts[0].trim(), first = parts[1].trim();
  if (!last || !first) return name;
  return `${first} ${last}`;
}

// Sheet eventType strings → DB enum values
const EVENT_TYPE_TO_DB = {
  'EOD Update': 'eod_update',
  'Job Won': 'job_won',
  'Site Visit Booked': 'site_visit_booked',
  'Quote Sent': 'quote_sent',
  'Email Sent': 'email_sent',
};

function toRow(data) {
  return [
    data.date,
    data.salesPerson,
    flipReversedName(data.contactName) || '',
    data.eventType || 'EOD Update',
    data.outcome || '',
    data.adSource || '',
    data.quoteJobValue || '',
    data.contactAddress || '',
    data.contactId || '',
    data.appointmentDateTime || '',
    data.appointmentDate || '',
  ];
}

function buildDbParams(data, ctx) {
  const eventType = EVENT_TYPE_TO_DB[data.eventType || 'EOD Update'];
  if (!eventType) return null;
  // Manual Job Won entries carry splitCommission / halfCommissionCharge on the
  // sheet-shaped row — persist them for TWA Conversion. GHL keeps webhook body.
  let rawPayload = ctx.rawPayload || null;
  if ((ctx.source || 'manual') === 'manual' && data && typeof data === 'object') {
    rawPayload = {
      ...data,
      via: (ctx.rawPayload && ctx.rawPayload.via) || 'dashboard',
    };
  }
  return {
    companyName: ctx.companyName,
    salesPersonName: data.salesPerson || 'Unknown',
    occurredOn: data.date,
    eventType,
    contactName: flipReversedName(data.contactName) || null,
    contactId: data.contactId || null,
    contactAddress: data.contactAddress || null,
    outcome: data.outcome || null,
    adSource: data.adSource || null,
    quoteJobValue: data.quoteJobValue || null,
    appointmentAt: data.appointmentDateTime || null,
    source: ctx.source || 'manual',
    sourceRowId: ctx.sourceRowId || null,
    rawPayload,
  };
}

/**
 * Append an activity to the sheet AND insert into Postgres (when ctx is given
 * and DATABASE_URL is set). Permanent dual-write — sheet stays as the ops
 * surface, DB is the dashboard's source of truth.
 *
 * @param {string} spreadsheetId
 * @param {object} data   See sheet column list in toRow().
 * @param {object} [ctx]  { companyName, source, sourceRowId, rawPayload }
 *                        Omit ctx (or omit companyName) to write to sheet only.
 */
async function logActivity(spreadsheetId, data, ctx = {}) {
  const sheetPromise = appendRows(spreadsheetId, 'Activity Log', [toRow(data)], true);

  const dbParams = ctx.companyName && db.isEnabled() ? buildDbParams(data, ctx) : null;
  const dbPromise = dbParams ? db.insertActivity(dbParams) : Promise.resolve({ skipped: true });

  const [sheetResult, dbResult] = await Promise.allSettled([sheetPromise, dbPromise]);

  if (sheetResult.status === 'rejected') {
    console.error(`[logActivity] sheet write failed (${ctx.companyName || spreadsheetId}):`, sheetResult.reason?.message || sheetResult.reason);
  }
  if (dbResult.status === 'rejected') {
    console.error(`[logActivity] db write failed (${ctx.companyName || '?'}):`, dbResult.reason?.message || dbResult.reason);
  }

  // Preserve original behaviour: throw if the sheet write failed. DB failures
  // are logged but don't break the webhook response (sheet stays canonical
  // until the dashboard cuts over).
  if (sheetResult.status === 'rejected') throw sheetResult.reason;
}

/**
 * Log multiple activity rows at once. Sheet write is batched (one append);
 * DB writes run in parallel with allSettled.
 */
async function logActivities(spreadsheetId, dataArray, ctx = {}) {
  const rows = dataArray.map(toRow);
  const sheetPromise = appendRows(spreadsheetId, 'Activity Log', rows, true);

  const dbPromises = ctx.companyName && db.isEnabled()
    ? dataArray.map((data, i) => {
        const params = buildDbParams(data, {
          ...ctx,
          sourceRowId: ctx.sourceRowId ? `${ctx.sourceRowId}:${i}` : null,
        });
        return params ? db.insertActivity(params) : Promise.resolve({ skipped: true });
      })
    : [];

  const results = await Promise.allSettled([sheetPromise, ...dbPromises]);
  const sheetResult = results[0];
  if (sheetResult.status === 'rejected') {
    console.error(`[logActivities] sheet write failed:`, sheetResult.reason?.message);
    throw sheetResult.reason;
  }
  const dbFailures = results.slice(1).filter(r => r.status === 'rejected');
  if (dbFailures.length > 0) {
    console.error(`[logActivities] ${dbFailures.length}/${dataArray.length} db writes failed`);
  }
}

module.exports = { logActivity, logActivities };
