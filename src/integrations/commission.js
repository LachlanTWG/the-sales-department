// Fire Sales Exec Invoicing when a Job Won is logged via EOD (manual entry /
// extension form). Avoids per-location GHL custom fields for commissions.
//
// COMMISSION_WEBHOOK_URL should point at:
//   https://<se-inv-host>/webhook/eod-job-won
// When unset, Job Won still logs to EOD — commission fire is skipped.

/**
 * @param {string} companyName  EOD company roster name (e.g. "Bolton EC")
 * @param {object} activity     Sheet-shaped activity: salesPerson, contactName,
 *                              contactAddress, quoteJobValue, quoteNumber?,
 *                              splitCommission?, splitWith?, halfCommissionCharge?
 * @returns {Promise<{ ok: boolean, skipped?: boolean, status?: number, body?: any, error?: string }>}
 */
async function reportJobWonToCommission(companyName, activity) {
  const url = (process.env.COMMISSION_WEBHOOK_URL || '').trim();
  if (!url) {
    return { ok: true, skipped: true };
  }

  const quoteValue = String(activity.quoteJobValue || '').split('|')[0].trim();
  const payload = {
    company_name: companyName,
    exec_name: activity.salesPerson || '',
    full_name: activity.contactName || '',
    address: activity.contactAddress || '',
    quote_value_incl_gst: quoteValue,
    quote_number: String(activity.quoteNumber || '').trim(),
    split_commission: Boolean(activity.splitCommission),
    half_commission_charge: Boolean(activity.halfCommissionCharge),
  };
  // Only when the form named people. Omitted → invoicing uses the company roster.
  if (Array.isArray(activity.splitWith)) {
    payload.split_with = activity.splitWith;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text().catch(() => '');
    let body = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    if (!res.ok) {
      console.error(
        `[commission] ${companyName} / ${payload.exec_name} / ${payload.quote_number} → ${res.status}: ${text.slice(0, 300)}`,
      );
      return { ok: false, status: res.status, body };
    }
    console.log(
      `[commission] ${companyName} / ${payload.exec_name} / ${payload.full_name} / $${payload.quote_value_incl_gst} / #${payload.quote_number}`,
    );
    return { ok: true, status: res.status, body };
  } catch (e) {
    console.error(`[commission] request failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/**
 * Report every Job Won in a batch. Failures are logged but not thrown —
 * activity logging must succeed even if commissions are down.
 */
async function reportJobWonsToCommission(companyName, activities) {
  const wins = (activities || []).filter(a => a && a.eventType === 'Job Won');
  if (wins.length === 0) return [];
  const results = [];
  for (const a of wins) {
    results.push(await reportJobWonToCommission(companyName, a));
  }
  return results;
}

module.exports = { reportJobWonToCommission, reportJobWonsToCommission };
