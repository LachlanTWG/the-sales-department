const { getOutcomeNames } = require('../sheets/createCompanySheet');
const { loadConfig } = require('../config/configLoader');
const { countOutcomes } = require('./generateEOD');
const { cleanAddress } = require('./addressFormat');
const { displayLabel, formatDqLine } = require('./displayLabels');

function formatMonth(year, month) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[month - 1]} ${year}`;
}

function getTopSources(counts, companyName) {
  const { outcomes } = loadConfig(companyName);
  const sources = outcomes.outcomes
    .filter(o => o.category === 'source')
    .map(o => o.name);

  return sources
    .map(s => ({ name: s, count: counts[s] || 0 }))
    .filter(s => s.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

function formatDollar(value) {
  return '$' + Math.round(value).toLocaleString('en-AU');
}

/**
 * Generate EOM report by counting raw Activity Log rows with exact month
 * boundaries — same engine as EOD (countOutcomes), so counts always match
 * the ClickUp side-by-side tables and drop deleted activities.
 */
async function generateEOM(spreadsheetId, salesPerson, year, month, companyName, ownerName, activityData) {
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;

  const activityRows = activityData;
  if (activityRows.length < 2) {
    return { message: `No data found for ${formatMonth(year, month)}.`, counts: {} };
  }

  const headers = activityRows[0];
  const allParsed = activityRows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] || ''; });
    return obj;
  });

  // Filter Activity Log rows for this month and person
  const monthRows = allParsed.filter(a => {
    const rowDate = a['Date'] || '';
    if (rowDate < monthStart || rowDate >= nextMonth) return false;
    if (salesPerson !== 'Team' && !(a['Sales Person'] || '').startsWith(salesPerson)) return false;
    return true;
  });

  if (monthRows.length === 0) {
    return { message: `No data found for ${formatMonth(year, month)}.`, counts: {} };
  }

  const { outcomes } = loadConfig(companyName);
  const outcomeNames = getOutcomeNames(ownerName, companyName);

  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  const forExec = salesPerson && salesPerson !== 'Team' ? salesPerson : undefined;
  const data = countOutcomes(monthRows, ownerName, companyName, allParsed, {
    forExec,
    rangeStart: monthStart,
    rangeEnd: monthEnd,
  });
  const monthlyCounts = {};
  for (const name of outcomeNames) {
    monthlyCounts[name] = data.counts[name] || 0;
  }
  const jobDetails = data.jobDetails.map(j => ({
    ...j,
    address: cleanAddress(j.address).replace(/,/g, ''),
  }));

  const topSources = getTopSources(monthlyCounts, companyName);

  // Determine what metrics exist for this company
  const has = (name) => outcomeNames.includes(name) || (monthlyCounts[name] !== undefined);

  const monthStr = formatMonth(year, month);
  const lines = [
    `MONTHLY PERFORMANCE REPORT - ${salesPerson || 'Team'} - ${companyName}`,
    `${monthStr}`,
    '',
    `📞 Calls`,
  ];

  const totalField = has('Total Calls') ? 'Total Calls' : 'Total Contact Attempts';
  const totalCallCount = monthlyCounts[totalField] || 0;
  const answeredCount = monthlyCounts['Answered'] || 0;
  const pickUpRate = totalCallCount > 0 ? Math.round((answeredCount / totalCallCount) * 100) : 0;
  lines.push(`Total Calls: ${totalCallCount}`);
  lines.push(`Answered: ${answeredCount} | Didn't Answer: ${monthlyCounts["Didn't Answer"] || 0}`);
  if (totalCallCount > 0) lines.push(`Pick Up Rate: ${pickUpRate}%`);

  if (has('New Leads')) {
    const leadParts = [`New Leads: ${monthlyCounts['New Leads'] || 0}`];
    if (monthlyCounts['Pre-Quote Follow Up']) leadParts.push(`Pre-Quote Follow Up: ${monthlyCounts['Pre-Quote Follow Up']}`);
    if (monthlyCounts['Post Quote Follow Up']) leadParts.push(`Post Quote Follow Up: ${monthlyCounts['Post Quote Follow Up']}`);
    if (monthlyCounts['Follow Up']) leadParts.push(`Follow Up: ${monthlyCounts['Follow Up']}`);
    lines.push(`📋 ${leadParts.join(' | ')}`);
  }

  const emailCount = monthlyCounts['Emails Sent'] || 0;
  if (emailCount > 0) {
    lines.push('');
    lines.push(`📧 Emails Sent: ${emailCount}`);
  }

  // Trade-specific metrics
  if (has('Quote Sent')) {
    lines.push('');
    lines.push(`💰 Revenue Pipeline`);
    lines.push(`Total Contacts Quoted: ${monthlyCounts['Quote Sent'] || 0}`);
    lines.push(`Total Individual Quotes: ${monthlyCounts['Total Individual Quotes'] || 0}`);
    lines.push(`Pipeline Value: ${formatDollar(monthlyCounts['Pipeline Value'] || 0)}`);
    if (has('Site Visit Booked')) {
      const sv = monthlyCounts['Site Visits Booked'] || monthlyCounts['Site Visit Booked'] || 0;
      lines.push(`Site Visits Booked - ${sv}`);
    }
    if (has('Job Won')) {
      const jobCount = jobDetails.length > 0 ? jobDetails.length : (monthlyCounts['Job Won'] || 0);
      lines.push(`Jobs Won: ${jobCount}`);
      if (jobDetails.length > 0) {
        for (const j of jobDetails) {
          lines.push(`${j.contactName} ${formatDollar(j.value)} ${displayLabel(j.source) || 'N/A'} - ${j.address || 'N/A'}`);
        }
        const totalRevenue = jobDetails.reduce((sum, j) => sum + (j.value || 0), 0);
        lines.push(`Total Revenue Generated: ${formatDollar(totalRevenue)}`);
      }
    }
  }

  // Agency-specific metrics
  if (has('Roadmap Booked')) {
    lines.push('');
    lines.push(`🗺️ Roadmaps`);
    lines.push(`Roadmaps Booked: ${monthlyCounts['Roadmap Booked'] || 0}`);
    lines.push(`Roadmaps Proposed: ${monthlyCounts['Roadmap Proposed'] || 0}`);
    if (has('Deal Closed')) lines.push(`Deals Closed: ${monthlyCounts['Deal Closed'] || 0}`);
  }

  if (topSources.length > 0) {
    lines.push('');
    lines.push('📣 Top Lead Sources');
    for (const s of topSources) {
      lines.push(`${displayLabel(s.name)}: ${s.count}`);
    }
  }

  // Attrition
  const lostOutcomes = outcomes.outcomes.filter(o => o.category === 'lost');
  const abandonedOutcomes = outcomes.outcomes.filter(o => o.category === 'abandoned');
  const dqOutcomes = outcomes.outcomes.filter(o => o.category === 'dq');

  const totalLost = lostOutcomes.reduce((sum, o) => sum + (monthlyCounts[o.name] || 0), 0);
  const totalAbandoned = abandonedOutcomes.reduce((sum, o) => sum + (monthlyCounts[o.name] || 0), 0);
  const totalDQ = dqOutcomes.reduce((sum, o) => sum + (monthlyCounts[o.name] || 0), 0);

  if (totalLost > 0 || totalAbandoned > 0 || totalDQ > 0) {
    lines.push('');
    lines.push('🔴 Attrition');
    if (totalLost > 0) lines.push(`Lost: ${totalLost}`);
    if (totalAbandoned > 0) lines.push(`Abandoned: ${totalAbandoned}`);
    for (const o of dqOutcomes) {
      const n = monthlyCounts[o.name] || 0;
      if (n > 0) lines.push(formatDqLine(o.name, n));
    }
  }

  // Personal: quoting / site-visit coverage for the month (same rules as EOD).
  if (salesPerson && salesPerson !== 'Team') {
    const rqNames = [...new Set((data.names['Requires Quoting'] || []).filter(Boolean))];
    if (rqNames.length > 0) {
      const open = data.quotingOpen || [];
      lines.push('');
      lines.push('✅ Quoting coverage');
      if (open.length === 0) {
        lines.push('Complete 100%');
      } else {
        lines.push(`Still in need of quote: ${open.length} of ${rqNames.length}`);
        for (const name of open) lines.push(`- ${name}`);
      }
    }

    const bsvNames = [...new Set((data.names['Book Site Visit'] || []).filter(Boolean))];
    if (bsvNames.length > 0) {
      const open = data.visitsOpen || [];
      lines.push('');
      lines.push('✅ Site visit coverage');
      if (open.length === 0) {
        lines.push('Complete 100%');
      } else {
        lines.push(`Still in need of log: ${open.length} of ${bsvNames.length}`);
        for (const name of open) lines.push(`- ${name}`);
      }
    }
  }

  const message = lines.join('\n');
  return { message, counts: monthlyCounts };
}

module.exports = { generateEOM, formatMonth, getTopSources };
