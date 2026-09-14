// Shared "is this GHL calendar booking already logged?" matcher.
//
// Two booking paths exist:
//   1. EOD popup "Book Site Visit" (optionally creating the GHL appointment
//      via Quotie) — writes a site_visit_booked activity, Slack, Quotie.
//   2. Appointment created in GHL first — calendar webhook opens the
//      "Log site visit" pending banner until someone fills it.
//
// Path 1 creates the GHL appointment AFTER the activity is written, so the
// calendar webhook arrives late and would reopen the banner (double work)
// unless we treat a matching site_visit_booked row as covering it.
// Path 2 has no matching activity yet, so the banner still appears.

export const LOGGED_VISIT_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
/** TZ / naive-vs-ISO skew still counts as the same visit. */
export const APPOINTMENT_MATCH_MS = 48 * 60 * 60 * 1000;
/** Pre-resolve only: pending created this recently, times unparseable. */
export const FRESH_PENDING_MS = 2 * 60 * 60 * 1000;

export type VisitContactRef = {
  contactId?: string | null;
  contact_id?: string | null;
  contactName?: string | null;
  contact_name?: string | null;
};

export type LoggedVisitRef = VisitContactRef & {
  appointmentAt?: string | null;
  appointment_at?: string | null;
  occurredOn?: string | null;
  occurred_on?: string | null;
};

export type PendingVisitRef = VisitContactRef & {
  appointmentAt?: string | null;
  appointment_at?: string | null;
  appointmentRaw?: string | null;
  appointment_raw?: string | null;
  createdAt?: string | null;
  created_at?: string | null;
  bookedOn?: string | null;
  booked_on?: string | null;
};

export function parseAppointmentMs(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  const s = String(value).trim();
  if (!s) return null;
  const naive = s.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})(?::(\d{2}))?$/);
  if (naive) {
    const t = Date.parse(`${naive[1]}T${naive[2]}:${naive[3] || "00"}Z`);
    return Number.isFinite(t) ? t : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function isoDateUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function contactIdOf(row: VisitContactRef): string {
  return String(row.contactId || row.contact_id || "").trim();
}

function contactNameOf(row: VisitContactRef): string {
  return String(row.contactName || row.contact_name || "").trim().toLowerCase();
}

export function sameSiteVisitContact(a: VisitContactRef, b: VisitContactRef): boolean {
  const idA = contactIdOf(a);
  const idB = contactIdOf(b);
  if (idA && idB) return idA === idB;
  const nA = contactNameOf(a);
  const nB = contactNameOf(b);
  return !!(nA && nB && nA === nB);
}

function occurredOnOf(row: LoggedVisitRef): string {
  return String(row.occurredOn || row.occurred_on || "").slice(0, 10);
}

function pendingAppointmentMs(pending: PendingVisitRef): number | null {
  return (
    parseAppointmentMs(pending.appointmentAt ?? pending.appointment_at) ??
    parseAppointmentMs(pending.appointmentRaw ?? pending.appointment_raw)
  );
}

/**
 * True when `activity` (a site_visit_booked row) is the same physical booking
 * as `pending` (a GHL calendar webhook / pending_site_visits row).
 */
export function loggedVisitCoversPending(
  activity: LoggedVisitRef,
  pending: PendingVisitRef,
): boolean {
  if (!activity || !pending) return false;
  if (!sameSiteVisitContact(activity, pending)) return false;

  const actAt = parseAppointmentMs(activity.appointmentAt ?? activity.appointment_at);
  const pendAt = pendingAppointmentMs(pending);
  const occurredOn = occurredOnOf(activity);

  if (actAt != null && pendAt != null) {
    if (Math.abs(actAt - pendAt) <= APPOINTMENT_MATCH_MS) return true;
    if (isoDateUtc(actAt) === isoDateUtc(pendAt)) return true;
    return false;
  }
  if (occurredOn && pendAt != null) return occurredOn === isoDateUtc(pendAt);
  if (actAt == null && pendAt == null) return true;
  return false;
}

/**
 * EOD-3 pre-resolve: same as loggedVisitCoversPending, plus a short race
 * window so a GHL webhook that lands mid-submit still gets closed even when
 * appointment strings don't parse.
 */
export function pendingMatchesBooking(
  pending: PendingVisitRef,
  booking: LoggedVisitRef,
  nowMs: number = Date.now(),
): boolean {
  if (loggedVisitCoversPending(booking, pending)) return true;
  if (!sameSiteVisitContact(booking, pending)) return false;
  const created = parseAppointmentMs(pending.createdAt ?? pending.created_at);
  return created != null && nowMs - created <= FRESH_PENDING_MS;
}
