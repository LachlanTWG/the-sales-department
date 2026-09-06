/**
 * Detect Virtual Site Visit from a GHL calendar webhook body / pending
 * raw_payload. Match is the word "virtual" in the calendar name or
 * appointment title (case-insensitive). Everything else is in-person.
 */

export type VisitKind = "in_person" | "virtual";

function collectVisitLabels(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const b = body as Record<string, unknown>;
  const cal = (b.calendar && typeof b.calendar === "object" ? b.calendar : {}) as Record<string, unknown>;
  const appt = (b.appointment && typeof b.appointment === "object" ? b.appointment : {}) as Record<string, unknown>;
  const custom = (b.customData && typeof b.customData === "object" ? b.customData : {}) as Record<string, unknown>;
  return [
    cal.name, cal.title, cal.calendarName, cal.calendar_name, cal.calendarTitle,
    appt.title, appt.name, appt.calendarName, appt.calendar_name,
    b.title, b.calendarName, b.calendar_name,
    b.appointmentTitle, b.appointment_title, b.appointmentName,
    custom.calendar_name, custom.calendarName, custom.title, custom.appointment_title,
  ].map(v => String(v || "").trim()).filter(Boolean);
}

export function isVirtualVisitPayload(body: unknown): boolean {
  return collectVisitLabels(body).some(s => /virtual/i.test(s));
}

export function visitKindFromPayload(body: unknown): VisitKind {
  return isVirtualVisitPayload(body) ? "virtual" : "in_person";
}

export function isVirtualVisitKind(kind: string | null | undefined): boolean {
  return String(kind || "").toLowerCase() === "virtual";
}

export function virtualTag(virtual: boolean | undefined): string {
  return virtual ? " (virtual)" : "";
}

export function siteVisitsHeader(baseName: string, visits: { virtual?: boolean }[]): string {
  const n = visits.length;
  const v = visits.filter(s => s.virtual).length;
  if (n === 0 || v === 0) return baseName;
  return `${baseName} — ${n} (${v} virtual)`;
}
