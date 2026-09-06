// One-off backfill: East Coast Electrical quotes that the Quotie automation
// failed to log on 8–9 Jun 2026. Dual-writes to the Activity Log sheet AND
// Postgres (via logActivities) so reports, storage tabs and the dashboard all
// agree — same as a live /webhook/quote call.
//
// Each entry is one Quotie quote *group*: the value is the pipe-separated
// alternative tiers (averaged at read time via quoteGroupValue, never re-summed).
// Idempotent: source='quotie', source_row_id='quotie-group-<headerQuoteId>'.
// `on conflict (company_id, source, source_row_id) do nothing` makes re-runs safe.
//
// Usage:
//   node src/scripts/backfillECEQuotes.js            # dry run (prints, writes nothing)
//   node src/scripts/backfillECEQuotes.js --commit   # actually dual-write

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { loadAllCompanies } = require('../config/companiesStore');
const { logActivity } = require('../sheets/logActivity');
const db = require('../db');

const COMPANY_NAME = 'East Coast Electrical';

// Parsed from the Quotie screenshots. tiers = alternative quote values for the
// one job (highest-numbered quote in the group is used as the idempotency id).
const QUOTES = [
  { groupId: '7000', date: '2026-06-09', rep: 'Zac',   contact: 'Brendan Mcdonald', address: '12 Lower Mount Mellum Rd, Landsborough QLD 4550', tiers: [23579, 21162, 13617, 11171], avgShown: 17382 },
  { groupId: '7002', date: '2026-06-09', rep: 'Benji', contact: 'Carrie Ang',       address: '66 Rokeby Road, Booral, QLD',                       tiers: [16779, 14749],               avgShown: 15764 },
  { groupId: '6986', date: '2026-06-09', rep: 'Benji', contact: 'Col Blumson',      address: '65 Pathara Road, North Arm, QLD',                   tiers: [12455, 9960, 7909],          avgShown: 10108 },
  { groupId: '6983', date: '2026-06-08', rep: 'Zac',   contact: 'Henry Weatherill', address: '6 Corinthia Ct, Noosaville QLD 4566',               tiers: [25550, 19877, 19173, 15945], avgShown: 20136 },
  { groupId: '6975', date: '2026-06-08', rep: 'Zac',   contact: 'Colin James male', address: '283 Mount Mellum Rd, Mount Mellum QLD 4550',        tiers: [16865, 13778, 11627, 9612],  avgShown: 12970 },
  { groupId: '6965', date: '2026-06-08', rep: 'Zac',   contact: 'Alan Ford',        address: '91 Southland Way, Buderim QLD 4556',                tiers: [15321, 12289, 9878, 7826],   avgShown: 11328 },
];

const mean = (a) => a.reduce((s, n) => s + n, 0) / a.length;

async function main() {
  const commit = process.argv.includes('--commit');

  const { companies } = loadAllCompanies();
  const company = companies.find(c => c.name === COMPANY_NAME);
  if (!company) throw new Error(`Company "${COMPANY_NAME}" not found in config`);
  if (!company.sheetId) throw new Error(`No sheetId for ${COMPANY_NAME}`);

  console.log(`\n${commit ? '*** COMMIT ***' : '— DRY RUN — (pass --commit to write)'}`);
  console.log(`Company: ${company.name}  sheet=${company.sheetId}  DB=${db.isEnabled() ? 'on' : 'OFF'}\n`);

  // Verify each computed mean against the "Avg" shown in Quotie (rounded).
  for (const q of QUOTES) {
    const avg = mean(q.tiers);
    const ok = Math.round(avg) === q.avgShown || Math.floor(avg) === q.avgShown;
    console.log(
      `${q.date}  ${q.rep.padEnd(6)} ${q.contact.padEnd(18)} ` +
      `tiers=${q.tiers.join('|').padEnd(28)} avg=$${avg.toFixed(0)} (shown $${q.avgShown}) ${ok ? 'OK' : '!! MISMATCH'}`
    );
    if (!ok) throw new Error(`Average mismatch for ${q.contact} — aborting before any write`);
  }

  if (!commit) {
    console.log(`\nDry run only. Nothing written. Re-run with --commit to dual-write ${QUOTES.length} quotes.\n`);
    return;
  }

  let written = 0;
  for (const q of QUOTES) {
    const quoteJobValue = q.tiers.join('|');
    const activityData = {
      date: q.date,
      salesPerson: q.rep,
      contactName: q.contact,
      eventType: 'Quote Sent',
      outcome: '',
      adSource: '',
      quoteJobValue,
      contactAddress: q.address,
      contactId: '',
    };
    await logActivity(company.sheetId, activityData, {
      companyName: company.name,
      source: 'quotie',
      sourceRowId: `quotie-group-${q.groupId}`,
      rawPayload: { backfill: true, reason: 'automation failure 8-9 Jun 2026', quoteGroupId: q.groupId, tiers: q.tiers },
    });
    written++;
    console.log(`  ✓ ${q.date} ${q.rep} / ${q.contact} / ${quoteJobValue}`);
  }

  console.log(`\nDone. Dual-wrote ${written} quote(s) to sheet + Postgres.\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
