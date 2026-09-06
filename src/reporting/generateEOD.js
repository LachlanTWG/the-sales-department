const { getOutcomeNames } = require('../sheets/createCompanySheet');
const { loadConfig } = require('../config/configLoader');
const { cleanAddress } = require('./addressFormat');
const { displayLabel, formatDqLine } = require('./displayLabels');
const { isVirtualVisitKind } = require('../ghl/visitKind');

function virtualTag(virtual) {
  return virtual ? ' (virtual)' : '';
}

function siteVisitsHeader(baseName, visits) {
  const n = (visits || []).length;
  const v = (visits || []).filter(s => s.virtual).length;
  if (n === 0 || v === 0) return baseName;
  return `${baseName} — ${n} (${v} virtual)`;
}

function rowIsVirtualVisit(activity) {
  return isVirtualVisitKind(activity['Visit Kind']) || /virtual/i.test(activity['Outcome'] || '');
}

/**
 * Parse a pipe-delimited outcome string.
 * Format: "Lead Type | Answer Status | Action/Outcome | Notes | Source"
 * @returns {{ leadType, answerStatus, action, notes, source }}
 */
function parseOutcome(outcomeStr) {
  if (!outcomeStr) return {};
  const parts = outcomeStr.split('|').map(s => s.trim());
  return {
    leadType: parts[0] || '',
    answerStatus: parts[1] || '',
    action: parts[2] || '',
    notes: parts[3] || '',
    source: parts[4] || '',
  };
}

/**
 * Parse activity log rows into structured objects.
 */
function parseActivityRows(rows, headers) {
  return rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] || '';
    });
    return obj;
  });
}

/**
 * Filter activity log by date and optional sales person.
 */
function filterActivities(activities, targetDate, salesPerson) {
  return activities.filter(a => {
    if (a['Date'] !== targetDate) return false;
    if (salesPerson && salesPerson !== 'Team' && !a['Sales Person'].startsWith(salesPerson)) return false;
    return true;
  });
}

/**
 * Normalize a contact name for fuzzy matching.
 * "Bradburn, Jody" and "Jody Bradburn" both become "bradburn jody".
 */
function normalizeName(name) {
  return (name || '').split(/[, ]+/).filter(Boolean).map(p => p.toLowerCase()).sort().join(' ');
}

/**
 * Look up the lead source for a contact from all activity rows.
 * Tries in order: contactId → normalized name → partial/first-name match.
 * Gives benefit of the doubt — shortened names, reversed order, etc.
 */
function resolveLeadSource(contactName, contactId, allActivities) {
  const withSource = allActivities.filter(a => a['Ad Source']);

  // 1. Try contactId match
  if (contactId) {
    const byId = withSource.find(a =>
      a['Contact ID'] && a['Contact ID'].trim() === contactId.trim()
    );
    if (byId) return byId['Ad Source'];
  }

  // 2. Try normalized name match (handles "Bradburn, Jody" ↔ "Jody Bradburn")
  const norm = normalizeName(contactName);
  if (norm.length >= 3) {
    const byName = withSource.find(a => normalizeName(a['Contact Name']) === norm);
    if (byName) return byName['Ad Source'];
  }

  // 3. Partial match — if any name part (4+ chars) appears in another contact's name
  const parts = (contactName || '').split(/[, ]+/).filter(p => p.length >= 4).map(p => p.toLowerCase());
  if (parts.length > 0) {
    const byPartial = withSource.find(a => {
      const other = (a['Contact Name'] || '').toLowerCase();
      return parts.some(p => other.includes(p));
    });
    if (byPartial) return byPartial['Ad Source'];
  }

  return '';
}

// GHL dropdown values that differ from internal outcome names
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

function resolveAlias(name) {
  return OUTCOME_ALIASES[name] || name;
}

const HANDOFF_LOOKBACK_DAYS = 30;

function sameExec(a, b) {
  const na = String(a || '').trim().toLowerCase();
  const nb = String(b || '').trim().toLowerCase();
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.startsWith(nb + ' ') || nb.startsWith(na + ' ');
}

function execLabel(name) {
  const t = String(name || '').trim();
  return t.split(/\s+/)[0] || t;
}

function addDaysIso(dateStr, n) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

function rosterNamesFor(companyName) {
  try {
    const { loadCompanies } = require('../config/companiesStore');
    const { companies } = loadCompanies();
    const c = (companies || []).find(x => x.name === companyName);
    return (c?.salesPeople || []).map(p => p.name).filter(Boolean);
  } catch {
    return [];
  }
}

function isRosterName(name, roster) {
  if (!name || name === 'Team' || /^unknown$/i.test(name)) return false;
  if (!roster || roster.length === 0) return true; // fail open if config missing
  return roster.some(r => sameExec(name, r));
}

function sheetContactKey(row) {
  const cid = String(row['Contact ID'] || '').trim();
  if (cid) return `id:${cid}`;
  const n = normalizeName(row['Contact Name']);
  if (n.length >= 3) return `name:${n}`;
  return null;
}

function parseQuoteValues(raw) {
  return String(raw || '')
    .split('|')
    .map(v => parseFloat(String(v).replace(/[$,\s]/g, '')))
    .filter(v => Number.isFinite(v));
}

function isRequiresQuotingAction(outcomeStr) {
  return resolveAlias(parseOutcome(outcomeStr).action) === 'Requires Quoting';
}

function findQuoteHandoffs(inRangeQuotes, pool, roster) {
  const rqs = [];
  for (const a of pool || []) {
    const ev = a['Event Type'];
    if (ev && ev !== 'EOD Update') continue;
    if (!isRosterName(a['Sales Person'], roster)) continue;
    if (!isRequiresQuotingAction(a['Outcome'])) continue;
    const key = sheetContactKey(a);
    if (!key) continue;
    rqs.push({ key, exec: a['Sales Person'], day: a['Date'] });
  }

  const out = new Map();
  for (const q of inRangeQuotes) {
    if (q['Event Type'] !== 'Quote Sent') continue;
    if (!isRosterName(q['Sales Person'], roster)) continue;
    const key = sheetContactKey(q);
    if (!key) continue;
    const cutoff = addDaysIso(q['Date'], -HANDOFF_LOOKBACK_DAYS);
    let best = null;
    for (const rq of rqs) {
      if (rq.key !== key) continue;
      if (sameExec(rq.exec, q['Sales Person'])) continue;
      if (rq.day > q['Date'] || rq.day < cutoff) continue;
      if (!best || rq.day > best.day) best = rq;
    }
    if (!best) continue;
    out.set(key, { key, talker: execLabel(best.exec), sender: execLabel(q['Sales Person']) });
  }
  return out;
}

function pushQuote(list, contactName, values, extra) {
  extra = extra || {};
  const existing = list.find(q => q.contactName === contactName);
  if (existing) {
    existing.values.push(...values);
    if (extra.sentBy && !existing.sentBy) existing.sentBy = extra.sentBy;
    if (extra.fromExec && !existing.fromExec) existing.fromExec = extra.fromExec;
    if (extra.isHandoff) existing.isHandoff = true;
    return;
  }
  list.push({ contactName, values, ...extra });
}

function formatQuoteDetailLine(q, isTeam) {
  const valStr = q.values.map(v => formatDollar(v)).join(', ');
  let line = `- ${q.contactName} - ${q.values.length} - (${valStr})`;
  if (!isTeam && q.sentBy) line += ` — by ${q.sentBy}`;
  else if (!isTeam && q.fromExec) line += ` — from ${q.fromExec}`;
  return line;
}

/**
 * Count outcomes from filtered EOD Update activities.
 * @param {Array} allActivities - ALL activity log rows (for cross-referencing lead sources)
 * @returns {{ counts: {name: count}, names: {name: [contactNames]}, quoteDetails: [...], siteVisits: [...], jobDetails: [...] }}
 */
function countOutcomes(filtered, ownerName, companyName, allActivities, opts) {
  opts = opts || {};
  const outcomeNames = getOutcomeNames(ownerName, companyName);
  const counts = {};
  const names = {};
  for (const name of outcomeNames) {
    counts[name] = 0;
    names[name] = [];
  }

  const quoteDetails = []; // { contactName, values, sentBy?, fromExec?, isHandoff? }
  const siteVisits = [];   // { contactName, address, datetime }
  const jobDetails = [];   // { contactName, address, value, source }
  const customNotes = [];  // { contactName, note } — EOD 4 custom outcomes, surfaced verbatim
  const myRq = [];
  const myBookSv = [];
  const pool = allActivities || filtered || [];
  const roster = rosterNamesFor(companyName);
  const rangeStart = opts.rangeStart;
  const rangeEnd = opts.rangeEnd;
  const inRange = (day) =>
    (!rangeStart || day >= rangeStart) && (!rangeEnd || day <= rangeEnd);
  const inRangeQuotes = pool.filter(a => a['Event Type'] === 'Quote Sent' && inRange(a['Date']));
  const handoffs = opts.forExec ? findQuoteHandoffs(inRangeQuotes, pool, roster) : new Map();

  for (const activity of filtered) {
    const eventType = activity['Event Type'];

    if (eventType === 'Quote Sent') {
      const contactName = activity['Contact Name'];
      const values = parseQuoteValues(activity['Quote/Job Value']);
      const key = sheetContactKey(activity);
      const handoff = key ? handoffs.get(key) : undefined;
      const fromExec = handoff && opts.forExec && sameExec(handoff.sender, opts.forExec)
        ? handoff.talker
        : undefined;
      pushQuote(quoteDetails, contactName, values, fromExec ? { fromExec } : {});
      continue;
    }

    if (eventType === 'Site Visit Booked') {
      siteVisits.push({
        contactName: activity['Contact Name'],
        address: activity['Contact Address'],
        datetime: activity['Appointment Date Time'],
        virtual: rowIsVirtualVisit(activity),
      });
      const outcomeName = 'Site Visit Booked';
      if (outcomeName in counts) {
        counts[outcomeName]++;
        names[outcomeName].push(activity['Contact Name']);
      }
      continue;
    }

    if (eventType === 'Email Sent') {
      const outcomeName = 'Emails Sent';
      if (outcomeName in counts) {
        counts[outcomeName]++;
        names[outcomeName].push(activity['Contact Name']);
      }
      continue;
    }

    if (eventType === 'Job Won') {
      const valuesStr = activity['Quote/Job Value'] || '';
      const value = parseFloat(valuesStr.replace(/[$,\s]/g, '')) || 0;
      let source = activity['Ad Source'] || '';
      if (!source && allActivities) {
        source = resolveLeadSource(activity['Contact Name'], activity['Contact ID'], allActivities);
      }
      jobDetails.push({
        contactName: activity['Contact Name'],
        address: activity['Contact Address'],
        value,
        source,
      });
      const outcomeName = 'Job Won';
      if (outcomeName in counts) {
        counts[outcomeName]++;
        names[outcomeName].push(activity['Contact Name']);
      }
      continue;
    }

    // EOD Update — parse pipe-delimited outcome
    if (eventType === 'EOD Update' || !eventType) {
      const parsed = parseOutcome(activity['Outcome']);
      const contactName = activity['Contact Name'];
      const source = parsed.source || activity['Ad Source'] || '';

      // Lead Type
      if (parsed.leadType && parsed.leadType in counts) {
        counts[parsed.leadType]++;
        names[parsed.leadType].push(contactName);
      }

      // Answer Status
      if (parsed.answerStatus && parsed.answerStatus in counts) {
        counts[parsed.answerStatus]++;
        names[parsed.answerStatus].push(contactName);
      }

      // Action/Outcome
      if (parsed.action) {
        let actionKey = resolveAlias(parsed.action);
        const passedOntoKey = `Passed Onto ${ownerName}`;
        if (actionKey.startsWith('Passed Onto')) {
          actionKey = passedOntoKey;
        }
        if (actionKey in counts) {
          counts[actionKey]++;
          names[actionKey].push(contactName);
        }
        if (actionKey === 'Requires Quoting') {
          myRq.push({ name: contactName, key: sheetContactKey(activity) });
        }
        if (actionKey === 'Book Site Visit') {
          myBookSv.push({ name: contactName, key: sheetContactKey(activity) });
        }
      }

      // Source
      if (source && source in counts) {
        counts[source]++;
        names[source].push(contactName);
      }

      // Custom Outcome (EOD 4) — captured verbatim, surfaced in the Notes section.
      if (parsed.notes) {
        customNotes.push({ contactName, note: parsed.notes });
      }
    }
  }

  // Compute total calls/contact attempts (works for both "Total Calls" and "Total Contact Attempts")
  const totalAnswered = (counts['Answered'] || 0) + (counts["Didn't Answer"] || 0);
  if ('Total Calls' in counts) counts['Total Calls'] = totalAnswered;
  if ('Total Contact Attempts' in counts) counts['Total Contact Attempts'] = totalAnswered;

  if (opts.forExec) {
    const ownNames = new Set(quoteDetails.map(q => normalizeName(q.contactName)));
    const injected = new Set();
    for (const q of inRangeQuotes) {
      if (!isRosterName(q['Sales Person'], roster)) continue;
      const key = sheetContactKey(q);
      if (!key || injected.has(key)) continue;
      const handoff = handoffs.get(key);
      if (!handoff || !sameExec(handoff.talker, opts.forExec)) continue;
      const contactName = (q['Contact Name'] || '').trim();
      if (!contactName || ownNames.has(normalizeName(contactName))) continue;
      const values = [];
      for (const row of inRangeQuotes) {
        if (sheetContactKey(row) === key) values.push(...parseQuoteValues(row['Quote/Job Value']));
      }
      pushQuote(quoteDetails, contactName, values, { sentBy: handoff.sender, isHandoff: true });
      injected.add(key);
    }
  }

  // Compute Quote Sent count and Total Individual Quotes (trade companies)
  if ('Quote Sent' in counts) {
    counts['Quote Sent'] = quoteDetails.length;
  }
  const ownQuotes = quoteDetails.filter(q => !q.isHandoff);
  let totalIndividualQuotes = 0;
  for (const q of ownQuotes) {
    totalIndividualQuotes += q.values.length;
  }
  if ('Total Individual Quotes' in counts) {
    counts['Total Individual Quotes'] = totalIndividualQuotes;
  }

  // Compute Pipeline Value (trade companies) — sender only, not talker copies
  let pipelineValue = 0;
  for (const q of ownQuotes) {
    if (q.values.length > 0) {
      const avg = q.values.reduce((a, b) => a + b, 0) / q.values.length;
      pipelineValue += avg;
    }
  }
  if ('Pipeline Value' in counts) {
    counts['Pipeline Value'] = Math.round(pipelineValue);
  }

  const teamQuoted = new Set();
  for (const a of inRangeQuotes) {
    const key = sheetContactKey(a);
    if (key) teamQuoted.add(key);
    const n = normalizeName(a['Contact Name']);
    if (n) teamQuoted.add(`name:${n}`);
  }
  const openByName = new Map();
  for (const rq of myRq) {
    if (!rq.name) continue;
    const closed = (rq.key && teamQuoted.has(rq.key)) || teamQuoted.has(`name:${normalizeName(rq.name)}`);
    if (!openByName.has(rq.name) || closed) openByName.set(rq.name, !closed);
  }
  const quotingOpen = [...openByName.entries()].filter(([, open]) => open).map(([n]) => n).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );

  const teamVisited = new Set();
  for (const a of pool) {
    if (a['Event Type'] !== 'Site Visit Booked' || !inRange(a['Date'])) continue;
    const key = sheetContactKey(a);
    if (key) teamVisited.add(key);
    const n = normalizeName(a['Contact Name']);
    if (n) teamVisited.add(`name:${n}`);
  }
  const visitOpenByName = new Map();
  for (const b of myBookSv) {
    if (!b.name) continue;
    const closed = (b.key && teamVisited.has(b.key)) || teamVisited.has(`name:${normalizeName(b.name)}`);
    if (!visitOpenByName.has(b.name) || closed) visitOpenByName.set(b.name, !closed);
  }
  const visitsOpen = [...visitOpenByName.entries()].filter(([, open]) => open).map(([n]) => n).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );

  // Synthetic display count for the 🏠 Site Visits block header.
  counts['Site Visits Booked'] = siteVisits.length;

  return { counts, names, quoteDetails, siteVisits, jobDetails, customNotes, quotingOpen, visitsOpen };
}

/**
 * Format a date string for the EOD header.
 * "Wednesday 01 Apr"
 */
function formatEODDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00+10:00'); // AEST
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dayName = days[d.getDay()];
  const dd = String(d.getDate()).padStart(2, '0');
  const mon = months[d.getMonth()];
  return `${dayName} ${dd} ${mon}`;
}

/**
 * Format a site visit datetime for display.
 * "Fri 06 Feb 9:00am"
 */
function formatVisitDateTime(datetimeStr) {
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

/**
 * Format a dollar value with commas.
 */
function formatDollar(value) {
  return '$' + Math.round(value).toLocaleString('en-AU');
}

/**
 * Build a formatted EOD line for a given outcome based on its formula type.
 */
function formatEODLine(outcomeName, formulaTypeId, data, isTeam) {
  const { counts, names, quoteDetails, siteVisits, jobDetails } = data;
  // Printed text only; counts/names stay keyed on the raw outcomeName.
  const label = displayLabel(outcomeName);

  switch (formulaTypeId) {
    case 1: // Hidden
      return null;

    case 2: { // Count Only
      const count = counts[outcomeName] || 0;
      if (count === 0) return null;
      return `${label} - ${count}`;
    }

    case 3: { // Total Count
      const count = counts[outcomeName] || 0;
      if (count === 0) return null;
      return `${label}: ${count}`;
    }

    case 4: { // Count + Names
      const count = counts[outcomeName] || 0;
      if (count === 0) return null;
      if (isTeam) return `${label} - ${count}`;
      const contactNames = names[outcomeName] || [];
      const uniqueNames = [...new Set(contactNames)].filter(n => n);
      if (uniqueNames.length === 0) return `${label} - ${count}`;
      return `${label} - ${count} - ${uniqueNames.join(', ')}`;
    }

    case 5: { // Section Header
      const count = counts[outcomeName] || 0;
      if (count === 0) return null;
      return `${label}: ${count}`;
    }

    case 6: { // Quote Details
      const validQuotes = quoteDetails.filter(q => q.contactName || q.values.length > 0);
      if (validQuotes.length === 0) return null;
      if (isTeam) {
        return `Total Contacts Quoted: ${validQuotes.length}`;
      }
      const lines = [`Total Contacts Quoted: ${validQuotes.length}`];
      for (const q of validQuotes) lines.push(formatQuoteDetailLine(q, isTeam));
      return lines.join('\n');
    }

    case 7: { // Pipeline Value
      const value = counts['Pipeline Value'] || 0;
      if (value === 0) return null;
      return `Pipeline Value (Sum of Averages): ${formatDollar(value)}`;
    }

    case 8: { // Site Visit
      if (siteVisits.length === 0) return null;
      const lines = siteVisits.map(sv => {
        const dt = formatVisitDateTime(sv.datetime);
        return `${sv.contactName} - ${cleanAddress(sv.address) || 'TBC'} - ${dt || 'TBC'}${virtualTag(sv.virtual)}`;
      });
      return lines.join('\n');
    }

    case 9: { // Job Details
      if (jobDetails.length === 0) return null;
      const totalRevenue = jobDetails.reduce((sum, j) => sum + (j.value || 0), 0);
      if (isTeam) {
        return `Jobs Won: ${jobDetails.length}${totalRevenue > 0 ? ` - Total Revenue: ${formatDollar(totalRevenue)}` : ''}`;
      }
      const lines = jobDetails.map(j => {
        return `${j.contactName} ${formatDollar(j.value)} ${displayLabel(j.source) || 'N/A'} - ${cleanAddress(j.address).replace(/,/g, '') || 'N/A'}`;
      });
      if (totalRevenue > 0) {
        lines.push(`Total Revenue Generated: ${formatDollar(totalRevenue)}`);
      }
      return lines.join('\n');
    }

    case 10: { // Total Individual Quotes
      const count = counts['Total Individual Quotes'] || 0;
      if (count === 0) return null;
      return `Total Individual Quotes: ${count}`;
    }

    default:
      return null;
  }
}

/**
 * Build the full EOD message.
 */
function buildEODMessage(companyName, dateStr, ownerName, data, salesPerson) {
  const { blocks, formulas } = loadConfig(companyName);
  const dateFormatted = formatEODDate(dateStr);
  const personLabel = salesPerson || 'Team';
  const lines = [`EOD Report - ${dateFormatted} - ${personLabel} - ${companyName}`];
  lines.push('');

  const isTeam = salesPerson === 'Team';
  for (const block of blocks.eodBlocks) {
    const blockName = block.name.replace('{owner}', ownerName);
    const blockLines = [];
    const isDq = (block.outcomes || []).some(o => String(o).startsWith('DQ - '))
      || /disqualified/i.test(blockName);

    if (isDq) {
      for (const outcomeTpl of block.outcomes || []) {
        const outcomeName = outcomeTpl.replace('{owner}', ownerName);
        const count = data.counts[outcomeName] || 0;
        if (count === 0) continue;
        const names = isTeam ? [] : (data.names[outcomeName] || []);
        blockLines.push(formatDqLine(outcomeName, count, names));
      }
      if (blockLines.length > 0) {
        lines.push(...blockLines);
        lines.push('');
      }
      continue;
    }

    for (let outcomeTpl of block.outcomes) {
      const outcomeName = outcomeTpl.replace('{owner}', ownerName);
      const formulaEntry = formulas.outcomeFormulas[outcomeTpl] || { eod: 1 };
      const formulaTypeId = formulaEntry.eod;

      const line = formatEODLine(outcomeName, formulaTypeId, data, isTeam);
      if (line) blockLines.push(line);
    }

    if (blockLines.length > 0) {
      const heading = (block.outcomes || []).includes('Site Visit Booked')
        ? siteVisitsHeader(blockName, data.siteVisits)
        : blockName;
      lines.push(heading);
      lines.push(...blockLines);
      lines.push('');
    }
  }

  // Personal: flag Requires Quoting contacts that still have no team quote.
  if (salesPerson && salesPerson !== 'Team') {
    const rqNames = [...new Set((data.names['Requires Quoting'] || []).filter(Boolean))];
    if (rqNames.length > 0) {
      const open = data.quotingOpen || [];
      lines.push('✅ Quoting coverage');
      if (open.length === 0) {
        lines.push('Complete 100%');
      } else {
        lines.push(`Still in need of quote: ${open.length} of ${rqNames.length}`);
        for (const name of open) lines.push(`- ${name}`);
      }
      lines.push('');
    }

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

  // 📝 Notes — custom outcomes (EOD 4) surfaced verbatim at the very bottom,
  // one per line as "Contact Name - Custom Outcome". Deduped on name+note.
  const customNotes = data.customNotes || [];
  if (customNotes.length > 0) {
    const seen = new Set();
    const noteLines = [];
    for (const { contactName, note } of customNotes) {
      if (!note) continue;
      const key = `${contactName}||${note}`;
      if (seen.has(key)) continue;
      seen.add(key);
      noteLines.push(contactName ? `${contactName} - ${note}` : note);
    }
    if (noteLines.length > 0) {
      lines.push('📝 Notes');
      lines.push(...noteLines);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Generate an EOD report for a specific person (or 'Team' for all).
 * @param {string} spreadsheetId
 * @param {string} salesPerson - person name or 'Team'
 * @param {string} targetDate - YYYY-MM-DD
 * @param {string} companyName
 * @param {string} ownerName
 * @returns {Promise<{message: string, counts: object, names: object}>}
 */
async function generateEOD(spreadsheetId, salesPerson, targetDate, companyName, ownerName, activityData) {
  const allRows = activityData;
  if (allRows.length < 2) {
    return { message: 'No activity data found.', counts: {}, names: {} };
  }

  const headers = allRows[0];
  const activities = parseActivityRows(allRows.slice(1), headers);
  const filtered = filterActivities(activities, targetDate, salesPerson);

  if (filtered.length === 0) {
    return { message: `No activities found for ${salesPerson} on ${targetDate}.`, counts: {}, names: {} };
  }

  const forExec = salesPerson && salesPerson !== 'Team' ? salesPerson : undefined;
  const data = countOutcomes(filtered, ownerName, companyName, activities, {
    forExec,
    rangeStart: targetDate,
    rangeEnd: targetDate,
  });
  const message = buildEODMessage(companyName, targetDate, ownerName, data, salesPerson);

  return { message, counts: data.counts, names: data.names };
}

/**
 * Build a people-side-by-side summary table for ClickUp (columns per exec + Team).
 * Generic across periods — the caller supplies the bold heading line and the
 * per-person countOutcomes results for the period being summarised.
 * @param {string} companyName
 * @param {string} heading - bold heading text (rendered as **heading**)
 * @param {string} ownerName
 * @param {Array<{name: string, data: object}>} peopleData - each person's countOutcomes result
 */
function buildSummaryTable(companyName, heading, ownerName, peopleData) {
  const { blocks } = loadConfig(companyName);
  const personNames = peopleData.map(p => p.name);

  const lines = [];
  lines.push(`**${heading}**`);
  lines.push('');

  // Table header
  lines.push(`| Metric | ${personNames.join(' | ')} | Team |`);
  lines.push(`|---|${personNames.map(() => '---:').join('|')}|---:|`);

  // Walk through EOD blocks to keep the same metrics/ordering as the daily table
  for (const block of blocks.eodBlocks) {
    for (let outcomeTpl of block.outcomes) {
      const outcomeName = outcomeTpl.replace('{owner}', ownerName);
      const values = peopleData.map(p => p.data.counts[outcomeName] || 0);
      const team = values.reduce((a, b) => a + b, 0);

      if (team === 0) continue;

      if (outcomeName === 'Pipeline Value') {
        const fmtValues = values.map(v => formatDollar(v));
        lines.push(`| Pipeline Value | ${fmtValues.join(' | ')} | ${formatDollar(team)} |`);
      } else {
        lines.push(`| ${displayLabel(outcomeName)} | ${values.join(' | ')} | ${team} |`);
      }
    }
  }

  // Revenue from jobs
  const revValues = peopleData.map(p => {
    return (p.data.jobDetails || []).reduce((sum, j) => sum + (j.value || 0), 0);
  });
  const totalRev = revValues.reduce((a, b) => a + b, 0);
  if (totalRev > 0) {
    lines.push(`| Revenue | ${revValues.map(v => formatDollar(v)).join(' | ')} | ${formatDollar(totalRev)} |`);
  }

  return lines.join('\n');
}

/**
 * Build the daily (EOD) summary table for ClickUp — delegates to buildSummaryTable.
 * @param {string} companyName
 * @param {string} dateStr
 * @param {string} ownerName
 * @param {Array<{name: string, data: object}>} peopleData - each person's countOutcomes result
 */
function buildEODSummaryTable(companyName, dateStr, ownerName, peopleData) {
  return buildSummaryTable(companyName, `EOD Summary — ${formatEODDate(dateStr)} — ${companyName}`, ownerName, peopleData);
}

module.exports = { generateEOD, countOutcomes, parseOutcome, buildEODMessage, buildEODSummaryTable, buildSummaryTable, resolveLeadSource, normalizeName, formatVisitDateTime };
