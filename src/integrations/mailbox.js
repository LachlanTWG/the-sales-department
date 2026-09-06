/**
 * Multi-provider mailbox email tracking (Option B).
 *
 * Providers: gmail | outlook
 * Model: ONE mailbox connection per (exec, client) — not one per exec.
 * On connect the exec picks the client, then Gmail or Outlook. Company is
 * fixed on that connection; recipients are matched only within that client.
 *
 * Env (shared):
 *   DASHBOARD_URL
 *   WEBHOOK_SECRET or EOD_ENTRY_SECRET
 *   TOKEN_ENCRYPTION_KEY (optional AES for tokens)
 *
 * Gmail:
 *   GOOGLE_OAUTH_CLIENT_ID / SECRET
 *   GOOGLE_OAUTH_REDIRECT_URI  → …/oauth/mailbox/callback
 *
 * Outlook (Microsoft Graph):
 *   MICROSOFT_OAUTH_CLIENT_ID / SECRET
 *   MICROSOFT_OAUTH_REDIRECT_URI → …/oauth/mailbox/callback
 *   MICROSOFT_OAUTH_TENANT (optional, default "common")
 */

const crypto = require('crypto');
const { google } = require('googleapis');
const db = require('../db');
const { appendRows } = require('../sheets/writeSheet');
const { loadCompanies } = require('../config/companiesStore');

const PROVIDERS = ['gmail', 'outlook'];
const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const OUTLOOK_SCOPES = ['offline_access', 'User.Read', 'Mail.Read'];
const STATE_TTL_MS = 15 * 60 * 1000;
const BACKFILL_DAYS = 2;

// ─── Config / crypto ────────────────────────────────────────────────

function isGmailConfigured() {
  return Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID &&
    process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
    process.env.GOOGLE_OAUTH_REDIRECT_URI,
  );
}

function isOutlookConfigured() {
  return Boolean(
    process.env.MICROSOFT_OAUTH_CLIENT_ID &&
    process.env.MICROSOFT_OAUTH_CLIENT_SECRET &&
    process.env.MICROSOFT_OAUTH_REDIRECT_URI,
  );
}

/** True if at least one provider is wired. */
function isConfigured() {
  return isGmailConfigured() || isOutlookConfigured();
}

function isProviderConfigured(provider) {
  if (provider === 'gmail') return isGmailConfigured();
  if (provider === 'outlook') return isOutlookConfigured();
  return false;
}

function stateSecret() {
  return process.env.WEBHOOK_SECRET || process.env.EOD_ENTRY_SECRET || null;
}

function microsoftTenant() {
  return process.env.MICROSOFT_OAUTH_TENANT || 'common';
}

function encryptToken(plain) {
  if (!plain) return plain;
  const keyMaterial = process.env.TOKEN_ENCRYPTION_KEY;
  if (!keyMaterial || keyMaterial.length < 16) return plain;
  const key = crypto.createHash('sha256').update(keyMaterial).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decryptToken(stored) {
  if (!stored) return stored;
  if (!String(stored).startsWith('enc:v1:')) return stored;
  const keyMaterial = process.env.TOKEN_ENCRYPTION_KEY;
  if (!keyMaterial || keyMaterial.length < 16) {
    throw new Error('TOKEN_ENCRYPTION_KEY required to decrypt stored mailbox tokens');
  }
  const key = crypto.createHash('sha256').update(keyMaterial).digest();
  const [, , ivB64, tagB64, dataB64] = String(stored).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function signState(payload) {
  const secret = stateSecret();
  if (!secret) throw new Error('WEBHOOK_SECRET / EOD_ENTRY_SECRET required for mailbox OAuth state');
  if (!PROVIDERS.includes(payload.provider)) {
    throw new Error(`Invalid mailbox provider: ${payload.provider}`);
  }
  if (!payload.companyId) throw new Error('companyId required in OAuth state');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** Human-readable OAuth error from the provider callback query string. */
function describeOAuthError(searchParams) {
  const err = (searchParams.get('error') || '').trim();
  const desc = (searchParams.get('error_description') || '').trim();
  if (!err && !desc) return null;
  const combined = `${err} ${desc}`.toLowerCase();
  if (
    combined.includes('access_denied') ||
    combined.includes('verification') ||
    combined.includes('unverified') ||
    combined.includes('not completed')
  ) {
    return (
      'Google blocked this mailbox (403 access_denied). The Gmail app is still in testing, ' +
      'so only approved testers can connect. Add this Google address as a test user in ' +
      'Google Cloud → Auth → Audience, then connect again.'
    );
  }
  return (desc || err).slice(0, 200);
}

function verifyState(state) {
  const secret = stateSecret();
  if (!secret) throw new Error('WEBHOOK_SECRET / EOD_ENTRY_SECRET required for mailbox OAuth state');
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) throw new Error('Invalid OAuth state');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Invalid OAuth state signature');
  }
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!payload.exp || Date.now() > payload.exp) throw new Error('OAuth state expired');
  if (!payload.userId || !payload.salesPersonName) throw new Error('OAuth state missing fields');
  if (!payload.companyId) throw new Error('OAuth state missing companyId');
  if (!PROVIDERS.includes(payload.provider)) throw new Error('OAuth state missing/invalid provider');
  return payload;
}

// ─── Address helpers ────────────────────────────────────────────────

function normaliseEmail(raw) {
  if (!raw) return null;
  let s = String(raw).trim().toLowerCase();
  const angle = s.match(/<([^>]+)>/);
  if (angle) s = angle[1].trim().toLowerCase();
  s = s.replace(/^mailto:/, '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s;
}

/** "Craig Bannister <x@y.com>" / '"Craig Bannister" <x@y.com>' / bare email → { email, name } */
function parseOneAddress(raw) {
  const part = String(raw || '').trim();
  if (!part) return null;
  const angle = part.match(/^(.*?)\s*<([^>]+)>\s*$/);
  let email;
  let name = null;
  if (angle) {
    email = normaliseEmail(angle[2]);
    name = angle[1].replace(/^["']|["']$/g, '').trim() || null;
  } else {
    email = normaliseEmail(part);
  }
  if (!email) return null;
  // Ignore "name" that's empty, same as email, or just the local-part
  if (name) {
    const n = name.toLowerCase();
    if (!n || n === email || n === email.split('@')[0]) name = null;
  }
  return { email, name };
}

function parseAddressList(headerValue) {
  if (!headerValue) return [];
  const parts = String(headerValue).split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const out = [];
  for (const p of parts) {
    const parsed = parseOneAddress(p);
    if (parsed) out.push(parsed);
  }
  return out;
}

function looksLikeEmail(s) {
  return typeof s === 'string' && s.includes('@');
}

function headerMap(headers) {
  const m = {};
  for (const h of headers || []) {
    if (h?.name) m[String(h.name).toLowerCase()] = h.value || '';
  }
  return m;
}

function isNoiseRecipient(email, ownEmail, teamEmails) {
  if (!email) return true;
  if (ownEmail && email === ownEmail) return true;
  if (teamEmails.has(email)) return true;
  if (email.endsWith('@google.com') || email.endsWith('@docs.google.com')) return true;
  if (email.endsWith('@microsoft.com') || email.endsWith('@microsoftonline.com')) return true;
  if (/^(noreply|no-reply|mailer-daemon|postmaster)@/i.test(email)) return true;
  return false;
}

// ─── Contact email upsert ───────────────────────────────────────────

async function upsertContactEmail({ companyName, companyId, email, contactName, contactId, source = 'ghl' }) {
  if (!db.isEnabled()) return { skipped: true };
  const norm = normaliseEmail(email);
  if (!norm) return { skipped: true, reason: 'bad_email' };

  const client = await db.getPool().connect();
  try {
    let cid = companyId;
    if (!cid && companyName) {
      cid = await db.resolveCompanyId(client, companyName);
    }
    if (!cid) return { skipped: true, reason: 'unknown_company' };

    await client.query(
      `insert into contact_emails (company_id, email, contact_name, contact_id, source, updated_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (company_id, email) do update set
         contact_name = coalesce(excluded.contact_name, contact_emails.contact_name),
         contact_id   = coalesce(excluded.contact_id, contact_emails.contact_id),
         updated_at   = now()`,
      [cid, norm, contactName || null, contactId || null, source],
    );
    return { ok: true, email: norm, companyId: cid };
  } finally {
    client.release();
  }
}

// ─── DB: accounts ───────────────────────────────────────────────────

async function upsertMailboxAccount({
  userId,
  companyId,
  provider,
  email,
  salesPersonName,
  refreshToken,
  accessToken,
  tokenExpiry,
  syncCursor,
}) {
  if (!PROVIDERS.includes(provider)) throw new Error(`Invalid provider: ${provider}`);
  if (!companyId) throw new Error('companyId required');
  const client = await db.getPool().connect();
  try {
    const { rows } = await client.query(
      `insert into mailbox_accounts (
         user_id, company_id, provider, email, sales_person_name,
         refresh_token, access_token, token_expiry,
         sync_cursor, status, last_error, connected_at, updated_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', null, now(), now())
       on conflict (user_id, company_id) do update set
         provider = excluded.provider,
         email = excluded.email,
         sales_person_name = excluded.sales_person_name,
         refresh_token = coalesce(excluded.refresh_token, mailbox_accounts.refresh_token),
         access_token = excluded.access_token,
         token_expiry = excluded.token_expiry,
         sync_cursor = coalesce(excluded.sync_cursor, mailbox_accounts.sync_cursor),
         status = 'active',
         last_error = null,
         updated_at = now()
       returning *`,
      [
        userId,
        companyId,
        provider,
        normaliseEmail(email) || email,
        salesPersonName,
        encryptToken(refreshToken),
        accessToken ? encryptToken(accessToken) : null,
        tokenExpiry || null,
        syncCursor || null,
      ],
    );
    // Attach company_name for sync logging
    return hydrateAccount(rows[0]);
  } finally {
    client.release();
  }
}

async function hydrateAccount(row) {
  if (!row) return null;
  if (row.company_name && row.sheet_id !== undefined) return row;
  if (!row.company_id) return row;
  const client = await db.getPool().connect();
  try {
    const { rows } = await client.query(
      `select name, sheet_id from companies where id = $1 limit 1`,
      [row.company_id],
    );
    return {
      ...row,
      company_name: rows[0]?.name || null,
      sheet_id: rows[0]?.sheet_id || null,
    };
  } finally {
    client.release();
  }
}

async function listActiveAccounts() {
  if (!db.isEnabled()) return [];
  const client = await db.getPool().connect();
  try {
    const { rows } = await client.query(
      `select ma.*, c.name as company_name, c.sheet_id, c.timezone as company_timezone
         from mailbox_accounts ma
         join companies c on c.id = ma.company_id and c.active = true
        where ma.status = 'active'
          and ma.company_id is not null
        order by c.name, ma.email`,
    );
    return rows;
  } finally {
    client.release();
  }
}

async function listAccountsForUser(userId) {
  if (!db.isEnabled()) return [];
  const client = await db.getPool().connect();
  try {
    const { rows } = await client.query(
      `select ma.id, ma.user_id, ma.company_id, ma.provider, ma.email,
              ma.sales_person_name, ma.status, ma.last_synced_at, ma.last_error,
              ma.connected_at, c.name as company_name, c.slug as company_slug
         from mailbox_accounts ma
         join companies c on c.id = ma.company_id
        where ma.user_id = $1
        order by c.name`,
      [userId],
    );
    return rows;
  } finally {
    client.release();
  }
}

async function updateAccountSync(id, patch) {
  const client = await db.getPool().connect();
  try {
    const sets = [];
    const vals = [];
    let i = 1;
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = $${i++}`);
      vals.push(v);
    }
    sets.push('updated_at = now()');
    vals.push(id);
    await client.query(
      `update mailbox_accounts set ${sets.join(', ')} where id = $${i}`,
      vals,
    );
  } finally {
    client.release();
  }
}

/** Disconnect one (user, company) binding. */
async function deleteMailboxAccount(userId, companyId) {
  if (!companyId) throw new Error('companyId required to disconnect a mailbox');
  const client = await db.getPool().connect();
  try {
    await client.query(
      `delete from mailbox_accounts where user_id = $1 and company_id = $2`,
      [userId, companyId],
    );
  } finally {
    client.release();
  }
}

async function getAccountByUserAndCompany(userId, companyId) {
  if (!db.isEnabled()) return null;
  const client = await db.getPool().connect();
  try {
    const { rows } = await client.query(
      `select ma.*, c.name as company_name, c.sheet_id, c.timezone as company_timezone
         from mailbox_accounts ma
         left join companies c on c.id = ma.company_id
        where ma.user_id = $1 and ma.company_id = $2
        limit 1`,
      [userId, companyId],
    );
    return rows[0] || null;
  } finally {
    client.release();
  }
}

// ─── Attribution + logging ──────────────────────────────────────────

/**
 * Match recipients against contact_emails for THIS client only.
 * Company is already fixed on the mailbox connection.
 */
async function resolveContactForCompany(recipientEmails, companyId) {
  if (!recipientEmails.length || !companyId) return null;
  const client = await db.getPool().connect();
  try {
    const { rows } = await client.query(
      `select ce.email, ce.contact_name, ce.contact_id
         from contact_emails ce
        where ce.company_id = $1
          and ce.email = any($2::text[])
        order by ce.updated_at desc
        limit 1`,
      [companyId, recipientEmails],
    );
    if (!rows.length) return null;
    return {
      contactName: rows[0].contact_name,
      contactId: rows[0].contact_id,
      matchedEmail: rows[0].email,
    };
  } finally {
    client.release();
  }
}

/** Prefer DB name → header display name → email. */
function bestContactName({ dbName, headerName, email }) {
  const db = (dbName || '').trim();
  if (db && !looksLikeEmail(db)) return db;
  const hdr = (headerName || '').trim();
  if (hdr && !looksLikeEmail(hdr)) return hdr;
  if (db) return db;
  return email || '';
}

async function upgradeActivityContactName(companyName, source, sourceRowId, contactName) {
  if (!contactName || looksLikeEmail(contactName) || !db.isEnabled()) return;
  const client = await db.getPool().connect();
  try {
    const companyId = await db.resolveCompanyId(client, companyName);
    if (!companyId) return;
    // Only upgrade rows that still show a bare email as the contact.
    await client.query(
      `update activities
          set contact_name = $1
        where company_id = $2
          and source = $3
          and source_row_id = $4
          and (contact_name is null or contact_name = '' or contact_name like '%@%')`,
      [contactName, companyId, source, sourceRowId],
    );
  } finally {
    client.release();
  }
}

async function recordUnmatched(accountId, messageId, { occurredAt, subject, recipients, reason, rawHeaders }) {
  const client = await db.getPool().connect();
  try {
    await client.query(
      `insert into mailbox_unmatched (
         mailbox_account_id, message_id, occurred_at, subject, recipients, reason, raw_headers
       ) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (mailbox_account_id, message_id) do nothing`,
      [
        accountId,
        messageId,
        occurredAt || null,
        subject || null,
        recipients || [],
        reason || 'no_contact_match',
        rawHeaders ? JSON.stringify(rawHeaders) : null,
      ],
    );
  } finally {
    client.release();
  }
}

function dateFromIso(iso, timezone) {
  if (!iso) {
    return new Date().toLocaleDateString('en-CA', { timeZone: timezone || 'Australia/Sydney' });
  }
  return new Date(iso).toLocaleDateString('en-CA', {
    timeZone: timezone || 'Australia/Sydney',
  });
}

/**
 * Shared: take a normalised sent message and log against the connection's client.
 * Company is fixed on mailbox_accounts. Every non-noise outbound email is logged.
 * Name priority: contact_emails → To/Cc display name (e.g. "Craig Bannister") → email.
 * @param {{ messageId, recipients: {email,name}[], subject, occurredAt, extra? }} msg
 */
async function ingestSentMessage(account, msg, teamEmails, stats) {
  const provider = account.provider || 'gmail';
  const companyName = account.company_name;
  const companyId = account.company_id;
  if (!companyId || !companyName) {
    stats.errors.push('mailbox missing company binding');
    return;
  }

  // Normalise: accept {email,name}[] or legacy string[]
  const rawRecipients = (msg.recipients || []).map(r => {
    if (r && typeof r === 'object' && r.email) {
      return { email: normaliseEmail(r.email), name: r.name || null };
    }
    return parseOneAddress(r);
  }).filter(r => r && r.email);

  const recipients = [];
  const seen = new Set();
  for (const r of rawRecipients) {
    if (isNoiseRecipient(r.email, account.email, teamEmails)) continue;
    if (seen.has(r.email)) continue;
    seen.add(r.email);
    recipients.push(r);
  }

  const subject = msg.subject || '';
  const occurredAt = msg.occurredAt || null;
  const messageId = msg.messageId;

  // Pure noise only: self-sends, other connected mailboxes, noreply, etc.
  if (!recipients.length) {
    stats.skippedNoise++;
    return;
  }

  const emails = recipients.map(r => r.email);
  const primary = recipients[0];
  // Optional DB enrichment — never required to count the email.
  const contact = await resolveContactForCompany(emails, companyId);
  const contactName = bestContactName({
    dbName: contact?.contactName,
    headerName: primary?.name,
    email: primary?.email,
  });
  const contactId = (contact && contact.contactId) || null;
  const matchedEmail = (contact && contact.matchedEmail) || primary?.email || null;

  let sheetId = account.sheet_id;
  const { companies } = loadCompanies();
  const cfg = companies.find(c => c.name === companyName);
  if (!sheetId) sheetId = cfg?.sheetId || null;
  if (!sheetId) {
    stats.errors.push(`no sheet for ${companyName}`);
    return;
  }

  const tz = account.company_timezone || cfg?.timezone || 'Australia/Sydney';
  const date = dateFromIso(occurredAt, tz);
  const source = provider === 'outlook' ? 'outlook' : 'gmail';
  const sourceRowId = `${provider}:${messageId}`;

  const dbResult = await db.insertActivity({
    companyName,
    salesPersonName: account.sales_person_name,
    occurredOn: date,
    occurredAt: occurredAt || null,
    eventType: 'email_sent',
    contactName,
    contactId,
    outcome: subject || null,
    source,
    sourceRowId,
    rawPayload: {
      provider,
      messageId,
      recipients,
      subject,
      matchedEmail,
      contactMatched: Boolean(contact),
      mailbox: account.email,
      companyId,
      companyName,
      occurredAt,
      ...(msg.extra || {}),
    },
  });

  if (dbResult?.deduped) {
    // Older rows may only have the bare email — upgrade to display name when we have it.
    await upgradeActivityContactName(companyName, source, sourceRowId, contactName);
    stats.deduped++;
    return;
  }
  if (dbResult?.skipped) {
    stats.errors.push('db_disabled');
    return;
  }

  try {
    await appendRows(
      sheetId,
      'Activity Log',
      [[
        date,
        account.sales_person_name,
        contactName,
        'Email Sent',
        subject || '',
        '',
        '',
        '',
        contactId || '',
        '',
        '',
      ]],
      true,
    );
  } catch (e) {
    console.error(`[mailbox] sheet append failed ${companyName}:`, e.message);
  }

  stats.logged++;
}

// ─── Gmail provider ─────────────────────────────────────────────────

function getGmailOAuth2Client() {
  if (!isGmailConfigured()) {
    throw new Error('Gmail OAuth not configured (GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI)');
  }
  return new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REDIRECT_URI,
  );
}

function gmailAuthUrl(state) {
  const client = getGmailOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GMAIL_SCOPES,
    state,
    include_granted_scopes: true,
  });
}

async function gmailAuthClientForAccount(account) {
  const client = getGmailOAuth2Client();
  const refresh = decryptToken(account.refresh_token);
  const access = account.access_token ? decryptToken(account.access_token) : null;
  client.setCredentials({
    refresh_token: refresh,
    access_token: access || undefined,
    expiry_date: account.token_expiry ? new Date(account.token_expiry).getTime() : undefined,
  });

  client.on('tokens', async (tokens) => {
    try {
      const patch = { last_error: null };
      if (tokens.access_token) patch.access_token = encryptToken(tokens.access_token);
      if (tokens.refresh_token) patch.refresh_token = encryptToken(tokens.refresh_token);
      if (tokens.expiry_date) patch.token_expiry = new Date(tokens.expiry_date).toISOString();
      await updateAccountSync(account.id, patch);
    } catch (e) {
      console.error(`[mailbox/gmail] token persist failed for ${account.email}:`, e.message);
    }
  });

  if (!access || (account.token_expiry && new Date(account.token_expiry).getTime() < Date.now() + 60_000)) {
    const { credentials } = await client.refreshAccessToken();
    client.setCredentials(credentials);
  }
  return client;
}

async function syncGmailAccount(account, { forceBackfill = false } = {}) {
  const stats = { logged: 0, deduped: 0, unmatched: 0, skippedNoise: 0, errors: [] };
  if (!isGmailConfigured()) {
    return { ok: false, error: 'gmail_oauth_not_configured', stats };
  }

  let auth;
  try {
    auth = await gmailAuthClientForAccount(account);
  } catch (e) {
    await updateAccountSync(account.id, { status: 'needs_reauth', last_error: e.message });
    return { ok: false, error: e.message, stats };
  }

  const gmail = google.gmail({ version: 'v1', auth });
  const teamEmails = new Set(
    (await listActiveAccounts()).map(a => normaliseEmail(a.email)).filter(Boolean),
  );
  const cursor = account.sync_cursor;

  try {
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const latestHistoryId = profile.data.historyId ? String(profile.data.historyId) : null;
    const messageIds = new Set();
    let doBackfill = forceBackfill;

    if (cursor && !doBackfill) {
      try {
        let pageToken;
        do {
          const hist = await gmail.users.history.list({
            userId: 'me',
            startHistoryId: cursor,
            historyTypes: ['messageAdded'],
            labelId: 'SENT',
            pageToken,
          });
          for (const h of hist.data.history || []) {
            for (const added of h.messagesAdded || []) {
              if (added.message?.id) messageIds.add(added.message.id);
            }
          }
          pageToken = hist.data.nextPageToken;
        } while (pageToken);
      } catch (e) {
        if (!/404|historyId|notFound/i.test(e.message || '')) throw e;
        console.warn(`[mailbox/gmail] history expired for ${account.email}, backfilling`);
        doBackfill = true;
      }
    } else {
      doBackfill = true;
    }

    if (doBackfill || (messageIds.size === 0 && !cursor)) {
      const after = new Date();
      after.setDate(after.getDate() - BACKFILL_DAYS);
      const q = `in:sent after:${after.getFullYear()}/${after.getMonth() + 1}/${after.getDate()}`;
      let pageToken;
      do {
        const list = await gmail.users.messages.list({
          userId: 'me',
          q,
          maxResults: 100,
          pageToken,
        });
        for (const m of list.data.messages || []) {
          if (m.id) messageIds.add(m.id);
        }
        pageToken = list.data.nextPageToken;
      } while (pageToken);
    }

    for (const id of messageIds) {
      try {
        const full = await gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'],
        });
        const headers = headerMap(full.data.payload?.headers);
        const to = parseAddressList(headers.to);
        const cc = parseAddressList(headers.cc);
        const occurredAt = full.data.internalDate
          ? new Date(Number(full.data.internalDate)).toISOString()
          : null;
        await ingestSentMessage(
          account,
          {
            messageId: id,
            recipients: [...to, ...cc], // [{ email, name }, ...]
            subject: headers.subject || '',
            occurredAt,
            extra: { headers },
          },
          teamEmails,
          stats,
        );
      } catch (e) {
        stats.errors.push(`${id}: ${e.message}`);
        console.error(`[mailbox/gmail] message ${id} (${account.email}):`, e.message);
      }
    }

    await updateAccountSync(account.id, {
      sync_cursor: latestHistoryId || cursor,
      last_synced_at: new Date().toISOString(),
      last_error: stats.errors.length ? stats.errors.slice(0, 3).join('; ') : null,
      status: 'active',
    });
    return { ok: true, stats, messageCount: messageIds.size };
  } catch (e) {
    const needsReauth = /invalid_grant|revoked|unauthorized|401/i.test(e.message || '');
    await updateAccountSync(account.id, {
      status: needsReauth ? 'needs_reauth' : 'active',
      last_error: e.message,
    });
    return { ok: false, error: e.message, stats };
  }
}

async function handleGmailCallback(code, payload) {
  const client = getGmailOAuth2Client();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    const existing = await getAccountByUserAndCompany(payload.userId, payload.companyId);
    if (!existing?.refresh_token || existing.provider !== 'gmail') {
      throw new Error(
        'Google did not return a refresh token. Remove app access at myaccount.google.com/permissions and Connect again.',
      );
    }
    tokens.refresh_token = decryptToken(existing.refresh_token);
  }
  client.setCredentials(tokens);
  const gmail = google.gmail({ version: 'v1', auth: client });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const email = profile.data.emailAddress;
  const syncCursor = profile.data.historyId ? String(profile.data.historyId) : null;

  const account = await upsertMailboxAccount({
    userId: payload.userId,
    companyId: payload.companyId,
    provider: 'gmail',
    email,
    salesPersonName: payload.salesPersonName,
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
    syncCursor,
  });

  const syncResult = await syncGmailAccount(account, { forceBackfill: true });
  return {
    email,
    provider: 'gmail',
    companyId: payload.companyId,
    companyName: account.company_name,
    returnUrl: payload.returnUrl,
    syncResult,
  };
}

// ─── Outlook / Microsoft Graph ──────────────────────────────────────

function outlookAuthUrl(state) {
  if (!isOutlookConfigured()) {
    throw new Error('Outlook OAuth not configured (MICROSOFT_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI)');
  }
  const tenant = microsoftTenant();
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_OAUTH_CLIENT_ID,
    response_type: 'code',
    redirect_uri: process.env.MICROSOFT_OAUTH_REDIRECT_URI,
    response_mode: 'query',
    scope: OUTLOOK_SCOPES.join(' '),
    state,
    // force account picker + consent so we get refresh_token
    prompt: 'select_account',
  });
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params}`;
}

async function outlookTokenRequest(body) {
  const tenant = microsoftTenant();
  const res = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error_description || data.error || `Microsoft token error ${res.status}`);
  }
  return data;
}

async function outlookExchangeCode(code) {
  return outlookTokenRequest({
    client_id: process.env.MICROSOFT_OAUTH_CLIENT_ID,
    client_secret: process.env.MICROSOFT_OAUTH_CLIENT_SECRET,
    code,
    redirect_uri: process.env.MICROSOFT_OAUTH_REDIRECT_URI,
    grant_type: 'authorization_code',
    scope: OUTLOOK_SCOPES.join(' '),
  });
}

async function outlookRefresh(refreshToken) {
  return outlookTokenRequest({
    client_id: process.env.MICROSOFT_OAUTH_CLIENT_ID,
    client_secret: process.env.MICROSOFT_OAUTH_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: OUTLOOK_SCOPES.join(' '),
  });
}

async function outlookAccessToken(account) {
  let access = account.access_token ? decryptToken(account.access_token) : null;
  const expiry = account.token_expiry ? new Date(account.token_expiry).getTime() : 0;
  if (access && expiry > Date.now() + 60_000) return access;

  const refresh = decryptToken(account.refresh_token);
  const tokens = await outlookRefresh(refresh);
  access = tokens.access_token;
  const patch = {
    access_token: encryptToken(tokens.access_token),
    last_error: null,
  };
  if (tokens.refresh_token) patch.refresh_token = encryptToken(tokens.refresh_token);
  if (tokens.expires_in) {
    patch.token_expiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  }
  await updateAccountSync(account.id, patch);
  return access;
}

async function graphGet(accessToken, url) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'odata.maxpagesize=50',
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || `Graph ${res.status}`);
    err.status = res.status;
    err.code = data.error?.code;
    throw err;
  }
  return data;
}

function graphRecipients(list) {
  const out = [];
  for (const r of list || []) {
    const e = normaliseEmail(r?.emailAddress?.address);
    if (!e) continue;
    let name = (r?.emailAddress?.name || '').trim() || null;
    if (name) {
      const n = name.toLowerCase();
      if (n === e || n === e.split('@')[0]) name = null;
    }
    out.push({ email: e, name });
  }
  return out;
}

async function syncOutlookAccount(account, { forceBackfill = false } = {}) {
  const stats = { logged: 0, deduped: 0, unmatched: 0, skippedNoise: 0, errors: [] };
  if (!isOutlookConfigured()) {
    return { ok: false, error: 'outlook_oauth_not_configured', stats };
  }

  let accessToken;
  try {
    accessToken = await outlookAccessToken(account);
  } catch (e) {
    await updateAccountSync(account.id, { status: 'needs_reauth', last_error: e.message });
    return { ok: false, error: e.message, stats };
  }

  const teamEmails = new Set(
    (await listActiveAccounts()).map(a => normaliseEmail(a.email)).filter(Boolean),
  );

  try {
    const messages = []; // { id, subject, to, cc, sentDateTime }
    let newCursor = account.sync_cursor;

    // Prefer delta link when we have one (incremental).
    if (account.sync_cursor && account.sync_cursor.includes('/delta') && !forceBackfill) {
      try {
        let url = account.sync_cursor;
        while (url) {
          const page = await graphGet(accessToken, url);
          for (const m of page.value || []) {
            // Delta may include removals (@removed) — skip those
            if (m['@removed'] || !m.id) continue;
            messages.push(m);
          }
          if (page['@odata.deltaLink']) {
            newCursor = page['@odata.deltaLink'];
            url = null;
          } else {
            url = page['@odata.nextLink'] || null;
          }
        }
      } catch (e) {
        // Delta expired / bad — fall back to windowed list
        if (e.status !== 410 && e.status !== 404) throw e;
        console.warn(`[mailbox/outlook] delta expired for ${account.email}, backfilling`);
        forceBackfill = true;
      }
    } else {
      forceBackfill = true;
    }

    if (forceBackfill || !account.sync_cursor) {
      const after = new Date();
      after.setDate(after.getDate() - BACKFILL_DAYS);
      const filter = `sentDateTime ge ${after.toISOString()}`;
      let url =
        'https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages' +
        `?$select=id,subject,toRecipients,ccRecipients,sentDateTime` +
        `&$filter=${encodeURIComponent(filter)}` +
        `&$orderby=sentDateTime desc` +
        `&$top=50`;

      while (url) {
        const page = await graphGet(accessToken, url);
        for (const m of page.value || []) messages.push(m);
        url = page['@odata.nextLink'] || null;
      }

      // Seed a delta link for next incremental sync
      try {
        const deltaStart = await graphGet(
          accessToken,
          'https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages/delta' +
            '?$select=id,subject,toRecipients,ccRecipients,sentDateTime',
        );
        // Drain to get deltaLink without re-processing (we already listed)
        let dUrl = deltaStart['@odata.nextLink'];
        let dLink = deltaStart['@odata.deltaLink'];
        while (dUrl) {
          const page = await graphGet(accessToken, dUrl);
          dLink = page['@odata.deltaLink'] || dLink;
          dUrl = page['@odata.nextLink'] || null;
        }
        if (dLink) newCursor = dLink;
      } catch (e) {
        console.warn(`[mailbox/outlook] could not seed delta for ${account.email}:`, e.message);
      }
    }

    // Dedupe by id in case delta + list overlapped
    const seen = new Set();
    for (const m of messages) {
      if (!m.id || seen.has(m.id)) continue;
      seen.add(m.id);
      try {
        const to = graphRecipients(m.toRecipients);
        const cc = graphRecipients(m.ccRecipients);
        await ingestSentMessage(
          account,
          {
            messageId: m.id,
            recipients: [...to, ...cc],
            subject: m.subject || '',
            occurredAt: m.sentDateTime || null,
            extra: { graph: true },
          },
          teamEmails,
          stats,
        );
      } catch (e) {
        stats.errors.push(`${m.id}: ${e.message}`);
        console.error(`[mailbox/outlook] message ${m.id} (${account.email}):`, e.message);
      }
    }

    await updateAccountSync(account.id, {
      sync_cursor: newCursor || account.sync_cursor,
      last_synced_at: new Date().toISOString(),
      last_error: stats.errors.length ? stats.errors.slice(0, 3).join('; ') : null,
      status: 'active',
    });
    return { ok: true, stats, messageCount: seen.size };
  } catch (e) {
    const needsReauth = /invalid_grant|AADSTS|unauthorized|401|expired/i.test(e.message || '');
    await updateAccountSync(account.id, {
      status: needsReauth ? 'needs_reauth' : 'active',
      last_error: e.message,
    });
    return { ok: false, error: e.message, stats };
  }
}

async function handleOutlookCallback(code, payload) {
  const tokens = await outlookExchangeCode(code);
  if (!tokens.refresh_token) {
    const existing = await getAccountByUserAndCompany(payload.userId, payload.companyId);
    if (!existing?.refresh_token || existing.provider !== 'outlook') {
      throw new Error(
        'Microsoft did not return a refresh token. Ensure the app has offline_access and try Connect again.',
      );
    }
    tokens.refresh_token = decryptToken(existing.refresh_token);
  }

  // Profile email
  const meRes = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const me = await meRes.json().catch(() => ({}));
  if (!meRes.ok) {
    throw new Error(me.error?.message || 'Failed to read Microsoft profile');
  }
  const email = normaliseEmail(me.mail || me.userPrincipalName);
  if (!email) throw new Error('Microsoft account has no email address');

  const account = await upsertMailboxAccount({
    userId: payload.userId,
    companyId: payload.companyId,
    provider: 'outlook',
    email,
    salesPersonName: payload.salesPersonName,
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    tokenExpiry: tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null,
    syncCursor: null,
  });

  const syncResult = await syncOutlookAccount(account, { forceBackfill: true });
  return {
    email,
    provider: 'outlook',
    companyId: payload.companyId,
    companyName: account.company_name,
    returnUrl: payload.returnUrl,
    syncResult,
  };
}

// ─── Unified public API ─────────────────────────────────────────────

function buildAuthUrl({ userId, salesPersonName, returnUrl, provider, companyId }) {
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Invalid provider: ${provider}`);
  }
  if (!isProviderConfigured(provider)) {
    throw new Error(`${provider} OAuth is not configured on this server`);
  }
  if (!companyId) throw new Error('companyId required');
  const state = signState({
    userId,
    salesPersonName,
    provider,
    companyId,
    returnUrl:
      returnUrl ||
      `${(process.env.DASHBOARD_URL || '').replace(/\/+$/, '')}/settings/email`,
    exp: Date.now() + STATE_TTL_MS,
  });
  if (provider === 'gmail') return gmailAuthUrl(state);
  return outlookAuthUrl(state);
}

/** Start URL uses dashboard-issued state (already includes provider). */
function authUrlForState(state) {
  const payload = verifyState(state);
  if (!isProviderConfigured(payload.provider)) {
    throw new Error(`${payload.provider} OAuth is not configured on this server`);
  }
  if (payload.provider === 'gmail') return gmailAuthUrl(state);
  return outlookAuthUrl(state);
}

async function handleOAuthCallback(code, state) {
  const payload = verifyState(state);
  if (payload.provider === 'gmail') return handleGmailCallback(code, payload);
  if (payload.provider === 'outlook') return handleOutlookCallback(code, payload);
  throw new Error(`Unknown provider: ${payload.provider}`);
}

async function syncAccount(account, opts = {}) {
  const provider = account.provider || 'gmail';
  if (provider === 'outlook') return syncOutlookAccount(account, opts);
  return syncGmailAccount(account, opts);
}

async function syncAllAccounts(opts = {}) {
  if (!isConfigured()) {
    return { ok: false, error: 'mailbox_oauth_not_configured', accounts: [] };
  }
  if (!db.isEnabled()) {
    return { ok: false, error: 'database_disabled', accounts: [] };
  }
  const accounts = await listActiveAccounts();
  const results = [];
  for (const account of accounts) {
    if (!isProviderConfigured(account.provider || 'gmail')) {
      results.push({
        email: account.email,
        provider: account.provider,
        ok: false,
        error: `${account.provider}_not_configured`,
      });
      continue;
    }
    const r = await syncAccount(account, opts);
    results.push({
      email: account.email,
      provider: account.provider,
      companyId: account.company_id,
      companyName: account.company_name,
      salesPersonName: account.sales_person_name,
      ...r,
    });
    console.log(
      `[mailbox/${account.provider}] ${account.company_name} / ${account.email}: ok=${r.ok} logged=${r.stats?.logged || 0} unmatched=${r.stats?.unmatched || 0} err=${r.error || '-'}`,
    );
  }
  return { ok: true, accounts: results };
}

module.exports = {
  PROVIDERS,
  isConfigured,
  isGmailConfigured,
  isOutlookConfigured,
  isProviderConfigured,
  signState,
  verifyState,
  buildAuthUrl,
  authUrlForState,
  handleOAuthCallback,
  describeOAuthError,
  syncAllAccounts,
  syncAccount,
  listActiveAccounts,
  listAccountsForUser,
  getAccountByUserAndCompany,
  deleteMailboxAccount,
  upsertContactEmail,
  normaliseEmail,
};
