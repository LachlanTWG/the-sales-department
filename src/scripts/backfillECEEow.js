// One-off backfill: East Coast Electrical EOW reports that were never generated.
// ECE has activities in the system from 2026-06-04 on, but zero reports of any
// type — the cron never produced EOW for it. This regenerates the EOW for each
// complete week since onboarding and (optionally) re-delivers + archives them.
//
// EOW reports normally land in four places (see runReports.js):
//   - Slack       (company.slack.webhookUrl)        [--send only]
//   - ClickUp     (company.clickup.chatChannelId)   [--send only]
//   - Google Sheet "{Person} Weekly" / "Team Weekly" tabs   [--commit]
//   - Postgres `reports` table (dashboard source of truth)  [--commit]
//
// generateEOW reads the Activity Log live and recreates the Weekly Storage
// formulas if missing, so past weeks regenerate cleanly. Archive is idempotent
// (sheet row updates in place, Postgres upserts on conflict). SEND is NOT
// idempotent — it posts fresh Slack/ClickUp messages every run, so it is OFF by
// default and must be explicitly opted into with --send.
//
// Usage:
//   node src/scripts/backfillECEEow.js                  # dry run: print previews, write nothing
//   node src/scripts/backfillECEEow.js --commit         # archive to sheet + Postgres (no client pings)
//   node src/scripts/backfillECEEow.js --commit --send  # ALSO post to Slack + ClickUp (client-facing!)
//
// Optional: restrict to specific weeks by Monday date, e.g.
//   node src/scripts/backfillECEEow.js --commit --weeks 2026-06-08,2026-06-15

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { readTab } = require('../sheets/readSheet');
const { generateEOW } = require('../reporting/generateEOW');
const { loadCompanies, sendCompanyEOW, archiveCompanyEOW } = require('../runReports');

const COMMIT = process.argv.includes('--commit');
const SEND = process.argv.includes('--send');

function getArg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
}

// Complete weeks since ECE onboarded (Mon 2026-06-01). The current week
// (Jun 22–28) is left out — it fires via the normal Friday cron.
const DEFAULT_WEEKS = [
  { start: '2026-06-01', end: '2026-06-07' },
  { start: '2026-06-08', end: '2026-06-14' },
  { start: '2026-06-15', end: '2026-06-21' },
];

function sundayOf(monday) {
  const d = new Date(monday + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

function preview(text, lines = 12) {
  const arr = String(text).split('\n');
  const head = arr.slice(0, lines).join('\n');
  return arr.length > lines ? `${head}\n    … (+${arr.length - lines} more lines)` : head;
}

async function main() {
  const weeksArg = getArg('--weeks');
  const weeks = weeksArg
    ? weeksArg.split(',').map(s => s.trim()).filter(Boolean).map(start => ({ start, end: sundayOf(start) }))
    : DEFAULT_WEEKS;

  const { companies } = loadCompanies();
  const company = companies.find(c => c.name.toLowerCase().includes('east coast'));
  if (!company) throw new Error('East Coast Electrical not found in config');

  const activePeople = company.salesPeople.filter(p => p.active).map(p => p.name);
  console.log(`Company : ${company.name}`);
  console.log(`Sheet   : ${company.sheetId}`);
  console.log(`People  : ${activePeople.join(', ')} (+ Team)`);
  console.log(`Weeks   : ${weeks.map(w => `${w.start}→${w.end}`).join(', ')}`);
  console.log(`Mode    : ${COMMIT ? (SEND ? 'COMMIT + SEND (Slack/ClickUp + sheet + Postgres)' : 'COMMIT (sheet + Postgres only — no client pings)') : 'DRY RUN (no writes)'}`);
  console.log('─'.repeat(70));

  for (const week of weeks) {
    console.log(`\n### Week ${week.start} → ${week.end}`);

    // Read the Activity Log once per week for the preview.
    const activityData = await readTab(company.sheetId, 'Activity Log');

    for (const person of [...activePeople, 'Team']) {
      try {
        const { message, counts } = await generateEOW(
          company.sheetId, person, week.start, week.end,
          company.name, company.ownerName, activityData
        );
        const totals = counts && Object.keys(counts).length
          ? Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')
          : '(no counts)';
        console.log(`\n  • ${person}: ${totals}`);
        console.log(preview(message).split('\n').map(l => `      ${l}`).join('\n'));
      } catch (err) {
        console.log(`\n  • ${person}: ERROR — ${err.message}`);
      }
    }

    if (COMMIT) {
      if (SEND) {
        console.log(`\n  → Sending to Slack + ClickUp …`);
        await sendCompanyEOW(company, week.start, week.end);
      }
      console.log(`  → Archiving to sheet + Postgres …`);
      await archiveCompanyEOW(company, week.start, week.end);
    }
  }

  console.log('\n' + '─'.repeat(70));
  if (!COMMIT) {
    console.log('DRY RUN complete. Re-run with --commit to archive (sheet + Postgres),');
    console.log('or --commit --send to also post to the ECE Slack/ClickUp channels.');
  } else {
    console.log(`Done. Archived ${weeks.length} week(s)${SEND ? ' and sent to Slack/ClickUp' : ' (sheet + Postgres only)'}.`);
  }
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
