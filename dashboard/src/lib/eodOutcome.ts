// EOD outcome line: stage | answered | action | notes | source.
// The reports match these strings exactly, so the editor picks from the same
// lists the EOD form submits and only joins them back into one line on save.

export const EOD_STAGES = ["New Leads", "Pre-Quote Follow Up", "Post Quote Follow Up"];

export const STAGE_SHORT_LABELS: Record<string, string> = {
  "New Leads": "New Lead",
  "Pre-Quote Follow Up": "Pre Quote",
  "Post Quote Follow Up": "Post Quote",
};

export const EOD_ANSWERS = ["Answered", "Didn't Answer"];

export const EOD_SOURCES = [
  "Facebook Ad Form",
  "Facebook Message",
  "Google Ads",
  "Website Form",
  "Direct Phone Call",
  "Direct Email",
  "Direct Lead passed on from Client",
  "Instagram Message",
  "Direct Text Message",
  "Recommended Another Company",
];

/** Word-different labels that must count as the canonical action. */
export const ACTION_ALIASES: Record<string, string> = {
  "Rough Figures Sent": "Requires Quoting",
  "Disqualified - Extent of Works": "DQ - Extent of Works",
  "Disqualified - Out of Service Area": "DQ - Out of Service Area",
  "Disqualified - Wrong Contact/Number": "DQ - Wrong Contact / Spam",
  "Disqualified - Wrong Contact / Spam": "DQ - Wrong Contact / Spam",
  "Disqualified - Price": "DQ - Price",
  "Disqualified - Lead Looking for Work": "DQ - Lead Looking for Work",
  "Disqualified - Incorrect Details": "DQ - Incorrect Details",
  "Disqualified - Recommended Another Company": "DQ - Recommended Another Company",
  "Disqualified - Trying to Sell Me Something": "DQ - Trying to Sell Me Something",
  "Disqualified - Not Proceeding": "DQ - Not Proceeding",
  "Not Ready Yet - Pre Quote": "Not Ready Yet - Pre-Quote",
  "Not Ready for Site Visit": "Not Ready Yet - Pre-Quote",
  "Rescheduled Site Visit": "Not Ready Yet - Pre-Quote",
  "Not Ready to Proceed w. Job": "Not Ready Yet - Post Quote",
};

const ANSWER_ALIASES: Record<string, string> = {
  "Didnt Answer": "Didn't Answer",
  "Did Not Answer": "Didn't Answer",
};

const SOURCE_ALIASES: Record<string, string> = {
  "FB Ad Form": "Facebook Ad Form",
  "Direct Lead from Client": "Direct Lead passed on from Client",
};

export type ActionGroup = { label: string; items: string[] };

/** EOD 3 order. "Passed Onto {owner}" is per client (Bolton → Jed, HDK → Jesse). */
export function actionGroups(ownerName?: string | null): ActionGroup[] {
  const owner = (ownerName || "").trim();
  return [
    {
      label: "Outcome",
      items: [
        "Not a Good Time to Talk",
        "Requires Quoting",
        "Book Site Visit",
        ...(owner ? [`Passed Onto ${owner}`] : []),
        "Not Ready Yet - Pre-Quote",
        "Not Ready Yet - Post Quote",
        "Quote Sent",
        "Verbal Confirmation",
        "Waiting on Photos",
      ],
    },
    {
      label: "Lost",
      items: ["Lost - Price", "Lost - Time Related", "Lost - Priorities Changed"],
    },
    {
      label: "Disqualified",
      items: [
        "DQ - Incorrect Details",
        "DQ - Wrong Contact / Spam",
        "DQ - Out of Service Area",
        "DQ - Extent of Works",
        "DQ - Price",
        "DQ - Lead Looking for Work",
        "DQ - Recommended Another Company",
        "DQ - Trying to Sell Me Something",
        "DQ - Not Proceeding",
      ],
    },
    {
      label: "Abandoned",
      items: ["Abandoned - Not Responding", "Abandoned - Headache"],
    },
  ];
}

export function standardOutcomes(ownerName?: string | null): string[] {
  return actionGroups(ownerName).flatMap(group => group.items);
}

/**
 * Client-specific sources that aren't in the shared list. Matched on company
 * name/slug so a slug rename doesn't drop the option.
 */
export function companyExtraSources(companyName: string, slug?: string): string[] {
  const s = `${companyName} ${slug || ""}`.toLowerCase();
  if (s.includes("hdk")) return ["Landing Page Lead Form"];
  return [];
}

export function eodSources(companyName?: string | null, slug?: string | null): string[] {
  return [...EOD_SOURCES, ...companyExtraSources(companyName || "", slug || undefined)];
}

export type EodOutcomeParts = {
  stage: string;
  answered: string;
  action: string;
  notes: string;
  source: string;
};

const EMPTY_PARTS: EodOutcomeParts = {
  stage: "",
  answered: "",
  action: "",
  notes: "",
  source: "",
};

/** Split a stored outcome line. Extra pipes stay in the notes slot. */
export function parseEodOutcome(raw: string | null | undefined): EodOutcomeParts {
  const parts = String(raw || "").split("|").map(part => part.trim());
  if (parts.length === 0 || (parts.length === 1 && !parts[0])) return { ...EMPTY_PARTS };
  if (parts.length <= 5) {
    return {
      stage: parts[0] || "",
      answered: parts[1] || "",
      action: parts[2] || "",
      notes: parts[3] || "",
      source: parts[4] || "",
    };
  }
  return {
    stage: parts[0] || "",
    answered: parts[1] || "",
    action: parts[2] || "",
    notes: parts.slice(3, -1).join(" | "),
    source: parts[parts.length - 1] || "",
  };
}

/** Join back into the line the reports read. Blank when every slot is empty. */
export function serializeEodOutcome(parts: EodOutcomeParts): string {
  const slots = [parts.stage, parts.answered, parts.action, parts.notes, parts.source].map(slot => slot.trim());
  if (slots.every(slot => !slot)) return "";
  return slots.join(" | ");
}

function optionKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function aliasTarget(value: string, aliases: Record<string, string>): string | null {
  if (aliases[value]) return aliases[value];
  const key = optionKey(value);
  for (const [from, to] of Object.entries(aliases)) {
    if (optionKey(from) === key) return to;
  }
  return null;
}

/** Map a stored label onto a known option. Unknown text is kept so it can still be shown. */
export function snapToOption(value: string, options: string[], aliases: Record<string, string> = {}): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const candidate = aliasTarget(trimmed, aliases) || trimmed;
  const key = optionKey(candidate);
  return options.find(option => optionKey(option) === key) || candidate;
}

export function presentEodOutcome(
  raw: string | null | undefined,
  opts: { ownerName?: string | null; companyName?: string | null; companySlug?: string | null } = {},
): EodOutcomeParts {
  const parts = parseEodOutcome(raw);
  return {
    stage: snapToOption(parts.stage, EOD_STAGES),
    answered: snapToOption(parts.answered, EOD_ANSWERS, ANSWER_ALIASES),
    action: snapToOption(parts.action, standardOutcomes(opts.ownerName), ACTION_ALIASES),
    notes: parts.notes.trim(),
    source: snapToOption(parts.source, eodSources(opts.companyName, opts.companySlug), SOURCE_ALIASES),
  };
}

/** What save should write for an EOD update: the choices on screen, as one line. */
export function commitEodOutcome(
  raw: string | null | undefined,
  opts: { ownerName?: string | null; companyName?: string | null; companySlug?: string | null } = {},
): { outcome: string; source: string } {
  const parts = presentEodOutcome(raw, opts);
  return { outcome: serializeEodOutcome(parts), source: parts.source };
}
