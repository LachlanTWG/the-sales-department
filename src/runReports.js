require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { generateEOD, countOutcomes, buildEODSummaryTable, buildSummaryTable } = require('./reporting/generateEOD');
const { getOutcomeNames } = require('./sheets/createCompanySheet');
const { archiveDaily } = require('./reporting/archiveDaily');
const { generateEOW } = require('./reporting/generateEOW');
const { archiveWeekly } = require('./reporting/archiveWeekly');
const { generateEOM } = require('./reporting/generateEOM');
const { archiveMonthly } = require('./reporting/archiveMonthly');
const { generateEOQ } = require('./reporting/generateEOQ');
const { archiveQuarterly } = require('./reporting/archiveQuarterly');
const { generateEOY } = require('./reporting/generateEOY');
const { archiveYearly } = require('./reporting/archiveYearly');
const { generateMeetingDoc, generateMonthlyDoc } = require('./reporting/generateMeetingDoc');
const { sendReportToSlack } = require('./integrations/slack');
const { sendReportToClickUp, createMeetingDocPage } = require('./integrations/clickup');

const db = require('./db');
const { loadCompanies } = require('./config/companiesStore');
// Google Sheets is no longer read or written by the reporting pipeline —
// Postgres is the sole source. The cross-company Summary sheet (summarySheet.js)
// used to read per-company storage tabs here; that aggregation was removed.

/**
 * Get today's date in a specific timezone.
 */
function todayInTz(tz) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

function getMondayOfWeek(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().split('T')[0];
}

function getSundayOfWeek(dateStr) {
  const monday = getMondayOfWeek(dateStr);
  const d = new Date(monday + 'T12:00:00Z');
  d.setDate(d.getDate() + 6);
  return d.toISOString().split('T')[0];
}

/**
 * Parse the Activity Log grid into row objects keyed by header.
 */
function parseActivities(activityData) {
  if (!activityData || activityData.length < 2) return [];
  const headers = activityData[0];
  return activityData.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] || ''; });
    return obj;
  });
}

/**
 * Build per-person countOutcomes results over a period, for the ClickUp
 * side-by-side summary table. `inPeriod(dateStr)` selects the rows in range.
 */
function buildPeopleData(activityData, activePeople, inPeriod, ownerName, companyName) {
  const activities = parseActivities(activityData);
  return activePeople.map(person => {
    const filtered = activities.filter(a =>
      inPeriod(a['Date']) && (a['Sales Person'] || '').startsWith(person.name)
    );
    const dates = filtered.map(a => a['Date']).filter(Boolean).sort();
    return {
      name: person.name,
      data: countOutcomes(filtered, ownerName, companyName, activities, {
        forExec: person.name,
        rangeStart: dates[0],
        rangeEnd: dates[dates.length - 1],
      }),
    };
  });
}

/**
 * Post the period's Team output to ClickUp as TWO messages: a people
 * side-by-side summary table first, then the detailed Team report. No-op if
 * nobody had any activity in the period.
 */
async function sendTeamToClickUp(company, type, periodLabel, teamMessage, peopleData, ownerName) {
  const anyActivity = peopleData.some(p => Object.values(p.data.counts || {}).some(v => v > 0));
  if (!anyActivity) return;
  const TYPE = type.toUpperCase();
  const table = buildSummaryTable(company.name, `${TYPE} Summary — ${periodLabel} — ${company.name}`, ownerName, peopleData);
  await sendReportToClickUp(company, type, `${TYPE} Summary - ${company.name} - ${periodLabel}`, table)
    .catch(e => console.error(`  ClickUp table error: ${e.message}`));
  await sendReportToClickUp(company, type, `${TYPE} - Team - ${periodLabel}`, teamMessage)
    .catch(e => console.error(`  ClickUp Team report error: ${e.message}`));
  console.log(`  ClickUp: Team ${TYPE} table + report sent.`);
}

// ─── Single-Company Runners ──────────────────────────────────────────
// These operate on ONE company. The scheduler calls them per-company
// at the right time for that company's timezone.

/**
 * Send EOD for one company (5:30pm) — generate + send to Slack/ClickUp, NO archive.
 */
async function sendCompanyEOD(company, targetDate) {
  const tz = company.timezone || 'Australia/Sydney';
  const date = targetDate || todayInTz(tz);
  console.log(`[SEND EOD] ${company.name} — ${date}`);

  // Read Activity Log ONCE for all people
  const activityData = await db.fetchActivityGrid(company.name);

  const activePeople = company.salesPeople.filter(p => p.active);
  let peopleWithActivity = 0;
  const peopleData = []; // Collect for summary table

  for (const person of activePeople) {
    try {
      const { message, counts } = await generateEOD(
        company.sheetId, person.name, date, company.name, company.ownerName, activityData
      );
      const hasActivity = Object.values(counts).some(v => v > 0);
      if (hasActivity) peopleWithActivity++;

      // Collect data for ClickUp summary table
      const headers = activityData[0];
      const activities = activityData.slice(1).map(row => {
        const obj = {};
        headers.forEach((h, i) => { obj[h] = row[i] || ''; });
        return obj;
      });
      const filtered = activities.filter(a => {
        if (a['Date'] !== date) return false;
        if (!a['Sales Person'].startsWith(person.name)) return false;
        return true;
      });
      const data = countOutcomes(filtered, company.ownerName, company.name, activities, {
        forExec: person.name,
        rangeStart: date,
        rangeEnd: date,
      });
      peopleData.push({ name: person.name, data });

      // Individual reports to Slack only
      await sendReportToSlack(company, 'eod', message).catch(e =>
        console.error(`  Slack error (${person.name}): ${e.message}`)
      );
      console.log(`  ${person.name}: Sent to Slack.`);
    } catch (err) {
      console.error(`  ${person.name}: ${err.message}`);
    }
  }

  // Skip team report if only 1 of 2 people had activity (would just duplicate their report)
  const skipTeam = activePeople.length === 2 && peopleWithActivity <= 1;

  // Team daily — summarised report to Slack
  try {
    const { message } = await generateEOD(
      company.sheetId, 'Team', date, company.name, company.ownerName, activityData
    );
    if (skipTeam) {
      console.log(`  Team: Skipped Slack (only ${peopleWithActivity}/2 had activity).`);
    } else {
      await sendReportToSlack(company, 'eod', message).catch(e =>
        console.error(`  Slack error (Team): ${e.message}`)
      );
      console.log(`  Team: Sent to Slack.`);
    }
  } catch (err) {
    console.error(`  Team: ${err.message}`);
  }

  // ClickUp — send one summary table with all people + team totals
  if (peopleData.length > 0 && peopleWithActivity > 0) {
    try {
      const summary = buildEODSummaryTable(company.name, date, company.ownerName, peopleData);
      const title = `EOD Summary - ${date}`;
      await sendReportToClickUp(company, 'eod', title, summary);
      console.log(`  ClickUp: Summary table sent.`);
    } catch (err) {
      console.error(`  ClickUp summary error: ${err.message}`);
    }
  }
}

/**
 * Archive EOD for one company (11:55pm) — generate final + archive to sheets.
 */
async function archiveCompanyEOD(company, targetDate) {
  const tz = company.timezone || 'Australia/Sydney';
  const date = targetDate || todayInTz(tz);
  console.log(`[ARCHIVE EOD] ${company.name} — ${date}`);

  // Read Activity Log ONCE for all people
  const activityData = await db.fetchActivityGrid(company.name);

  const activePeople = company.salesPeople.filter(p => p.active);

  for (const person of activePeople) {
    try {
      const { message, counts, names } = await generateEOD(
        company.sheetId, person.name, date, company.name, company.ownerName, activityData
      );
      await archiveDaily(company.sheetId, person.name, date, message, counts || {}, names || {}, company.ownerName, company.name);
      console.log(`  ${person.name}: Archived.`);
    } catch (err) {
      console.error(`  ${person.name}: ${err.message}`);
    }
  }

  // Team archive
  try {
    const { message, counts, names } = await generateEOD(
      company.sheetId, 'Team', date, company.name, company.ownerName, activityData
    );
    await archiveDaily(company.sheetId, 'Team', date, message, counts || {}, names || {}, company.ownerName, company.name);
  } catch (err) {
    console.error(`  Team: ${err.message}`);
  }
}

/**
 * Send EOW for one company (Friday 5:30pm).
 */
async function sendCompanyEOW(company, startDate, endDate) {
  const tz = company.timezone || 'Australia/Sydney';
  const today = todayInTz(tz);
  const start = startDate || getMondayOfWeek(today);
  const end = endDate || getSundayOfWeek(today);
  console.log(`[SEND EOW] ${company.name} — ${start} to ${end}`);

  // Read Activity Log ONCE for job/site visit details across all people
  const activityData = await db.fetchActivityGrid(company.name);

  const activePeople = company.salesPeople.filter(p => p.active);
  const peopleData = buildPeopleData(activityData, activePeople,
    d => d >= start && d <= end, company.ownerName, company.name);

  for (const person of activePeople) {
    try {
      const { message, counts } = await generateEOW(
        company.sheetId, person.name, start, end, company.name, company.ownerName, activityData
      );

      // Individual reports go to Slack only (ClickUp gets the Team report + table)
      await sendReportToSlack(company, 'eow', message).catch(e =>
        console.error(`  Slack error: ${e.message}`)
      );
      console.log(`  ${person.name}: Sent to Slack.`);
    } catch (err) {
      console.error(`  ${person.name}: ${err.message}`);
    }
  }

  // Team send: Slack (if >1 active person) + ClickUp (side-by-side table + Team report)
  try {
    const { message, counts } = await generateEOW(
      company.sheetId, 'Team', start, end, company.name, company.ownerName, activityData
    );
    if (activePeople.length > 1) {
      await sendReportToSlack(company, 'eow', message).catch(() => {});
    }
    await sendTeamToClickUp(company, 'eow', `${start} to ${end}`, message, peopleData, company.ownerName);
  } catch (err) {
    console.error(`  Team: ${err.message}`);
  }
}

/**
 * Archive EOW for one company (Friday 11:55pm).
 */
async function archiveCompanyEOW(company, startDate, endDate) {
  const tz = company.timezone || 'Australia/Sydney';
  const today = todayInTz(tz);
  const start = startDate || getMondayOfWeek(today);
  const end = endDate || getSundayOfWeek(today);
  console.log(`[ARCHIVE EOW] ${company.name} — ${start} to ${end}`);

  // Read Activity Log ONCE for all people
  const activityData = await db.fetchActivityGrid(company.name);

  const activePeople = company.salesPeople.filter(p => p.active);

  for (const person of activePeople) {
    try {
      const { message, counts } = await generateEOW(
        company.sheetId, person.name, start, end, company.name, company.ownerName, activityData
      );
      await archiveWeekly(company.sheetId, person.name, start, end, message, counts || {}, {}, company.ownerName, company.name);
      console.log(`  ${person.name}: Archived.`);
    } catch (err) {
      console.error(`  ${person.name}: ${err.message}`);
    }
  }

  // Team archive
  try {
    const { message, counts } = await generateEOW(
      company.sheetId, 'Team', start, end, company.name, company.ownerName, activityData
    );
    await archiveWeekly(company.sheetId, 'Team', start, end, message, counts || {}, {}, company.ownerName, company.name);
  } catch (err) {
    console.error(`  Team: ${err.message}`);
  }
}

/**
 * Run EOM for one company (send + archive).
 */
async function runCompanyEOM(company, year, month) {
  const tz = company.timezone || 'Australia/Sydney';
  const today = todayInTz(tz);
  const y = year || parseInt(today.split('-')[0]);
  const todayDay = parseInt(today.split('-')[2]);
  const m = month || (todayDay <= 3 ? (parseInt(today.split('-')[1]) - 1 || 12) : parseInt(today.split('-')[1]));
  const actualYear = (!month && todayDay <= 3 && m === 12) ? y - 1 : y;

  console.log(`[EOM] ${company.name} — ${actualYear}-${String(m).padStart(2, '0')}`);

  // Read Activity Log ONCE for all people
  const activityData = await db.fetchActivityGrid(company.name);

  const activePeople = company.salesPeople.filter(p => p.active);
  const monthLabel = `${actualYear}-${String(m).padStart(2, '0')}`;
  const peopleData = buildPeopleData(activityData, activePeople,
    d => (d || '').startsWith(monthLabel), company.ownerName, company.name);

  for (const person of activePeople) {
    try {
      const { message, counts } = await generateEOM(
        company.sheetId, person.name, actualYear, m, company.name, company.ownerName, activityData
      );
      if (!counts || Object.keys(counts).length === 0) continue;

      await archiveMonthly(company.sheetId, person.name, actualYear, m, message, counts, {}, company.ownerName, company.name);
      // Individual reports go to Slack only (ClickUp gets the Team report + table)
      await sendReportToSlack(company, 'eom', message).catch(e =>
        console.error(`  Slack error: ${e.message}`)
      );
      console.log(`  ${person.name}: Done.`);
    } catch (err) {
      console.error(`  ${person.name}: ${err.message}`);
    }
  }

  // Team EOM: Slack (if >1 active person) + ClickUp (side-by-side table + Team report)
  try {
    const { message, counts } = await generateEOM(
      company.sheetId, 'Team', actualYear, m, company.name, company.ownerName, activityData
    );
    if (counts && Object.keys(counts).length > 0) {
      await archiveMonthly(company.sheetId, 'Team', actualYear, m, message, counts, {}, company.ownerName, company.name);
      if (activePeople.length > 1) {
        await sendReportToSlack(company, 'eom', message).catch(() => {});
      }
      await sendTeamToClickUp(company, 'eom', monthLabel, message, peopleData, company.ownerName);
    }
  } catch (err) {
    console.error(`  Team: ${err.message}`);
  }
}

/**
 * Run EOQ for one company (send + archive).
 */
async function runCompanyEOQ(company, year, quarter) {
  const tz = company.timezone || 'Australia/Sydney';
  const today = todayInTz(tz);
  const y = year || parseInt(today.split('-')[0]);
  const todayMonth = parseInt(today.split('-')[1]);
  const todayDay = parseInt(today.split('-')[2]);
  // If no quarter specified, figure out the previous quarter
  // (EOQ runs on 1st day of new quarter, so report the one that just ended)
  const q = quarter || (todayDay <= 3 ? Math.ceil(todayMonth / 3) - 1 || 4 : Math.ceil(todayMonth / 3));
  const actualYear = (!quarter && todayDay <= 3 && q === 4) ? y - 1 : y;

  console.log(`[EOQ] ${company.name} — ${actualYear}-Q${q}`);

  // Read Activity Log ONCE for all people
  const activityData = await db.fetchActivityGrid(company.name);

  const activePeople = company.salesPeople.filter(p => p.active);
  const quarterLabel = `${actualYear}-Q${q}`;
  const qStart = (q - 1) * 3 + 1, qEnd = q * 3;
  const peopleData = buildPeopleData(activityData, activePeople, d => {
    const parts = (d || '').split('-');
    const yy = parseInt(parts[0], 10), mm = parseInt(parts[1], 10);
    return yy === actualYear && mm >= qStart && mm <= qEnd;
  }, company.ownerName, company.name);

  for (const person of activePeople) {
    try {
      const { message, counts } = await generateEOQ(
        company.sheetId, person.name, actualYear, q, company.name, company.ownerName, activityData
      );
      if (!counts || Object.keys(counts).length === 0) continue;

      await archiveQuarterly(company.sheetId, person.name, actualYear, q, message, counts, company.ownerName, company.name);
      // Individual reports go to Slack only (ClickUp gets the Team report + table)
      await sendReportToSlack(company, 'eoq', message).catch(e =>
        console.error(`  Slack error: ${e.message}`)
      );
      console.log(`  ${person.name}: Done.`);
    } catch (err) {
      console.error(`  ${person.name}: ${err.message}`);
    }
  }

  // Team EOQ: Slack (if >1 active person) + ClickUp (side-by-side table + Team report)
  try {
    const { message, counts } = await generateEOQ(
      company.sheetId, 'Team', actualYear, q, company.name, company.ownerName, activityData
    );
    if (counts && Object.keys(counts).length > 0) {
      await archiveQuarterly(company.sheetId, 'Team', actualYear, q, message, counts, company.ownerName, company.name);
      if (activePeople.length > 1) {
        await sendReportToSlack(company, 'eoq', message).catch(() => {});
      }
      await sendTeamToClickUp(company, 'eoq', quarterLabel, message, peopleData, company.ownerName);
    }
  } catch (err) {
    console.error(`  Team: ${err.message}`);
  }
}

/**
 * Run EOY for one company (send + archive).
 */
async function runCompanyEOY(company, year) {
  const tz = company.timezone || 'Australia/Sydney';
  const today = todayInTz(tz);
  const y = year || parseInt(today.split('-')[0]) - 1;

  console.log(`[EOY] ${company.name} — ${y}`);

  const activePeople = company.salesPeople.filter(p => p.active);

  const activityData = await db.fetchActivityGrid(company.name);
  const peopleData = buildPeopleData(activityData, activePeople,
    d => (d || '').startsWith(`${y}-`), company.ownerName, company.name);

  for (const person of activePeople) {
    try {
      const { message, counts } = await generateEOY(
        company.sheetId, person.name, y, company.name, company.ownerName, activityData
      );
      if (!counts || Object.keys(counts).length === 0) continue;

      await archiveYearly(company.sheetId, person.name, y, message, counts, {}, company.ownerName, company.name);
      // Individual reports go to Slack only (ClickUp gets the Team report + table)
      await sendReportToSlack(company, 'eoy', message).catch(e =>
        console.error(`  Slack error: ${e.message}`)
      );
      console.log(`  ${person.name}: Done.`);
    } catch (err) {
      console.error(`  ${person.name}: ${err.message}`);
    }
  }

  // Team EOY: Slack (if >1 active person) + ClickUp (side-by-side table + Team report)
  const activeEOY = company.salesPeople.filter(p => p.active);
  try {
    const { message, counts } = await generateEOY(
      company.sheetId, 'Team', y, company.name, company.ownerName, activityData
    );
    if (counts && Object.keys(counts).length > 0) {
      await archiveYearly(company.sheetId, 'Team', y, message, counts, {}, company.ownerName, company.name);
      if (activeEOY.length > 1) {
        await sendReportToSlack(company, 'eoy', message).catch(() => {});
      }
      await sendTeamToClickUp(company, 'eoy', String(y), message, peopleData, company.ownerName);
    }
  } catch (err) {
    console.error(`  Team: ${err.message}`);
  }
}

/**
 * Send daily site visit notification for one company (7am).
 * Shows today's visits + upcoming visits (next 7 days).
 */
async function sendSiteVisitNotification(company) {
  const tz = company.timezone || 'Australia/Sydney';
  const today = todayInTz(tz);
  console.log(`[SITE VISITS] ${company.name} — ${today}`);

  const activityData = await db.fetchActivityGrid(company.name);
  const logged = parseActivities(activityData).filter(a =>
    a['Event Type'] === 'Site Visit Booked' && a['Appointment Date Time']
  );

  // Booked-but-not-yet-logged calendar visits (open pending_site_visits) are
  // real appointments too — merge them in so the schedule mirrors the
  // calendar, not just what execs have popup-logged. On a (name, day) clash
  // the logged activity wins.
  const pending = await db.fetchOpenPendingSiteVisits(company.name).catch(e => {
    console.error(`  Pending visits: ${e.message}`);
    return [];
  });
  const visitKey = (name, dtStr) =>
    `${String(name || '').trim().toLowerCase()}|${String(dtStr || '').slice(0, 10)}`;
  const seenVisits = new Set(logged.map(b => visitKey(b['Contact Name'], b['Appointment Date Time'])));
  const bookings = [...logged];
  for (const p of pending) {
    if (!p.appointment_date_time) continue;
    const key = visitKey(p.contact_name, p.appointment_date_time);
    if (seenVisits.has(key)) continue;
    seenVisits.add(key);
    bookings.push({
      'Contact Name': p.contact_name,
      'Contact Address': p.contact_address,
      'Appointment Date Time': p.appointment_date_time,
      'Sales Person': p.sales_person_name,
    });
  }

  if (bookings.length === 0) {
    console.log(`  No site visit data found.`);
    return;
  }

  // Appointment Date Time is a naive client-wall-clock string
  // (YYYY-MM-DDTHH:MM:SS), so date boundaries compare as plain strings.
  const next7 = new Date(today + 'T12:00:00Z');
  next7.setUTCDate(next7.getUTCDate() + 7);
  const next7Str = next7.toISOString().split('T')[0];

  const todayVisits = [];
  const upcomingVisits = [];  // next 7 days (excl today)
  const beyondVisits = [];    // after 7 days

  for (const b of bookings) {
    const dtStr = b['Appointment Date Time'];
    const visitDateOnly = dtStr.slice(0, 10);
    const entry = {
      contactName: (b['Contact Name'] || '').trim(),
      address: (b['Contact Address'] || '').replace(/,\s*$/, '').trim(),
      datetime: dtStr,
      salesPerson: (b['Sales Person'] || '').trim(),
      virtual: String(b['Visit Kind'] || '').toLowerCase() === 'virtual',
    };

    if (visitDateOnly === today) {
      todayVisits.push(entry);
    } else if (visitDateOnly > today && visitDateOnly <= next7Str) {
      upcomingVisits.push(entry);
    } else if (visitDateOnly > next7Str) {
      beyondVisits.push(entry);
    }
  }

  // Build message
  const lines = [];
  lines.push(`*Site Visits — ${formatNotificationDate(today)}*`);
  lines.push('');

  if (todayVisits.length > 0) {
    const todayVirtual = todayVisits.filter(sv => sv.virtual).length;
    const todayCount = todayVirtual > 0
      ? `${todayVisits.length}, ${todayVirtual} virtual`
      : String(todayVisits.length);
    lines.push(`*Today's Site Visits (${todayCount}):*`);
    for (const sv of todayVisits) {
      const dt = formatVisitTime(sv.datetime);
      lines.push(`- ${sv.contactName} - ${sv.address || 'TBC'} - ${dt || 'TBC'} (${sv.salesPerson})${sv.virtual ? ' (virtual)' : ''}`);
    }
  } else {
    lines.push('*Today\'s Site Visits:* No site visits booked for today');
  }

  lines.push('');

  if (upcomingVisits.length > 0) {
    lines.push(`*Upcoming Site Visits (Next 7 Days):*`);
    upcomingVisits.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
    for (const sv of upcomingVisits) {
      const dt = formatVisitDateTimeFull(sv.datetime);
      lines.push(`- ${sv.contactName} - ${sv.address || 'TBC'} - ${dt || 'TBC'} (${sv.salesPerson})${sv.virtual ? ' (virtual)' : ''}`);
    }
  } else {
    lines.push('*Upcoming Site Visits (Next 7 Days):* Nothing booked for the week ahead');
  }

  // Only show beyond-7-day visits if there are any
  if (beyondVisits.length > 0) {
    lines.push('');
    lines.push(`*Later (${beyondVisits.length} visit${beyondVisits.length === 1 ? '' : 's'} scheduled beyond 7 days)*`);
  }

  const message = lines.join('\n');
  await sendReportToSlack(company, 'site-visits', message, { username: 'Site Visit Schedule', icon_emoji: ':round_pushpin:' });
  console.log(`  Sent site visit notification.`);
}

/**
 * Format date for notification header: "Monday 06 Apr"
 */
function formatNotificationDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getDay()]} ${String(d.getDate()).padStart(2, '0')} ${months[d.getMonth()]}`;
}

/**
 * Format time only for today's visits: "9:00am"
 */
function formatVisitTime(datetimeStr) {
  if (!datetimeStr) return '';
  try {
    const d = new Date(datetimeStr);
    if (isNaN(d.getTime())) return datetimeStr;
    let hours = d.getHours();
    const mins = String(d.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'pm' : 'am';
    if (hours > 12) hours -= 12;
    if (hours === 0) hours = 12;
    return `${hours}:${mins}${ampm}`;
  } catch {
    return datetimeStr;
  }
}

/**
 * Format full date+time for upcoming visits: "Fri 06 Feb 9:00am"
 */
function formatVisitDateTimeFull(datetimeStr) {
  if (!datetimeStr) return '';
  try {
    const d = new Date(datetimeStr);
    if (isNaN(d.getTime())) return datetimeStr;
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    let hours = d.getHours();
    const mins = String(d.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'pm' : 'am';
    if (hours > 12) hours -= 12;
    if (hours === 0) hours = 12;
    return `${days[d.getDay()]} ${String(d.getDate()).padStart(2, '0')} ${months[d.getMonth()]} ${hours}:${mins}${ampm}`;
  } catch {
    return datetimeStr;
  }
}

// ─── "Run All" Wrappers (for CLI / webhooks) ────────────────────────

async function runAllEOD(targetDate, mode = 'both') {
  const { companies } = loadCompanies();
  for (const company of companies) {
    if (mode === 'send' || mode === 'both') await sendCompanyEOD(company, targetDate);
    if (mode === 'archive' || mode === 'both') await archiveCompanyEOD(company, targetDate);
  }
}

async function runAllEOW(startDate, endDate, mode = 'both') {
  const { companies } = loadCompanies();
  for (const company of companies) {
    if (mode === 'send' || mode === 'both') await sendCompanyEOW(company, startDate, endDate);
    if (mode === 'archive' || mode === 'both') await archiveCompanyEOW(company, startDate, endDate);
  }
}

async function runAllEOM(year, month) {
  const { companies } = loadCompanies();
  for (const company of companies) {
    await runCompanyEOM(company, year, month);
  }
}

async function runAllEOQ(year, quarter) {
  const { companies } = loadCompanies();
  for (const company of companies) {
    await runCompanyEOQ(company, year, quarter);
  }
}

async function runAllEOY(year) {
  const { companies } = loadCompanies();
  for (const company of companies) {
    await runCompanyEOY(company, year);
  }
}

async function runAllSiteVisitNotifications() {
  const { companies } = loadCompanies();
  for (const company of companies) {
    await sendSiteVisitNotification(company);
  }
}

async function runMeetingDoc(startDate, endDate) {
  // Default week under review:
  //   - Sunday (cron night-before): this week's Mon–Sun (week ending today)
  //   - Mon–Sat (manual re-run): last completed Mon–Sun
  // Cron fires Sunday 5:30pm AEST so the team can comment overnight before
  // the Monday morning meeting.
  const today = todayInTz('Australia/Sydney');
  const thisMonday = getMondayOfWeek(today);
  const dow = new Date(today + 'T12:00:00Z').getUTCDay(); // 0 = Sunday
  let weekMonday = thisMonday;
  if (dow !== 0) {
    const d = new Date(thisMonday + 'T12:00:00Z');
    d.setDate(d.getDate() - 7);
    weekMonday = d.toISOString().split('T')[0];
  }
  const start = startDate || weekMonday;
  const end = endDate || getSundayOfWeek(weekMonday);

  console.log(`\n=== Generating Meeting Doc — ${start} to ${end} ===\n`);

  const { title, content } = await generateMeetingDoc(start, end);
  console.log(content);

  // Create as a page in the ClickUp meeting doc
  try {
    const page = await createMeetingDocPage(title, content, end);
    if (page) {
      console.log(`\nCreated meeting doc page in ClickUp: ${page.id || 'done'}`);
    }
  } catch (err) {
    console.error(`ClickUp doc creation error: ${err.message}`);
  }

  return { title, content };
}

async function runMonthlyDoc(year, month) {
  const today = todayInTz('Australia/Sydney');
  const y = year || parseInt(today.split('-')[0]);
  const todayDay = parseInt(today.split('-')[2]);
  // No month specified + early in the month → report the month that just ended.
  const m = month || (todayDay <= 3 ? (parseInt(today.split('-')[1]) - 1 || 12) : parseInt(today.split('-')[1]));
  const actualYear = (!month && todayDay <= 3 && m === 12) ? y - 1 : y;

  console.log(`\n=== Generating Monthly Review — ${actualYear}-${String(m).padStart(2, '0')} ===\n`);

  const { title, content } = await generateMonthlyDoc(actualYear, m);
  console.log(content);

  // Create as a page in the ClickUp meeting doc (under the right quarter).
  const mm = String(m).padStart(2, '0');
  const lastDay = new Date(Date.UTC(actualYear, m, 0)).getUTCDate();
  const monthEndStr = `${actualYear}-${mm}-${String(lastDay).padStart(2, '0')}`;
  try {
    const page = await createMeetingDocPage(title, content, monthEndStr);
    if (page) {
      console.log(`\nCreated monthly review page in ClickUp: ${page.id || 'done'}`);
    }
  } catch (err) {
    console.error(`ClickUp doc creation error: ${err.message}`);
  }

  return { title, content };
}

// CLI support
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  const getArg = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

  const commands = {
    eod: () => runAllEOD(getArg('--date')),
    eow: () => runAllEOW(getArg('--start'), getArg('--end')),
    eom: () => runAllEOM(getArg('--year') ? parseInt(getArg('--year')) : null, getArg('--month') ? parseInt(getArg('--month')) : null),
    eoq: () => runAllEOQ(getArg('--year') ? parseInt(getArg('--year')) : null, getArg('--quarter') ? parseInt(getArg('--quarter')) : null),
    eoy: () => runAllEOY(getArg('--year') ? parseInt(getArg('--year')) : null),
    'site-visits': () => runAllSiteVisitNotifications(),
    meeting: () => runMeetingDoc(getArg('--start'), getArg('--end')),
    monthly: () => runMonthlyDoc(getArg('--year') ? parseInt(getArg('--year')) : null, getArg('--month') ? parseInt(getArg('--month')) : null),
  };

  if (!command || !commands[command]) {
    console.log(`
Usage: node runReports.js <command> [options]

Commands:
  eod      Run EOD for all companies    [--date YYYY-MM-DD]
  eow      Run EOW for all companies    [--start YYYY-MM-DD --end YYYY-MM-DD]
  eom      Run EOM for all companies    [--year YYYY --month M]
  eoq      Run EOQ for all companies    [--year YYYY --quarter Q]
  eoy          Run EOY for all companies    [--year YYYY]
  site-visits  Send daily site visit notifications
  meeting      Generate weekly meeting doc  [--start YYYY-MM-DD --end YYYY-MM-DD]
  monthly      Generate monthly review doc  [--year YYYY --month M]
`);
    process.exit(0);
  }

  commands[command]().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

module.exports = {
  sendCompanyEOD, archiveCompanyEOD,
  sendCompanyEOW, archiveCompanyEOW,
  runCompanyEOM, runCompanyEOQ, runCompanyEOY,
  sendSiteVisitNotification,
  runAllEOD, runAllEOW, runAllEOM, runAllEOQ, runAllEOY, runAllSiteVisitNotifications, runMeetingDoc, runMonthlyDoc,
  loadCompanies,
};
