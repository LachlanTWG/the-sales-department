// Pure metric computation for the Sales Exec Huddle Board (ClickUp).
//
// Consumes the deduped activity grid from db.fetchActivityGrid() — the same
// read path every report uses — so leaderboard numbers can never disagree
// with EOD/EOW reports. Classification rules mirror the dashboard
// (dashboard/src/lib/messages.ts + configs/outcomes.json): outcome strings
// are pipe-delimited "Lead Type | Answer Status | Action | Notes | Source",
// pipe-separated quote values are alternative tiers averaged (never summed),
// and Total Calls = Answered + Didn't Answer.

// GHL webhook outcome names → canonical names (subset relevant to
// dead-lead classification; mirrors OUTCOME_ALIASES in messages.ts).
const OUTCOME_ALIASES = {
  'Disqualified - Extent of Works': 'DQ - Extent of Works',
  'Disqualified - Out of Service Area': 'DQ - Out of Service Area',
  'Disqualified - Wrong Contact/Number': 'DQ - Wrong Contact / Spam',
  'Disqualified - Price': 'DQ - Price',
  'Disqualified - Lead Looking for Work': 'DQ - Lead Looking for Work',
};

// Outcome actions that mean a lead is dead (categories dq/lost/abandoned in
// dashboard/src/lib/configs/outcomes.json).
const DEAD_OUTCOMES = new Set([
  'DQ - Incorrect Details',
  'DQ - Out of Service Area',
  'DQ - Price',
  'DQ - Extent of Works',
  'DQ - Wrong Contact / Spam',
  'DQ - Lead Looking for Work',
  'DQ - Recommended Another Company',
  'DQ - Trying to Sell Me Something',
  'DQ - Not Proceeding',
  'Lost - Price',
  'Lost - Time Related',
  'Lost - Priorities Changed',
  'Abandoned - Not Responding',
  'Abandoned - Headache',
]);

const FB_SOURCES = new Set(['Facebook Ad Form', 'Facebook Message']);

// Pipe-separated quote values are alternative tiers for one quote group:
// the group's value is their MEAN, never the sum (quoteGroupValue in
// dashboard/src/lib/format.ts).
function quoteGroupValue(raw) {
  if (!raw) return 0;
  const parts = String(raw)
    .split('|')
    .map(v => Number(String(v).replace(/[^\d.]/g, '')))
    .filter(n => Number.isFinite(n) && n > 0);
  if (parts.length === 0) return 0;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

function parseOutcome(s) {
  const parts = String(s || '').split('|').map(p => p.trim());
  const action = OUTCOME_ALIASES[parts[2]] || parts[2] || '';
  return {
    leadType: parts[0] || '',
    answerStatus: parts[1] || '',
    action,
    notes: parts[3] || '',
    source: parts[4] || '',
  };
}

function normName(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Date helpers (calendar dates; occurred_on is already client-local) ──

function todayInTz(tz) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay() || 7; // 1=Mon … 7=Sun
  d.setUTCDate(d.getUTCDate() - (dow - 1));
  return d.toISOString().slice(0, 10);
}

function monthStartOf(dateStr) {
  return dateStr.slice(0, 8) + '01';
}

// Calendar quarter start (Jan/Apr/Jul/Oct). Same boundaries as Aus FY
// quarters — only the Q numbering differs.
function quarterStartOf(dateStr) {
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(5, 7));
  const startM = Math.floor((m - 1) / 3) * 3 + 1;
  return `${y}-${String(startM).padStart(2, '0')}-01`;
}

function nextQuarterStartOf(dateStr) {
  const qs = quarterStartOf(dateStr);
  const y = Number(qs.slice(0, 4));
  const m = Number(qs.slice(5, 7));
  if (m === 10) return `${y + 1}-01-01`;
  return `${y}-${String(m + 3).padStart(2, '0')}-01`;
}

function daysBetween(startStr, endStr) {
  const a = new Date(startStr + 'T00:00:00Z');
  const b = new Date(endStr + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

// Inclusive day-of-quarter (1 on the first day of the quarter).
function dayOfQuarter(dateStr) {
  return daysBetween(quarterStartOf(dateStr), dateStr) + 1;
}

function daysInQuarter(dateStr) {
  return daysBetween(quarterStartOf(dateStr), nextQuarterStartOf(dateStr));
}

// ─── Grid → row objects ─────────────────────────────────────────────

// Convert the sheet-shaped grid (header row + string rows) from
// fetchActivityGrid into objects keyed by header name.
function gridToRows(grid, companyName) {
  const [headers, ...rows] = grid;
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
  return rows.map(r => ({
    company: companyName,
    date: r[idx['Date']],
    salesPerson: r[idx['Sales Person']],
    contactName: r[idx['Contact Name']],
    eventType: r[idx['Event Type']],
    outcome: r[idx['Outcome']],
    adSource: r[idx['Ad Source']],
    quoteJobValue: r[idx['Quote/Job Value']],
    contactId: r[idx['Contact ID']],
    contactAddress: r[idx['Contact Address']],
    appointmentDateTime: r[idx['Appointment Date Time']],
    appointmentDate: r[idx['Appointment Date']],
  }));
}

const inRange = (row, start, end) => row.date >= start && row.date <= end;

// ─── Exec metrics ───────────────────────────────────────────────────

// Activity totals for one exec over [start, end], with per-company splits.
// `rows` spans all companies (already deduped by fetchActivityGrid).
function execMetrics(rows, execName, start, end) {
  const zero = () => ({
    calls: 0, spokeTo: 0, appointments: 0,
    quotesSent: 0, quoteValue: 0, jobsWon: 0, revenue: 0,
  });
  const total = zero();
  const byCompany = {};

  for (const row of rows) {
    if (row.salesPerson !== execName || !inRange(row, start, end)) continue;
    const c = (byCompany[row.company] ||= zero());
    const bump = (key, n = 1) => { total[key] += n; c[key] += n; };

    if (row.eventType === 'EOD Update') {
      const { answerStatus } = parseOutcome(row.outcome);
      if (answerStatus === 'Answered' || answerStatus === "Didn't Answer") bump('calls');
      if (answerStatus === 'Answered') bump('spokeTo');
    } else if (row.eventType === 'Site Visit Booked') {
      bump('appointments');
    } else if (row.eventType === 'Quote Sent') {
      bump('quotesSent');
      bump('quoteValue', quoteGroupValue(row.quoteJobValue));
    } else if (row.eventType === 'Job Won') {
      bump('jobsWon');
      bump('revenue', quoteGroupValue(row.quoteJobValue));
    }
  }
  return { total, byCompany };
}

// Activity totals over [start, end] for whatever rows are passed in (one
// company's rows, or all companies' rows for portfolio totals). Same event
// classification as execMetrics, plus New Leads from the outcome lead type.
function rangeTotals(rows, start, end) {
  const t = {
    calls: 0, spokeTo: 0, newLeads: 0, appointments: 0,
    quotesSent: 0, quoteValue: 0, jobsWon: 0, revenue: 0,
  };
  for (const row of rows) {
    if (!inRange(row, start, end)) continue;
    if (row.eventType === 'EOD Update') {
      const { leadType, answerStatus } = parseOutcome(row.outcome);
      if (answerStatus === 'Answered' || answerStatus === "Didn't Answer") t.calls += 1;
      if (answerStatus === 'Answered') t.spokeTo += 1;
      if (leadType === 'New Leads') t.newLeads += 1;
    } else if (row.eventType === 'Site Visit Booked') {
      t.appointments += 1;
    } else if (row.eventType === 'Quote Sent') {
      t.quotesSent += 1;
      t.quoteValue += quoteGroupValue(row.quoteJobValue);
    } else if (row.eventType === 'Job Won') {
      t.jobsWon += 1;
      t.revenue += quoteGroupValue(row.quoteJobValue);
    }
  }
  return t;
}

// ─── Client metrics ─────────────────────────────────────────────────

// Contact registry for one company's rows: first-seen date, whether the
// contact ever came via a Facebook ad, whether they ever booked a visit.
function buildContacts(rows) {
  const contacts = new Map();
  for (const row of rows) {
    const key = normName(row.contactName) || (row.contactId || '').trim();
    if (!key) continue;
    let c = contacts.get(key);
    if (!c) { c = { firstSeen: row.date, fb: false, appt: false }; contacts.set(key, c); }
    if (row.date < c.firstSeen) c.firstSeen = row.date;
    if (FB_SOURCES.has((row.adSource || '').trim())) c.fb = true;
    if (row.eventType === 'Site Visit Booked') c.appt = true;
  }
  return contacts;
}

// Health for one client. Jobs/revenue pace is quarter-to-date against
// `target * 3` (e.g. 8/mo → 24/qtr), so a fresh calendar month mid-quarter
// doesn't falsely read as "no jobs / off pace". FB lead stats stay monthly.
// `rows` are that company's rows only.
function clientMetrics(rows, { today, weekStart, monthStart, target }) {
  const quarterStart = quarterStartOf(today);
  const quarterTarget = (Number(target) || 0) * 3;

  let jobsWonQTD = 0;
  let revenueQTD = 0;
  let deadLeadsWTD = 0;
  for (const row of rows) {
    if (row.eventType === 'Job Won' && inRange(row, quarterStart, today)) {
      jobsWonQTD += 1;
      revenueQTD += quoteGroupValue(row.quoteJobValue);
    }
    if (row.eventType === 'EOD Update' && inRange(row, weekStart, today)
        && DEAD_OUTCOMES.has(parseOutcome(row.outcome).action)) {
      deadLeadsWTD += 1;
    }
  }

  const contacts = buildContacts(rows);
  let fbLeadsWTD = 0, fbLeadsMTD = 0, fbLeadsMTDWithAppt = 0;
  for (const c of contacts.values()) {
    if (!c.fb) continue;
    if (c.firstSeen >= weekStart && c.firstSeen <= today) fbLeadsWTD += 1;
    if (c.firstSeen >= monthStart && c.firstSeen <= today) {
      fbLeadsMTD += 1;
      if (c.appt) fbLeadsMTDWithAppt += 1;
    }
  }
  const leadToApptPct = fbLeadsMTD > 0
    ? Math.round((fbLeadsMTDWithAppt / fbLeadsMTD) * 100)
    : 0;

  // Traffic light from quarter-end projection at the current pace. "Happy"
  // (the human half of green) stays a manual call on the board.
  const dayOfQ = Math.max(1, dayOfQuarter(today));
  const daysInQ = daysInQuarter(today);
  const projected = jobsWonQTD * (daysInQ / dayOfQ);
  const health = projected >= quarterTarget ? '🟢 On Pace'
    : jobsWonQTD > 0 ? '🟠 Behind Pace'
    : '🔴 No Jobs Yet';

  return {
    jobsWonQTD,
    revenueQTD,
    quarterTarget,
    quarterStart,
    // Aliases kept so older callers reading MTD names still get QTD numbers
    // (pace is the quarterly target either way).
    jobsWonMTD: jobsWonQTD,
    revenueMTD: revenueQTD,
    fbLeadsWTD,
    fbLeadsMTD,
    leadToApptPct,
    deadLeadsWTD,
    health,
  };
}

// ─── Site visits ────────────────────────────────────────────────────

// Upcoming booked site visits for one exec, across all companies: appointment
// date on/after `fromDate`, soonest first. appointment_at is client wall-clock
// (fetchActivityGrid emits it as a naive string), so the >= compare against a
// Sydney "today" can be a few hours off around midnight — fine for a board.
// Visits with no appointment date at all can't be placed in time, so they're
// left out (mirrors the morning Slack notification in runReports.js).
function upcomingSiteVisits(rows, execName, fromDate) {
  return rows
    .filter(r => r.eventType === 'Site Visit Booked'
      && r.salesPerson === execName
      && (r.appointmentDate || (r.appointmentDateTime || '').slice(0, 10)) >= fromDate)
    .map(r => ({
      company: r.company,
      contact: r.contactName || '(no name)',
      address: r.contactAddress || '',
      datetime: r.appointmentDateTime || '',
      date: r.appointmentDate || (r.appointmentDateTime || '').slice(0, 10),
    }))
    .sort((a, b) => (a.datetime || a.date).localeCompare(b.datetime || b.date));
}

// Dead leads over [start, end] for the meeting agenda: who, which client,
// which exec, and the outcome that killed it.
function deadLeads(rows, start, end) {
  const out = [];
  for (const row of rows) {
    if (row.eventType !== 'EOD Update' || !inRange(row, start, end)) continue;
    const { action, notes } = parseOutcome(row.outcome);
    if (!DEAD_OUTCOMES.has(action)) continue;
    out.push({
      date: row.date,
      company: row.company,
      exec: row.salesPerson,
      contact: row.contactName || '(no name)',
      outcome: action,
      notes,
    });
  }
  return out.sort((a, b) => a.company.localeCompare(b.company) || a.date.localeCompare(b.date));
}

module.exports = {
  quoteGroupValue,
  parseOutcome,
  gridToRows,
  execMetrics,
  rangeTotals,
  clientMetrics,
  deadLeads,
  upcomingSiteVisits,
  todayInTz,
  mondayOf,
  monthStartOf,
  quarterStartOf,
  dayOfQuarter,
  daysInQuarter,
  DEAD_OUTCOMES,
  FB_SOURCES,
};
