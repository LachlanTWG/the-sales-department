"use client";

// Structured EOD outcome editor. The row still stores one pipe-delimited line;
// these controls are the same choices the EOD form submits.

import {
  EOD_ANSWERS,
  EOD_STAGES,
  STAGE_SHORT_LABELS,
  actionGroups,
  eodSources,
  presentEodOutcome,
  serializeEodOutcome,
  type EodOutcomeParts,
} from "@/lib/eodOutcome";

function withCurrent(options: string[], current: string): string[] {
  if (!current || options.includes(current)) return options;
  return [current, ...options];
}

function choiceClass(selected: boolean, tone: "stage" | "answered" | "missed"): string {
  if (!selected) {
    return "rounded border border-zinc-800 bg-zinc-900 px-2 py-2 text-center text-sm text-zinc-400 hover:border-zinc-600";
  }
  if (tone === "missed") {
    return "rounded border border-amber-600 bg-amber-600/15 px-2 py-2 text-center text-sm font-medium text-amber-700 dark:text-amber-300";
  }
  if (tone === "stage") {
    return "rounded border border-sky-600 bg-sky-600/15 px-2 py-2 text-center text-sm font-medium text-sky-700 dark:text-sky-300";
  }
  return "rounded border border-emerald-600 bg-emerald-600/20 px-2 py-2 text-center text-sm font-medium text-emerald-300";
}

export function OutcomeFields({
  value,
  onChange,
  ownerName,
  companyName,
  inputClass,
}: {
  value: string;
  onChange: (next: string) => void;
  ownerName?: string | null;
  companyName?: string | null;
  inputClass: string;
}) {
  const parts = presentEodOutcome(value, { ownerName, companyName });
  const groups = actionGroups(ownerName);
  const knownActions = new Set(groups.flatMap(group => group.items));
  const sources = eodSources(companyName);

  function update(patch: Partial<EodOutcomeParts>) {
    onChange(serializeEodOutcome({ ...parts, ...patch }));
  }

  return (
    <fieldset className="m-0 min-w-0 space-y-3 border-0 p-0">
      <legend className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">Outcome</legend>

      <div>
        <span className="block text-[11px] font-medium uppercase tracking-wider text-zinc-500">Stage</span>
        <div className="mt-1.5 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Stage">
          {withCurrent(EOD_STAGES, parts.stage).map(stage => (
            <button
              key={stage}
              type="button"
              role="radio"
              aria-checked={parts.stage === stage}
              onClick={() => update({ stage })}
              className={choiceClass(parts.stage === stage, "stage")}
            >
              {STAGE_SHORT_LABELS[stage] ?? stage}
            </button>
          ))}
        </div>
      </div>

      <div>
        <span className="block text-[11px] font-medium uppercase tracking-wider text-zinc-500">Answered?</span>
        <div className="mt-1.5 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Answered?">
          {withCurrent(EOD_ANSWERS, parts.answered).map(answer => (
            <button
              key={answer}
              type="button"
              role="radio"
              aria-checked={parts.answered === answer}
              onClick={() => update({ answered: answer })}
              className={choiceClass(parts.answered === answer, answer === "Didn't Answer" ? "missed" : "answered")}
            >
              {answer}
            </button>
          ))}
        </div>
      </div>

      <label className="block">
        <span className="block text-[11px] font-medium uppercase tracking-wider text-zinc-500">Standard outcome</span>
        <select
          value={parts.action}
          onChange={e => update({ action: e.target.value })}
          className={`${inputClass} mt-1.5`}
        >
          <option value="">—</option>
          {parts.action && !knownActions.has(parts.action) && (
            <option value={parts.action}>{parts.action}</option>
          )}
          {groups.map(group => (
            <optgroup key={group.label} label={group.label}>
              {group.items.map(item => (
                <option key={item} value={item}>{item}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="block text-[11px] font-medium uppercase tracking-wider text-zinc-500">Custom outcome</span>
        <input
          type="text"
          value={parts.notes}
          onChange={e => update({ notes: e.target.value })}
          className={`${inputClass} mt-1.5`}
          placeholder="Optional note"
        />
      </label>

      <label className="block">
        <span className="block text-[11px] font-medium uppercase tracking-wider text-zinc-500">Contact source</span>
        <select
          value={parts.source}
          onChange={e => update({ source: e.target.value })}
          className={`${inputClass} mt-1.5`}
        >
          <option value="">—</option>
          {withCurrent(sources, parts.source).map(source => (
            <option key={source} value={source}>{source}</option>
          ))}
        </select>
      </label>

      <p className="text-[10px] text-zinc-500">Saved as one line, the same way the reports read it.</p>
    </fieldset>
  );
}
