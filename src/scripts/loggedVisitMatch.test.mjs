// node --test src/scripts/loggedVisitMatch.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loggedVisitCoversPending,
  parseAppointmentMs,
} from "../../supabase/functions/ingest/core.mjs";

test("naive form time vs GHL UTC ISO still matches (TZ skew)", () => {
  const activity = {
    contact_id: "abc",
    contact_name: "Jane Solar",
    appointment_at: "2026-09-20T13:30:00",
    occurred_on: "2026-09-20",
  };
  const pending = {
    contact_id: "abc",
    contact_name: "Jane Solar",
    appointment_at: "2026-09-20T05:30:00.000Z", // 13:30 AWST
  };
  assert.equal(loggedVisitCoversPending(activity, pending), true);
});

test("GHL-only booking with no activity is not covered", () => {
  assert.equal(loggedVisitCoversPending(null, { contact_id: "abc" }), false);
});

test("different contact is not covered", () => {
  const activity = { contact_id: "aaa", occurred_on: "2026-09-20", appointment_at: "2026-09-20T13:30:00" };
  const pending = { contact_id: "bbb", appointment_at: "2026-09-20T13:30:00" };
  assert.equal(loggedVisitCoversPending(activity, pending), false);
});

test("same contact, visit a week later is a new booking", () => {
  const activity = {
    contact_id: "abc",
    appointment_at: "2026-09-20T13:30:00",
    occurred_on: "2026-09-20",
  };
  const pending = { contact_id: "abc", appointment_at: "2026-09-27T13:30:00.000Z" };
  assert.equal(loggedVisitCoversPending(activity, pending), false);
});

test("name fallback when ids missing", () => {
  const activity = {
    contact_name: "Jane Solar",
    occurred_on: "2026-09-20",
    appointment_at: "2026-09-20T10:00:00",
  };
  const pending = { contact_name: "jane solar", appointment_at: "2026-09-20T10:00:00" };
  assert.equal(loggedVisitCoversPending(activity, pending), true);
});

test("occurred_on covers a pending when activity has no appointment time", () => {
  const activity = { contact_id: "abc", occurred_on: "2026-09-20" };
  const pending = { contact_id: "abc", appointment_at: "2026-09-20T05:30:00.000Z" };
  assert.equal(loggedVisitCoversPending(activity, pending), true);
});

test("parseAppointmentMs accepts datetime-local", () => {
  assert.equal(parseAppointmentMs("2026-09-20T13:30"), Date.parse("2026-09-20T13:30:00Z"));
});
