const { getOutcomeNames } = require('../sheets/createCompanySheet');
const { formatMonth, getTopSources } = require('./generateEOM');
const { loadConfig } = require('../config/configLoader');
const { countOutcomes } = require('./generateEOD');
const { displayLabel, formatDqLine } = require('./displayLabels');

function formatDollar(value) {
  return '$' + Math.round(value).toLocaleString('en-AU');
}

/**
 * Generate EOY report by counting raw Activity Log rows with exact year
 * boundaries — no storage-tab reads, so deleted activities drop out of the
 * report on the next run. Monthly breakdown is recomputed per month from the
 * same rows.
 */
async function generateEOY(spreadsheetId, salesPerson, year, companyName, ownerName, activityData) {
  const yearStr = String(year);

  const allRows = activityData || [];
  if (allRows.length < 2) {
    return { message: `No data found for ${year}.`, counts: {}, monthlyBreakdown: [] };
  }

  const headers = allRows[0];
  const allParsed = allRows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] || ''; });
    return obj;
  });

  const yearRows = allParsed.filter(a => {
    const d = a['Date'] || '';
    if (!d.startsWith(`${yearStr}-`)) return false;
    if (salesPerson !== 'Team' && !(a['Sales Person'] || '').startsWith(salesPerson)) return false;
    return true;
  });

  if (yearRows.length === 0) {
    return { message: `No data found for ${year}.`, counts: {}, monthlyBreakdown: [] };
  }

  const outcomeNames = getOutcomeNames(ownerName, companyName);
  const { outcomes } = loadConfig(companyName);

  // Yearly totals computed directly over the whole year's rows
  const yearlyData = countOutcomes(yearRows, ownerName, companyName, allParsed);
  const yearlyCounts = {};
  for (const name of outcomeNames) {
    yearlyCounts[name] = yearlyData.counts[name] || 0;
  }
  const yearlyJobDetails = yearlyData.jobDetails || [];
  const yearlyRevenue = yearlyJobDetails.reduce((sum, j) => sum + (j.value || 0), 0);

  // Per-month breakdown recomputed from the same rows
  const monthlyBreakdown = [];
  for (let m = 1; m <= 12; m++) {
    const monthPrefix = `${yearStr}-${String(m).padStart(2, '0')}`;
    const monthRows = yearRows.filter(a => (a['Date'] || '').startsWith(monthPrefix));
    if (monthRows.length === 0) continue;
    const monthData = countOutcomes(monthRows, ownerName, companyName, allParsed);
    const monthCounts = {};
    for (const name of outcomeNames) {
      monthCounts[name] = monthData.counts[name] || 0;
    }
    const monthRevenue = (monthData.jobDetails || []).reduce((sum, j) => sum + (j.value || 0), 0);
    monthlyBreakdown.push({ month: monthPrefix, counts: monthCounts, revenue: monthRevenue });
  }

  const topSources = getTopSources(yearlyCounts, companyName);

  const has = (name) => outcomeNames.includes(name);
  const totalField = has('Total Calls') ? 'Total Calls' : 'Total Contact Attempts';

  // Find best and worst months
  let bestMonth = null, worstMonth = null;
  for (const m of monthlyBreakdown) {
    const calls = m.counts[totalField] || 0;
    if (!bestMonth || calls > (bestMonth.counts[totalField] || 0)) bestMonth = m;
    if (!worstMonth || calls < (worstMonth.counts[totalField] || 0)) worstMonth = m;
  }

  const totalCallCount = yearlyCounts[totalField] || 0;
  const answeredCount = yearlyCounts['Answered'] || 0;
  const pickUpRate = totalCallCount > 0 ? Math.round((answeredCount / totalCallCount) * 100) : 0;

  const lines = [
    `YEARLY PERFORMANCE REPORT - ${salesPerson || 'Team'} - ${companyName}`,
    `${year}`,
    '',
    `📞 Calls`,
    `Total Calls: ${totalCallCount}`,
    `Answered: ${answeredCount} | Didn't Answer: ${yearlyCounts["Didn't Answer"] || 0}`,
  ];
  if (totalCallCount > 0) lines.push(`Pick Up Rate: ${pickUpRate}%`);

  if (has('New Leads')) {
    const leadParts = [`New Leads: ${yearlyCounts['New Leads'] || 0}`];
    if (yearlyCounts['Pre-Quote Follow Up']) leadParts.push(`Pre-Quote Follow Up: ${yearlyCounts['Pre-Quote Follow Up']}`);
    if (yearlyCounts['Post Quote Follow Up']) leadParts.push(`Post Quote Follow Up: ${yearlyCounts['Post Quote Follow Up']}`);
    if (yearlyCounts['Follow Up']) leadParts.push(`Follow Up: ${yearlyCounts['Follow Up']}`);
    lines.push(`📋 ${leadParts.join(' | ')}`);
  }

  const emailCount = yearlyCounts['Emails Sent'] || 0;
  if (emailCount > 0) {
    lines.push('');
    lines.push(`📧 Emails Sent: ${emailCount}`);
  }

  // Trade metrics
  if (has('Quote Sent')) {
    lines.push('');
    lines.push(`💰 Revenue`);
    lines.push(`Total Contacts Quoted: ${yearlyCounts['Quote Sent'] || 0}`);
    lines.push(`Total Individual Quotes: ${yearlyCounts['Total Individual Quotes'] || 0}`);
    lines.push(`Total Pipeline Value: ${formatDollar(yearlyCounts['Pipeline Value'] || 0)}`);
    if (has('Site Visit Booked')) {
      const sv = yearlyCounts['Site Visits Booked'] || yearlyCounts['Site Visit Booked'] || 0;
      lines.push(`Site Visits Booked - ${sv}`);
    }
    if (has('Job Won')) {
      const jobCount = yearlyJobDetails.length > 0 ? yearlyJobDetails.length : (yearlyCounts['Job Won'] || 0);
      lines.push(`Jobs Won: ${jobCount}`);
      if (yearlyRevenue > 0) {
        lines.push(`Total Revenue Generated: ${formatDollar(yearlyRevenue)}`);
      }
    }
  }

  // Agency metrics
  if (has('Roadmap Booked')) {
    lines.push('');
    lines.push(`🗺️ Roadmaps`);
    lines.push(`Roadmaps Booked: ${yearlyCounts['Roadmap Booked'] || 0}`);
    lines.push(`Roadmaps Proposed: ${yearlyCounts['Roadmap Proposed'] || 0}`);
    if (has('Deal Closed')) lines.push(`Deals Closed: ${yearlyCounts['Deal Closed'] || 0}`);
  }

  if (topSources.length > 0) {
    lines.push('');
    lines.push('📣 Top Lead Sources');
    for (const s of topSources) {
      lines.push(`${displayLabel(s.name)}: ${s.count}`);
    }
  }

  // Attrition (dynamic from outcome categories)
  const totalLost = outcomes.outcomes.filter(o => o.category === 'lost').reduce((sum, o) => sum + (yearlyCounts[o.name] || 0), 0);
  const totalAbandoned = outcomes.outcomes.filter(o => o.category === 'abandoned').reduce((sum, o) => sum + (yearlyCounts[o.name] || 0), 0);
  const dqOutcomes = outcomes.outcomes.filter(o => o.category === 'dq');
  const totalDQ = dqOutcomes.reduce((sum, o) => sum + (yearlyCounts[o.name] || 0), 0);

  if (totalLost > 0 || totalAbandoned > 0 || totalDQ > 0) {
    lines.push('');
    lines.push('🔴 Attrition');
    if (totalLost > 0) lines.push(`Lost: ${totalLost}`);
    if (totalAbandoned > 0) lines.push(`Abandoned: ${totalAbandoned}`);
    for (const o of dqOutcomes) {
      const n = yearlyCounts[o.name] || 0;
      if (n > 0) lines.push(formatDqLine(o.name, n));
    }
  }

  // Monthly breakdown table (dynamic columns)
  if (monthlyBreakdown.length > 1) {
    lines.push('');
    lines.push('📊 Monthly Breakdown');

    if (has('Quote Sent')) {
      lines.push('Month | Calls | Answered | Quotes | Site Visits | Jobs Won | Revenue');
      lines.push('------|-------|----------|--------|-------------|----------|--------');
      for (const m of monthlyBreakdown) {
        const parts = m.month.split('-');
        const label = formatMonth(parseInt(parts[0]), parseInt(parts[1]));
        const c = m.counts;
        const rev = m.revenue > 0 ? formatDollar(m.revenue) : '$0';
        lines.push(`${label} | ${c[totalField] || 0} | ${c['Answered'] || 0} | ${c['Quote Sent'] || 0} | ${c['Site Visit Booked'] || 0} | ${c['Job Won'] || 0} | ${rev}`);
      }
    } else {
      lines.push('Month | Contacts | Answered | Roadmaps | Deals');
      lines.push('------|----------|----------|----------|------');
      for (const m of monthlyBreakdown) {
        const parts = m.month.split('-');
        const label = formatMonth(parseInt(parts[0]), parseInt(parts[1]));
        const c = m.counts;
        lines.push(`${label} | ${c[totalField] || 0} | ${c['Answered'] || 0} | ${c['Roadmap Booked'] || 0} | ${c['Deal Closed'] || 0}`);
      }
    }
  }

  if (bestMonth && worstMonth && monthlyBreakdown.length > 1) {
    const bestParts = bestMonth.month.split('-');
    const worstParts = worstMonth.month.split('-');
    lines.push('');
    lines.push(`Best Month: ${formatMonth(parseInt(bestParts[0]), parseInt(bestParts[1]))} (${bestMonth.counts[totalField]} ${totalField.toLowerCase()})`);
    lines.push(`Quietest Month: ${formatMonth(parseInt(worstParts[0]), parseInt(worstParts[1]))} (${worstMonth.counts[totalField]} ${totalField.toLowerCase()})`);
  }

  const message = lines.join('\n');
  return { message, counts: yearlyCounts, monthlyBreakdown };
}

module.exports = { generateEOY };
