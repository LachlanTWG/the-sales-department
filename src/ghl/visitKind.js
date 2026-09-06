/**
 * Detect Virtual Site Visit from a GHL calendar webhook body.
 * Match is the word "virtual" in the calendar name or appointment title
 * (case-insensitive). Everything else is in-person.
 */

function collectVisitLabels(body) {
  if (!body || typeof body !== 'object') return [];
  const cal = body.calendar && typeof body.calendar === 'object' ? body.calendar : {};
  const appt = body.appointment && typeof body.appointment === 'object' ? body.appointment : {};
  const custom = body.customData && typeof body.customData === 'object' ? body.customData : {};
  return [
    cal.name, cal.title, cal.calendarName, cal.calendar_name, cal.calendarTitle,
    appt.title, appt.name, appt.calendarName, appt.calendar_name,
    body.title, body.calendarName, body.calendar_name,
    body.appointmentTitle, body.appointment_title, body.appointmentName,
    custom.calendar_name, custom.calendarName, custom.title, custom.appointment_title,
  ].map(v => String(v || '').trim()).filter(Boolean);
}

function isVirtualVisitPayload(body) {
  return collectVisitLabels(body).some(s => /virtual/i.test(s));
}

function visitKindFromPayload(body) {
  return isVirtualVisitPayload(body) ? 'virtual' : 'in_person';
}

function isVirtualVisitKind(kind) {
  return String(kind || '').toLowerCase() === 'virtual';
}

module.exports = {
  collectVisitLabels,
  isVirtualVisitPayload,
  visitKindFromPayload,
  isVirtualVisitKind,
};
