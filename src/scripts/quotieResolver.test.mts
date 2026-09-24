// node --experimental-strip-types --test src/scripts/quotieResolver.test.mts
//
// Pins the pure Quotie resolvers the EOD popup and submitEodEntry both depend
// on: which lane a stage selects, which endpoint + outcome an EOD 3 / EOD 2
// selection resolves to in that lane, what the browser is allowed to see, and
// — since the two-checkbox popup — which single follow-up call a submit makes
// and whether the exec's date rides along with it.
//
// These are the rules nothing else guards: the lane-separation rule (a contact
// with a live quote must never enter the callback cadence), the "never a second
// Quotie call" rule, and the date-merge table. Everything here is pure, so no
// network, no Quotie, no GHL.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_POST_QUOTE_STAGES,
  followUpDateToSend,
  resolveAnsweredCallback,
  resolveAnsweredForLane,
  resolveFollowUpPlan,
  resolveLane,
  resolveQuotieAction,
  resolveQuotieActionForLane,
  safeQuotieClientConfig,
  type QuotieConfig,
} from "../../dashboard/src/app/eod-entry/quotie.ts";

/** Minimum viable config: an api_key is what switches the integration on. */
const CFG: QuotieConfig = {
  api_url: "https://example.supabase.co/functions/v1",
  api_key: "qk_test",
  user_map: { Lachlan: "auth-1" },
};
const OFF: QuotieConfig = { api_url: "https://example.supabase.co/functions/v1" };

const TOMORROW = "2026-09-23";

// ── resolveLane ────────────────────────────────────────────────────────

test("resolveLane: the default post-quote stage selects the post lane", () => {
  assert.equal(resolveLane("Post Quote Follow Up", CFG), "post_quote");
  assert.equal(DEFAULT_POST_QUOTE_STAGES.includes("Post Quote Follow Up"), true);
});

test("resolveLane: every other stage is pre-quote", () => {
  assert.equal(resolveLane("New Leads", CFG), "pre_quote");
  assert.equal(resolveLane("Pre-Quote Follow Up", CFG), "pre_quote");
  assert.equal(resolveLane("", CFG), "pre_quote");
  assert.equal(resolveLane("  ", CFG), "pre_quote");
});

test("resolveLane: stages are trimmed, not fuzzy-matched", () => {
  assert.equal(resolveLane("  Post Quote Follow Up  ", CFG), "post_quote");
  assert.equal(resolveLane("post quote follow up", CFG), "pre_quote");
});

test("resolveLane: post_quote_stages overrides the default list", () => {
  const cfg = { ...CFG, post_quote_stages: ["Chasing Quote"] };
  assert.equal(resolveLane("Chasing Quote", cfg), "post_quote");
  assert.equal(resolveLane("Post Quote Follow Up", cfg), "pre_quote");
});

test("resolveLane: an empty post_quote_stages disables the post lane entirely", () => {
  assert.equal(resolveLane("Post Quote Follow Up", { ...CFG, post_quote_stages: [] }), "pre_quote");
});

test("resolveLane: works without a config (integration off still needs a lane)", () => {
  assert.equal(resolveLane("Post Quote Follow Up", null), "post_quote");
  assert.equal(resolveLane("New Leads", undefined), "pre_quote");
});

// ── resolveQuotieAction (pre-quote defaults) ───────────────────────────

test("resolveQuotieAction: no api_key means the integration is off", () => {
  assert.equal(resolveQuotieAction("Requires Quoting", OFF), null);
  assert.equal(resolveQuotieAction("Requires Quoting", null), null);
});

test("resolveQuotieAction: unknown and blank outcomes resolve to nothing", () => {
  assert.equal(resolveQuotieAction("Something Lockie Typed", CFG), null);
  assert.equal(resolveQuotieAction("", CFG), null);
});

test("resolveQuotieAction: pipeline defaults", () => {
  assert.deepEqual(resolveQuotieAction("Requires Quoting", CFG), {
    type: "callback",
    outcome: "requires_quoting",
  });
  assert.deepEqual(resolveQuotieAction("Not a Good Time to Talk", CFG), {
    type: "callback",
    outcome: "callback_requested",
  });
  assert.deepEqual(resolveQuotieAction("Not Ready Yet - Pre-Quote", CFG), {
    type: "callback",
    outcome: "callback_requested",
  });
  assert.deepEqual(resolveQuotieAction("Book Site Visit", CFG), { type: "site_visit" });
});

test("resolveQuotieAction: every DQ / Lost / Abandoned outcome closes the lead", () => {
  for (const outcome of [
    "Lost - Price",
    "Lost - Time Related",
    "Lost - Priorities Changed",
    "DQ - Incorrect Details",
    "DQ - Wrong Contact / Spam",
    "DQ - Out of Service Area",
    "DQ - Extent of Works",
    "DQ - Price",
    "DQ - Lead Looking for Work",
    "DQ - Recommended Another Company",
    "DQ - Trying to Sell Me Something",
    "DQ - Not Proceeding",
    "Abandoned - Not Responding",
    "Abandoned - Headache",
  ]) {
    assert.deepEqual(
      resolveQuotieAction(outcome, CFG),
      { type: "callback", outcome: "lost" },
      outcome,
    );
  }
});

test("resolveQuotieAction: Waiting on Photos keeps its task template", () => {
  assert.deepEqual(resolveQuotieAction("Waiting on Photos", CFG), {
    type: "task",
    titleTemplate: "Chase photos from {contact}",
  });
});

test("resolveQuotieAction: an override merges field-by-field over the default", () => {
  const cfg = { ...CFG, actions: { "Waiting on Photos": { type: "task" as const, assign_to: "auth-9" } } };
  assert.deepEqual(resolveQuotieAction("Waiting on Photos", cfg), {
    type: "task",
    titleTemplate: "Chase photos from {contact}",
    assign_to: "auth-9",
  });
});

test("resolveQuotieAction: an explicit null disables the outcome", () => {
  assert.equal(resolveQuotieAction("Requires Quoting", { ...CFG, actions: { "Requires Quoting": null } }), null);
});

test("resolveQuotieAction: an override can add an outcome with no default", () => {
  const cfg = { ...CFG, actions: { "Sent Brochure": { type: "task" as const } } };
  assert.deepEqual(resolveQuotieAction("Sent Brochure", cfg), { type: "task" });
});

// ── resolveQuotieActionForLane (post-quote lane + lane separation) ─────

test("resolveQuotieActionForLane: the pre lane is the pre-quote map verbatim", () => {
  assert.deepEqual(resolveQuotieActionForLane("Requires Quoting", "pre_quote", CFG), {
    type: "callback",
    outcome: "requires_quoting",
  });
  assert.deepEqual(resolveQuotieActionForLane("Lost - Price", "pre_quote", CFG), {
    type: "callback",
    outcome: "lost",
  });
});

test("resolveQuotieActionForLane: post-quote 'not ready' / 'bad time' reschedule", () => {
  assert.deepEqual(resolveQuotieActionForLane("Not Ready Yet - Post Quote", "post_quote", CFG), {
    type: "follow_up",
    outcome: "reschedule",
  });
  assert.deepEqual(resolveQuotieActionForLane("Not a Good Time to Talk", "post_quote", CFG), {
    type: "follow_up",
    outcome: "reschedule",
  });
});

test("resolveQuotieActionForLane: verbal confirmation flags the quote", () => {
  assert.deepEqual(resolveQuotieActionForLane("Verbal Confirmation", "post_quote", CFG), {
    type: "follow_up",
    outcome: "verbal_yes",
  });
  // No pre-quote equivalent — the callback cadence has no verbal-yes column.
  assert.equal(resolveQuotieActionForLane("Verbal Confirmation", "pre_quote", CFG), null);
});

test("resolveQuotieActionForLane: post-quote Lost closes the quote, Abandoned keeps its own outcome", () => {
  assert.deepEqual(resolveQuotieActionForLane("DQ - Price", "post_quote", CFG), {
    type: "follow_up",
    outcome: "lost",
  });
  assert.deepEqual(resolveQuotieActionForLane("Abandoned - Headache", "post_quote", CFG), {
    type: "follow_up",
    outcome: "abandoned",
  });
  // …unlike the pre lane, which folds abandoned into lost.
  assert.deepEqual(resolveQuotieActionForLane("Abandoned - Headache", "pre_quote", CFG), {
    type: "callback",
    outcome: "lost",
  });
});

test("resolveQuotieActionForLane: lane-neutral actions fall through to the post lane", () => {
  assert.deepEqual(resolveQuotieActionForLane("Book Site Visit", "post_quote", CFG), { type: "site_visit" });
  assert.deepEqual(resolveQuotieActionForLane("Waiting on Photos", "post_quote", CFG), {
    type: "task",
    titleTemplate: "Chase photos from {contact}",
  });
  // A post-quote contact who needs a NEW quote legitimately re-enters the
  // Requires Quoting column.
  assert.deepEqual(resolveQuotieActionForLane("Requires Quoting", "post_quote", CFG), {
    type: "callback",
    outcome: "requires_quoting",
  });
});

test("resolveQuotieActionForLane: LANE SEPARATION — no pre-quote callback cadence after a quote", () => {
  // "Not Ready Yet - Pre-Quote" is callback_requested in the pre lane and must
  // NOT leak into the post lane, where it would fork a parallel callback lead.
  assert.equal(resolveQuotieActionForLane("Not Ready Yet - Pre-Quote", "post_quote", CFG), null);
});

test("resolveQuotieActionForLane: post_quote_actions override / disable per lane", () => {
  const cfg = {
    ...CFG,
    post_quote_actions: {
      "Verbal Confirmation": { type: "follow_up" as const, outcome: "hot" },
      "Abandoned - Headache": null,
    },
  };
  assert.deepEqual(resolveQuotieActionForLane("Verbal Confirmation", "post_quote", cfg), {
    type: "follow_up",
    outcome: "hot",
  });
  assert.equal(resolveQuotieActionForLane("Abandoned - Headache", "post_quote", cfg), null);
  // The pre lane is untouched by post_quote_actions.
  assert.deepEqual(resolveQuotieActionForLane("Abandoned - Headache", "pre_quote", cfg), {
    type: "callback",
    outcome: "lost",
  });
});

test("resolveQuotieActionForLane: no api_key resolves to nothing in either lane", () => {
  assert.equal(resolveQuotieActionForLane("Requires Quoting", "pre_quote", OFF), null);
  assert.equal(resolveQuotieActionForLane("Not a Good Time to Talk", "post_quote", OFF), null);
});

// ── EOD 2 (Answered?) signals ──────────────────────────────────────────

test("resolveAnsweredCallback: the no-answer family, and nothing else", () => {
  assert.equal(resolveAnsweredCallback("Didn't Answer", CFG), "no_answer");
  assert.equal(resolveAnsweredCallback("No Answer", CFG), "no_answer");
  assert.equal(resolveAnsweredCallback("Voicemail", CFG), "voicemail");
  assert.equal(resolveAnsweredCallback("Left Voicemail", CFG), "voicemail");
  assert.equal(resolveAnsweredCallback("Answered", CFG), null);
  assert.equal(resolveAnsweredCallback("", CFG), null);
  assert.equal(resolveAnsweredCallback("Didn't Answer", OFF), null);
});

test("resolveAnsweredForLane: pre lane keeps voicemail distinct, post lane folds it into no_answer", () => {
  assert.deepEqual(resolveAnsweredForLane("Didn't Answer", "pre_quote", CFG), {
    kind: "callback",
    outcome: "no_answer",
  });
  assert.deepEqual(resolveAnsweredForLane("Voicemail", "pre_quote", CFG), {
    kind: "callback",
    outcome: "voicemail",
  });
  assert.deepEqual(resolveAnsweredForLane("Didn't Answer", "post_quote", CFG), {
    kind: "follow_up",
    outcome: "no_answer",
  });
  // api-follow-ups has no voicemail outcome.
  assert.deepEqual(resolveAnsweredForLane("Voicemail", "post_quote", CFG), {
    kind: "follow_up",
    outcome: "no_answer",
  });
});

test("resolveAnsweredForLane: 'Answered' alone is never a pipeline signal", () => {
  assert.equal(resolveAnsweredForLane("Answered", "pre_quote", CFG), null);
  assert.equal(resolveAnsweredForLane("Answered", "post_quote", CFG), null);
});

test("resolveAnsweredForLane: per-lane overrides, null disables", () => {
  const cfg = {
    ...CFG,
    answered_callbacks: { "Didn't Answer": null },
    answered_follow_ups: { "Didn't Answer": "reschedule" },
  };
  assert.equal(resolveAnsweredForLane("Didn't Answer", "pre_quote", cfg), null);
  assert.deepEqual(resolveAnsweredForLane("Didn't Answer", "post_quote", cfg), {
    kind: "follow_up",
    outcome: "reschedule",
  });
});

// ── safeQuotieClientConfig (what the browser may see) ──────────────────

test("safeQuotieClientConfig: never leaks api_key / api_url / user_map / templates", () => {
  const safe = safeQuotieClientConfig({
    ...CFG,
    actions: { "Waiting on Photos": { type: "task", titleTemplate: "secret {contact}", assign_to: "auth-9" } },
  });
  const json = JSON.stringify(safe);
  assert.equal(json.includes("qk_test"), false);
  assert.equal(json.includes("example.supabase.co"), false);
  assert.equal(json.includes("auth-1"), false);
  assert.equal(json.includes("auth-9"), false);
  assert.equal(json.includes("secret"), false);
  assert.deepEqual(safe.actions.pre_quote["Waiting on Photos"], { type: "task" });
});

test("safeQuotieClientConfig: all-empty when the integration is off", () => {
  const safe = safeQuotieClientConfig(OFF);
  assert.deepEqual(safe.actions, { pre_quote: {}, post_quote: {} });
  assert.deepEqual(safe.answered, { pre_quote: {}, post_quote: {} });
  assert.deepEqual(safe.post_quote_stages, DEFAULT_POST_QUOTE_STAGES);
});

test("safeQuotieClientConfig: carries both lanes' maps + the endpoint outcome", () => {
  const safe = safeQuotieClientConfig(CFG);
  assert.deepEqual(safe.actions.post_quote["Not Ready Yet - Post Quote"], {
    type: "follow_up",
    outcome: "reschedule",
  });
  assert.deepEqual(safe.actions.pre_quote["Requires Quoting"], {
    type: "callback",
    outcome: "requires_quoting",
  });
  // Lane separation survives the projection.
  assert.equal(safe.actions.post_quote["Not Ready Yet - Pre-Quote"], undefined);
  assert.equal(safe.answered.pre_quote["Didn't Answer"], true);
  assert.equal(safe.answered.post_quote["Didn't Answer"], true);
  assert.equal(safe.answered.pre_quote["Answered"], undefined);
});

test("safeQuotieClientConfig: falls back to the default stage list when the override is empty", () => {
  assert.deepEqual(safeQuotieClientConfig({ ...CFG, post_quote_stages: [] }).post_quote_stages, DEFAULT_POST_QUOTE_STAGES);
  assert.deepEqual(safeQuotieClientConfig({ ...CFG, post_quote_stages: ["Chasing Quote"] }).post_quote_stages, ["Chasing Quote"]);
});

// ── resolveFollowUpPlan: ONE call per submit ───────────────────────────

const plan = (over: Partial<Parameters<typeof resolveFollowUpPlan>[0]> = {}) =>
  resolveFollowUpPlan({
    lane: "pre_quote",
    stdOutcome: "",
    answered: "",
    config: CFG,
    followUpRequested: true,
    ...over,
  });

test("plan: nothing at all when the integration is off", () => {
  assert.equal(plan({ config: OFF }), null);
  assert.equal(plan({ config: null }), null);
});

test("plan: an unticked checkbox with no outcome and no answer does nothing", () => {
  assert.equal(plan({ followUpRequested: false }), null);
});

test("plan: UNTICKED means nothing fires — not even an outcome-driven move", () => {
  // The checkbox owns the whole leg. An exec who unticks it on a Lost call
  // must not find the quote closed in Quotie anyway.
  assert.equal(plan({ lane: "post_quote", stdOutcome: "DQ - Price", followUpRequested: false }), null);
  assert.equal(plan({ lane: "pre_quote", stdOutcome: "Lost - Price", followUpRequested: false }), null);
  assert.equal(plan({ lane: "post_quote", stdOutcome: "Abandoned - Headache", followUpRequested: false }), null);
  assert.equal(plan({ lane: "pre_quote", stdOutcome: "Requires Quoting", followUpRequested: false }), null);
  assert.equal(
    plan({ lane: "post_quote", stdOutcome: "Not Ready Yet - Post Quote", followUpRequested: false }),
    null,
  );
});

test("plan: UNTICKED silences the EOD 2 no-answer signal too", () => {
  assert.equal(plan({ lane: "post_quote", answered: "Didn't Answer", followUpRequested: false }), null);
  assert.equal(plan({ lane: "pre_quote", answered: "Didn't Answer", followUpRequested: false }), null);
  assert.equal(plan({ lane: "pre_quote", answered: "Voicemail", followUpRequested: false }), null);
});

test("plan: post-lane plain set → reschedule", () => {
  assert.deepEqual(plan({ lane: "post_quote" }), {
    kind: "follow_up",
    outcome: "reschedule",
    source: "plain",
    acceptsDate: true,
  });
});

test("plan: pre-lane plain set → callback_requested", () => {
  assert.deepEqual(plan({ lane: "pre_quote" }), {
    kind: "callback",
    outcome: "callback_requested",
    source: "plain",
    acceptsDate: true,
  });
});

test("plan: an EOD 3 outcome owns the call and beats the EOD 2 signal", () => {
  // Both would fire on their own; only the EOD 3 move may.
  const p = plan({
    lane: "post_quote",
    stdOutcome: "Not Ready Yet - Post Quote",
    answered: "Didn't Answer",
  });
  assert.deepEqual(p, {
    kind: "follow_up",
    outcome: "reschedule",
    source: "eod3",
    acceptsDate: true,
  });
});

test("plan: EOD 2 no-answer drives the call when EOD 3 maps to nothing", () => {
  assert.deepEqual(plan({ lane: "post_quote", answered: "Didn't Answer" }), {
    kind: "follow_up",
    outcome: "no_answer",
    source: "eod2",
    acceptsDate: true,
  });
  assert.deepEqual(plan({ lane: "pre_quote", answered: "Didn't Answer" }), {
    kind: "callback",
    outcome: "no_answer",
    source: "eod2",
    acceptsDate: true,
  });
  assert.deepEqual(plan({ lane: "pre_quote", answered: "Voicemail" }), {
    kind: "callback",
    outcome: "voicemail",
    source: "eod2",
    acceptsDate: true,
  });
});

test("plan: a ticked box with an EOD 2 answer resolves to eod2, never to plain", () => {
  // The client sends quotie_follow_up (the tick) AND quotie_answered_callback;
  // precedence must still route it through the no-answer cadence.
  assert.equal(plan({ answered: "Didn't Answer" })?.source, "eod2");
  assert.equal(plan({ lane: "post_quote", answered: "Voicemail" })?.source, "eod2");
});

test("plan: a site-visit / task outcome leaves the plain path in charge", () => {
  // Neither maps to a pipeline move, so ticking the box just sets a date — the
  // booking and the task are separate legs.
  assert.equal(plan({ stdOutcome: "Book Site Visit" })?.source, "plain");
  assert.equal(plan({ stdOutcome: "Waiting on Photos" })?.source, "plain");
  assert.equal(plan({ stdOutcome: "Book Site Visit", followUpRequested: false }), null);
});

test("plan: terminal outcomes still fire but refuse a date", () => {
  assert.deepEqual(plan({ lane: "post_quote", stdOutcome: "DQ - Price" }), {
    kind: "follow_up",
    outcome: "lost",
    source: "eod3",
    acceptsDate: false,
    dateSkipReason: "quote closed",
  });
  assert.deepEqual(plan({ lane: "post_quote", stdOutcome: "Abandoned - Headache" }), {
    kind: "follow_up",
    outcome: "abandoned",
    source: "eod3",
    acceptsDate: false,
    dateSkipReason: "quote closed",
  });
  assert.deepEqual(plan({ lane: "pre_quote", stdOutcome: "Lost - Price" }), {
    kind: "callback",
    outcome: "lost",
    source: "eod3",
    acceptsDate: false,
    dateSkipReason: "quote closed",
  });
  assert.deepEqual(plan({ lane: "pre_quote", stdOutcome: "Requires Quoting" }), {
    kind: "callback",
    outcome: "requires_quoting",
    source: "eod3",
    acceptsDate: false,
    dateSkipReason: "requires quoting",
  });
});

test("plan: requires_quoting is terminal-for-dates in the post lane too", () => {
  const p = plan({ lane: "post_quote", stdOutcome: "Requires Quoting" });
  assert.equal(p?.kind, "callback");
  assert.equal(p?.acceptsDate, false);
  assert.equal(p?.dateSkipReason, "requires quoting");
});

test("plan: the EOD 3 action's assignee is carried onto the call", () => {
  const cfg = {
    ...CFG,
    post_quote_actions: { "Verbal Confirmation": { type: "follow_up" as const, outcome: "verbal_yes", assign_to: "auth-7" } },
  };
  assert.equal(plan({ lane: "post_quote", stdOutcome: "Verbal Confirmation", config: cfg })?.assign_to, "auth-7");
  // The EOD 2 path has no action to take an assignee from.
  assert.equal(plan({ lane: "post_quote", answered: "Didn't Answer" })?.assign_to, undefined);
});

test("plan: a disabled outcome falls back to the plain set, not to the pre-quote cadence", () => {
  const cfg = { ...CFG, post_quote_actions: { "Not Ready Yet - Post Quote": null } };
  assert.deepEqual(plan({ lane: "post_quote", stdOutcome: "Not Ready Yet - Post Quote", config: cfg }), {
    kind: "follow_up",
    outcome: "reschedule",
    source: "plain",
    acceptsDate: true,
  });
});

// ── followUpDateToSend: the merge table ────────────────────────────────

test("date: reschedule + explicit date → the exec's date is merged in", () => {
  const p = plan({ lane: "post_quote", stdOutcome: "Not Ready Yet - Post Quote" })!;
  assert.equal(followUpDateToSend(p, "2026-10-01", TOMORROW), "2026-10-01");
});

test("date: reschedule with no date → tomorrow (a reschedule must say when)", () => {
  const p = plan({ lane: "post_quote", stdOutcome: "Not Ready Yet - Post Quote" })!;
  assert.equal(followUpDateToSend(p, "", TOMORROW), TOMORROW);
});

test("date: lost / abandoned / requires_quoting + date → date NOT applied", () => {
  for (const outcome of ["DQ - Price", "Abandoned - Headache"]) {
    const p = plan({ lane: "post_quote", stdOutcome: outcome })!;
    assert.equal(followUpDateToSend(p, "2026-10-01", TOMORROW), "", outcome);
  }
  const rq = plan({ lane: "pre_quote", stdOutcome: "Requires Quoting" })!;
  assert.equal(followUpDateToSend(rq, "2026-10-01", TOMORROW), "");
  const lost = plan({ lane: "pre_quote", stdOutcome: "Lost - Price" })!;
  assert.equal(followUpDateToSend(lost, "2026-10-01", TOMORROW), "");
});

test("date: EOD 2 no-answer + explicit date → the date is merged (it replaces the auto bump)", () => {
  const post = plan({ lane: "post_quote", answered: "Didn't Answer" })!;
  assert.equal(followUpDateToSend(post, "2026-10-01", TOMORROW), "2026-10-01");
  const pre = plan({ lane: "pre_quote", answered: "Didn't Answer" })!;
  assert.equal(followUpDateToSend(pre, "2026-10-01", TOMORROW), "2026-10-01");
  const vm = plan({ lane: "pre_quote", answered: "Voicemail" })!;
  assert.equal(followUpDateToSend(vm, "2026-10-01", TOMORROW), "2026-10-01");
});

test("date: EOD 2 no-answer with NO date → none sent, Quotie keeps its own cadence", () => {
  const post = plan({ lane: "post_quote", answered: "Didn't Answer" })!;
  assert.equal(followUpDateToSend(post, "", TOMORROW), "");
  const pre = plan({ lane: "pre_quote", answered: "Didn't Answer" })!;
  assert.equal(followUpDateToSend(pre, "", TOMORROW), "");
});

test("date: verbal yes / hot take an optional date and never default one", () => {
  const vy = plan({ lane: "post_quote", stdOutcome: "Verbal Confirmation" })!;
  assert.equal(followUpDateToSend(vy, "2026-10-01", TOMORROW), "2026-10-01");
  assert.equal(followUpDateToSend(vy, "", TOMORROW), "");
  const hotCfg = {
    ...CFG,
    post_quote_actions: { "Verbal Confirmation": { type: "follow_up" as const, outcome: "hot" } },
  };
  const hot = plan({ lane: "post_quote", stdOutcome: "Verbal Confirmation", config: hotCfg })!;
  assert.equal(followUpDateToSend(hot, "", TOMORROW), "");
});

test("date: a plain set always lands a date, in both lanes", () => {
  const post = plan({ lane: "post_quote" })!;
  assert.equal(followUpDateToSend(post, "", TOMORROW), TOMORROW);
  assert.equal(followUpDateToSend(post, "2026-10-01", TOMORROW), "2026-10-01");
  const pre = plan({ lane: "pre_quote" })!;
  assert.equal(followUpDateToSend(pre, "", TOMORROW), TOMORROW);
  assert.equal(followUpDateToSend(pre, "2026-10-01", TOMORROW), "2026-10-01");
});
