"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  disconnectMailbox,
  startMailboxConnect,
  type CompanyOption,
  type MailboxConnection,
} from "./actions";
import type { MailboxProvider } from "@/lib/mailboxConnect";

const PROVIDER_LABEL: Record<MailboxProvider, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
};

export function MailboxConnectPanel({
  connections,
  companies,
  connectedCompanyIds,
  returnUrl,
  unmatchedLast7d,
  flash,
}: {
  connections: MailboxConnection[];
  companies: CompanyOption[];
  connectedCompanyIds: string[];
  returnUrl: string;
  unmatchedLast7d: number;
  flash: { kind: "ok" | "error"; message: string } | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const unboundCompanies = useMemo(
    () => companies.filter(c => !connectedCompanyIds.includes(c.id)),
    [companies, connectedCompanyIds],
  );

  const [companyId, setCompanyId] = useState(unboundCompanies[0]?.id ?? "");

  const selectedCompany = useMemo(
    () => unboundCompanies.find(c => c.id === companyId) || companies.find(c => c.id === companyId),
    [unboundCompanies, companies, companyId],
  );
  const preferredProvider: MailboxProvider = selectedCompany?.mailboxProvider || "gmail";
  const otherProvider: MailboxProvider = preferredProvider === "gmail" ? "outlook" : "gmail";

  function connect(provider: MailboxProvider, forCompanyId: string) {
    setError(null);
    if (!forCompanyId) {
      setError("Pick a client first");
      return;
    }
    startTransition(async () => {
      const res = await startMailboxConnect(forCompanyId, provider, returnUrl);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      window.location.href = res.url;
    });
  }

  function disconnect(companyIdToDrop: string, companyName: string) {
    if (!confirm(`Disconnect mailbox for ${companyName}?`)) return;
    setError(null);
    startTransition(async () => {
      const res = await disconnectMailbox(companyIdToDrop);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      {flash && (
        <div
          className={
            flash.kind === "ok"
              ? "rounded border border-emerald-900/50 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-300"
              : "rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300"
          }
        >
          {flash.message}
        </div>
      )}

      {/* Existing connections — one row per client */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40">
        <div className="border-b border-zinc-800 px-4 py-3">
          <div className="text-sm font-medium text-zinc-100">Your mailboxes</div>
          <p className="mt-0.5 text-xs text-zinc-500">
            One connection per client. Gmail mailboxes must be on the Google tester list.
          </p>
        </div>

        {connections.length === 0 ? (
          <div className="px-4 py-6 text-sm text-zinc-500">
            No mailboxes connected yet. Add one below for each client.
          </div>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {connections.map(c => {
              const needsReauth = c.status === "needs_reauth";
              return (
                <li key={c.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-zinc-100">{c.companyName}</span>
                      <span
                        className={
                          c.status === "active" && !needsReauth
                            ? "rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300"
                            : needsReauth
                              ? "rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300"
                              : "rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] font-medium text-zinc-400"
                        }
                      >
                        {needsReauth ? "Needs reauth" : c.status}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-xs text-zinc-400">
                      {PROVIDER_LABEL[c.provider]} · {c.email}
                      {c.lastSyncedAt && (
                        <>
                          {" "}
                          · synced{" "}
                          {new Date(c.lastSyncedAt).toLocaleString("en-AU", {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </>
                      )}
                    </div>
                    {c.lastError && (
                      <div className="mt-1 text-[11px] text-amber-300/90">{c.lastError}</div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {(needsReauth || c.status === "active") && (
                      <>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => connect(c.provider, c.companyId)}
                          className="rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
                        >
                          Reconnect {PROVIDER_LABEL[c.provider]}
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => connect(c.provider === "gmail" ? "outlook" : "gmail", c.companyId)}
                          className="rounded border border-zinc-800 px-2.5 py-1 text-xs text-zinc-500 hover:border-zinc-600 hover:text-zinc-300 disabled:opacity-50"
                        >
                          Switch to {c.provider === "gmail" ? "Outlook" : "Gmail"}
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => disconnect(c.companyId, c.companyName)}
                      className="rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:border-red-800 hover:text-red-300 disabled:opacity-50"
                    >
                      Disconnect
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Add connection for another client */}
      {unboundCompanies.length > 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="text-sm font-medium text-zinc-100">Add mailbox for a client</div>
          <p className="mt-1 text-xs text-zinc-500">
            Pick the client — we&apos;ll use their usual provider. You can override if needed.
          </p>

          <label className="mt-4 block">
            <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">
              Client
            </span>
            <select
              value={companyId}
              onChange={e => setCompanyId(e.target.value)}
              className="mt-1.5 w-full rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none"
            >
              {unboundCompanies.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name} ({PROVIDER_LABEL[c.mailboxProvider]})
                </option>
              ))}
            </select>
          </label>

          {selectedCompany && (
            <p className="mt-2 text-xs text-zinc-400">
              <span className="text-zinc-300">{selectedCompany.name}</span> usually uses{" "}
              <span className="font-medium text-zinc-200">
                {PROVIDER_LABEL[preferredProvider]}
              </span>
              {preferredProvider === "outlook"
                ? " (Microsoft 365)."
                : " (Google Workspace)."}
            </p>
          )}

          {preferredProvider === "gmail" && (
            <p className="mt-3 rounded border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-[11px] leading-relaxed text-amber-200/90">
              Gmail is still in Google testing. If you see{" "}
              <span className="text-amber-100">Access blocked</span> /{" "}
              <span className="text-amber-100">has not completed the Google verification process</span>
              , the mailbox isn&apos;t on the tester list yet. Send the address
              (e.g. admin@client.com) to Lachlan to add, then connect again.
            </p>
          )}

          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              disabled={pending || !companyId}
              onClick={() => connect(preferredProvider, companyId)}
              className="flex-1 rounded-lg border border-emerald-700 bg-emerald-600/20 px-3 py-3 text-left text-sm font-medium text-emerald-200 hover:bg-emerald-600/30 disabled:opacity-50"
            >
              <div>Connect {PROVIDER_LABEL[preferredProvider]}</div>
              <div className="mt-0.5 text-[11px] font-normal text-emerald-400/80">
                Recommended for this client
              </div>
            </button>
            <button
              type="button"
              disabled={pending || !companyId}
              onClick={() => connect(otherProvider, companyId)}
              className="rounded-lg border border-zinc-700 bg-zinc-950/50 px-3 py-3 text-left text-sm font-medium text-zinc-300 hover:border-zinc-500 disabled:opacity-50 sm:max-w-[11rem]"
            >
              <div>Use {PROVIDER_LABEL[otherProvider]}</div>
              <div className="mt-0.5 text-[11px] font-normal text-zinc-500">Override</div>
            </button>
          </div>
        </div>
      ) : companies.length > 0 ? (
        <p className="text-xs text-zinc-500">
          Every client on your roster already has a mailbox connected.
        </p>
      ) : (
        <p className="text-xs text-amber-300/90">
          No clients on your roster — ask an admin to add you to sales_people.
        </p>
      )}

      {error && (
        <div className="rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {connections.length > 0 && unmatchedLast7d > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
          <div className="font-medium text-zinc-200">Legacy unmatched (pre all-mail tracking)</div>
          <p className="mt-1">
            <span className="tabular-nums text-zinc-100">{unmatchedLast7d}</span> older
            skip{unmatchedLast7d === 1 ? "" : "s"} still on record. New sends count every
            external recipient — self/noreply only are filtered.
          </p>
        </div>
      )}

      {pending && (
        <p className="text-xs text-zinc-500">Working…</p>
      )}
    </div>
  );
}
