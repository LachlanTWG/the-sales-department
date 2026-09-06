// Sales Exec Huddle Board sync (ClickUp OPERATIONS space).
//
// Pushes live Postgres numbers into the huddle board lists so the ClickUp
// dashboard cards (which can only read ClickUp data) stay current:
//   - Leaderboards:   one task per exec, WTD + MTD custom fields, hourly
//   - Client Health:  one task per client, jobs pace + FB lead stats, hourly
//   - Meetings:       one task per week, Friday morning, agenda pre-filled
//
// Custom fields are created on first run and matched by NAME afterwards —
// renaming a field in ClickUp orphans it and the sync will create a fresh
// one with the original name. Task matching is also by name; the sync owns
// task descriptions + synced fields, everything else (comments, manual
// fields, checklists) is left untouched.

const { clickupRequest } = require('./clickup');
const { loadCompanies } = require('../config/companiesStore');
const db = require('../db');
const {
  gridToRows, execMetrics, clientMetrics, deadLeads, upcomingSiteVisits,
  todayInTz, mondayOf, monthStartOf,
} = require('../reporting/huddleMetrics');
const { cleanAddress } = require('../reporting/addressFormat');
const cfg = require('../config/huddleBoard.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Field specs ────────────────────────────────────────────────────

const LEADERBOARD_FIELDS = [
  ['Calls (WTD)', 'number'], ['Calls (MTD)', 'number'],
  ['Spoke To (WTD)', 'number'], ['Spoke To (MTD)', 'number'],
  ['Appointments (WTD)', 'number'], ['Appointments (MTD)', 'number'],
  ['Quotes Sent (WTD)', 'number'], ['Quotes Sent (MTD)', 'number'],
  ['Quote Value (WTD)', 'currency'], ['Quote Value (MTD)', 'currency'],
  ['Jobs Won (WTD)', 'number'], ['Jobs Won (MTD)', 'number'],
  ['Revenue (WTD)', 'currency'], ['Revenue (MTD)', 'currency'],
];

const CLIENT_HEALTH_FIELDS = [
  ['Health (Auto)', 'short_text'],
  // Pace is quarterly (8/mo × 3 = 24/qtr). New field names — ensureFields
  // creates them; any leftover MTD fields in ClickUp are left untouched.
  ['Jobs Won (QTD)', 'number'], ['Jobs Target (/qtr)', 'number'],
  ['Revenue (QTD)', 'currency'],
  ['FB Leads (WTD)', 'number'], ['FB Leads (MTD)', 'number'],
  ['Lead → Appt % (MTD)', 'number'],
  ['Dead Leads (WTD)', 'number'],
];

// Some field types may be rejected on some plans — degrade rather than fail.
const TYPE_FALLBACK = { currency: 'number', short_text: 'text' };

// ─── ClickUp helpers ────────────────────────────────────────────────

async function ensureFields(listId, specs) {
  const existing = await clickupRequest('GET', `/api/v2/list/${listId}/field`);
  const byName = new Map((existing.fields || []).map(f => [f.name, f]));
  for (const [name, type] of specs) {
    if (byName.has(name)) continue;
    let field;
    try {
      ({ field } = await clickupRequest('POST', `/api/v2/list/${listId}/field`, { name, type }));
    } catch (err) {
      const fallback = TYPE_FALLBACK[type];
      if (!fallback) throw err;
      ({ field } = await clickupRequest('POST', `/api/v2/list/${listId}/field`, { name, type: fallback }));
    }
    byName.set(name, field);
    console.log(`  [huddle] created field "${name}" on list ${listId}`);
    await sleep(150);
  }
  return byName;
}

async function getTasks(listId) {
  const res = await clickupRequest('GET', `/api/v2/list/${listId}/task?include_closed=true`);
  return res.tasks || [];
}

function fieldValueEquals(field, next) {
  const current = field ? field.value : undefined;
  if (current === undefined || current === null) return next === null;
  if (typeof next === 'number') return Number(current) === next;
  return String(current) === String(next);
}

/**
 * Create or update one synced task: description always refreshed, custom
 * fields only written when the value actually changed (keeps API calls and
 * task activity noise down).
 * @param {Map} fieldMap  name -> field (from ensureFields)
 * @param {object} values name -> number|string
 */
async function upsertTask(listId, tasks, name, description, fieldMap, values) {
  let task = tasks.find(t => t.name === name);

  if (!task) {
    const custom_fields = Object.entries(values)
      .filter(([f]) => fieldMap.has(f))
      .map(([f, value]) => ({ id: fieldMap.get(f).id, value }));
    task = await clickupRequest('POST', `/api/v2/list/${listId}/task`, {
      name, markdown_description: description, custom_fields,
    });
    console.log(`  [huddle] created task "${name}"`);
    return task;
  }

  await clickupRequest('PUT', `/api/v2/task/${task.id}`, { markdown_description: description });
  for (const [fname, value] of Object.entries(values)) {
    const field = fieldMap.get(fname);
    if (!field) continue;
    const current = (task.custom_fields || []).find(f => f.id === field.id);
    if (fieldValueEquals(current, value)) continue;
    await clickupRequest('POST', `/api/v2/task/${task.id}/field/${field.id}`, { value });
    await sleep(120);
  }
  return task;
}

// ─── Formatting ─────────────────────────────────────────────────────

const money = n => '$' + Math.round(n).toLocaleString('en-AU');
const pretty = d => new Date(d + 'T12:00:00Z')
  .toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });

// "2026-07-18T09:00:00" (client wall-clock, no zone) → "Sat 18 Jul 9:00am",
// same shape as the EOD report's visit lines. Date-only visits → "Sun 19 Jul".
const VISIT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const VISIT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function prettyVisit(v) {
  const iso = v.datetime || (v.date ? v.date + 'T00:00:00' : '');
  const d = new Date(iso + 'Z'); // parse as UTC so local machine TZ can't shift the wall-clock
  if (!iso || isNaN(d.getTime())) return v.datetime || v.date || 'TBC';
  const day = `${VISIT_DAYS[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2, '0')} ${VISIT_MONTHS[d.getUTCMonth()]}`;
  if (!v.datetime) return day;
  let h = d.getUTCHours();
  const mins = String(d.getUTCMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${day} ${h}:${mins}${ampm}`;
}

function siteVisitsSection(visits) {
  if (!visits.length) return '### 🏠 Site visits (upcoming)\n_None booked._';
  const lines = visits.map(v => {
    const addr = cleanAddress(v.address);
    return `- **${v.contact}** — ${v.company}${addr ? ` — ${addr}` : ''} — ${prettyVisit(v)}${v.virtual ? ' (virtual)' : ''}`;
  });
  return `### 🏠 Site visits (upcoming)\n${lines.join('\n')}`;
}

function syncedStamp() {
  const now = new Date().toLocaleString('en-AU', {
    timeZone: cfg.timezone, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  });
  return `_Auto-synced from the EOD database — ${now} AEST. Manual edits to this description will be overwritten._`;
}

function metricsTable(byCompany) {
  const lines = [
    '| Client | Calls | Spoke To | Appts | Quotes | Quote $ | Won | Revenue |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const [company, m] of Object.entries(byCompany)) {
    lines.push(`| ${company} | ${m.calls} | ${m.spokeTo} | ${m.appointments} | ${m.quotesSent} | ${money(m.quoteValue)} | ${m.jobsWon} | ${money(m.revenue)} |`);
  }
  return lines.join('\n');
}

// ─── Data load ──────────────────────────────────────────────────────

async function loadAllRows() {
  const { companies } = loadCompanies();
  const rows = [];
  const companyNames = [];
  for (const company of companies) {
    try {
      const grid = await db.fetchActivityGrid(company.name);
      rows.push(...gridToRows(grid, company.name));
      companyNames.push(company.name);
    } catch (err) {
      console.warn(`  [huddle] skipping ${company.name}: ${err.message}`);
    }
  }
  return { rows, companyNames };
}

function periods() {
  const today = todayInTz(cfg.timezone);
  return { today, weekStart: mondayOf(today), monthStart: monthStartOf(today) };
}

// ─── Sync entry points ──────────────────────────────────────────────

async function syncHuddleBoard() {
  const { rows, companyNames } = await loadAllRows();
  const { today, weekStart, monthStart } = periods();

  // Leaderboards — one task per exec
  const lbFields = await ensureFields(cfg.leaderboardsListId, LEADERBOARD_FIELDS);
  const lbTasks = await getTasks(cfg.leaderboardsListId);
  for (const exec of cfg.execs) {
    const wtd = execMetrics(rows, exec, weekStart, today);
    const mtd = execMetrics(rows, exec, monthStart, today);
    const values = {
      'Calls (WTD)': wtd.total.calls, 'Calls (MTD)': mtd.total.calls,
      'Spoke To (WTD)': wtd.total.spokeTo, 'Spoke To (MTD)': mtd.total.spokeTo,
      'Appointments (WTD)': wtd.total.appointments, 'Appointments (MTD)': mtd.total.appointments,
      'Quotes Sent (WTD)': wtd.total.quotesSent, 'Quotes Sent (MTD)': mtd.total.quotesSent,
      'Quote Value (WTD)': Math.round(wtd.total.quoteValue), 'Quote Value (MTD)': Math.round(mtd.total.quoteValue),
      'Jobs Won (WTD)': wtd.total.jobsWon, 'Jobs Won (MTD)': mtd.total.jobsWon,
      'Revenue (WTD)': Math.round(wtd.total.revenue), 'Revenue (MTD)': Math.round(mtd.total.revenue),
    };
    const description = [
      syncedStamp(),
      '',
      siteVisitsSection(upcomingSiteVisits(rows, exec, today)),
      '',
      `### This week (from Mon ${pretty(weekStart)})`,
      Object.keys(wtd.byCompany).length ? metricsTable(wtd.byCompany) : '_No activity yet this week._',
      '',
      `### This month (from ${pretty(monthStart)})`,
      Object.keys(mtd.byCompany).length ? metricsTable(mtd.byCompany) : '_No activity yet this month._',
    ].join('\n');
    await upsertTask(cfg.leaderboardsListId, lbTasks, exec, description, lbFields, values);
  }

  // Client Health — one task per client
  const chFields = await ensureFields(cfg.clientHealthListId, CLIENT_HEALTH_FIELDS);
  const chTasks = await getTasks(cfg.clientHealthListId);
  for (const company of companyNames) {
    const companyRows = rows.filter(r => r.company === company);
    const m = clientMetrics(companyRows, {
      today, weekStart, monthStart, target: cfg.jobsPerMonthTarget,
    });
    const values = {
      'Health (Auto)': m.health,
      'Jobs Won (QTD)': m.jobsWonQTD,
      'Jobs Target (/qtr)': m.quarterTarget,
      'Revenue (QTD)': Math.round(m.revenueQTD),
      'FB Leads (WTD)': m.fbLeadsWTD,
      'FB Leads (MTD)': m.fbLeadsMTD,
      'Lead → Appt % (MTD)': m.leadToApptPct,
      'Dead Leads (WTD)': m.deadLeadsWTD,
    };
    const dead = deadLeads(companyRows, weekStart, today);
    const description = [
      syncedStamp(),
      '',
      `**${m.health}** — ${m.jobsWonQTD} job${m.jobsWonQTD === 1 ? '' : 's'} won this quarter (target ${m.quarterTarget}/qtr = ${cfg.jobsPerMonthTarget}/mo), ${money(m.revenueQTD)} revenue.`,
      `Health is projected from quarter-to-date pace (since ${pretty(m.quarterStart)}); "happy client" stays a human call.`,
      '',
      dead.length
        ? `### Dead leads this week\n` + dead.map(d =>
            `- **${d.contact}** — ${d.outcome} (${d.exec}, ${pretty(d.date)})${d.notes ? ` — ${d.notes}` : ''}`
          ).join('\n')
        : '_No dead leads this week._',
    ].join('\n');
    await upsertTask(cfg.clientHealthListId, chTasks, company, description, chFields, values);
  }

  console.log(`  [huddle] sync complete: ${cfg.execs.length} execs, ${companyNames.length} clients`);
}

// Weekly huddle meeting task — idempotent by name, so the Friday cron and
// manual runs can overlap safely. By default reviews the current week to
// date (Friday-huddle shape); pass {statsStart, statsEnd, weekLabel} to
// review a different window, e.g. the previous full week for a Monday run.
async function createWeeklyHuddleTask(opts = {}) {
  const { rows, companyNames } = await loadAllRows();
  const { today, weekStart } = periods();
  const statsStart = opts.statsStart || weekStart;
  const statsEnd = opts.statsEnd || today;
  const weekLabel = opts.weekLabel || pretty(weekStart);

  const name = `🏂 Sales Exec Huddle — Week of ${weekLabel}`;
  const tasks = await getTasks(cfg.meetingsListId);
  if (tasks.some(t => t.name === name)) {
    console.log(`  [huddle] meeting task already exists: "${name}"`);
    return null;
  }

  const execLines = [
    '| Exec | Calls | Spoke To | Appts | Quotes | Quote $ | Won | Revenue |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const exec of cfg.execs) {
    const { total: m } = execMetrics(rows, exec, statsStart, statsEnd);
    execLines.push(`| ${exec} | ${m.calls} | ${m.spokeTo} | ${m.appointments} | ${m.quotesSent} | ${money(m.quoteValue)} | ${m.jobsWon} | ${money(m.revenue)} |`);
  }

  const deadSections = [];
  for (const company of companyNames) {
    const dead = deadLeads(rows.filter(r => r.company === company), statsStart, statsEnd);
    if (!dead.length) continue;
    deadSections.push(`**${company}**\n` + dead.map(d =>
      `- ${d.contact} — ${d.outcome} (${d.exec}, ${pretty(d.date)})${d.notes ? ` — ${d.notes}` : ''}`
    ).join('\n'));
  }

  const statsLabel = `${pretty(statsStart)} – ${pretty(statsEnd)}`;
  const description = [
    `Stats cover ${statsLabel} — live numbers are on the Leaderboards and Client Health lists.`,
    '',
    `## By exec (${statsLabel})`,
    execLines.join('\n'),
    '',
    `## Dead leads (${statsLabel})`,
    deadSections.length ? deadSections.join('\n\n') : '_None recorded._',
    '',
    '## Agenda',
    '- Wins + numbers review',
    '- Client health / issues',
    '- Lead quality + process',
    '- Ideas / things worth addressing',
  ].join('\n');

  const task = await clickupRequest('POST', `/api/v2/list/${cfg.meetingsListId}/task`, {
    name,
    markdown_description: description,
    due_date: Date.parse(today + 'T17:00:00+10:00'),
  });
  console.log(`  [huddle] created meeting task: "${name}"`);
  return task;
}

module.exports = { syncHuddleBoard, createWeeklyHuddleTask };
