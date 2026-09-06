// Display-only relabels for report output.
//
// These shorten certain lead-source labels in the printed report WITHOUT
// changing the underlying outcome names in outcomes.json. Those names are still
// used as the matching keys against logged data (parsed EOD source / Ad Source)
// and as Google Sheet storage columns — so only the text a reader sees changes,
// never the counting. Mirrored in the dashboard renderer (dashboard/src/lib/messages.ts).

const DISPLAY_LABELS = {
  'Facebook Ad Form': 'FB Ad Form',
  'Direct Lead passed on from Client': 'Direct Lead from Client',
};

function dqReasonLabel(name) {
  return String(name || '').replace(/^DQ\s*-\s*/, '');
}

function displayLabel(name) {
  if (DISPLAY_LABELS[name]) return DISPLAY_LABELS[name];
  if (typeof name === 'string' && name.startsWith('DQ - ')) return dqReasonLabel(name);
  return name;
}

function formatDqLine(outcomeName, count, contactNames) {
  const reason = dqReasonLabel(outcomeName);
  const unique = [...new Set((contactNames || []).filter(Boolean))];
  return unique.length > 0
    ? `🚫 Disqualified - ${reason} - ${count} - ${unique.join(', ')}`
    : `🚫 Disqualified - ${reason} - ${count}`;
}

module.exports = { displayLabel, dqReasonLabel, formatDqLine };
