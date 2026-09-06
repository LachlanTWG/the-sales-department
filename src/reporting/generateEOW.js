const { getOutcomeNames } = require('../sheets/createCompanySheet');
const { loadConfig } = require('../config/configLoader');
const { countOutcomes, formatVisitDateTime } = require('./generateEOD');
const { cleanAddress } = require('./addressFormat');
const { displayLabel, formatDqLine } = require('./displayLabels');

function formatFullDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00+10:00');
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function formatDollar(value) {
  return '$' + Math.round(value).toLocaleString('en-AU');
}

function formatEOWLine(outcomeName, formulaTypeId, weeklyCounts, weeklyData) {
  switch (formulaTypeId) {
    case 1: return null;

    case 11: {
      const count = weeklyCounts[outcomeName] || 0;
      if (count === 0) return null;
      return `${displayLabel(outcomeName)} - ${count}`;
    }

    case 12: {
      // Calls Summary — works with both "Total Calls" and "Total Contact Attempts"
      const totalCalls = weeklyCounts['Total Calls'] || weeklyCounts['Total Contact Attempts'] || 0;
      if (totalCalls === 0) return null;
      const answered = weeklyCounts['Answered'] || 0;
      const rate = Math.round((answered / totalCalls) * 100);
      return `Total Calls: ${totalCalls} (${rate}% Answered)`;
    }

    case 6: {
      const quoteCount = weeklyCounts[outcomeName] || 0;
      if (quoteCount === 0) return null;
      return `Total Contacts Quoted: ${quoteCount}`;
    }

    case 7: {
      const value = weeklyCounts['Pipeline Value'] || 0;
      if (value === 0) return null;
      return `Pipeline Value (Sum of Averages): ${formatDollar(value)}`;
    }

    case 8: {
      if (weeklyData.siteVisits && weeklyData.siteVisits.length > 0) {
        const lines = weeklyData.siteVisits.map(sv => {
          const dt = formatVisitDateTime(sv.datetime);
          const virtual = sv.virtual ? ' (virtual)' : '';
          return `${sv.contactName} - ${cleanAddress(sv.address) || 'TBC'} - ${dt || 'TBC'}${virtual}`;
        });
        return lines.join('\n');
      }
      const svCount = weeklyCounts[outcomeName] || 0;
      if (svCount === 0) return null;
      return `${displayLabel(outcomeName)} - ${svCount}`;
    }

    case 9: {
      if (weeklyData.jobDetails && weeklyData.jobDetails.length > 0) {
        const lines = weeklyData.jobDetails.map(j => {
          return `${j.contactName} ${formatDollar(j.value)} ${displayLabel(j.source) || 'N/A'} - ${cleanAddress(j.address).replace(/,/g, '') || 'N/A'}`;
        });
        const totalRevenue = weeklyData.jobDetails.reduce((sum, j) => sum + (j.value || 0), 0);
        if (totalRevenue > 0) {
          lines.push(`Total Revenue Generated: ${formatDollar(totalRevenue)}`);
        }
        return lines.join('\n');
      }
      const jobCount = weeklyCounts[outcomeName] || 0;
      if (jobCount === 0) return null;
      return `${displayLabel(outcomeName)} - ${jobCount}`;
    }

    case 10: {
      const count = weeklyCounts['Total Individual Quotes'] || 0;
      if (count === 0) return null;
      return `Total Individual Quotes: ${count}`;
    }

    case 2:
    case 3: {
      const count = weeklyCounts[outcomeName] || 0;
      if (count === 0) return null;
      return `${displayLabel(outcomeName)} - ${count}`;
    }

    case 4: {
      const count = weeklyCounts[outcomeName] || 0;
      if (count === 0) return null;
      return `${displayLabel(outcomeName)} - ${count}`;
    }

    default:
      return null;
  }
}

/**
 * Generate EOW report by counting raw Activity Log rows with exact week
 * boundaries — same engine as EOD (countOutcomes), so a deleted activity
 * disappears from the report on the next run. No storage-tab reads.
 */
async function generateEOW(spreadsheetId, salesPerson, startDate, endDate, companyName, ownerName, activityData) {
  const { blocks, formulas } = loadConfig(companyName);
  const outcomeNames = getOutcomeNames(ownerName, companyName);

  const allRows = activityData || [];
  const headers = allRows.length > 0 ? allRows[0] : [];
  const allParsed = allRows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] || ''; });
    return obj;
  });

  const filtered = allParsed.filter(a => {
    const d = a['Date'] || '';
    if (d < startDate || d > endDate) return false;
    if (salesPerson !== 'Team' && !(a['Sales Person'] || '').startsWith(salesPerson)) return false;
    return true;
  });

  const forExec = salesPerson && salesPerson !== 'Team' ? salesPerson : undefined;
  const data = countOutcomes(filtered, ownerName, companyName, allParsed, {
    forExec,
    rangeStart: startDate,
    rangeEnd: endDate,
  });
  const weeklyCounts = {};
  for (const name of outcomeNames) {
    weeklyCounts[name] = data.counts[name] || 0;
  }
  // Carry computed/synthetic counts that aren't positional outcome columns
  weeklyCounts['Site Visits Booked'] = data.counts['Site Visits Booked'] || 0;

  const weeklyData = {
    quoteDetails: data.quoteDetails,
    siteVisits: data.siteVisits,
    jobDetails: data.jobDetails,
  };

  const startFormatted = formatFullDate(startDate);
  const endFormatted = formatFullDate(endDate);
  const lines = [
    `SALES EXECUTIVE PERFORMANCE REPORT - ${salesPerson || 'Team'} - ${companyName}`,
    `Dates: ${startFormatted} - ${endFormatted}`,
    '',
  ];

  for (const block of blocks.eowBlocks) {
    const blockName = block.name.replace('{owner}', ownerName);
    const blockLines = [];

    const isDq = (block.outcomes || []).some(o => String(o).startsWith('DQ - '))
      || /disqualified/i.test(blockName);

    if (isDq) {
      for (const outcomeTpl of block.outcomes || []) {
        const outcomeName = outcomeTpl.replace('{owner}', ownerName);
        const count = weeklyCounts[outcomeName] || 0;
        if (count === 0) continue;
        blockLines.push(formatDqLine(outcomeName, count));
      }
      if (blockLines.length > 0) {
        lines.push(...blockLines);
        lines.push('');
      }
      continue;
    }

    if (block.outcomes) {
      for (let outcomeTpl of block.outcomes) {
        const outcomeName = outcomeTpl.replace('{owner}', ownerName);
        const formulaEntry = formulas.outcomeFormulas[outcomeTpl] || { eow: 1 };
        const formulaTypeId = formulaEntry.eow;
        const line = formatEOWLine(outcomeName, formulaTypeId, weeklyCounts, weeklyData);
        if (line) blockLines.push(line);
      }
    }

    if (blockLines.length > 0) {
      const vCount = (weeklyData.siteVisits || []).filter(s => s.virtual).length;
      const heading = (block.outcomes || []).includes('Site Visit Booked') && vCount > 0
        ? `${blockName} — ${weeklyData.siteVisits.length} (${vCount} virtual)`
        : blockName;
      lines.push(heading);
      lines.push(...blockLines);
      lines.push('');
    }
  }

  if (salesPerson && salesPerson !== 'Team') {
    const bsvNames = [...new Set((data.names['Book Site Visit'] || []).filter(Boolean))];
    if (bsvNames.length > 0) {
      const open = data.visitsOpen || [];
      lines.push('✅ Site visit coverage');
      if (open.length === 0) {
        lines.push('Complete 100%');
      } else {
        lines.push(`Still in need of log: ${open.length} of ${bsvNames.length}`);
        for (const name of open) lines.push(`- ${name}`);
      }
      lines.push('');
    }
  }

  const message = lines.join('\n');
  return { message, counts: weeklyCounts };
}

module.exports = { generateEOW };
