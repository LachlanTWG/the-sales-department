// Move pre-quote "Not Ready Yet" to sit after "Not a Good Time to Talk"
// and before "Day 2" on every client's EOD pipeline.
//
// Stage ids are preserved — cards already in that column move with it.
// Post-quote Not Ready (Follow Up List / Post Quote / PQS) is not touched.
// Day-ladder ring-outs still walk by name (Day 1 → Day 2), not by position.
//
// Usage:
//   node src/scripts/moveNotReadyPreQuote.js            dry-run
//   node src/scripts/moveNotReadyPreQuote.js --apply    write to GHL

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { loadAllCompanies } = require('../config/companiesStore');

const GHL = 'https://services.leadconnectorhq.com';
const H = (t, json) => ({
  Authorization: `Bearer ${t}`,
  Version: '2021-07-28',
  ...(json ? { 'Content-Type': 'application/json' } : {}),
});

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function isNagtt(name) {
  return norm(name).startsWith('notagoodtime');
}

function isDay2(name) {
  return norm(name) === 'day2';
}

function isNotReadyPre(name) {
  const n = norm(name);
  if (n.includes('post') || n.includes('followup') || n.includes('pqs') || n.includes('proceed')) {
    return false;
  }
  return (
    n === 'notreadyyet' ||
    n === 'notreadyyetprequote' ||
    n === 'notreadyforsitevisit' ||
    n === 'notyetready'
  );
}

function reorder(stages) {
  const nagtt = stages.findIndex((s) => isNagtt(s.name));
  const day2 = stages.findIndex((s) => isDay2(s.name));
  const nrPre = stages.findIndex((s) => isNotReadyPre(s.name));
  if (nagtt === -1 || day2 === -1 || nrPre === -1) {
    return { stages, skip: true, nagtt, day2, nrPre };
  }
  // Already immediately after NAGTT and immediately before Day 2.
  if (nrPre === nagtt + 1 && nrPre === day2 - 1) {
    return { stages, skip: false, already: true, nagtt, day2, nrPre };
  }

  const next = stages.slice();
  const [moved] = next.splice(nrPre, 1);
  const nagttAfter = next.findIndex((s) => isNagtt(s.name));
  next.splice(nagttAfter + 1, 0, moved);
  return {
    stages: next.map((s, i) => ({ ...s, position: i })),
    skip: false,
    already: false,
    nagtt,
    day2,
    nrPre,
  };
}

function names(stages) {
  return stages.map((s) => s.name);
}

const apply = process.argv.includes('--apply');

(async () => {
  const tokens = JSON.parse(process.env.GHL_LOCATION_TOKENS || '{}');
  const { companies } = loadAllCompanies();
  let changed = 0;
  let skipped = 0;
  let failed = 0;

  for (const c of companies) {
    const loc = c.ghlLocationId;
    const token = tokens[loc];
    const flag = c.active === false ? ' (inactive)' : '';
    if (!loc || !token) {
      console.log(`■ ${c.name}${flag}: no token — skipped`);
      skipped++;
      continue;
    }

    const res = await fetch(`${GHL}/opportunities/pipelines?locationId=${loc}`, { headers: H(token) });
    if (!res.ok) {
      console.log(`■ ${c.name}${flag}: pipelines HTTP ${res.status}`);
      failed++;
      continue;
    }
    const pipes = (await res.json()).pipelines || [];
    const pipe = pipes.find((p) => (p.stages || []).some((s) => norm(s.name) === 'day1'));
    if (!pipe) {
      console.log(`■ ${c.name}${flag}: no Day 1 pipeline — skipped`);
      skipped++;
      continue;
    }

    const result = reorder(pipe.stages || []);
    if (result.skip) {
      console.log(
        `■ ${c.name}${flag}: missing a required stage (NAGTT=${result.nagtt}, Day2=${result.day2}, NotReadyPre=${result.nrPre}) — skipped`,
      );
      skipped++;
      continue;
    }
    if (result.already) {
      console.log(`■ ${c.name}${flag}: already NAGTT → ${pipe.stages[result.nrPre].name} → Day 2`);
      skipped++;
      continue;
    }

    const before = names(pipe.stages);
    const after = names(result.stages);
    const movedName = pipe.stages[result.nrPre].name;
    console.log(`■ ${c.name}${flag} — ${pipe.name}`);
    console.log(`  move "${movedName}" to after NAGTT / before Day 2`);
    console.log(`  before: ${before.join(' → ')}`);
    console.log(`  after:  ${after.join(' → ')}`);

    if (!apply) {
      changed++;
      continue;
    }

    const put = await fetch(`${GHL}/opportunities/pipelines/${pipe.id}`, {
      method: 'PUT',
      headers: H(token, true),
      body: JSON.stringify({ name: pipe.name, stages: result.stages }),
    });
    const body = await put.text();
    if (!put.ok) {
      console.log(`  PUT ${put.status}: ${body.slice(0, 400)}`);
      failed++;
      continue;
    }
    console.log(`  PUT ${put.status} ok`);
    changed++;
  }

  console.log(
    `\n${apply ? 'Applied' : 'Dry-run'}: ${changed} to change, ${skipped} skipped, ${failed} failed.`,
  );
  if (!apply) console.log('Re-run with --apply to write.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
