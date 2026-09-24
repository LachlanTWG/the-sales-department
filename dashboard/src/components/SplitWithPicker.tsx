"use client";

import { splitPartnerOptions } from "@/lib/manualActivities";

export function SplitWithPicker({
  loggerName,
  selected,
  onChange,
}: {
  loggerName: string;
  selected: string[];
  onChange: (names: string[]) => void;
}) {
  const options = splitPartnerOptions(loggerName);

  function toggle(name: string) {
    onChange(
      selected.includes(name) ? selected.filter(n => n !== name) : [...selected, name],
    );
  }

  return (
    <div className="mt-2 space-y-1 pl-5">
      <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
        Split with
      </div>
      {options.map(name => (
        <label key={name} className="flex items-center gap-2 text-xs text-zinc-300">
          <input
            type="checkbox"
            checked={selected.includes(name)}
            onChange={() => toggle(name)}
            className="rounded border-zinc-600 bg-zinc-900"
          />
          {name}
        </label>
      ))}
      <p className="text-[11px] text-zinc-500">
        Your share is included. Tick everyone else on this deal.
      </p>
    </div>
  );
}
