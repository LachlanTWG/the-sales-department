require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const http = require('http');
const zlib = require('zlib');
const cron = require('node-cron');
const {
  sendCompanyEOD, archiveCompanyEOD,
  sendCompanyEOW, archiveCompanyEOW,
  runCompanyEOM, runCompanyEOQ, runCompanyEOY,
  sendSiteVisitNotification,
  runAllEOD, runAllEOW, runAllEOM, runAllEOQ, runAllEOY, runAllSiteVisitNotifications, runMeetingDoc, runMonthlyDoc,
  loadCompanies,
} = require('./runReports');
const { logActivity, logActivities } = require('./sheets/logActivity');
const { visitKindFromPayload, isVirtualVisitKind } = require('./ghl/visitKind');
const { appendRows } = require('./sheets/writeSheet');
const { populateAllFormulas } = require('./sheets/populateFormulas');
const {
  archiveSummaryDaily,
  archiveSummaryWeekly,
  archiveSummaryMonthly,
  archiveSummaryTotalDaily,
  archiveSummaryTotalWeekly,
  archiveSummaryTotalMonthly,
  buildExecMap,
} = require('./sheets/summarySheet');
const { getSummarySheetId } = require('./config/companiesStore');
const { previewEOD, previewEOW, previewEOM, previewEOQ, previewEOY } = require('./preview');
const { syncHuddleBoard, createWeeklyHuddleTask } = require('./integrations/huddleBoard');
const { reportJobWonsToCommission } = require('./integrations/commission');
const mailbox = require('./integrations/mailbox');
const db = require('./db');
const {
  moveEodOpportunity,
  parseMonetaryValue,
} = require('./ghl/moveEodOpportunity');

const PORT = process.env.PORT || 3000;

// ─── Sales-person name canonicalisation ──────────────────────────────
// Different sources name our execs differently:
//   - GHL/Make: usually short ("Lachlan", "Buzz", "Zac")
//   - Quotie:   full name ("Lachlan Boys", "Buzz Brady", "Zac Russell")
// Our sales_people roster uses short names, so without this map the DB
// lookup misses and the row lands with sales_person_id = NULL.
const PERSON_NAME_CANONICAL = {
  'lachlan boys': 'Lachlan',
  'buzz brady':   'Buzz',
  'zac russell':  'Zac',
  'benji boys':   'Benji',
  'max brady':    'Max',
};
function canonicalisePersonName(name) {
  if (!name) return name;
  const key = String(name).trim().toLowerCase();
  return PERSON_NAME_CANONICAL[key] || name;
}

// Company names arrive hand-typed into Make.com scenarios, GHL workflows and
// URLs, so "&" vs "and", stray punctuation and extra spaces must all match
// the config's spelling.
function normaliseCompanyName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function findCompanyByName(companies, name) {
  const target = normaliseCompanyName(name);
  if (!target) return undefined;
  return companies.find(c => normaliseCompanyName(c.name) === target);
}

function oneLineAddress(s) {
  return String(s || '').replace(/\s*\n+\s*/g, ', ').replace(/\s+/g, ' ').trim();
}

/** Best-effort YYYY-MM-DD from ISO / GHL date strings (incl. d/m/y). */
function toIsoDateOnly(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    // GHL NZ/AU custom fields are day/month/year
    const day = m[1].padStart(2, "0");
    const month = m[2].padStart(2, "0");
    return `${m[3]}-${month}-${day}`;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function formatMoney(v) {
  if (v == null || v === '') return '—';
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (Number.isFinite(n)) return `$${Math.round(n).toLocaleString('en-AU')}`;
  return String(v);
}

/** DD/MM/YYYY for Slack / AU-NZ display. */
function formatAuNzDateForSlack(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) return s;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/** Slack message for a popup-completed site visit booking summary. */
function formatSiteVisitSummary(b) {
  const virtual = isVirtualVisitKind(b.visitKind) || b.virtual === true;
  const lines = [
    virtual
      ? `*Virtual Site Visit Booked* — ${b.companyName || 'Client'}`
      : `*Site Visit Booked* — ${b.companyName || 'Client'}`,
    `*Exec:* ${b.salesPerson || '—'}`,
    `*Lead:* ${b.contactName || '—'}`,
    `*Phone:* ${b.contactPhone || '—'}`,
    `*Email:* ${b.contactEmail || '—'}`,
    `*Location:* ${b.contactAddress || '—'}`,
    `*Visit time:* ${b.appointmentDisplay || b.appointmentAt || '—'}`,
    `*Booked on:* ${formatAuNzDateForSlack(b.bookedOn) || b.bookedOn || '—'}`,
  ];
  if (Array.isArray(b.previousQuotes) && b.previousQuotes.length > 0) {
    lines.push('*Previous quotes:*');
    for (const q of b.previousQuotes) {
      const when = formatAuNzDateForSlack(q.date) || q.date || '—';
      const who = q.person ? ` (${q.person})` : '';
      const num = q.number ? `#${String(q.number).replace(/^#/, '')} · ` : '';
      lines.push(`• ${num}${formatMoney(q.value)} — ${when}${who}`);
    }
  } else {
    lines.push('*Previous quotes:* No previous quote has been sent.');
  }

  if (b.vertical === 'roofing') {
    lines.push(`*Rough job value:* ${formatMoney(b.roughJobValue)}`);
    lines.push(`*Ideal start date:* ${b.idealStartDate || '—'}`);
    if (b.detailsComment) lines.push(`*Details:* ${b.detailsComment}`);
  } else if (b.detailsComment) {
    lines.push(`*Comment:* ${b.detailsComment}`);
  }
  return lines.join('\n');
}

// ─── Per-Company Timezone Scheduling ─────────────────────────────────
//
// Each company has its own timezone. We schedule cron jobs per-company
// so that reports fire at the right local time:
//
//   5:30pm local (Mon-Fri)  → SEND EOD to Slack + ClickUp
//   5:30pm local (Friday)   → Also SEND EOW
//   11:55pm local (Mon-Fri) → ARCHIVE EOD to sheets (final record)
//   11:55pm local (Friday)  → Also ARCHIVE EOW
//   1st of month, 9am local → EOM (send + archive)
//   Jan 2, 9am local        → EOY (send + archive)
//   Sunday 5:30pm AEST      → Meeting doc (night before Monday meeting)

const scheduledJobs = [];

function scheduleCompanyJobs() {
  const { companies } = loadCompanies();

  for (const company of companies) {
    // Postgres is the report source. sheetId is legacy (sheet dual-write)
    // and must not gate Slack/ClickUp sends — newer clients have none.
    const tz = company.timezone || 'Australia/Sydney';
    const name = company.name;

    // EOD Send — 5:30pm weekdays
    scheduledJobs.push(cron.schedule('30 17 * * 1-5', () => {
      console.log(`[${new Date().toISOString()}] SEND EOD: ${name} (${tz})`);
      sendCompanyEOD(company).catch(e => console.error(`${name} send EOD error:`, e.message));
    }, { timezone: tz }));

    // EOD Archive — 11:55pm AEST (consistent cutoff for all companies)
    scheduledJobs.push(cron.schedule('55 23 * * 1-5', () => {
      console.log(`[${new Date().toISOString()}] ARCHIVE EOD: ${name} (AEST)`);
      archiveCompanyEOD(company).catch(e => console.error(`${name} archive EOD error:`, e.message));
    }, { timezone: 'Australia/Sydney' }));

    // EOW Send — Friday 5:30pm (same time as EOD send, runs after)
    scheduledJobs.push(cron.schedule('30 17 * * 5', () => {
      console.log(`[${new Date().toISOString()}] SEND EOW: ${name} (${tz})`);
      sendCompanyEOW(company).catch(e => console.error(`${name} send EOW error:`, e.message));
    }, { timezone: tz }));

    // EOW Archive — Friday 11:55pm AEST (consistent cutoff for all companies)
    scheduledJobs.push(cron.schedule('55 23 * * 5', () => {
      console.log(`[${new Date().toISOString()}] ARCHIVE EOW: ${name} (AEST)`);
      archiveCompanyEOW(company).catch(e => console.error(`${name} archive EOW error:`, e.message));
    }, { timezone: 'Australia/Sydney' }));

    // EOM — 1st of every month at 9am
    scheduledJobs.push(cron.schedule('0 9 1 * *', () => {
      console.log(`[${new Date().toISOString()}] EOM: ${name} (${tz})`);
      runCompanyEOM(company).catch(e => console.error(`${name} EOM error:`, e.message));
    }, { timezone: tz }));

    // EOQ — 1st of Jan, Apr, Jul, Oct at 9am
    scheduledJobs.push(cron.schedule('0 9 1 1,4,7,10 *', () => {
      console.log(`[${new Date().toISOString()}] EOQ: ${name} (${tz})`);
      runCompanyEOQ(company).catch(e => console.error(`${name} EOQ error:`, e.message));
    }, { timezone: tz }));

    // EOY — January 2nd at 9am
    scheduledJobs.push(cron.schedule('0 9 2 1 *', () => {
      console.log(`[${new Date().toISOString()}] EOY: ${name} (${tz})`);
      runCompanyEOY(company).catch(e => console.error(`${name} EOY error:`, e.message));
    }, { timezone: tz }));

    // Site Visit Notification — 7am weekdays
    scheduledJobs.push(cron.schedule('0 7 * * 1-5', () => {
      console.log(`[${new Date().toISOString()}] SITE VISITS: ${name} (${tz})`);
      sendSiteVisitNotification(company).catch(e => console.error(`${name} site visit notification error:`, e.message));
    }, { timezone: tz }));

    console.log(`  ${name}: 8 jobs scheduled (tz: ${tz})`);
  }
}

// Summary archive helpers — run after per-company archives have written their daily rows.
async function runSummaryDailyArchive() {
  const summaryId = getSummarySheetId();
  if (!summaryId) return;
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  const execMap = buildExecMap();
  for (const execName of Object.keys(execMap)) {
    try { await archiveSummaryDaily(summaryId, execName, date); }
    catch (e) { console.error(`  Summary daily (${execName}): ${e.message}`); }
  }
  try { await archiveSummaryTotalDaily(summaryId, date); }
  catch (e) { console.error(`  Summary total daily: ${e.message}`); }
}

async function runSummaryWeeklyArchive() {
  const summaryId = getSummarySheetId();
  if (!summaryId) return;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  const d = new Date(today + 'T00:00:00');
  const dow = d.getDay() || 7; // 1=Mon..7=Sun
  const monday = new Date(d); monday.setDate(d.getDate() - (dow - 1));
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  const start = monday.toISOString().slice(0, 10);
  const end = sunday.toISOString().slice(0, 10);
  const execMap = buildExecMap();
  for (const execName of Object.keys(execMap)) {
    try { await archiveSummaryWeekly(summaryId, execName, start, end); }
    catch (e) { console.error(`  Summary weekly (${execName}): ${e.message}`); }
  }
  try { await archiveSummaryTotalWeekly(summaryId, start, end); }
  catch (e) { console.error(`  Summary total weekly: ${e.message}`); }
}

async function runSummaryMonthlyArchive() {
  const summaryId = getSummarySheetId();
  if (!summaryId) return;
  // Cron fires on the 1st at local time AFTER per-company EOM has run.
  // Archive the PREVIOUS month, since EOM reports look back at the just-finished month.
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  const today = new Date(todayStr + 'T00:00:00');
  const prev = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const year = prev.getFullYear();
  const month = prev.getMonth() + 1;
  const execMap = buildExecMap();
  for (const execName of Object.keys(execMap)) {
    try { await archiveSummaryMonthly(summaryId, execName, year, month); }
    catch (e) { console.error(`  Summary monthly (${execName}): ${e.message}`); }
  }
  try { await archiveSummaryTotalMonthly(summaryId, year, month); }
  catch (e) { console.error(`  Summary total monthly: ${e.message}`); }
}

function scheduleSummaryArchive() {
  // Daily — 11:59pm AEST Mon-Fri (4 min after per-company 11:55pm archives)
  scheduledJobs.push(cron.schedule('59 23 * * 1-5', () => {
    console.log(`[${new Date().toISOString()}] ARCHIVE SUMMARY DAILY`);
    runSummaryDailyArchive().catch(e => console.error('Summary daily archive error:', e.message));
  }, { timezone: 'Australia/Sydney' }));

  // Weekly — Friday 11:59pm AEST (after per-company EOW archive at 11:55pm)
  scheduledJobs.push(cron.schedule('59 23 * * 5', () => {
    console.log(`[${new Date().toISOString()}] ARCHIVE SUMMARY WEEKLY`);
    runSummaryWeeklyArchive().catch(e => console.error('Summary weekly archive error:', e.message));
  }, { timezone: 'Australia/Sydney' }));

  // Monthly — 1st of month at 2pm AEST (after slowest per-company EOM at 9am Perth = 11am AEST)
  scheduledJobs.push(cron.schedule('0 14 1 * *', () => {
    console.log(`[${new Date().toISOString()}] ARCHIVE SUMMARY MONTHLY`);
    runSummaryMonthlyArchive().catch(e => console.error('Summary monthly archive error:', e.message));
  }, { timezone: 'Australia/Sydney' }));

  console.log(`  Summary Archive: Daily 11:59pm Mon-Fri, Weekly 11:59pm Fri, Monthly 2pm 1st (all AEST)`);
}

// Meeting Doc — Sunday 5:30pm AEST, covering the week ending that Sunday
// (Mon–Sun). Runs the night before the Monday morning meeting so the team
// can add comments overnight.
function scheduleMeetingDoc() {
  scheduledJobs.push(cron.schedule('30 17 * * 0', () => {
    console.log(`[${new Date().toISOString()}] MEETING DOC`);
    runMeetingDoc().catch(e => console.error('Meeting doc error:', e.message));
  }, { timezone: 'Australia/Sydney' }));
  console.log(`  Meeting Doc: Sunday 5:30pm AEST (week ending today)`);
}

// Monthly Review Doc — 1st of month, 12pm AEST (after per-company EOM at ~11am AEST)
function scheduleMonthlyDoc() {
  scheduledJobs.push(cron.schedule('0 12 1 * *', () => {
    console.log(`[${new Date().toISOString()}] MONTHLY REVIEW DOC`);
    runMonthlyDoc().catch(e => console.error('Monthly doc error:', e.message));
  }, { timezone: 'Australia/Sydney' }));
  console.log(`  Monthly Review Doc: 12pm 1st of month AEST`);
}

// Sales Exec Huddle Board (ClickUp) — hourly DB→ClickUp sync so the huddle
// dashboard cards stay live, plus the weekly meeting task Friday 8am AEST
// (before the huddle; the 6pm meeting DOC is a separate client-facing artefact).
function scheduleHuddleBoard() {
  scheduledJobs.push(cron.schedule('5 * * * *', () => {
    console.log(`[${new Date().toISOString()}] HUDDLE BOARD SYNC`);
    syncHuddleBoard().catch(e => console.error('Huddle board sync error:', e.message));
  }, { timezone: 'Australia/Sydney' }));

  scheduledJobs.push(cron.schedule('0 8 * * 5', () => {
    console.log(`[${new Date().toISOString()}] HUDDLE MEETING TASK`);
    createWeeklyHuddleTask().catch(e => console.error('Huddle meeting task error:', e.message));
  }, { timezone: 'Australia/Sydney' }));

  console.log(`  Huddle Board: sync hourly at :05, meeting task Friday 8am AEST`);
}

// Mailbox sent-mail sync (Gmail + Outlook) — primary email_sent path.
// Replaces per-exec×company Make watches. Every 3 minutes.
function scheduleMailboxSync() {
  if (!mailbox.isConfigured()) {
    console.log('  Mailbox sync: skipped (configure Gmail and/or Outlook OAuth env)');
    return;
  }
  const providers = [
    mailbox.isGmailConfigured() ? 'gmail' : null,
    mailbox.isOutlookConfigured() ? 'outlook' : null,
  ].filter(Boolean).join('+');
  // Override with MAILBOX_SYNC_CRON for testing (e.g. "*/1 * * * *" = every minute).
  // Default: every 3 minutes.
  const expr = (process.env.MAILBOX_SYNC_CRON || '*/3 * * * *').trim();
  scheduledJobs.push(cron.schedule(expr, () => {
    console.log(`[${new Date().toISOString()}] MAILBOX SYNC (${providers}) cron=${expr}`);
    mailbox.syncAllAccounts().catch(e => console.error('Mailbox sync error:', e.message));
  }, { timezone: 'Australia/Sydney' }));
  console.log(`  Mailbox sync: cron "${expr}" (${providers})`);
}

/** Best-effort: stash contact email from a GHL payload so mailbox sync can attribute sends. */
function captureGhlContactEmail(company, body, deepFindField) {
  const email =
    deepFindField(body, 'email') ||
    body.email ||
    body.Email ||
    body.contact?.email ||
    body.contact_email ||
    null;
  if (!email) return;
  const contactName =
    deepFindField(body, 'full_name') || body.contactName || body.contact_name || null;
  const contactId =
    deepFindField(body, 'contact_id') || body.id || body.contact?.id || null;
  mailbox.upsertContactEmail({
    companyName: company.name,
    email,
    contactName,
    contactId,
    source: 'ghl',
  }).catch(e => console.error(`[contact_emails] ${company.name}:`, e.message));
}

// ─── Webhook Server ──────────────────────────────────────────────────

// Escape literal newlines/control chars inside JSON string values so JSON.parse won't choke
// (Make.com can send unescaped newlines in fields like contactAddress)
function sanitizeJsonString(text) {
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
// whose JSON is broken (e.g. Make.com pastes an unescaped JSON object into a
// string field). Misses the broken field but recovers everything else, so a
// single bad value doesn't 404 the whole webhook.
function bestEffortExtract(text) {
  const out = {};
  const re = /"([a-zA-Z_][a-zA-Z0-9_]*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) out[m[1]] = m[2];
  return out;
}

function parseBody(req) {
  return new Promise((resolve) => {
    const encoding = (req.headers['content-encoding'] || '').toLowerCase();
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const decode = (buf) => {
        const text = buf.toString();
        try { return resolve(JSON.parse(text)); } catch {}
        try { return resolve(JSON.parse(sanitizeJsonString(text))); } catch {}
        const extracted = bestEffortExtract(text);
        if (Object.keys(extracted).length > 0) {
          console.log(`[parseBody] JSON malformed, recovered ${Object.keys(extracted).length} fields via regex`);
          return resolve(extracted);
        }
        resolve({});
      };
      if (encoding === 'gzip') {
        zlib.gunzip(raw, (err, result) => decode(err ? raw : result));
      } else if (encoding === 'deflate') {
        zlib.inflate(raw, (err, result) => decode(err ? raw : result));
      } else if (encoding === 'br') {
        zlib.brotliDecompress(raw, (err, result) => decode(err ? raw : result));
      } else {
        decode(raw);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // Health check
  if (pathname === '/' || pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // DB health — confirms DATABASE_URL is set and the pooler is reachable.
  if (pathname === '/health/db') {
    if (!db.isEnabled()) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'disabled', reason: 'DATABASE_URL not set' }));
      return;
    }
    try {
      const t0 = Date.now();
      const client = await db.getPool().connect();
      try {
        const { rows } = await client.query('select 1 as ok');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', latencyMs: Date.now() - t0, ok: rows[0]?.ok === 1 }));
      } finally { client.release(); }
    } catch (e) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: e.message }));
    }
    return;
  }

  // ─── Mailbox OAuth (Gmail + Outlook) — above WEBHOOK_SECRET gate.
  // Provider OAuth redirects have no Bearer token; state is HMAC-signed.
  //
  // GET  /oauth/mailbox/start?state=…  — redirect to provider consent (provider in state)
  // GET  /oauth/mailbox/callback       — store tokens, backfill, bounce to dashboard
  // POST /oauth/mailbox/sync           — manual sync (Bearer WEBHOOK_SECRET)
  // POST /oauth/mailbox/disconnect     — { userId } (Bearer WEBHOOK_SECRET)
  // Legacy /oauth/gmail/* aliases still work.
  if (
    (pathname === '/oauth/mailbox/start' || pathname === '/oauth/gmail/start') &&
    req.method === 'GET'
  ) {
    try {
      if (!mailbox.isConfigured()) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No mailbox OAuth provider configured on this server' }));
        return;
      }
      const state = url.searchParams.get('state');
      if (!state) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing state' }));
        return;
      }
      const urlToProvider = mailbox.authUrlForState(state);
      res.writeHead(302, { Location: urlToProvider });
      res.end();
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (
    (pathname === '/oauth/mailbox/callback' || pathname === '/oauth/gmail/callback') &&
    req.method === 'GET'
  ) {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const dashBase = (process.env.DASHBOARD_URL || 'https://eod-creator.vercel.app').replace(/\/+$/, '');
    try {
      // Providers (Google/Microsoft) send error= without a code when the user
      // is blocked or cancels. Read that first or we mis-report "missing code".
      const oauthErr = mailbox.describeOAuthError(url.searchParams);
      if (oauthErr) throw new Error(oauthErr);
      if (!code || !state) throw new Error('Missing code or state');
      const result = await mailbox.handleOAuthCallback(code, state);
      const dest = new URL(result.returnUrl || `${dashBase}/settings/email`);
      dest.searchParams.set('connected', '1');
      dest.searchParams.set('email', result.email || '');
      dest.searchParams.set('provider', result.provider || '');
      if (result.companyName) dest.searchParams.set('company', result.companyName);
      res.writeHead(302, { Location: dest.toString() });
      res.end();
    } catch (e) {
      console.error('[mailbox oauth callback]', e.message);
      const dest = new URL(`${dashBase}/settings/email`);
      dest.searchParams.set('error', e.message.slice(0, 200));
      res.writeHead(302, { Location: dest.toString() });
      res.end();
    }
    return;
  }

  // Audit every /webhook/* request to webhook_events (fire-and-forget). Also
  // serves as a per-request signal that DB writes work in this environment.
  if (pathname.startsWith('/webhook') && !pathname.endsWith('-test')) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    const originalEnd = res.end.bind(res);
    res.end = function (...args) {
      db.insertWebhookEvent({
        path: pathname,
        method: req.method,
        status: res.statusCode,
        ip,
        body: null,
        error: res.statusCode >= 400 ? (typeof args[0] === 'string' ? args[0].slice(0, 500) : null) : null,
      }).catch(e => console.error(`[webhook_events] insert failed (${pathname}):`, e.message));
      return originalEnd(...args);
    };
  }

  // Auth check — accept several shapes GHL / Make custom webhooks use:
  //   Authorization: Bearer <secret>
  //   Authorization: <secret>
  //   X-Webhook-Secret / X-Api-Key: <secret>
  //   ?token=<secret> or ?secret=<secret>
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (webhookSecret) {
    const authHeader = (req.headers['authorization'] || '').trim();
    const bearer = authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : '';
    const headerToken = bearer || authHeader;
    const altHeader = (
      req.headers['x-webhook-secret'] ||
      req.headers['x-api-key'] ||
      ''
    ).toString().trim();
    const queryToken = (
      url.searchParams.get('token') ||
      url.searchParams.get('secret') ||
      ''
    ).trim();
    const candidates = [headerToken, altHeader, queryToken].filter(Boolean);
    const ok = candidates.some(c => c === webhookSecret);
    if (!ok) {
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';
      const reason = candidates.length === 0 ? 'no credential'
        : authHeader ? 'header mismatch'
        : queryToken ? 'query token mismatch'
        : 'credential mismatch';
      console.warn(`[401] ${req.method} ${pathname} from ${ip} (${reason})`);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }

  // ─── Preview endpoints (read-only, return report as JSON) ────────────
  // GET /preview/<eod|eow|eom|eoq|eoy>/<company>
  // Optional query params per report:
  //   eod: ?date=YYYY-MM-DD
  //   eow: ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
  //   eom: ?year=YYYY&month=1-12
  //   eoq: ?year=YYYY&quarter=1-4
  //   eoy: ?year=YYYY
  // Returns { company, report, period, team:{formatted,counts,names?}, people:[{name,formatted,counts,names?}] }
  // Reads the activity log + runs the same generators as the scheduled jobs, without posting to Slack/ClickUp or archiving.
  const previewMatch = pathname.match(/^\/preview\/(eod|eow|eom|eoq|eoy)\/(.+)$/);
  if (previewMatch && req.method === 'GET') {
    const [, reportType, companySlug] = previewMatch;
    const companyName = decodeURIComponent(companySlug);
    const { companies } = loadCompanies();
    const company = findCompanyByName(companies, companyName);
    if (!company) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Company "${companyName}" not found` }));
      return;
    }
    const opts = {};
    for (const k of ['date', 'startDate', 'endDate', 'year', 'month', 'quarter']) {
      const v = url.searchParams.get(k);
      if (v) opts[k] = v;
    }
    const fns = { eod: previewEOD, eow: previewEOW, eom: previewEOM, eoq: previewEOQ, eoy: previewEOY };
    try {
      const data = await fns[reportType](company, opts);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      console.error(`[preview] ${reportType}/${companyName}: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  const body = await parseBody(req);

  // Manual mailbox sync / disconnect (protected by WEBHOOK_SECRET above)
  if (
    (pathname === '/oauth/mailbox/sync' || pathname === '/oauth/gmail/sync') &&
    req.method === 'POST'
  ) {
    try {
      const result = await mailbox.syncAllAccounts({ forceBackfill: !!body.forceBackfill });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (
    (pathname === '/oauth/mailbox/disconnect' || pathname === '/oauth/gmail/disconnect') &&
    req.method === 'POST'
  ) {
    try {
      if (!body.userId || !body.companyId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'userId and companyId required' }));
        return;
      }
      await mailbox.deleteMailboxAccount(body.userId, body.companyId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'disconnected' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Test endpoints — logs full payload for debugging
  if (pathname.startsWith('/webhook/ghl') && pathname.endsWith('-test')) {
    const label = pathname.replace('/webhook/', '').toUpperCase();
    console.log(`\n[${label}] Full payload received:`);
    console.log(JSON.stringify(body, null, 2));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'received', endpoint: pathname, keys: Object.keys(body) }));
    return;
  }

  // ─── Manual activity entry (from the dashboard) ────────────────────
  // POST /api/activities/manual
  // Body: { companyName, activities: [ { date, salesPerson, eventType,
  //         contactName, outcome, adSource, quoteJobValue, contactAddress,
  //         contactId, appointmentDateTime, appointmentDate } ] }
  //
  // Routes hand-entered activities through the SAME dual-write funnel as the
  // webhooks (logActivities → Activity Log sheet + Postgres), tagged
  // source:'manual'. The dashboard server action authorises the exec against
  // their roster before calling; this endpoint is protected by WEBHOOK_SECRET
  // (the global auth gate above) and trusts that caller.
  if (pathname === '/api/activities/manual' && req.method === 'POST') {
    const { companies } = loadCompanies();
    const company = findCompanyByName(companies, body.companyName);
    if (!company) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Company "${body.companyName}" not found` }));
      return;
    }
    const activities = Array.isArray(body.activities) ? body.activities : [];
    if (activities.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No activities provided' }));
      return;
    }
    const VALID_TYPES = new Set(['EOD Update', 'Quote Sent', 'Job Won', 'Site Visit Booked', 'Email Sent']);
    for (const a of activities) {
      if (!a || !/^\d{4}-\d{2}-\d{2}$/.test(String(a.date || ''))) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Each activity needs a valid date (YYYY-MM-DD)' }));
        return;
      }
      if (!VALID_TYPES.has(a.eventType)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid eventType: ${a.eventType}` }));
        return;
      }
    }

    try {
      await logActivities(company.sheetId, activities, {
        companyName: company.name, source: 'manual', rawPayload: { via: 'dashboard' },
      });
      // Mirror the webhook behaviour: site visits also land on the Site Visits tab.
      const visits = activities.filter(a => a.eventType === 'Site Visit Booked');
      if (visits.length > 0) {
        await appendRows(company.sheetId, 'Site Visits', visits.map(v => [
          v.contactName || '', v.contactAddress || '', v.appointmentDateTime || '', v.salesPerson || '', '',
        ]));
      }
      // Job Won → Sales Exec Invoicing (commission sheets). Best-effort.
      const commissionResults = await reportJobWonsToCommission(company.name, activities);
      console.log(`[MANUAL] ${company.name} — ${activities.length} activit${activities.length === 1 ? 'y' : 'ies'}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'logged',
        company: company.name,
        count: activities.length,
        commissions: commissionResults.length,
      }));
    } catch (e) {
      console.error(`[MANUAL] Error ${company.name}:`, e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ─── GHL / Make.com Activity Webhooks ──────────────────────────────

  // Shared: resolve company from GHL location.id
  function resolveGHLCompany(body, res) {
    const locationId = body.location?.id;
    if (!locationId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing location.id' }));
      return null;
    }
    const { companies } = loadCompanies();
    const company = companies.find(c => c.ghlLocationId === locationId);
    if (!company) {
      console.log(`[GHL] Unknown location: ${locationId}`);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `No company for location ${locationId}` }));
      return null;
    }
    return company;
  }

  // Shared: resolve sales person from GHL payload (owner / assignee / user).
  function resolveGHLSalesPerson(body, company) {
    const candidates = [
      body.customData?.assigned_to,
      body.assigned_to,
      body.assignedTo,
      body.owner,
      body.contact?.assignedTo,
      body.user ? [body.user.firstName, body.user.lastName].filter(Boolean).join(' ') : '',
      body.user?.firstName,
      body.calendar?.created_by,
    ].map(v => String(v || '').trim()).filter(Boolean);

    const activePeople = (company.salesPeople || []).filter(p => p.active);
    for (const raw of candidates) {
      // Skip raw GHL user ids (look like long alphanumerics without spaces)
      if (/^[A-Za-z0-9]{15,}$/.test(raw) && !raw.includes(' ')) continue;
      const lower = raw.toLowerCase();
      const exact = activePeople.find(p => p.name.toLowerCase() === lower);
      if (exact) return exact.name;
      const first = lower.split(/\s+/)[0];
      const byFirst = activePeople.find(p =>
        p.name.toLowerCase() === first || p.name.toLowerCase().startsWith(first)
      );
      if (byFirst) return byFirst.name;
    }
    // Last resort: first non-id candidate as free text
    const free = candidates.find(c => !/^[A-Za-z0-9]{15,}$/.test(c));
    return free || 'Unknown';
  }

  // Shared: today in company timezone
  function companyToday(company) {
    const tz = company.timezone || 'Australia/Sydney';
    return new Date().toLocaleDateString('en-CA', { timeZone: tz });
  }

  // Normalize GHL outcome values to canonical names used in reporting
  const OUTCOME_ALIASES = {
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
  function normalizeOutcome(val) {
    return OUTCOME_ALIASES[val] || val;
  }

  // Shared: search GHL customFields array by display name or key
  // GHL sends custom fields as: [{ id, key, value, field_value }]
  // key is snake_case like "eod_1___stage", display name is "EOD 1 - Stage"
  function findGHLCustomField(obj, fieldName) {
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

  // Shared: extract a field value by key from anywhere in the body (GHL nests fields inconsistently)
  function deepFindField(obj, fieldName, visited = new Set()) {
    if (!obj || typeof obj !== 'object' || visited.has(obj)) return undefined;
    visited.add(obj);
    // Check top-level first
    if (obj[fieldName] !== undefined && obj[fieldName] !== null && obj[fieldName] !== '') return obj[fieldName];
    // Check all nested objects/arrays
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
    // Fall back to GHL customFields array search
    if (visited.size <= 1) {
      const ghlVal = findGHLCustomField(obj, fieldName);
      if (ghlVal !== undefined) return ghlVal;
    }
    return undefined;
  }

  // EOD Update — from GHL
  if (pathname === '/webhook/ghl/eod') {
    const company = resolveGHLCompany(body, res);
    if (!company) return;

    const eod1 = deepFindField(body, 'EOD 1 - Stage') || '';
    const eod2 = deepFindField(body, 'EOD 2 - Answered?') || '';
    const eod3 = normalizeOutcome(deepFindField(body, 'EOD 3 - Standard Outcome') || '');
    const eod4 = deepFindField(body, 'EOD 4 - Custom Outcome') || '';
    const eod5 = deepFindField(body, 'EOD 5 - Contact Source') || '';

    if (!eod1 && !eod2 && !eod3) {
      console.log(`[GHL EOD] No EOD fields found. Full body keys: ${JSON.stringify(Object.keys(body))}`);
      console.log(`[GHL EOD] customFields: ${JSON.stringify(body.customFields || body.customData?.customFields || 'none')}`);
      console.log(`[GHL EOD] Full body: ${JSON.stringify(body).substring(0, 3000)}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'skipped', reason: 'No EOD fields populated' }));
      return;
    }

    const salesPersonName = resolveGHLSalesPerson(body, company);
    const outcome = [eod1, eod2, eod3, eod4, eod5].map(s => s.trim()).join(' | ');
    const contactName = deepFindField(body, 'full_name') || body.contactName || body.contact_name || '';

    const activityData = {
      date: companyToday(company),
      salesPerson: salesPersonName,
      contactName,
      eventType: 'EOD Update',
      outcome,
      adSource: eod5,
      contactAddress: deepFindField(body, 'address1') || '',
      contactId: deepFindField(body, 'contact_id') || body.id || '',
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'logged', type: 'eod', company: company.name, salesPerson: salesPersonName }));

    captureGhlContactEmail(company, body, deepFindField);
    logActivity(company.sheetId, activityData, {
      companyName: company.name, source: 'ghl', rawPayload: body,
    }).then(() => {
      console.log(`[GHL EOD] ${company.name} / ${salesPersonName} / ${contactName || '?'}`);
    }).catch(e => console.error(`[GHL EOD] Error ${company.name}:`, e.message));
    return;
  }

  // Job Won — from GHL
  if (pathname === '/webhook/ghl/job-won') {
    const company = resolveGHLCompany(body, res);
    if (!company) return;

    const salesPersonName = resolveGHLSalesPerson(body, company);
    const value = deepFindField(body, 'Job Won Value - incl. GST') || deepFindField(body, 'Job Won Quote Value ($) - Entered ') || deepFindField(body, 'Job Won Quote Value ($) - Entered') || body.lead_value || '';
    const comment = deepFindField(body, 'Job Won Client Comment - Entered') || '';
    const source = deepFindField(body, 'EOD 5 - Contact Source') || '';

    const activityData = {
      date: companyToday(company),
      salesPerson: salesPersonName,
      contactName: deepFindField(body, 'full_name') || body.contactName || body.contact_name || '',
      eventType: 'Job Won',
      outcome: comment,
      adSource: source,
      quoteJobValue: String(value),
      contactAddress: deepFindField(body, 'address1') || '',
      contactId: deepFindField(body, 'contact_id') || body.id || '',
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'logged', type: 'job-won', company: company.name, salesPerson: salesPersonName, value }));

    captureGhlContactEmail(company, body, deepFindField);
    logActivity(company.sheetId, activityData, {
      companyName: company.name, source: 'ghl', rawPayload: body,
    }).then(() => {
      console.log(`[GHL JOB WON] ${company.name} / ${salesPersonName} / ${body.full_name || '?'} / $${value}`);
    }).catch(e => console.error(`[GHL JOB WON] Error ${company.name}:`, e.message));

    // Close / create the GHL opportunity with value (same ladder as the popup).
    if (company.ghlLocationId) {
      moveEodOpportunity({
        locationId: company.ghlLocationId,
        contactId: activityData.contactId,
        contactName: activityData.contactName,
        stage: '',
        answered: '',
        stdOutcome: 'Job Won',
        monetaryValue: parseMonetaryValue(value),
      }).then((r) => {
        if (r.ok) console.log(`[GHL JOB WON] pipeline: ${r.moved || 'ok'}`);
        else console.warn(`[GHL JOB WON] pipeline not moved: ${r.reason}`);
      }).catch((e) => console.error(`[GHL JOB WON] pipeline error:`, e.message));
    }
    return;
  }

  // Site Visit Booked — from GHL calendar.
  // Creates a pending_site_visits row the EOD popup surfaces until the exec
  // fills vertical-specific fields and Logs once → activity + Slack summary.
  if (pathname === '/webhook/ghl/site-visit') {
    const company = resolveGHLCompany(body, res);
    if (!company) return;

    const salesPersonName = resolveGHLSalesPerson(body, company);
    const cal = body.calendar || {};
    const appointmentDisplay =
      deepFindField(body, 'Appointment Date Time') ||
      deepFindField(body, 'Appointment Date Time - Automated') ||
      cal.startTime ||
      '';
    const appointmentStart =
      cal.startTime ||
      deepFindField(body, 'Appointment Start Time - Automated') ||
      '';
    const contactName =
      deepFindField(body, 'full_name') ||
      body.full_name ||
      body.contactName ||
      body.contact_name ||
      [body.firstName || body.first_name, body.lastName || body.last_name].filter(Boolean).join(' ') ||
      '';
    const contactId =
      deepFindField(body, 'contact_id') ||
      body.contact_id ||
      body.contactId ||
      body.id ||
      '';
    const contactAddress = oneLineAddress(
      deepFindField(body, 'address1') ||
      body.address1 ||
      body.full_address ||
      cal.address ||
      body.address ||
      ''
    );
    const contactPhone = String(body.phone || deepFindField(body, 'phone') || '').trim();
    const contactEmail = String(body.email || deepFindField(body, 'email') || '').trim();
    const bookedRaw =
      deepFindField(body, 'Date Appointment Booked - Automated') ||
      cal.date_created ||
      '';
    const bookedOn = toIsoDateOnly(bookedRaw) || companyToday(company);
    const visitKind = visitKindFromPayload(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'pending',
      type: visitKind === 'virtual' ? 'virtual-site-visit' : 'site-visit',
      company: company.name,
      salesPerson: salesPersonName,
      visitKind,
    }));

    captureGhlContactEmail(company, body, deepFindField);
    db.upsertPendingSiteVisit({
      companyName: company.name,
      contactId: String(contactId || '').trim() || null,
      contactName: String(contactName || '').trim() || null,
      contactAddress: contactAddress || null,
      contactPhone: contactPhone || null,
      contactEmail: contactEmail || null,
      salesPersonName: salesPersonName || null,
      appointmentRaw: String(appointmentDisplay || appointmentStart || '').trim() || null,
      appointmentDisplay: String(appointmentDisplay || appointmentStart || '').trim() || null,
      appointmentAt: appointmentStart ? String(appointmentStart) : null,
      bookedOn,
      // Rough job value is filled manually in the popup — do not prefill from GHL.
      roughJobValue: null,
      source: 'ghl',
      rawPayload: body,
      visitKind,
    }).then((r) => {
      console.log(
        `[GHL SITE VISIT → pending] ${company.name} / ${salesPersonName} / ${contactName || '?'} ` +
        `(${visitKind}${r.deduped ? ' deduped' : ''}, id=${r.id || '?'})`
      );
    }).catch(e => console.error(`[GHL SITE VISIT → pending] Error ${company.name}:`, e.message));
    return;
  }

  // Popup completed a pending site visit → Slack booking summary on the
  // client's EOD channel (same slack config as daily reports).
  if (pathname === '/api/site-visit-summary' && req.method === 'POST') {
    try {
      const { companies } = loadCompanies();
      const company = findCompanyByName(companies, body.companyName);
      if (!company) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Company "${body.companyName}" not found` }));
        return;
      }
      const message = formatSiteVisitSummary(body);
      const { sendReportToSlack } = require('./integrations/slack');
      await sendReportToSlack(company, 'site-visit-summary', message, {
        username: 'Site Visit Booked',
        icon_emoji: ':round_pushpin:',
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'sent' }));
    } catch (e) {
      console.error('[site-visit-summary]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Quote Sent — from Make.com / Quotie
  if (pathname === '/webhook/quote') {
    // Quotie sends full names ("Lachlan Boys") but our sales_people roster
    // uses short names ("Lachlan"). Without canonicalising, sales_person_id
    // resolves to NULL — the row never attributes to a roster exec.
    body.salesPerson = canonicalisePersonName(body.salesPerson);
    // Expected JSON from Make.com / Quotie HTTP module:
    // { companyName, salesPerson, contactName, quoteValue, contactAddress, contactId, source,
    //   quoteNumber? | quoteNumbers?  — optional, pipe-separated when multi-option }
    const { companies } = loadCompanies();
    const company = findCompanyByName(companies, body.companyName);
    if (!company) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Company "${body.companyName}" not found` }));
      return;
    }

    // Clean quote values: strip $ and commas, keep pipe-separated
    const rawValue = String(body.quoteValue || '');
    const cleanValues = rawValue.split('|').map(v => v.replace(/[$,\s]/g, '').trim()).filter(Boolean);
    const quoteJobValue = cleanValues.join('|');

    // Quote numbers (optional). Store pipe-aligned with quoteValue so the
    // site-visit popup can show "#7381 · $16,758.83" without re-querying GHL.
    const rawNumbers = String(
      body.quoteNumber || body.quote_number || body.quoteNumbers || body.quote_numbers || ''
    );
    const cleanNumbers = rawNumbers
      .split('|')
      .map(n => String(n).replace(/[^\d]/g, '').trim())
      .filter(n => n.length >= 3 && n.length <= 8);
    // Prefer first number in outcome for single-quote rows; multi stays in raw_payload.
    const quoteNumberOutcome = cleanNumbers.length === 1 ? cleanNumbers[0] : (cleanNumbers.length > 1 ? cleanNumbers.join('|') : '');

    const activityData = {
      date: companyToday(company),
      salesPerson: body.salesPerson || 'Unknown',
      contactName: body.contactName || '',
      eventType: 'Quote Sent',
      outcome: quoteNumberOutcome,
      adSource: body.source || '',
      quoteJobValue,
      contactAddress: body.contactAddress || '',
      contactId: body.contactId || '',
    };
    // Ensure raw payload always carries quoteNumber for multi-option matching
    if (cleanNumbers.length > 0) {
      body.quoteNumber = cleanNumbers.join('|');
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'logged', type: 'quote', company: company.name, salesPerson: body.salesPerson }));

    // Quotie sometimes includes contactEmail — stash for Gmail attribution.
    if (body.contactEmail || body.email) {
      mailbox.upsertContactEmail({
        companyName: company.name,
        email: body.contactEmail || body.email,
        contactName: body.contactName || null,
        contactId: body.contactId || null,
        source: 'ghl',
      }).catch(e => console.error(`[contact_emails] quote ${company.name}:`, e.message));
    }

    logActivity(company.sheetId, activityData, {
      companyName: company.name, source: 'quotie', rawPayload: body,
    }).then(() => {
      console.log(`[QUOTE] ${company.name} / ${body.salesPerson} / ${body.contactName || '?'} / $${body.quoteValue}`);
    }).catch(e => console.error(`[QUOTE] Error ${company.name}:`, e.message));

    // Move (or create) the opportunity to Quote Sent and write the deal value.
    // Activity log was never enough after the GHL "Contact Changed" workflows
    // were retired — Quotie must drive the stage the same way EOD popup does.
    if (company.ghlLocationId) {
      moveEodOpportunity({
        locationId: company.ghlLocationId,
        contactId: activityData.contactId,
        contactName: activityData.contactName,
        stage: '',
        answered: '',
        stdOutcome: 'Quote Sent',
        monetaryValue: parseMonetaryValue(quoteJobValue),
      }).then((r) => {
        if (r.ok) console.log(`[QUOTE] pipeline: ${r.moved || 'ok'}`);
        else console.warn(`[QUOTE] pipeline not moved: ${r.reason}`);
      }).catch((e) => console.error(`[QUOTE] pipeline error:`, e.message));
    } else {
      console.warn(`[QUOTE] pipeline skipped: no ghlLocationId for ${company.name}`);
    }
    return;
  }

  // Email Sent — from Make.com (Gmail / Outlook watch)
  if (pathname === '/webhook/email') {
    console.log(`[EMAIL] Raw body:`, JSON.stringify(body));
    body.salesPerson = canonicalisePersonName(body.salesPerson);
    const { companies } = loadCompanies();
    const company = findCompanyByName(companies, body.companyName);
    if (!company) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Company "${body.companyName}" not found` }));
      return;
    }

    // Normalize date to YYYY-MM-DD
    let emailDate = body.date || companyToday(company);
    if (emailDate.includes('T')) {
      emailDate = emailDate.split('T')[0];
    }

    const activityData = {
      date: emailDate,
      salesPerson: body.salesPerson || 'Unknown',
      contactName: body.contactName || body.recipientEmail || body.to || '',
      eventType: 'Email Sent',
      outcome: body.subject || '',
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'logged', type: 'email', company: company.name, salesPerson: activityData.salesPerson, date: activityData.date, contact: activityData.contactName }));

    logActivity(company.sheetId, activityData, {
      companyName: company.name, source: 'make', rawPayload: body,
    }).then(() => {
      console.log(`[EMAIL] ${company.name} / ${activityData.salesPerson} / ${activityData.contactName || '?'} / ${activityData.date}`);
    }).catch(e => console.error(`[EMAIL] Error ${company.name}:`, e.message));
    return;
  }

  // Legacy /webhook/ghl — redirect to /webhook/ghl/eod
  if (pathname === '/webhook/ghl') {
    const company = resolveGHLCompany(body, res);
    if (!company) return;

    const eod1 = deepFindField(body, 'EOD 1 - Stage') || '';
    const eod2 = deepFindField(body, 'EOD 2 - Answered?') || '';
    const eod3 = normalizeOutcome(deepFindField(body, 'EOD 3 - Standard Outcome') || '');
    const eod4 = deepFindField(body, 'EOD 4 - Custom Outcome') || '';
    const eod5 = deepFindField(body, 'EOD 5 - Contact Source') || '';

    if (!eod1 && !eod2 && !eod3) {
      console.log(`[GHL EOD legacy] No EOD fields found. Full body keys: ${JSON.stringify(Object.keys(body))}`);
      console.log(`[GHL EOD legacy] customFields: ${JSON.stringify(body.customFields || body.customData?.customFields || 'none')}`);
      console.log(`[GHL EOD legacy] Full body: ${JSON.stringify(body).substring(0, 3000)}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'skipped', reason: 'No EOD fields populated' }));
      return;
    }

    const salesPersonName = resolveGHLSalesPerson(body, company);
    const outcome = [eod1, eod2, eod3, eod4, eod5].map(s => s.trim()).join(' | ');
    const contactName = deepFindField(body, 'full_name') || body.contactName || body.contact_name || '';

    const activityData = {
      date: companyToday(company),
      salesPerson: salesPersonName,
      contactName,
      eventType: 'EOD Update',
      outcome,
      adSource: eod5,
      contactAddress: deepFindField(body, 'address1') || '',
      contactId: deepFindField(body, 'contact_id') || body.id || '',
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'logged', type: 'eod', company: company.name, salesPerson: salesPersonName }));

    logActivity(company.sheetId, activityData, {
      companyName: company.name, source: 'ghl', rawPayload: body,
    }).then(() => {
      console.log(`[GHL EOD] ${company.name} / ${salesPersonName} / ${contactName || '?'}`);
    }).catch(e => console.error(`[GHL EOD] Error ${company.name}:`, e.message));
    return;
  }

  // Refresh formulas for a company or all companies
  if (pathname === '/webhook/refresh-formulas') {
    const { companies } = loadCompanies();
    const targetName = body.company;
    const targets = targetName
      ? companies.filter(c => normaliseCompanyName(c.name) === normaliseCompanyName(targetName))
      : companies.filter(c => c.sheetId);

    if (targets.length === 0) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Company "${targetName}" not found` }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'triggered', companies: targets.map(c => c.name) }));

    (async () => {
      for (const c of targets) {
        try {
          await populateAllFormulas(c.sheetId, c.name, c.ownerName, c.salesPeople);
          console.log(`[REFRESH] Formulas updated: ${c.name}`);
        } catch (e) {
          console.error(`[REFRESH] Error ${c.name}:`, e.message);
        }
      }
    })();
    return;
  }

  // Webhook endpoints — all companies
  const endpoints = {
    '/webhook/eod': () => runAllEOD(body.date),
    '/webhook/eow': () => runAllEOW(body.startDate, body.endDate),
    '/webhook/eom': () => runAllEOM(body.year, body.month),
    '/webhook/eoq': () => runAllEOQ(body.year, body.quarter),
    '/webhook/eoy': () => runAllEOY(body.year),
    '/webhook/meeting': () => runMeetingDoc(body.startDate, body.endDate),
    '/webhook/monthly': () => runMonthlyDoc(body.year, body.month),
  };

  if (endpoints[pathname]) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'triggered', report: pathname.split('/').pop() }));
    endpoints[pathname]().catch(e => console.error(`Webhook ${pathname} error:`, e.message));
    return;
  }

  // Per-company webhook: /webhook/eod/Bolton%20EC
  const perCompanyMatch = pathname.match(/^\/webhook\/(eod|eow|eom|eoq|eoy)\/(send|archive)?\/?(.*)?$/);
  if (perCompanyMatch) {
    const [, reportType, mode, companySlug] = perCompanyMatch;
    if (companySlug) {
      const companyName = decodeURIComponent(companySlug);
      const { companies } = loadCompanies();
      const company = findCompanyByName(companies, companyName);
      if (!company) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Company "${companyName}" not found` }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'triggered', report: reportType, company: company.name, mode: mode || 'both' }));

      const handlers = {
        eod: () => mode === 'archive' ? archiveCompanyEOD(company, body.date) :
                   mode === 'send' ? sendCompanyEOD(company, body.date) :
                   sendCompanyEOD(company, body.date).then(() => archiveCompanyEOD(company, body.date)),
        eow: () => mode === 'archive' ? archiveCompanyEOW(company) :
                   mode === 'send' ? sendCompanyEOW(company) :
                   sendCompanyEOW(company).then(() => archiveCompanyEOW(company)),
        eom: () => runCompanyEOM(company, body.year, body.month),
        eoq: () => runCompanyEOQ(company, body.year, body.quarter),
        eoy: () => runCompanyEOY(company, body.year),
      };
      handlers[reportType]().catch(e => console.error(`Webhook error:`, e.message));
      return;
    }
  }

  // Status endpoint
  if (pathname === '/status') {
    const { companies } = loadCompanies();
    const companySchedules = companies
      .map(c => ({ name: c.name, timezone: c.timezone || 'Australia/Sydney' }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'running',
      uptime: process.uptime(),
      totalJobs: scheduledJobs.length,
      companies: companySchedules,
      schedule: {
        'EOD Send': '5:30pm local (Mon-Fri)',
        'EOD Archive': '11:55pm AEST (Mon-Fri)',
        'EOW Send': '5:30pm local (Friday)',
        'EOW Archive': '11:55pm AEST (Friday)',
        'EOM': '1st of month, 9am local',
        'EOQ': '1st of Jan/Apr/Jul/Oct, 9am local',
        'EOY': 'Jan 2, 9am local',
        'Meeting Doc': 'Sunday 5:30pm AEST',
        'Monthly Review Doc': '12pm 1st of month AEST',
      },
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ─── Start ───────────────────────────────────────────────────────────

function start() {
  console.log('\nEOD Creator — Scheduling per-company jobs...\n');

  scheduleCompanyJobs();
  scheduleMeetingDoc();
  scheduleMonthlyDoc();
  scheduleSummaryArchive();
  scheduleHuddleBoard();
  scheduleMailboxSync();

  console.log(`\nTotal cron jobs: ${scheduledJobs.length}`);

  server.listen(PORT, () => {
    console.log(`\nServer running on port ${PORT}`);
    console.log(`\nWebhook endpoints:`);
    console.log(`  POST /webhook/eod                          — All companies`);
    console.log(`  POST /webhook/eow                          — All companies`);
    console.log(`  POST /webhook/eom                          — All companies`);
    console.log(`  POST /webhook/eoq                          — All companies`);
    console.log(`  POST /webhook/eoy                          — All companies`);
    console.log(`  POST /webhook/meeting                      — Meeting doc`);
    console.log(`  POST /webhook/monthly                      — Monthly review doc`);
    console.log(`  POST /webhook/ghl/eod                      — GHL EOD Update`);
    console.log(`  POST /webhook/ghl/job-won                  — GHL Job Won`);
    console.log(`  POST /webhook/ghl/site-visit               — GHL Site Visit Booked`);
    console.log(`  POST /webhook/quote                        — Make.com Quote Sent`);
    console.log(`  POST /webhook/email                        — Make.com Email Sent (legacy)`);
    console.log(`  GET  /oauth/mailbox/start                  — Mailbox OAuth start (gmail|outlook)`);
    console.log(`  GET  /oauth/mailbox/callback               — Mailbox OAuth callback`);
    console.log(`  POST /oauth/mailbox/sync                   — Manual mailbox sync`);
    console.log(`  POST /webhook/eod/send/<company>           — Send EOD for one company`);
    console.log(`  POST /webhook/eod/archive/<company>        — Archive EOD for one company`);
    console.log(`  GET  /status                               — Status + schedules`);
    console.log(`  GET  /health                               — Health check\n`);
  });
}

start();
