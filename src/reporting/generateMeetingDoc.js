const db = require('../db');
const { countOutcomes } = require('./generateEOD');
const { loadConfig } = require('../config/configLoader');
const { loadCompanies } = require('../config/companiesStore');
const { displayLabel } = require('./displayLabels');
const {
  gridToRows, execMetrics, rangeTotals, clientMetrics, deadLeads,
  upcomingSiteVisits, quoteGroupValue, monthStartOf,
} = require('./huddleMetrics');
const huddleCfg = require('../config/huddleBoard.json');

function formatDollar(value) {
  return '$' + Math.round(value).toLocaleString('en-AU');
}

function formatShortDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()} ${months[d.getMonth()]}`;
}

function formatLongDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function parseActivityRows(rows, headers) {
  return rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] || ''; });
    return obj;
  });
}

function filterActivities(activities, targetDate, salesPerson) {
  return activities.filter(a => {
    if (a['Date'] !== targetDate) return false;
    if (salesPerson && salesPerson !== 'Team' && !a['Sales Person'].startsWith(salesPerson)) return false;
    return true;
  });
}

// ClickUp @mention user IDs
const CLICKUP_USER_IDS = {
  'Lachlan': 89456729,
  'Buzz': 95618544,
  'Zac': 89544715,
  'Benji': 89419061,
  'Max': 113602349,
};

function mention(name) {
  const id = CLICKUP_USER_IDS[name];
  if (id) return `[@${name}](#user_mention#${id})`;
  return `@${name}`;
}

// "Bolton EC — Solar | Perth, WA" heading, tolerating missing config fields.
function companyHeading(company) {
  const meta = [company.industry, company.location].filter(Boolean).join(' | ');
  return `### 🏢 ${company.name}${meta ? ` — ${meta}` : ''}`;
}

function getCompanyType(companyName) {
  const { outcomes } = loadConfig(companyName);
  const names = outcomes.outcomes.map(o => o.name);
  if (names.includes('Quote Sent')) return 'trade';
  if (names.includes('Roadmap Booked')) return 'agency';
  return 'trade';
}

function getTotalField(companyName) {
  const { outcomes } = loadConfig(companyName);
  const names = outcomes.outcomes.map(o => o.name);
  return names.includes('Total Calls') ? 'Total Calls' : 'Total Contact Attempts';
}

function collectSources(counts, companyName) {
  const { outcomes } = loadConfig(companyName);
  const sourceOutcomes = outcomes.outcomes.filter(o => o.category === 'source');
  const shortNames = {
    'Facebook Ad Form': 'FB Ad', 'Website Form': 'Website', 'Instagram Message': 'Insta',
    'Facebook Message': 'FB Msg', 'Direct Email': 'Email', 'Direct Phone Call': 'Phone',
    'Direct Text Message': 'Text', 'Direct Lead passed on from Client': 'Referral',
    'Recommended Another Company': 'Recommended',
  };
  const sources = {};
  for (const s of sourceOutcomes) {
    const count = counts[s.name] || 0;
    if (count > 0) {
      const label = shortNames[s.name] || s.name;
      sources[label] = (sources[label] || 0) + count;
    }
  }
  return sources;
}

function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

function pct(numerator, denominator) {
  if (!denominator) return '-';
  return ((numerator / denominator) * 100).toFixed(0) + '%';
}

// ─── Weekly Doc — Exec-First, Exceptions-First ──────────────────────
//
// All numbers come from huddleMetrics over the deduped fetchActivityGrid
// rows, so the meeting doc can never disagree with the huddle board or the
// dashboard. Structure: portfolio snapshot → exec scoreboard → client
// health → 90-day funnel → auto talking points → jobs won → meeting
// scaffold (KPIs / notes / to-dos) → per-client trend appendix.

// Sum-of-range totals for [weeks] prior weeks, for the snapshot comparison.
function priorWeeksAverage(rows, weekStart, weekEnd, weeks) {
  const totals = [];
  for (let i = 1; i <= weeks; i++) {
    totals.push(rangeTotals(rows, addDaysStr(weekStart, -7 * i), addDaysStr(weekEnd, -7 * i)));
  }
  const avg = {};
  for (const key of Object.keys(totals[0] || {})) {
    avg[key] = totals.reduce((s, t) => s + t[key], 0) / (totals.length || 1);
  }
  return avg;
}

function deltaArrow(current, average, isMoney) {
  const diff = current - average;
  if (Math.abs(diff) < (isMoney ? 1 : 0.5)) return '—';
  const arrow = diff > 0 ? '▲' : '▼';
  const magnitude = isMoney ? formatDollar(Math.abs(diff)) : Math.round(Math.abs(diff));
  return `${arrow} ${magnitude}`;
}

// Recent weekly totals for one company: 4 most recent weeks (including the
// reported one) plus an average over up to 12 active weeks (scanning back up
// to 26). A week is "active" if anything at all was logged.
function weeklyTrend(rows, weekStart) {
  const weeks = [];
  for (let i = 0; i <= 26 && weeks.length < 12; i++) {
    const ws = addDaysStr(weekStart, -7 * i);
    const t = rangeTotals(rows, ws, addDaysStr(ws, 6));
    if (t.calls === 0 && t.appointments === 0 && t.quotesSent === 0 && t.jobsWon === 0) continue;
    weeks.push({ ...t, weekStart: ws });
  }
  if (weeks.length === 0) return null;
  const last4 = weeks.slice(0, 4).reverse(); // chronological
  const averages = {};
  for (const key of Object.keys(weeks[0])) {
    if (key === 'weekStart') continue;
    averages[key] = weeks.reduce((s, w) => s + w[key], 0) / weeks.length;
  }
  return { last4, averages, weeksUsed: weeks.length };
}

const TREND_METRICS = [
  { label: '📞 Calls', key: 'calls' },
  { label: '📱 Answered', key: 'spokeTo' },
  { label: '🌱 New Leads', key: 'newLeads' },
  { label: '📤 Quotes Sent', key: 'quotesSent' },
  { label: '🚙 Site Visits', key: 'appointments' },
  { label: '🏆 Jobs Won', key: 'jobsWon' },
  { label: '💰 Revenue', key: 'revenue', dollar: true },
];

function buildTrendTable(trend) {
  if (!trend) return '_No activity logged yet._';
  const headers = trend.last4.map(w => formatShortDate(w.weekStart));
  headers.push(`**${trend.weeksUsed}wk Avg**`);
  const lines = [];
  lines.push(`| Metric | ${headers.join(' | ')} |`);
  lines.push(`|---|${headers.map(() => '---').join('|')}|`);
  for (const m of TREND_METRICS) {
    const vals = trend.last4.map(w => m.dollar ? formatDollar(w[m.key]) : Math.round(w[m.key]));
    const avg = trend.averages[m.key] || 0;
    vals.push(`**${m.dollar ? formatDollar(avg) : Math.round(avg)}**`);
    lines.push(`| ${m.label} | ${vals.join(' | ')} |`);
  }
  return lines.join('\n');
}

function getAllActivePeople(companies) {
  const seen = new Set();
  const people = [];
  for (const c of companies) {
    for (const p of (c.salesPeople || [])) {
      if (p.active && !seen.has(p.name)) {
        seen.add(p.name);
        people.push(p.name);
      }
    }
  }
  return people;
}

async function generateMeetingDoc(startDate, endDate) {
  const { companies } = loadCompanies();
  const allPeople = getAllActivePeople(companies);

  // One deduped grid fetch per company → row objects tagged with company name.
  const rowsByCompany = new Map();
  const fetchErrors = new Map();
  for (const company of companies) {
    try {
      const grid = await db.fetchActivityGrid(company.name);
      rowsByCompany.set(company.name, grid.length >= 2 ? gridToRows(grid, company.name) : []);
    } catch (err) {
      fetchErrors.set(company.name, err.message);
      rowsByCompany.set(company.name, []);
    }
  }
  const allRows = [...rowsByCompany.values()].flat();

  const monthStart = monthStartOf(endDate);
  const funnelStart = addDaysStr(endDate, -89);
  const jobsPerMonth = huddleCfg.jobsPerMonthTarget;
  const jobsPerQuarter = jobsPerMonth * 3; // 8/mo → 24/qtr

  // Per-client computations. Health/pace is quarter-to-date "as at" the
  // Sunday under review (target = 8 jobs/mo × 3 = 24/quarter), so a fresh
  // calendar month mid-quarter doesn't wipe the signal.
  const clients = companies.map(company => {
    const rows = rowsByCompany.get(company.name);
    return {
      company,
      rows,
      week: rangeTotals(rows, startDate, endDate),
      health: clientMetrics(rows, {
        today: endDate, weekStart: startDate, monthStart,
        target: jobsPerMonth,
      }),
      funnel: rangeTotals(rows, funnelStart, endDate),
      trend: weeklyTrend(rows, startDate),
      error: fetchErrors.get(company.name),
    };
  });

  const lines = [];

  // ═══ HEADER ═══
  lines.push('# 📊 Sales Exec Weekly Meeting');
  lines.push('');
  lines.push(`**Facilitator:** ${mention('Lachlan')} | **Documenter:** ${mention('Lachlan')} | **Timekeeper:** ${mention('Lachlan')}`);
  lines.push(`**Participants:** ${allPeople.map(name => mention(name)).join(' ')}`);
  lines.push('');
  lines.push('* * *');
  lines.push('');

  // ═══ SEGUE ═══
  lines.push('## 💬 Segue — 5 min');
  lines.push('');
  lines.push('*   One piece of personal good news');
  lines.push('*   One piece of professional good news');
  lines.push('');
  lines.push('* * *');
  lines.push('');

  // ═══ PORTFOLIO SNAPSHOT ═══
  const week = rangeTotals(allRows, startDate, endDate);
  const avg4 = priorWeeksAverage(allRows, startDate, endDate, 4);
  const activeClientCount = clients.filter(c => c.week.calls > 0 || c.week.jobsWon > 0).length;

  lines.push('## 🏆 Portfolio Snapshot');
  lines.push(`_${formatLongDate(startDate)} — ${formatLongDate(endDate)} · ${activeClientCount} of ${companies.length} clients active_`);
  lines.push('_💵 Quote value = sum of per-quote averages: a quote with multiple tiers (e.g. 4 options for one job) counts once at the mean of its tiers, not their total._');
  lines.push('');
  lines.push('| Metric | This Week | 4-Wk Avg | Δ |');
  lines.push('|---|---|---|---|');
  const snapshotMetrics = [
    { label: '📞 Calls', key: 'calls' },
    { label: '📱 Answered', key: 'spokeTo' },
    { label: '🌱 New Leads', key: 'newLeads' },
    { label: '📤 Quotes Sent', key: 'quotesSent' },
    { label: '💵 Quote Value', key: 'quoteValue', dollar: true },
    { label: '🚙 Site Visits', key: 'appointments' },
    { label: '🏆 Jobs Won', key: 'jobsWon' },
    { label: '💰 Revenue', key: 'revenue', dollar: true },
  ];
  for (const m of snapshotMetrics) {
    const cur = m.dollar ? formatDollar(week[m.key]) : week[m.key];
    const avg = m.dollar ? formatDollar(avg4[m.key]) : Math.round(avg4[m.key]);
    lines.push(`| ${m.label} | **${cur}** | ${avg} | ${deltaArrow(week[m.key], avg4[m.key], m.dollar)} |`);
  }
  const avgPickUp = avg4.calls > 0 ? ((avg4.spokeTo / avg4.calls) * 100).toFixed(0) + '%' : '-';
  lines.push(`| ⚡ Pick-Up Rate | **${pct(week.spokeTo, week.calls)}** | ${avgPickUp} | |`);
  lines.push('');
  lines.push('* * *');
  lines.push('');

  // ═══ EXEC SCOREBOARD ═══
  lines.push('## 🧑‍💼 Exec Scoreboard — This Week');
  lines.push('_Quotes = quote groups sent · 💵 Quote Value = each group at the mean of its tiers._');
  lines.push('');
  lines.push('| Exec | 📞 Calls | 📱 Answered | ⚡ Pick-Up | 🚙 Visits | 📤 Quotes | 💵 Quote Value | 🏆 Jobs | 💰 Revenue |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const person of allPeople) {
    const m = execMetrics(allRows, person, startDate, endDate).total;
    lines.push(`| ${person} | ${m.calls} | ${m.spokeTo} | ${pct(m.spokeTo, m.calls)} | ${m.appointments} | ${m.quotesSent} | ${formatDollar(m.quoteValue)} | ${m.jobsWon} | ${formatDollar(m.revenue)} |`);
  }
  lines.push('');
  lines.push('* * *');
  lines.push('');

  // ═══ CLIENT HEALTH ═══
  lines.push('## 🏢 Client Health');
  lines.push(`_Jobs/revenue are quarter-to-date as at ${formatShortDate(endDate)} (target ${jobsPerMonth}/mo = ${jobsPerQuarter}/qtr). Pace projects to quarter-end. FB leads and lead→appt are month-to-date from Facebook-sourced contacts._`);
  lines.push('');
  lines.push('| Client | 📞 Calls | ⚡ Pick-Up | 📤 Quotes | 🏆 Jobs QTD | 💰 Revenue QTD | Pace | 🌱 FB Leads | 📅 Lead→Appt |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const c of clients) {
    const h = c.health;
    lines.push(`| ${c.company.name} | ${c.week.calls} | ${pct(c.week.spokeTo, c.week.calls)} | ${c.week.quotesSent} | ${h.jobsWonQTD} / ${jobsPerQuarter} | ${formatDollar(h.revenueQTD)} | ${h.health} | ${h.fbLeadsWTD} | ${h.fbLeadsMTD > 0 ? h.leadToApptPct + '%' : '-'} |`);
  }
  lines.push('');
  lines.push('* * *');
  lines.push('');

  // ═══ 90-DAY CONVERSION FUNNEL ═══
  lines.push('## 🔄 90-Day Conversion Funnel');
  lines.push(`_${formatShortDate(funnelStart)} — ${formatShortDate(endDate)}. Answered % of calls · visits % of answered · jobs % of visits._`);
  lines.push('');
  lines.push('| Client | 📞 Calls | 📱 Answered | 🚙 Site Visits | 🏆 Jobs Won |');
  lines.push('|---|---|---|---|---|');
  const portfolioFunnel = { calls: 0, spokeTo: 0, appointments: 0, jobsWon: 0 };
  for (const c of clients) {
    const f = c.funnel;
    portfolioFunnel.calls += f.calls;
    portfolioFunnel.spokeTo += f.spokeTo;
    portfolioFunnel.appointments += f.appointments;
    portfolioFunnel.jobsWon += f.jobsWon;
    if (f.calls === 0 && f.jobsWon === 0) continue;
    lines.push(`| ${c.company.name} | ${f.calls} | ${f.spokeTo} (${pct(f.spokeTo, f.calls)}) | ${f.appointments} (${pct(f.appointments, f.spokeTo)}) | ${f.jobsWon} (${pct(f.jobsWon, f.appointments)}) |`);
  }
  const pf = portfolioFunnel;
  lines.push(`| **Portfolio** | **${pf.calls}** | **${pf.spokeTo} (${pct(pf.spokeTo, pf.calls)})** | **${pf.appointments} (${pct(pf.appointments, pf.spokeTo)})** | **${pf.jobsWon} (${pct(pf.jobsWon, pf.appointments)})** |`);
  lines.push('');
  lines.push('* * *');
  lines.push('');

  // ═══ TALKING POINTS (auto-agenda) ═══
  lines.push('## 🗣️ Talking Points');
  lines.push('');

  const flags = [];
  for (const c of clients) {
    if (c.error) { flags.push(`⚠️ **${c.company.name}** — data fetch failed (${c.error})`); continue; }
    if (c.week.calls === 0) { flags.push(`🔇 **${c.company.name}** — no calls logged this week`); continue; }
    if (!c.health.health.startsWith('🟢')) {
      flags.push(`${c.health.health.split(' ')[0]} **${c.company.name}** — ${c.health.jobsWonQTD}/${jobsPerQuarter} jobs QTD (${c.health.health.replace(/^\S+\s/, '')})`);
    }
    if (c.week.calls >= 10 && c.week.spokeTo / c.week.calls < 0.25) {
      flags.push(`⚡ **${c.company.name}** — pick-up rate ${pct(c.week.spokeTo, c.week.calls)} on ${c.week.calls} calls`);
    }
  }
  lines.push('**Needs attention:**');
  if (flags.length > 0) {
    for (const f of flags) lines.push(`*   ${f}`);
  } else {
    lines.push('*   Nothing flagged — all clients active and on pace. 🎉');
  }
  lines.push('');

  const dead = deadLeads(allRows, startDate, endDate);
  lines.push(`**💀 Dead Leads This Week — ${dead.length}**`);
  lines.push('');
  if (dead.length > 0) {
    lines.push('| Client | Contact | Exec | Outcome | Notes |');
    lines.push('|---|---|---|---|---|');
    for (const d of dead) {
      const notes = (d.notes || '').replace(/[\n\r|]+/g, ' ').trim() || '-';
      lines.push(`| ${d.company} | ${d.contact} | ${d.exec} | ${d.outcome} | ${notes} |`);
    }
  } else {
    lines.push('_None._');
  }
  lines.push('');

  const upcomingFrom = addDaysStr(endDate, 1);
  const upcoming = [];
  for (const person of allPeople) {
    for (const v of upcomingSiteVisits(allRows, person, upcomingFrom)) {
      upcoming.push({ ...v, exec: person });
    }
  }
  upcoming.sort((a, b) => (a.datetime || a.date).localeCompare(b.datetime || b.date));
  lines.push(`**🚙 Upcoming Site Visits — ${upcoming.length}**`);
  lines.push('');
  if (upcoming.length > 0) {
    lines.push('| Date | Exec | Client | Contact | Address |');
    lines.push('|---|---|---|---|---|');
    for (const v of upcoming) {
      const addr = (v.address || '-').replace(/[\n\r]+/g, ', ');
      lines.push(`| ${v.datetime || v.date} | ${v.exec} | ${v.company} | ${v.contact}${v.virtual ? ' (virtual)' : ''} | ${addr} |`);
    }
  } else {
    lines.push('_None booked._');
  }
  lines.push('');
  lines.push('* * *');
  lines.push('');

  // ═══ JOBS WON THIS WEEK ═══
  const jobs = [];
  for (const c of clients) {
    for (const row of c.rows) {
      if (row.eventType !== 'Job Won' || row.date < startDate || row.date > endDate) continue;
      jobs.push({
        client: c.company.name,
        contact: row.contactName || '-',
        value: quoteGroupValue(row.quoteJobValue),
        source: displayLabel(row.adSource) || '-',
        exec: row.salesPerson || '-',
      });
    }
  }
  const jobsTotal = jobs.reduce((s, j) => s + j.value, 0);
  lines.push(`## 🏆 Jobs Won This Week — ${jobs.length} | ${formatDollar(jobsTotal)}`);
  lines.push('');
  if (jobs.length > 0) {
    lines.push('| Client | Contact | Value | Source | Exec |');
    lines.push('|---|---|---|---|---|');
    for (const j of jobs) {
      lines.push(`| ${j.client} | ${j.contact} | ${formatDollar(j.value)} | ${j.source} | ${j.exec} |`);
    }
  } else {
    lines.push('_No jobs won this week._');
  }
  lines.push('');
  lines.push('* * *');
  lines.push('');

  // ═══ KPIs ═══
  lines.push('## 🎯 KPIs');
  lines.push('');
  lines.push('**Ledger:** 🔴 Code Red — Needs attention | 🟠 Discussion — Needs improvement | 🟢 On-track');
  lines.push('');
  for (const person of allPeople) {
    lines.push(`**${person}**`);
    lines.push('');
    lines.push('| KPI | Status |');
    lines.push('| ---| --- |');
    lines.push('| 9am start-time each day |  |');
    lines.push('| Did all leads get actioned each day? |  |');
    lines.push('| Have all leads in the pipeline been progressed? |  |');
    lines.push('| Have all quotes been actioned (followed up)? |  |');
    lines.push('| EOW client meeting done? |  |');
    lines.push('');
  }
  lines.push('* * *');
  lines.push('');

  // ═══ DOING MORE ═══
  lines.push("## 🚀 Sales Exec's Doing More? — 5 min");
  lines.push('');
  lines.push("1. Are the Sales Exec's Capable of Handling More Work? Y/N");
  lines.push('2. What can we do to add more value / improve results?');
  lines.push('3. Lead conversation quality and volume discussion.');
  lines.push('');
  lines.push('* * *');
  lines.push('');

  // ═══ NOTES ═══
  lines.push('## 💡 Client / Employee Headlines & Issues');
  lines.push('');
  for (const person of allPeople) {
    lines.push(`**${person}'s Notes:**`);
    lines.push('*   ');
    lines.push('');
  }
  lines.push('* * *');
  lines.push('');

  // ═══ TO-DOS ═══
  lines.push('## ✅ TO-DO Reminders');
  lines.push('');
  for (const person of allPeople) {
    lines.push(`**${person}'s To-Do's**`);
    lines.push('*   ');
    lines.push('');
  }
  lines.push('* * *');
  lines.push('');

  // ═══ APPENDIX — PER-CLIENT TREND ═══
  lines.push('## 📎 Appendix — 4-Week Trend by Client');
  lines.push('');
  for (const c of clients) {
    lines.push(companyHeading(c.company));
    lines.push('');
    lines.push(c.error ? `_Data fetch failed: ${c.error}_` : buildTrendTable(c.trend));
    lines.push('');
  }

  const title = `Week of ${formatShortDate(startDate)} - ${formatShortDate(endDate)}`;
  const content = lines.join('\n');

  return { title, content };
}

// ─── This Period's Data (monthly doc) ───────────────────────────────

async function getCompanyData(company, weekdays, activityData) {
  const allRows = activityData || await db.fetchActivityGrid(company.name);
  if (allRows.length < 2) return null;

  const headers = allRows[0];
  const activities = parseActivityRows(allRows.slice(1), headers);
  const activePeople = company.salesPeople.filter(p => p.active);

  const companyType = getCompanyType(company.name);
  const totalField = getTotalField(company.name);

  const dailyStats = {};
  const weeklyStats = {};

  const jobDetailsByPerson = {};

  for (const person of activePeople) {
    dailyStats[person.name] = {};
    const weeklyCounts = {};
    let jobValue = 0;
    jobDetailsByPerson[person.name] = [];

    for (const date of weekdays) {
      const filtered = filterActivities(activities, date, person.name);
      const data = countOutcomes(filtered, company.ownerName, company.name);
      const c = data.counts;

      dailyStats[person.name][date] = {
        total: c[totalField] || 0,
        answered: c['Answered'] || 0,
      };

      for (const [key, val] of Object.entries(c)) {
        if (typeof val === 'number') {
          weeklyCounts[key] = (weeklyCounts[key] || 0) + val;
        }
      }

      for (const job of (data.jobDetails || [])) {
        jobValue += job.value || 0;
        jobDetailsByPerson[person.name].push(job);
      }
    }

    weeklyCounts._jobValue = jobValue;
    weeklyCounts._sources = collectSources(weeklyCounts, company.name);
    weeklyStats[person.name] = weeklyCounts;
  }

  const teamWeekly = {};
  const teamDaily = {};

  for (const date of weekdays) {
    let dayTotal = 0;
    for (const person of activePeople) {
      dayTotal += dailyStats[person.name][date].total;
    }
    teamDaily[date] = { total: dayTotal };
  }

  for (const person of activePeople) {
    const w = weeklyStats[person.name];
    for (const [key, val] of Object.entries(w)) {
      if (key === '_sources') {
        if (!teamWeekly._sources) teamWeekly._sources = {};
        for (const [src, count] of Object.entries(val)) {
          teamWeekly._sources[src] = (teamWeekly._sources[src] || 0) + count;
        }
      } else if (typeof val === 'number') {
        teamWeekly[key] = (teamWeekly[key] || 0) + val;
      }
    }
  }

  const totalActivity = teamWeekly[totalField] || 0;
  const answered = teamWeekly['Answered'] || 0;
  const pickUp = totalActivity > 0 ? ((answered / totalActivity) * 100).toFixed(0) : '0';

  let rates;
  if (companyType === 'trade') {
    const sv = teamWeekly['Site Visit Booked'] || 0;
    const jw = teamWeekly['Job Won'] || 0;
    rates = {
      pickUp,
      siteVisitRate: answered > 0 ? ((sv / answered) * 100).toFixed(0) : '0',
      closingRate: sv > 0 ? ((jw / sv) * 100).toFixed(0) : '0',
    };
  } else {
    const rb = teamWeekly['Roadmap Booked'] || 0;
    const dc = teamWeekly['Deal Closed'] || 0;
    rates = {
      pickUp,
      roadmapRate: answered > 0 ? ((rb / answered) * 100).toFixed(0) : '0',
      dealRate: totalActivity > 0 ? ((dc / totalActivity) * 100).toFixed(0) : '0',
    };
  }

  // Also return raw activities for 90-day calc
  return {
    company: company.name,
    owner: company.ownerName,
    people: activePeople.map(p => p.name),
    companyType,
    totalField,
    dailyStats,
    teamDaily,
    weeklyStats,
    teamWeekly,
    rates,
    activities,
    jobDetailsByPerson,
  };
}

function formatSources(sources) {
  if (!sources) return 'None';
  const entries = Object.entries(sources).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  return entries.map(([k, v]) => `${k}: ${v}`).join(' | ') || 'None';
}

function buildPersonMetrics(name, w, companyType) {
  const totalContacts = w['Total Calls'] || w['Total Contact Attempts'] || 0;
  const answered = w['Answered'] || 0;
  const didntAnswer = w["Didn't Answer"] || 0;
  const pickUp = totalContacts > 0 ? ((answered / totalContacts) * 100).toFixed(0) + '%' : '-';
  const lines = [];

  lines.push(`| Metric | Value |`);
  lines.push(`| ---| --- |`);
  lines.push(`| 🌱 New Leads | ${w['New Leads'] || 0} |`);

  if (companyType === 'trade') {
    lines.push(`| ⏳ Pre-Quote Follow Up | ${w['Pre-Quote Follow Up'] || 0} |`);
    lines.push(`| 🔄 Post-Quote Follow Up | ${w['Post Quote Follow Up'] || 0} |`);
  } else {
    lines.push(`| 🔄 Follow Up | ${w['Follow Up'] || 0} |`);
  }

  const totalLabel = w['Total Calls'] !== undefined ? 'Total Calls' : 'Total Contacts';
  lines.push(`| 📞 ${totalLabel} | ${totalContacts} |`);
  lines.push(`| 📱 Answered / No Answer | ${answered} / ${didntAnswer} |`);
  lines.push(`| ⚡ Pick Up Rate | ${pickUp} |`);

  if (companyType === 'trade') {
    lines.push(`| 📋 Requires Quoting | ${w['Requires Quoting'] || 0} |`);
    lines.push(`| 📤 Contacts Quoted | ${w['Quote Sent'] || 0} |`);
    lines.push(`| 📄 Individual Quotes | ${w['Total Individual Quotes'] || 0} |`);
    lines.push(`| 🚙 Site Visits Booked | ${w['Site Visit Booked'] || 0} |`);
    lines.push(`| 🤝 Verbal Confirmations | ${w['Verbal Confirmation'] || 0} |`);
    lines.push(`| 🏆 Jobs Won | ${w['Job Won'] || 0} |`);
    lines.push(`| 💰 Revenue Generated | ${formatDollar(w._jobValue || 0)} |`);
    lines.push(`| 📈 Pipeline Value | ${formatDollar(w['Pipeline Value'] || 0)} |`);
  } else {
    lines.push(`| 💬 SMS Sent | ${w['SMS Sent'] || 0} |`);
    lines.push(`| 📧 Email Sent | ${w['Email Sent'] || 0} |`);
    lines.push(`| 🗺️ Roadmaps Booked | ${w['Roadmap Booked'] || 0} |`);
    lines.push(`| 📋 Roadmaps Proposed | ${w['Roadmap Proposed'] || 0} |`);
    lines.push(`| 🏆 Deals Closed | ${w['Deal Closed'] || 0} |`);
  }

  return lines.join('\n');
}

function buildAttritionLine(w, companyName) {
  const { outcomes } = loadConfig(companyName);
  const lost = outcomes.outcomes.filter(o => o.category === 'lost');
  const abandoned = outcomes.outcomes.filter(o => o.category === 'abandoned');
  const dq = outcomes.outcomes.filter(o => o.category === 'dq');

  const parts = [];

  const lostItems = lost.map(o => `${o.name.replace('Lost - ', '')}: ${w[o.name] || 0}`).filter(s => !s.endsWith(': 0'));
  if (lostItems.length > 0) parts.push(`**Lost:** ${lostItems.join(' | ')}`);

  const abandonedItems = abandoned.map(o => `${o.name.replace('Abandoned - ', '')}: ${w[o.name] || 0}`).filter(s => !s.endsWith(': 0'));
  if (abandonedItems.length > 0) parts.push(`**Abandoned:** ${abandonedItems.join(' | ')}`);

  const dqItems = dq.map(o => `${o.name.replace('DQ - ', '')}: ${w[o.name] || 0}`).filter(s => !s.endsWith(': 0'));
  if (dqItems.length > 0) parts.push(`**DQ:** ${dqItems.join(' | ')}`);

  return parts.length > 0 ? parts.join('\n') : '';
}

/**
 * Calculate 90-day rolling conversion rates from Activity Log (monthly doc).
 */
function calc90DayConversions(activities, companyName) {
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const recent = activities.filter(a => a['Date'] >= cutoffStr);

  const companyType = getCompanyType(companyName);

  let totalCalls = 0, answered = 0, siteVisits = 0, jobsWon = 0;
  let roadmaps = 0, deals = 0, quotesSent = 0;

  for (const a of recent) {
    const eventType = a['Event Type'] || '';
    const outcome = a['Outcome'] || '';

    if (eventType === 'Site Visit Booked') { siteVisits++; continue; }
    if (eventType === 'Job Won') { jobsWon++; continue; }
    if (eventType === 'Quote Sent') { quotesSent++; continue; }

    // EOD Update activities — parse pipe-delimited outcome
    if (eventType === 'EOD Update' && outcome) {
      const parts = outcome.split('|').map(s => s.trim());
      for (const part of parts) {
        if (part === 'Answered') answered++;
        if (part === "Didn't Answer") totalCalls++;
        if (part === 'Answered') totalCalls++;
        if (part === 'Roadmap Booked') roadmaps++;
        if (part === 'Deal Closed') deals++;
      }
    }
  }

  if (companyType === 'trade') {
    return {
      type: 'trade',
      pickUpRate: totalCalls > 0 ? ((answered / totalCalls) * 100).toFixed(0) : '-',
      siteVisitRate: answered > 0 ? ((siteVisits / answered) * 100).toFixed(0) : '-',
      closingRate: siteVisits > 0 ? ((jobsWon / siteVisits) * 100).toFixed(0) : '-',
      totalCalls, answered, siteVisits, jobsWon, quotesSent,
    };
  } else {
    return {
      type: 'agency',
      pickUpRate: totalCalls > 0 ? ((answered / totalCalls) * 100).toFixed(0) : '-',
      roadmapRate: answered > 0 ? ((roadmaps / answered) * 100).toFixed(0) : '-',
      dealRate: totalCalls > 0 ? ((deals / totalCalls) * 100).toFixed(0) : '-',
      totalCalls, answered, roadmaps, deals,
    };
  }
}

function build90DayConversions(conversions) {
  if (!conversions) return '_Not enough data for conversion rates._';

  const lines = [];
  lines.push('| Stage | Count | Conversion |');
  lines.push('|---|---|---|');

  if (conversions.type === 'trade') {
    lines.push(`| 📞 Total Calls | ${conversions.totalCalls} | — |`);
    lines.push(`| 📱 Answered | ${conversions.answered} | ${conversions.pickUpRate}% pick up |`);
    lines.push(`| 🚙 Site Visits Booked | ${conversions.siteVisits} | ${conversions.siteVisitRate}% of answered |`);
    lines.push(`| 🏆 Jobs Won | ${conversions.jobsWon} | ${conversions.closingRate}% of site visits |`);
  } else {
    lines.push(`| 📞 Total Calls | ${conversions.totalCalls} | — |`);
    lines.push(`| 📱 Answered | ${conversions.answered} | ${conversions.pickUpRate}% pick up |`);
    lines.push(`| 🗺️ Roadmaps Booked | ${conversions.roadmaps} | ${conversions.roadmapRate}% of answered |`);
    lines.push(`| 🏆 Deals Closed | ${conversions.deals} | ${conversions.dealRate}% of contacts |`);
  }

  return lines.join('\n');
}

// ─── Monthly Review Doc ─────────────────────────────────────────────
// A once-a-month consolidated review for the whole calendar month, in the
// same look as the weekly meeting doc but with month-appropriate sections
// (weekly breakdown instead of a daily table; calendar-month totals).

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function getMonthRange(year, month) {
  const mm = String(month).padStart(2, '0');
  const start = `${year}-${mm}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const end = `${year}-${mm}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

function getAllDates(startDate, endDate) {
  const dates = [];
  const d = new Date(startDate + 'T12:00:00Z');
  const end = new Date(endDate + 'T12:00:00Z');
  while (d <= end) {
    dates.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

/**
 * Compute one Team week straight from Activity Log rows.
 * Returns countOutcomes counts + Total Revenue, tagged with _weekStart.
 */
function computeTeamWeek(activities, company, weekStart) {
  const weekEnd = addDaysStr(weekStart, 6);
  const rows = activities.filter(a => a['Date'] >= weekStart && a['Date'] <= weekEnd);
  const data = countOutcomes(rows, company.ownerName, company.name, activities);
  const obj = { ...data.counts };
  obj['Total Revenue'] = (data.jobDetails || []).reduce((s, j) => s + (j.value || 0), 0);
  obj._weekStart = weekStart;
  return obj;
}

/**
 * Compute Team stats for each week beginning within the month, chronological,
 * straight from Activity Log rows. Used for the in-month weekly breakdown table.
 */
function getMonthlyWeeks(company, monthStart, monthEnd, activityData) {
  if (!activityData || activityData.length < 2) return null;
  const activities = parseActivityRows(activityData.slice(1), activityData[0]);

  // First Monday on/after monthStart
  const d = new Date(monthStart + 'T12:00:00Z');
  const day = d.getUTCDay();
  const offset = day === 1 ? 0 : day === 0 ? 1 : 8 - day;
  let weekStart = addDaysStr(monthStart, offset);

  const weeks = [];
  while (weekStart <= monthEnd) {
    weeks.push(computeTeamWeek(activities, company, weekStart));
    weekStart = addDaysStr(weekStart, 7);
  }
  return weeks.length > 0 ? weeks : null;
}

function buildMonthlyWeekTable(weeks, companyType, totalFieldLabel) {
  if (!weeks || weeks.length === 0) return '_No weekly data for this month._';

  const weekHeaders = weeks.map(w => formatShortDate(w._weekStart));
  const lines = [];
  lines.push(`| Metric | ${weekHeaders.join(' | ')} |`);
  lines.push(`|---|${weekHeaders.map(() => '---').join('|')}|`);

  const totalKey = totalFieldLabel === 'Calls' ? 'Total Calls' : 'Total Contact Attempts';
  const tradeMetrics = [
    { label: '📞 ' + totalFieldLabel, key: totalKey },
    { label: '📱 Answered', key: 'Answered' },
    { label: '🌱 New Leads', key: 'New Leads' },
    { label: '📤 Contacts Quoted', key: 'Quote Sent' },
    { label: '🚙 Site Visits', key: 'Site Visit Booked' },
    { label: '🏆 Jobs Won', key: 'Job Won' },
    { label: '💰 Revenue', key: 'Total Revenue', dollar: true },
  ];
  const agencyMetrics = [
    { label: '📞 ' + totalFieldLabel, key: totalKey },
    { label: '📱 Answered', key: 'Answered' },
    { label: '🌱 New Leads', key: 'New Leads' },
    { label: '🗺️ Roadmaps Booked', key: 'Roadmap Booked' },
    { label: '🏆 Deals Closed', key: 'Deal Closed' },
  ];
  const metrics = companyType === 'trade' ? tradeMetrics : agencyMetrics;

  for (const m of metrics) {
    const vals = weeks.map(w => {
      const v = w[m.key] || 0;
      return m.dollar ? formatDollar(v) : Math.round(v);
    });
    lines.push(`| ${m.label} | ${vals.join(' | ')} |`);
  }
  return lines.join('\n');
}

async function generateMonthlyDoc(year, month) {
  const { companies } = loadCompanies();
  const activeCompanies = companies;
  const { start, end } = getMonthRange(year, month);
  const monthDates = getAllDates(start, end);
  const allPeople = getAllActivePeople(activeCompanies);
  const monthLabel = `${MONTH_NAMES[month - 1]} ${year}`;

  const companyData = [];
  for (const company of activeCompanies) {
    try {
      const activityData = await db.fetchActivityGrid(company.name);
      const data = await getCompanyData(company, monthDates, activityData);
      const weeks = getMonthlyWeeks(company, start, end, activityData);
      const conversions = data ? calc90DayConversions(data.activities, company.name) : null;
      companyData.push({ company, data, weeks, conversions });
    } catch (err) {
      companyData.push({ company, data: null, weeks: null, conversions: null, error: err.message });
    }
  }

  const lines = [];

  // ═══ HEADER ═══
  lines.push(`# 📅 Monthly Sales Review — ${monthLabel}`);
  lines.push('');
  lines.push(`**Participants:** ${allPeople.map(name => mention(name)).join(' ')}`);
  lines.push('');
  lines.push('* * *');
  lines.push('');

  // ═══ PORTFOLIO SNAPSHOT ═══
  let grandCalls = 0, grandAnswered = 0, grandQuotes = 0;
  let grandPipeline = 0, grandSiteVisits = 0, grandJobs = 0, grandRevenue = 0;
  let grandRoadmaps = 0, grandDeals = 0;
  for (const { data } of companyData) {
    if (!data) continue;
    const totalField = data.totalField;
    grandCalls += (data.teamWeekly[totalField] || 0);
    grandAnswered += (data.teamWeekly['Answered'] || 0);
    grandQuotes += (data.teamWeekly['Quote Sent'] || 0);
    grandPipeline += (data.teamWeekly['Pipeline Value'] || 0);
    grandSiteVisits += (data.teamWeekly['Site Visit Booked'] || 0);
    grandJobs += (data.teamWeekly['Job Won'] || 0);
    grandRevenue += (data.teamWeekly._jobValue || 0);
    grandRoadmaps += (data.teamWeekly['Roadmap Booked'] || 0);
    grandDeals += (data.teamWeekly['Deal Closed'] || 0);
  }
  const grandPickUp = grandCalls > 0 ? ((grandAnswered / grandCalls) * 100).toFixed(1) : '0';
  const activeClientCount = companyData.filter(d => d.data && (d.data.teamWeekly[d.data.totalField] || 0) > 0).length;

  lines.push(`## 🏆 Portfolio Snapshot — ${monthLabel}`);
  lines.push(`_${formatLongDate(start)} — ${formatLongDate(end)}_`);
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| ---| --- |');
  lines.push(`| 🏢 Active Clients | ${activeClientCount} |`);
  lines.push(`| 📞 Total Contacts | ${grandCalls} |`);
  lines.push(`| 📱 Total Answered | ${grandAnswered} (${grandPickUp}%) |`);
  if (grandQuotes > 0) lines.push(`| 📤 Total Quotes | ${grandQuotes} |`);
  if (grandPipeline > 0) lines.push(`| 📈 Total Pipeline | ${formatDollar(grandPipeline)} |`);
  if (grandSiteVisits > 0) lines.push(`| 🚙 Total Site Visits | ${grandSiteVisits} |`);
  if (grandJobs > 0) lines.push(`| 🏆 Total Jobs Won | ${grandJobs} |`);
  if (grandRevenue > 0) lines.push(`| 💰 Total Revenue | ${formatDollar(grandRevenue)} |`);
  if (grandRoadmaps > 0) lines.push(`| 🗺️ Total Roadmaps | ${grandRoadmaps} |`);
  if (grandDeals > 0) lines.push(`| 🤝 Total Deals Closed | ${grandDeals} |`);
  lines.push('');
  lines.push('* * *');
  lines.push('');

  // ═══ PER-COMPANY DEEP DIVE ═══
  lines.push('## 📈 Client Performance Deep Dive');
  lines.push('');

  for (const { company, data, weeks, conversions, error } of companyData) {
    const totalField = data ? data.totalField : 'Total Calls';
    const totalActivity = data ? (data.teamWeekly[totalField] || 0) : 0;

    if (error || !data || totalActivity === 0) {
      lines.push(companyHeading(company));
      lines.push('_No activity this month._');
      lines.push('');
      lines.push('* * *');
      lines.push('');
      continue;
    }

    const companyType = data.companyType;
    const totalLabel = totalField === 'Total Calls' ? 'Calls' : 'Contacts';

    lines.push(companyHeading(company));
    lines.push('');

    // ── Weekly Breakdown ──
    lines.push(`**📊 Weekly Breakdown — ${monthLabel}**`);
    lines.push('');
    lines.push(buildMonthlyWeekTable(weeks, companyType, totalLabel));
    lines.push('');

    // ── 90-Day Conversion Funnel ──
    lines.push('**🔄 90-Day Conversion Funnel**');
    lines.push('');
    lines.push(build90DayConversions(conversions));
    lines.push('');

    // ── Per-Person Monthly Metrics ──
    for (const person of data.people) {
      const w = data.weeklyStats[person];
      lines.push(`**${person}**`);
      lines.push('');
      lines.push(buildPersonMetrics(person, w, companyType));
      lines.push('');

      const attrition = buildAttritionLine(w, company.name);
      if (attrition) {
        lines.push(attrition);
        lines.push('');
      }

      lines.push(`**Sources:** ${formatSources(w._sources)}`);
      lines.push('');
    }

    // ── Jobs Won Details (month) ──
    if (data.jobDetailsByPerson) {
      const allJobs = [];
      for (const person of data.people) {
        for (const job of (data.jobDetailsByPerson[person] || [])) {
          allJobs.push({ ...job, salesPerson: person });
        }
      }
      if (allJobs.length > 0) {
        const totalRevenue = allJobs.reduce((sum, j) => sum + (j.value || 0), 0);
        lines.push(`**🏆 Jobs Won — ${allJobs.length} | ${formatDollar(totalRevenue)}**`);
        lines.push('');
        lines.push('| Contact | Address | Value | Source | Sales Exec |');
        lines.push('|---|---|---|---|---|');
        for (const j of allJobs) {
          const addr = (j.address || '-').replace(/[\n\r]+/g, ', ');
          lines.push(`| ${j.contactName || '-'} | ${addr} | ${formatDollar(j.value || 0)} | ${displayLabel(j.source) || '-'} | ${j.salesPerson} |`);
        }
        lines.push('');
      }
    }

    // ── Combined Monthly Totals ──
    const t = data.teamWeekly;
    lines.push(`**🏁 ${data.company} — ${monthLabel} Total**`);
    lines.push('');
    lines.push(`| Metric | Value |`);
    lines.push(`| ---| --- |`);
    lines.push(`| 📞 ${totalLabel} | ${totalActivity} |`);
    lines.push(`| 📱 Answered / No Answer | ${t['Answered'] || 0} / ${t["Didn't Answer"] || 0} |`);
    lines.push(`| ⚡ Pick Up Rate | ${data.rates.pickUp}% |`);
    if (companyType === 'trade') {
      lines.push(`| 📤 Contacts Quoted | ${t['Quote Sent'] || 0} |`);
      lines.push(`| 📄 Individual Quotes | ${t['Total Individual Quotes'] || 0} |`);
      lines.push(`| 📈 Pipeline Value | ${formatDollar(t['Pipeline Value'] || 0)} |`);
      lines.push(`| 🚙 Site Visits | ${t['Site Visit Booked'] || 0} |`);
      lines.push(`| 🏆 Jobs Won | ${t['Job Won'] || 0} |`);
      lines.push(`| 💰 Revenue | ${formatDollar(t._jobValue || 0)} |`);
    } else {
      lines.push(`| 🗺️ Roadmaps Booked | ${t['Roadmap Booked'] || 0} |`);
      lines.push(`| 📋 Roadmaps Proposed | ${t['Roadmap Proposed'] || 0} |`);
      lines.push(`| 🏆 Deals Closed | ${t['Deal Closed'] || 0} |`);
    }
    lines.push('');
    lines.push('* * *');
    lines.push('');
  }

  const title = `Month of ${monthLabel}`;
  const content = lines.join('\n');
  return { title, content };
}

module.exports = { generateMeetingDoc, generateMonthlyDoc };
