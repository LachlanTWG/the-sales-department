// Server-only helpers for pushing EOD outcomes into a client's Quotie
// instance via its REST API. NOT a client module — only imported by
// page.tsx (for the safe outcome->type projection passed to the form) and
// actions.ts (for the actual authenticated API calls). The api_key, api_url
// and user_map live in companies.quotie_config and must never reach the
// browser: safeQuotieClientConfig() is the only projection the client ever sees.
//
// Two strictly separated lanes:
//   pre_quote  → api-callbacks  (Quotie's callback_leads pipeline: Day N /
//                Parked / Requires Quoting / Lost)
//   post_quote → api-follow-ups (Quotie's quote follow-up cadence on a SENT
//                quote group: reschedule / no_answer / verbal_yes / hot /
//                lost / abandoned)
// The lane is picked from the EOD 1 stage (post_quote_stages) and the exec can
// flip it with the form toggle. A post-quote call for a contact with no sent
// quote comes back 404 reason="no_quote_group" — the banner tells the exec to
// switch to Pre-quote rather than silently doing nothing.

export type QuotieActionType = "task" | "site_visit" | "callback" | "follow_up";

/** Which Quotie pipeline an EOD log drives. */
export type QuotieLane = "pre_quote" | "post_quote";

/** Stripped team-member shape sent to the browser — never includes quotie_auth_id. */
export type QuotieTeamMember = { id: string; name: string | null; is_primary: boolean };

export type QuotieAction = {
  type: QuotieActionType;
  /** Task title template, {contact} is substituted server-side. */
  titleTemplate?: string;
  /** Quotie users.auth_id override for this specific action. */
  assign_to?: string;
  /**
   * Endpoint outcome for the action. For `callback` it is an api-callbacks
   * outcome (requires_quoting | callback_requested | no_answer | voicemail |
   * lost …). For `follow_up` it is an api-follow-ups outcome
   * (reschedule | no_answer | verbal_yes | hot | lost | abandoned).
   */
  outcome?: string;
};

export type QuotieConfig = {
  api_url?: string;
  api_key?: string;
  /** Roster name → Quotie users.auth_id. */
  user_map?: Record<string, string>;
  /** PRE-quote lane: EOD 3 outcome → action, or null to disable the default. */
  actions?: Record<string, QuotieAction | null>;
  /** PRE-quote lane: EOD 2 (Answered?) selection → api-callbacks outcome, or null to disable. */
  answered_callbacks?: Record<string, string | null>;
  /** POST-quote lane: EOD 3 outcome → action, or null to disable the default. */
  post_quote_actions?: Record<string, QuotieAction | null>;
  /** POST-quote lane: EOD 2 (Answered?) selection → api-follow-ups outcome, or null to disable. */
  answered_follow_ups?: Record<string, string | null>;
  /** EOD 1 stage values that select the post-quote lane. Default ["Post Quote Follow Up"]. */
  post_quote_stages?: string[];
};

/**
 * EOD 1 stages that mean "this contact already has a quote out" — the exact
 * DEFAULT_STAGES[2] string from data.ts (the GHL pipeline workflows branch on
 * string equality against it, so it must stay verbatim).
 */
export const DEFAULT_POST_QUOTE_STAGES: string[] = ["Post Quote Follow Up"];

/**
 * Sensible defaults so a client with an api_key but no explicit `actions`
 * map still gets useful behaviour. A per-client `actions` entry overrides
 * the default for that outcome; an explicit null disables it.
 */
export const DEFAULT_QUOTIE_ACTIONS: Record<string, QuotieAction> = {
  "Book Site Visit": { type: "site_visit" },
  // Requires Quoting now drops the lead into Quotie's Requires Quoting pipeline
  // column (with a Create Quote button on the card) instead of a task — the
  // pipeline card supersedes the "Prepare quote for {contact}" task.
  "Requires Quoting": { type: "callback", outcome: "requires_quoting" },
  "Waiting on Photos": { type: "task", titleTemplate: "Chase photos from {contact}" },
  // Not a Good Time now Parks the lead in Quotie (callback_requested) instead of
  // a task — supersedes the "Call back {contact}" task.
  "Not a Good Time to Talk": { type: "callback", outcome: "callback_requested" },
  // Pre-quote "not ready" = park the lead for a later call-back, same column as
  // Not a Good Time. (Its post-quote twin lives in the post-quote map below.)
  "Not Ready Yet - Pre-Quote": { type: "callback", outcome: "callback_requested" },
  // DQ / Lost terminal outcomes → Quotie's Lost column. lost-with-no-lead is a
  // graceful no-op on Quotie's side (see actions.ts noop handling).
  "Lost - Price": { type: "callback", outcome: "lost" },
  "Lost - Time Related": { type: "callback", outcome: "lost" },
  "Lost - Priorities Changed": { type: "callback", outcome: "lost" },
  "DQ - Incorrect Details": { type: "callback", outcome: "lost" },
  "DQ - Wrong Contact / Spam": { type: "callback", outcome: "lost" },
  "DQ - Out of Service Area": { type: "callback", outcome: "lost" },
  "DQ - Extent of Works": { type: "callback", outcome: "lost" },
  "DQ - Price": { type: "callback", outcome: "lost" },
  "DQ - Lead Looking for Work": { type: "callback", outcome: "lost" },
  "DQ - Recommended Another Company": { type: "callback", outcome: "lost" },
  "DQ - Trying to Sell Me Something": { type: "callback", outcome: "lost" },
  "DQ - Not Proceeding": { type: "callback", outcome: "lost" },
  // Abandoned = terminal too (Buzz 2026-09-02): close the Quotie lead like DQ/Lost.
  "Abandoned - Not Responding": { type: "callback", outcome: "lost" },
  "Abandoned - Headache": { type: "callback", outcome: "lost" },
};

/**
 * POST-quote lane defaults: EOD 3 outcome → api-follow-ups action. These act on
 * the contact's most urgent OPEN SENT quote group, not on a callback lead.
 *
 * "Quote Sent" is deliberately absent — Quotie already knows a quote went out
 * via its own send pipeline. "Job Won" is deliberately not offered here either
 * (won is its own event type in the popup).
 *
 * Anything NOT listed here falls back to the pre-quote action only when that
 * action is lane-neutral (see isLaneNeutralAction) — that is the lane-separation
 * rule: a post-quote contact must never be pushed into the pre-quote callback
 * cadence.
 */
export const DEFAULT_QUOTIE_POST_QUOTE_ACTIONS: Record<string, QuotieAction> = {
  // "Not ready" / "bad time" after a quote is out = push the follow-up date out.
  "Not Ready Yet - Post Quote": { type: "follow_up", outcome: "reschedule" },
  "Not a Good Time to Talk": { type: "follow_up", outcome: "reschedule" },
  // Verbal yes flags every open group and moves the card to Verbal Yes.
  "Verbal Confirmation": { type: "follow_up", outcome: "verbal_yes" },
  // Terminal — Lost / DQ close the primary open group as lost.
  "Lost - Price": { type: "follow_up", outcome: "lost" },
  "Lost - Time Related": { type: "follow_up", outcome: "lost" },
  "Lost - Priorities Changed": { type: "follow_up", outcome: "lost" },
  "DQ - Incorrect Details": { type: "follow_up", outcome: "lost" },
  "DQ - Wrong Contact / Spam": { type: "follow_up", outcome: "lost" },
  "DQ - Out of Service Area": { type: "follow_up", outcome: "lost" },
  "DQ - Extent of Works": { type: "follow_up", outcome: "lost" },
  "DQ - Price": { type: "follow_up", outcome: "lost" },
  "DQ - Lead Looking for Work": { type: "follow_up", outcome: "lost" },
  "DQ - Recommended Another Company": { type: "follow_up", outcome: "lost" },
  "DQ - Trying to Sell Me Something": { type: "follow_up", outcome: "lost" },
  "DQ - Not Proceeding": { type: "follow_up", outcome: "lost" },
  // Terminal — Abandoned has its own api-follow-ups outcome (distinct close
  // reason + default outcome_notes), unlike the pre-quote lane where it is lost.
  "Abandoned - Not Responding": { type: "follow_up", outcome: "abandoned" },
  "Abandoned - Headache": { type: "follow_up", outcome: "abandoned" },
};

/**
 * EOD 2 (Answered?) selection → api-callbacks outcome. The no-answer signal
 * lives on the EOD 2 step, NOT the EOD 3 outcome dropdown: the current form is
 * binary ("Answered" / "Didn't Answer"). "Didn't Answer" → no_answer (Quotie
 * derives the lead into Day 1 on first log, bumps Day N on repeats). If a
 * voicemail-type EOD 2 value is ever added it maps to voicemail. "Answered"
 * alone is NOT a callback signal — it only fires via an EOD 3 outcome mapping.
 */
export const DEFAULT_ANSWERED_CALLBACKS: Record<string, string> = {
  "Didn't Answer": "no_answer",
  "No Answer": "no_answer",
  "Voicemail": "voicemail",
  "Left Voicemail": "voicemail",
};

/**
 * POST-quote twin of DEFAULT_ANSWERED_CALLBACKS: EOD 2 (Answered?) selection →
 * api-follow-ups outcome. api-follow-ups has no voicemail outcome — a voicemail
 * is a no-answer for the reschedule cadence (it pushes the follow-up out by the
 * acting user's no_answer_delay_days in company working days).
 */
export const DEFAULT_ANSWERED_FOLLOW_UPS: Record<string, string> = {
  "Didn't Answer": "no_answer",
  "No Answer": "no_answer",
  "Voicemail": "no_answer",
  "Left Voicemail": "no_answer",
};

/**
 * Resolve the api-callbacks outcome for an EOD 2 (Answered?) selection, or null
 * when the selection isn't a no-answer/voicemail signal. Gated on api_key like
 * resolveQuotieAction. Per-company overrides live under
 * quotie_config.answered_callbacks (same null-to-disable semantics).
 */
export function resolveAnsweredCallback(
  answered: string,
  config: QuotieConfig | null | undefined,
): string | null {
  if (!config?.api_key) return null;
  const key = (answered || "").trim();
  if (!key) return null;

  const overrides = config.answered_callbacks;
  if (overrides != null && Object.prototype.hasOwnProperty.call(overrides, key)) {
    const override = overrides[key];
    return override === null ? null : override || null;
  }
  return DEFAULT_ANSWERED_CALLBACKS[key] ?? null;
}

/**
 * Resolve the Quotie action for an EOD 3 outcome, merging the per-client
 * config over the defaults. Returns null when:
 *   - the client has no api_key (integration off), or
 *   - the outcome has no default and no config entry, or
 *   - the config explicitly maps the outcome to null (disabled).
 */
export function resolveQuotieAction(
  outcome: string,
  config: QuotieConfig | null | undefined,
): QuotieAction | null {
  if (!config?.api_key) return null;
  const key = (outcome || "").trim();
  if (!key) return null;

  const hasOverride =
    config.actions != null && Object.prototype.hasOwnProperty.call(config.actions, key);
  if (hasOverride) {
    const override = config.actions![key];
    // Explicit null disables the action entirely.
    if (override === null) return null;
    // Merge the override over the default (override wins field-by-field).
    const base = DEFAULT_QUOTIE_ACTIONS[key];
    return { ...(base ?? {}), ...override } as QuotieAction;
  }

  return DEFAULT_QUOTIE_ACTIONS[key] ?? null;
}

/**
 * A pre-quote action that still makes sense for a contact who already has a
 * quote out. Tasks and site visits are lane-agnostic by nature, and a
 * post-quote contact who needs a NEW quote legitimately re-enters the
 * Requires Quoting column. Every other pre-quote callback (callback_requested,
 * no_answer, voicemail, lost …) belongs to the callback_leads cadence and must
 * NOT fire for a post-quote contact — that is the lane-separation rule.
 */
function isLaneNeutralAction(action: QuotieAction): boolean {
  if (action.type === "task" || action.type === "site_visit") return true;
  return action.type === "callback" && action.outcome === "requires_quoting";
}

/**
 * Which lane an EOD 1 stage selects. Per-company override:
 * quotie_config.post_quote_stages (exact stage strings).
 */
export function resolveLane(
  stage: string,
  config: QuotieConfig | null | undefined,
): QuotieLane {
  const key = (stage || "").trim();
  if (!key) return "pre_quote";
  const stages = config?.post_quote_stages ?? DEFAULT_POST_QUOTE_STAGES;
  return stages.some(s => (s || "").trim() === key) ? "post_quote" : "pre_quote";
}

/**
 * Lane-aware twin of resolveQuotieAction. The pre-quote lane is the existing
 * behaviour verbatim. The post-quote lane merges quotie_config.post_quote_actions
 * over DEFAULT_QUOTIE_POST_QUOTE_ACTIONS (override wins field-by-field, explicit
 * null disables), then falls back to the pre-quote action only when that action
 * is lane-neutral.
 */
export function resolveQuotieActionForLane(
  outcome: string,
  lane: QuotieLane,
  config: QuotieConfig | null | undefined,
): QuotieAction | null {
  if (!config?.api_key) return null;
  if (lane === "pre_quote") return resolveQuotieAction(outcome, config);

  const key = (outcome || "").trim();
  if (!key) return null;

  const overrides = config.post_quote_actions;
  if (overrides != null && Object.prototype.hasOwnProperty.call(overrides, key)) {
    const override = overrides[key];
    // Explicit null disables the action entirely for this lane.
    if (override === null) return null;
    const base = DEFAULT_QUOTIE_POST_QUOTE_ACTIONS[key];
    return { ...(base ?? {}), ...override } as QuotieAction;
  }

  const preset = DEFAULT_QUOTIE_POST_QUOTE_ACTIONS[key];
  if (preset) return preset;

  // No post-quote entry: borrow the pre-quote action only if it is lane-neutral.
  const preQuote = resolveQuotieAction(key, config);
  return preQuote && isLaneNeutralAction(preQuote) ? preQuote : null;
}

/**
 * Lane-aware twin of resolveAnsweredCallback. Tells the caller WHICH endpoint
 * the EOD 2 (Answered?) signal belongs to, so the two lanes never cross.
 */
export function resolveAnsweredForLane(
  answered: string,
  lane: QuotieLane,
  config: QuotieConfig | null | undefined,
): { kind: "callback" | "follow_up"; outcome: string } | null {
  if (!config?.api_key) return null;

  if (lane === "pre_quote") {
    const outcome = resolveAnsweredCallback(answered, config);
    return outcome ? { kind: "callback", outcome } : null;
  }

  const key = (answered || "").trim();
  if (!key) return null;
  const overrides = config.answered_follow_ups;
  if (overrides != null && Object.prototype.hasOwnProperty.call(overrides, key)) {
    const override = overrides[key];
    if (!override) return null; // explicit null (or "") disables
    return { kind: "follow_up", outcome: override };
  }
  const preset = DEFAULT_ANSWERED_FOLLOW_UPS[key];
  return preset ? { kind: "follow_up", outcome: preset } : null;
}

/**
 * Outcomes that close (or re-open) the record rather than schedule the next
 * touch, so a follow-up date has nowhere to land. The move still fires; the
 * banner says why the date was dropped.
 */
export const FOLLOW_UP_DATE_BLOCKED: Record<string, "quote closed" | "requires quoting"> = {
  lost: "quote closed",
  abandoned: "quote closed",
  requires_quoting: "requires quoting",
};

/**
 * The ONE Quotie pipeline call the "Set follow-up" checkbox drives, whatever
 * drove it. Exactly one of these fires per submit — never an outcome move AND
 * a separate date-setting call for the same contact.
 */
export type QuotieFollowUpPlan = {
  /** Endpoint: api-follow-ups (post-quote) or api-callbacks (pre-quote). */
  kind: "follow_up" | "callback";
  /** Endpoint outcome. */
  outcome: string;
  /**
   * What selected this call:
   *   eod3  — the EOD 3 standard outcome maps to a pipeline move in this lane
   *   eod2  — the EOD 2 "Answered?" no-answer / voicemail signal
   *   plain — no outcome-driven move; the exec just ticked "Set follow-up"
   */
  source: "eod3" | "eod2" | "plain";
  /** Whether the exec's date/time may be merged into this call. */
  acceptsDate: boolean;
  /** Why a supplied date could not be applied (banner suffix). */
  dateSkipReason?: "quote closed" | "requires quoting";
  /** Assignee override carried through from the EOD 3 action. */
  assign_to?: string;
};

/**
 * Resolve the single follow-up leg for a submit. Pure — the server calls this
 * with the re-derived lane and the config, and the assertion suite pins the
 * merge rules (see scripts/quotieResolver.test.mts).
 *
 * Precedence: an EOD 3 outcome that maps to a pipeline move owns the call; then
 * the EOD 2 no-answer signal; then, only when the exec ticked the box, a plain
 * reschedule (post) / call-back request (pre). Terminal outcomes still fire,
 * they just refuse the date.
 */
export function resolveFollowUpPlan(args: {
  lane: QuotieLane;
  stdOutcome: string;
  answered: string;
  config: QuotieConfig | null | undefined;
  /** "Set follow-up" is ticked (or a legacy client sent an equivalent input). */
  followUpRequested: boolean;
}): QuotieFollowUpPlan | null {
  const { lane, stdOutcome, answered, config, followUpRequested } = args;
  if (!config?.api_key) return null;
  // The checkbox owns the WHOLE leg, outcome-driven moves included. Unticked
  // means nothing is sent — an exec who unticks it on a Lost call must not
  // find the quote closed in Quotie anyway.
  if (!followUpRequested) return null;

  const plan = (
    kind: "follow_up" | "callback",
    outcome: string,
    source: QuotieFollowUpPlan["source"],
    assign_to?: string,
  ): QuotieFollowUpPlan => {
    const blocked = FOLLOW_UP_DATE_BLOCKED[outcome];
    return {
      kind,
      outcome,
      source,
      acceptsDate: !blocked,
      ...(blocked ? { dateSkipReason: blocked } : {}),
      ...(assign_to ? { assign_to } : {}),
    };
  };

  const action = resolveQuotieActionForLane(stdOutcome, lane, config);
  if (action && (action.type === "callback" || action.type === "follow_up")) {
    const fallback = action.type === "follow_up" ? "reschedule" : "requires_quoting";
    return plan(action.type, action.outcome || fallback, "eod3", action.assign_to);
  }

  const eod2 = resolveAnsweredForLane(answered, lane, config);
  if (eod2) return plan(eod2.kind, eod2.outcome, "eod2");

  return lane === "post_quote"
    ? plan("follow_up", "reschedule", "plain")
    : plan("callback", "callback_requested", "plain");
}

/**
 * The date actually sent with a plan.
 *   - a terminal outcome takes none (the record is closing)
 *   - the exec's date wins whenever the plan accepts one
 *   - a reschedule, and any plain "set a follow-up", must say WHEN, so a
 *     missing date falls back to `defaultDate` (tomorrow, company-local)
 *   - everything else (no-answer cadence, verbal yes, hot) is happy with none
 *     and lets Quotie compute its own next date
 */
export function followUpDateToSend(
  plan: QuotieFollowUpPlan,
  askedDate: string,
  defaultDate: string,
): string {
  if (!plan.acceptsDate) return "";
  if (askedDate) return askedDate;
  return plan.outcome === "reschedule" || plan.source === "plain" ? defaultDate : "";
}

/** Per-outcome shape the browser gets. `outcome` is not secret — the form needs
 *  it to decide whether to show a follow-up date picker. */
export type QuotieClientAction = { type: QuotieActionType; outcome?: string };

/**
 * The ONLY projection of quotie_config that may be sent to the client. Carries
 * both lanes' outcome maps, both lanes' EOD 2 signals and the stage list that
 * pre-selects the lane. NEVER carries api_key / api_url / user_map.
 * All-empty when the integration is off (no api_key).
 */
export type QuotieClientConfig = {
  actions: {
    pre_quote: Record<string, QuotieClientAction>;
    post_quote: Record<string, QuotieClientAction>;
  };
  answered: {
    pre_quote: Record<string, true>;
    post_quote: Record<string, true>;
  };
  post_quote_stages: string[];
};

export function safeQuotieClientConfig(
  config: QuotieConfig | null | undefined,
): QuotieClientConfig {
  const out: QuotieClientConfig = {
    actions: { pre_quote: {}, post_quote: {} },
    answered: { pre_quote: {}, post_quote: {} },
    post_quote_stages: [...DEFAULT_POST_QUOTE_STAGES],
  };
  if (!config?.api_key) return out;

  const stages = (config.post_quote_stages ?? DEFAULT_POST_QUOTE_STAGES)
    .map(s => (s || "").trim())
    .filter(Boolean);
  out.post_quote_stages = stages.length ? stages : [...DEFAULT_POST_QUOTE_STAGES];

  // Every outcome either lane knows about, then per-lane resolution.
  const outcomes = new Set<string>([
    ...Object.keys(DEFAULT_QUOTIE_ACTIONS),
    ...Object.keys(DEFAULT_QUOTIE_POST_QUOTE_ACTIONS),
    ...(config.actions ? Object.keys(config.actions) : []),
    ...(config.post_quote_actions ? Object.keys(config.post_quote_actions) : []),
  ]);
  for (const lane of ["pre_quote", "post_quote"] as const) {
    for (const outcome of outcomes) {
      const action = resolveQuotieActionForLane(outcome, lane, config);
      if (!action) continue;
      out.actions[lane][outcome] = action.outcome
        ? { type: action.type, outcome: action.outcome }
        : { type: action.type };
    }
  }

  const answeredKeys = new Set<string>([
    ...Object.keys(DEFAULT_ANSWERED_CALLBACKS),
    ...Object.keys(DEFAULT_ANSWERED_FOLLOW_UPS),
    ...(config.answered_callbacks ? Object.keys(config.answered_callbacks) : []),
    ...(config.answered_follow_ups ? Object.keys(config.answered_follow_ups) : []),
  ]);
  for (const lane of ["pre_quote", "post_quote"] as const) {
    for (const key of answeredKeys) {
      if (resolveAnsweredForLane(key, lane, config)) out.answered[lane][key] = true;
    }
  }

  return out;
}

const QUOTIE_TIMEOUT_MS = 10_000;
/**
 * The popup-open read is on the page's critical path (it runs inside the same
 * Promise.all as the GHL contact fetch), so it gets a much tighter guard than
 * the write calls: a slow Quotie must never hold the form back. A miss just
 * renders "Couldn't reach Quotie".
 */
const QUOTIE_READ_TIMEOUT_MS = 4_000;

/** A Quotie timestamptz rendered as a company-local wall clock. `time` is null at midnight. */
export type QuotieLocalWallClock = { date: string; time: string | null };

/**
 * GET /api-follow-ups/contact — what Quotie already knows about this GHL
 * contact when the popup opens. Side-effect free on Quotie's side (no contact
 * import, no attempt rows) and carries NO auth ids, so the whole shape is safe
 * to hand straight to the browser.
 */
export type QuotieFollowUpState = {
  contact: { id: string; first_name: string | null; last_name: string | null } | null;
  /** Which lane Quotie itself says this contact is in — post_quote wins when a sent quote is open. */
  lane: QuotieLane;
  timezone: string;
  post_quote: {
    group_id: string;
    group_name: string | null;
    status: string | null;
    follow_up_date: string | null;
    follow_up_local: QuotieLocalWallClock | null;
    reschedule_count: number;
    follow_up_notes: string | null;
    assigned_to_name: string | null;
    is_hot: boolean;
    verbal_confirmed_at: string | null;
    sent_at: string | null;
    expires_at: string | null;
    pipeline_value: number | null;
    other_open_groups: number;
  } | null;
  pre_quote: {
    lead_id: string;
    status: string | null;
    callback_date: string | null;
    callback_local: QuotieLocalWallClock | null;
    attempt_count: number;
    callback_reason: string | null;
    assigned_to_name: string | null;
  } | null;
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : v == null ? null : String(v) || null;
}
function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function wallClock(v: unknown): QuotieLocalWallClock | null {
  if (!v || typeof v !== "object") return null;
  const o = v as { date?: unknown; time?: unknown };
  const date = typeof o.date === "string" ? o.date.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const time = typeof o.time === "string" && /^\d{2}:\d{2}/.test(o.time.trim())
    ? o.time.trim().slice(0, 5)
    : null;
  return { date, time };
}

/**
 * Read Quotie's current follow-up / callback state for a GHL contact so the
 * popup can show what is already scheduled before the exec logs anything.
 * Never throws and never blocks: any failure (not configured, 404, timeout,
 * malformed body) returns null and the form falls back to the stage-derived
 * lane with a "couldn't reach Quotie" line.
 */
export async function getQuotieFollowUpState(
  config: QuotieConfig | null | undefined,
  ghlContactId: string,
): Promise<QuotieFollowUpState | null> {
  const apiUrl = (config?.api_url || "").trim().replace(/\/+$/, "");
  const apiKey = (config?.api_key || "").trim();
  const contactId = (ghlContactId || "").trim();
  if (!apiUrl || !apiKey || !contactId) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUOTIE_READ_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${apiUrl}/api-follow-ups/contact?ghl_contact_id=${encodeURIComponent(contactId)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        cache: "no-store",
        signal: controller.signal,
      },
    );
    if (!res.ok) return null;
    const text = await res.text().catch(() => "");
    const parsed: unknown = text ? JSON.parse(text) : null;
    if (!parsed || typeof parsed !== "object") return null;
    // Quotie returns its payload bare (top-level), same as the other routes.
    const p = parsed as Record<string, unknown>;

    const rawContact = p.contact;
    const contact =
      rawContact && typeof rawContact === "object"
        ? {
            id: String((rawContact as { id?: unknown }).id || ""),
            first_name: str((rawContact as { first_name?: unknown }).first_name),
            last_name: str((rawContact as { last_name?: unknown }).last_name),
          }
        : null;

    const rawPost = p.post_quote;
    const post_quote =
      rawPost && typeof rawPost === "object"
        ? (() => {
            const g = rawPost as Record<string, unknown>;
            return {
              group_id: String(g.group_id || ""),
              group_name: str(g.group_name),
              status: str(g.status),
              follow_up_date: str(g.follow_up_date),
              follow_up_local: wallClock(g.follow_up_local),
              reschedule_count: num(g.reschedule_count),
              follow_up_notes: str(g.follow_up_notes),
              assigned_to_name: str(g.assigned_to_name),
              is_hot: g.is_hot === true,
              verbal_confirmed_at: str(g.verbal_confirmed_at),
              sent_at: str(g.sent_at),
              expires_at: str(g.expires_at),
              pipeline_value: typeof g.pipeline_value === "number" ? g.pipeline_value : null,
              other_open_groups: num(g.other_open_groups),
            };
          })()
        : null;

    const rawPre = p.pre_quote;
    const pre_quote =
      rawPre && typeof rawPre === "object"
        ? (() => {
            const l = rawPre as Record<string, unknown>;
            return {
              lead_id: String(l.lead_id || ""),
              status: str(l.status),
              callback_date: str(l.callback_date),
              callback_local: wallClock(l.callback_local),
              attempt_count: num(l.attempt_count),
              callback_reason: str(l.callback_reason),
              assigned_to_name: str(l.assigned_to_name),
            };
          })()
        : null;

    // Trust Quotie's lane when it sends a known one; otherwise derive it the
    // same way Quotie does (an open sent quote group means post-quote).
    const lane: QuotieLane =
      p.lane === "post_quote" || p.lane === "pre_quote"
        ? p.lane
        : post_quote
          ? "post_quote"
          : "pre_quote";

    return {
      contact,
      lane,
      timezone: (typeof p.timezone === "string" && p.timezone) || "Australia/Sydney",
      post_quote,
      pre_quote,
    };
  } catch {
    // Timeout, network error, non-JSON body — the caller renders the fallback.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type QuotieCallResult = {
  ok: boolean;
  warnings?: string[];
  error?: string;
  /** api-callbacks graceful no-op (e.g. lost with no existing lead) — HTTP 200 {noop:true}. */
  noop?: boolean;
  /** api-follow-ups success payload (the group as re-read after the write). */
  follow_up?: {
    follow_up_date: string | null;
    group_name: string | null;
    status: string | null;
    /** quote_groups.follow_up_reschedule_count after the write — "3rd follow-up" in the banner. */
    reschedule_count: number;
    other_open_groups: number;
  };
  /** api-follow-ups 404 reason=no_quote_group — contact has no sent quote in Quotie. */
  no_quote_group?: boolean;
  /** GHL appointment result from a successful api-site-visits response. */
  ghl?: {
    status?: string;
    assigned_user_name?: string | null;
    assigned_user_id?: string | null;
    assignment_source?: string;
  };
};

type QuotieTaskInput = {
  title: string;
  notes?: string;
  due_date?: string;
  /** Roster name — mapped to a Quotie users.auth_id via config.user_map. */
  salesPersonName?: string;
  /** Explicit assignee (auth_id) — wins over the user_map lookup. */
  assign_to?: string;
  ghl_contact_id?: string;
};

type QuotieCallbackInput = {
  /** api-callbacks outcome, e.g. "requires_quoting". */
  outcome: string;
  ghl_contact_id?: string;
  /** Free-text detail (job details / EOD notes) — lands in attempt history. */
  notes?: string;
  /** Roster name — mapped to a Quotie users.auth_id via config.user_map. */
  salesPersonName?: string;
  /** Explicit assignee (auth_id) — wins over the user_map lookup. */
  assign_to?: string;
  callback_reason?: string;
  /**
   * YYYY-MM-DD, read by Quotie as a wall clock in the COMPANY's timezone —
   * same parsing as follow_up_date since the two endpoints share
   * _shared/localDateTime.ts. Never compose an ISO timestamp on this side.
   */
  callback_date?: string;
  /** HH:MM, company-local, paired with callback_date. */
  callback_time?: string;
};

type QuotieFollowUpInput = {
  /** api-follow-ups outcome: reschedule | no_answer | verbal_yes | hot | lost | abandoned. */
  outcome: string;
  ghl_contact_id?: string;
  /** Free-text detail (EOD notes) — lands in the follow-up attempt history. */
  notes?: string;
  /** Roster name — mapped to a Quotie users.auth_id via config.user_map. */
  salesPersonName?: string;
  /** Explicit assignee (auth_id) — wins over the user_map lookup. */
  assign_to?: string;
  /**
   * YYYY-MM-DD, read by Quotie as a wall clock in the COMPANY's timezone.
   * Never compose an ISO timestamp on this side — Vercel runs UTC and would
   * shift the date by a day for AU companies.
   */
  follow_up_date?: string;
  /** HH:MM, company-local, paired with follow_up_date. */
  follow_up_time?: string;
};

type QuotieSiteVisitInput = {
  date: string;
  time?: string;
  contact_name: string;
  contact_phone?: string;
  contact_email?: string;
  ghl_contact_id?: string;
  address?: string;
  salesPersonName?: string;
  assign_to?: string;
  create_ghl_appointment: boolean;
  rough_job_value?: string;
  ideal_start?: string;
  details?: string;
  ghl_assigned_user_id?: string;
  /**
   * Existing GHL appointment id (GHL-originated / pending bookings). When set,
   * Quotie LINKS the visit to that appointment instead of creating a new one —
   * send create_ghl_appointment: false alongside it. (Param live on Quotie dev,
   * deploying to prod.)
   */
  ghl_appointment_id?: string;
};

/**
 * GET /api-site-visits/team-members from the client's Quotie instance.
 * Never throws — returns { ok: false, members: [] } on any failure.
 * quotie_auth_id is kept here (server-side) for the user_map lookup in
 * actions.ts; it must be stripped before reaching the browser.
 */
export async function getQuotieTeamMembers(
  config: QuotieConfig,
): Promise<{ ok: boolean; members: Array<{ ghl_user_id: string; name: string | null; is_primary: boolean; quotie_auth_id: string | null }>; error?: string }> {
  const apiUrl = (config.api_url || "").trim().replace(/\/+$/, "");
  const apiKey = (config.api_key || "").trim();
  if (!apiUrl || !apiKey) {
    return { ok: false, members: [] };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUOTIE_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiUrl}/api-site-visits/team-members`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      const detail =
        (parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error?: unknown }).error)
          : "") ||
        text.slice(0, 200) ||
        `HTTP ${res.status}`;
      return { ok: false, members: [], error: detail };
    }
    // Quotie returns the payload bare (top-level), not wrapped in {data: ...}.
    // Read from top-level first; fall back to parsed.data.members for safety.
    type RawMember = { ghl_user_id?: unknown; name?: unknown; is_primary?: unknown; quotie_auth_id?: unknown };
    const topLevelMembers =
      parsed && typeof parsed === "object" && "members" in parsed && Array.isArray((parsed as { members?: unknown }).members)
        ? (parsed as { members: RawMember[] }).members
        : null;
    const dataObj =
      parsed && typeof parsed === "object" && "data" in parsed
        ? (parsed as { data?: unknown }).data
        : null;
    const fallbackMembers =
      dataObj && typeof dataObj === "object" && "members" in dataObj && Array.isArray((dataObj as { members?: unknown }).members)
        ? (dataObj as { members: RawMember[] }).members
        : null;
    const rawMembers = topLevelMembers ?? fallbackMembers ?? [];
    const members = rawMembers.map(m => ({
      ghl_user_id: String(m.ghl_user_id || ""),
      name: m.name != null ? String(m.name) : null,
      is_primary: Boolean(m.is_primary),
      quotie_auth_id: m.quotie_auth_id != null ? String(m.quotie_auth_id) : null,
    }));
    return { ok: true, members };
  } catch (e) {
    const msg = (e as Error).name === "AbortError" ? "Quotie timed out" : (e as Error).message;
    return { ok: false, members: [], error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Quotie's shared apiError envelope is
 *   { error: { code, message, details?: { reason?, … } } }
 * (supabase/functions/_shared/apiAuth.ts). Older/edge responses sometimes put a
 * bare string on `error`, so handle both. Returns the human message plus the
 * machine `reason` the caller branches on (e.g. "no_quote_group").
 */
function readApiError(parsed: unknown): { message: string; reason: string } {
  if (!parsed || typeof parsed !== "object") return { message: "", reason: "" };
  const err = (parsed as { error?: unknown }).error;
  if (typeof err === "string") return { message: err, reason: "" };
  if (!err || typeof err !== "object") return { message: "", reason: "" };
  const e = err as { message?: unknown; code?: unknown; details?: unknown };
  const message =
    (typeof e.message === "string" && e.message) ||
    (typeof e.code === "string" && e.code) ||
    "";
  const details = e.details;
  const reason =
    details && typeof details === "object" && typeof (details as { reason?: unknown }).reason === "string"
      ? ((details as { reason: string }).reason)
      : "";
  return { message, reason };
}

/** POST to a Quotie REST endpoint with the client's api_key + a 10s guard. */
async function postQuotie(
  config: QuotieConfig,
  path: string,
  body: Record<string, unknown>,
): Promise<QuotieCallResult> {
  const apiUrl = (config.api_url || "").trim().replace(/\/+$/, "");
  const apiKey = (config.api_key || "").trim();
  if (!apiUrl || !apiKey) {
    return { ok: false, error: "Quotie is not configured for this client" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUOTIE_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiUrl}/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON response — keep raw text for the error path */
    }
    if (!res.ok) {
      const { message, reason } = readApiError(parsed);
      const detail = message || text.slice(0, 200) || `HTTP ${res.status}`;
      return {
        ok: false,
        error: detail,
        ...(reason === "no_quote_group" ? { no_quote_group: true as const } : {}),
      };
    }
    const warnings =
      parsed && typeof parsed === "object" && Array.isArray((parsed as { warnings?: unknown }).warnings)
        ? ((parsed as { warnings?: string[] }).warnings as string[])
        : undefined;
    const noop =
      parsed && typeof parsed === "object" && (parsed as { noop?: unknown }).noop === true
        ? true
        : undefined;
    const rawGhl =
      parsed && typeof parsed === "object" && "ghl" in parsed && parsed !== null
        ? (parsed as { ghl?: unknown }).ghl
        : undefined;
    const ghl =
      rawGhl && typeof rawGhl === "object"
        ? {
            status: "status" in rawGhl && rawGhl.status != null ? String((rawGhl as { status: unknown }).status) : undefined,
            assigned_user_name: "assigned_user_name" in rawGhl
              ? ((rawGhl as { assigned_user_name?: unknown }).assigned_user_name as string | null | undefined)
              : undefined,
            assigned_user_id: "assigned_user_id" in rawGhl
              ? ((rawGhl as { assigned_user_id?: unknown }).assigned_user_id as string | null | undefined)
              : undefined,
            assignment_source: "assignment_source" in rawGhl && (rawGhl as { assignment_source?: unknown }).assignment_source != null
              ? String((rawGhl as { assignment_source: unknown }).assignment_source)
              : undefined,
          }
        : undefined;
    // api-follow-ups returns its payload bare (top-level), same as the others.
    const p = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    const follow_up =
      p && ("group_id" in p || "other_open_groups" in p)
        ? {
            follow_up_date: typeof p.follow_up_date === "string" ? p.follow_up_date : null,
            group_name: typeof p.group_name === "string" ? p.group_name : null,
            status: typeof p.status === "string" ? p.status : null,
            reschedule_count:
              typeof p.reschedule_count === "number" && Number.isFinite(p.reschedule_count)
                ? p.reschedule_count
                : 0,
            other_open_groups:
              typeof p.other_open_groups === "number" && Number.isFinite(p.other_open_groups)
                ? p.other_open_groups
                : 0,
          }
        : undefined;
    return { ok: true, warnings, ghl, noop, follow_up };
  } catch (e) {
    const msg = (e as Error).name === "AbortError" ? "Quotie timed out" : (e as Error).message;
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve the assignee auth_id: explicit override first, then user_map. */
function resolveAssignee(
  config: QuotieConfig,
  salesPersonName?: string,
  assignOverride?: string,
): string | undefined {
  if (assignOverride?.trim()) return assignOverride.trim();
  const name = (salesPersonName || "").trim();
  if (!name) return undefined;
  return config.user_map?.[name] || undefined;
}

/** Create a Quotie task. Never throws — always returns a QuotieCallResult. */
export async function createQuotieTask(
  config: QuotieConfig,
  input: QuotieTaskInput,
): Promise<QuotieCallResult> {
  const assigned_to = resolveAssignee(config, input.salesPersonName, input.assign_to);
  const body: Record<string, unknown> = { title: input.title };
  if (input.notes?.trim()) body.notes = input.notes.trim();
  if (input.due_date?.trim()) body.due_date = input.due_date.trim();
  if (assigned_to) body.assigned_to = assigned_to;
  if (input.ghl_contact_id?.trim()) body.ghl_contact_id = input.ghl_contact_id.trim();
  return postQuotie(config, "api-tasks", body);
}

/** Create a Quotie site visit. Never throws — always returns a QuotieCallResult. */
export async function createQuotieSiteVisit(
  config: QuotieConfig,
  input: QuotieSiteVisitInput,
): Promise<QuotieCallResult> {
  const assigned_to = resolveAssignee(config, input.salesPersonName, input.assign_to);
  const body: Record<string, unknown> = {
    date: input.date,
    contact_name: input.contact_name,
    create_ghl_appointment: input.create_ghl_appointment,
  };
  if (input.time?.trim()) body.time = input.time.trim();
  if (input.contact_phone?.trim()) body.contact_phone = input.contact_phone.trim();
  if (input.contact_email?.trim()) body.contact_email = input.contact_email.trim();
  if (input.ghl_contact_id?.trim()) body.ghl_contact_id = input.ghl_contact_id.trim();
  if (input.address?.trim()) body.address = input.address.trim();
  if (input.rough_job_value?.trim()) body.rough_job_value = input.rough_job_value.trim();
  if (input.ideal_start?.trim()) body.ideal_start = input.ideal_start.trim();
  if (input.details?.trim()) body.details = input.details.trim();
  if (input.salesPersonName?.trim()) body.exec_name = input.salesPersonName.trim();
  if (assigned_to) body.assigned_to = assigned_to;
  if (input.ghl_assigned_user_id?.trim()) body.ghl_assigned_user_id = input.ghl_assigned_user_id.trim();
  // GHL-originated bookings: link the existing appointment instead of creating one.
  if (input.ghl_appointment_id?.trim()) body.ghl_appointment_id = input.ghl_appointment_id.trim();
  return postQuotie(config, "api-site-visits", body);
}

/**
 * Push an EOD outcome into Quotie's callback pipeline (api-callbacks). Drives
 * every pipeline move from the EOD selector: requires_quoting (Requires Quoting
 * column), callback_requested (Parked), no_answer/voicemail (Day N cadence),
 * lost (Lost column — graceful no-op when no lead exists). Never throws —
 * always returns a QuotieCallResult. `attempted_by` is resolved from the
 * company's user_map by exec short name (same lookup the task path uses);
 * unmapped execs log the attempt unattributed.
 */
export async function createQuotieCallback(
  config: QuotieConfig,
  input: QuotieCallbackInput,
): Promise<QuotieCallResult> {
  const attempted_by = resolveAssignee(config, input.salesPersonName, input.assign_to);
  const body: Record<string, unknown> = { outcome: input.outcome };
  if (input.callback_reason?.trim()) body.callback_reason = input.callback_reason.trim();
  if (input.callback_date?.trim()) body.callback_date = input.callback_date.trim();
  if (input.callback_time?.trim()) body.callback_time = input.callback_time.trim();
  if (input.ghl_contact_id?.trim()) body.ghl_contact_id = input.ghl_contact_id.trim();
  if (input.notes?.trim()) body.notes = input.notes.trim();
  if (attempted_by) body.attempted_by = attempted_by;
  return postQuotie(config, "api-callbacks", body);
}

/**
 * Push an EOD outcome into Quotie's POST-quote follow-up cadence
 * (api-follow-ups). Acts on the contact's most urgent open SENT quote group:
 * reschedule (push the follow-up date out), no_answer (push out by the acting
 * user's no-answer delay), verbal_yes / hot (flag every open group), lost /
 * abandoned (close the primary group). Never throws.
 *
 * A contact with no open sent group comes back 404 with
 * `no_quote_group: true` — the caller should tell the exec to switch to the
 * pre-quote lane rather than retrying.
 *
 * Dates are sent as YYYY-MM-DD (+ optional HH:MM) and read by Quotie in the
 * COMPANY's timezone. Never build an ISO timestamp here — this server runs UTC.
 */
export async function createQuotieFollowUp(
  config: QuotieConfig,
  input: QuotieFollowUpInput,
): Promise<QuotieCallResult> {
  const attempted_by = resolveAssignee(config, input.salesPersonName, input.assign_to);
  const body: Record<string, unknown> = { outcome: input.outcome };
  if (input.ghl_contact_id?.trim()) body.ghl_contact_id = input.ghl_contact_id.trim();
  if (input.follow_up_date?.trim()) body.follow_up_date = input.follow_up_date.trim();
  if (input.follow_up_time?.trim()) body.follow_up_time = input.follow_up_time.trim();
  if (input.notes?.trim()) body.notes = input.notes.trim();
  if (attempted_by) body.attempted_by = attempted_by;
  return postQuotie(config, "api-follow-ups", body);
}
