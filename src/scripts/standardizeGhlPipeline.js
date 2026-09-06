require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const map = JSON.parse(process.env.GHL_LOCATION_TOKENS);
const GHL = 'https://services.leadconnectorhq.com';
const H = (t) => ({ Authorization: `Bearer ${t}`, Version: '2021-07-28', 'Content-Type': 'application/json' });

// Canonical ladder (Sunbridge/Hughes shape); {owner} substituted per client.
const CANON = ['Inbound Lead', 'Day 1', 'Not a Good Time to Talk', 'Not Ready Yet - Pre-Quote',
  'Day 2', 'Day 3', 'Day 4', 'Day 5',
  'Requires Quoting', 'Quote Sent', 'Not Ready Yet - Post-Quote',
  'Site Visit Booked', 'Passed Onto {owner}', 'Verbal Confirmation', 'Accepted', 'Job Scheduled',
  'Job Completed', 'Lost', 'Abandoned', 'Disqualified'];

// Existing-stage renames into the canonical ladder (IDs preserved).
const RENAMES = {
  'Day 5 - Final Contact': 'Day 5',
  'Not Yet Ready': 'Not Ready Yet - Pre-Quote',
  'Proposal Sent': 'Quote Sent',
};

async function standardize(label, loc, pipelineId, owner, apply) {
  const token = map[loc];
  const res = await fetch(`${GHL}/opportunities/pipelines?locationId=${loc}`, { headers: H(token) });
  const pipe = (await res.json()).pipelines.find(p => p.id === pipelineId);

  const byName = new Map(pipe.stages.map(s => [RENAMES[s.name] || s.name, s]));
  const canon = CANON.map(n => n.replace('{owner}', owner));
  const stages = [];
  for (const name of canon) {
    const existing = byName.get(name);
    if (existing) {
      stages.push({ ...existing, name, position: stages.length });
      byName.delete(name);
    } else {
      stages.push({ name, position: stages.length, showInFunnel: true, showInPieChart: true });
    }
  }
  // Extra stages we keep (their automations may reference them) — appended.
  for (const [name, s] of byName) stages.push({ ...s, name, position: stages.length });

  console.log(`■ ${label}: ${stages.length} stages (${stages.filter(s => !s.id).length} new, ${Object.keys(RENAMES).length} renamed, extras kept: ${[...byName.keys()].join(', ') || 'none'})`);
  if (!apply) return;

  const put = await fetch(`${GHL}/opportunities/pipelines/${pipelineId}`, {
    method: 'PUT', headers: H(token),
    body: JSON.stringify({ name: pipe.name, stages }),
  });
  const body = await put.text();
  console.log(`  PUT ${put.status}: ${body.slice(0, 300)}`);
}

const apply = process.argv.includes('--apply');
const target = process.argv[2];
(async () => {
  if (target === 'PPS' || target === 'all') await standardize('PPS', 'RjUJhmqGE4f8BKrOt6FF', '0Okw6EjmoT05b16sIPAu', 'Ben', apply);
  if (target === 'LRS' || target === 'all') await standardize('LRS', 'rr409mgd1KBtPTg95J5K', 'cAi9qB7ZsKoqApj3Z1II', 'Lewis', apply);
  if (target === 'Enervia' || target === 'all') await standardize('Enervia', 'VclvarehVhFT6OQROeg8', 'swBqDL7ShBEsCOcXyfqC', 'Josh', apply);
  if (target === 'Nexgen' || target === 'all') await standardize('Nexgen', 'Cb7szZQAjO0dMCzf7HdH', 'Ryc1dTuSyfC33QMUUuDn', 'Jaidon', apply);
  if (!target) {
    console.log('Usage: node src/scripts/standardizeGhlPipeline.js <PPS|LRS|Enervia|Nexgen|all> [--apply]');
    console.log('Omit --apply for a dry-run.');
  }
})();
