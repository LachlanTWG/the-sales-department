import { getViewer, requireRosterOrAdmin } from "@/lib/viewer";
import { getEmailSettingsData } from "./actions";
import { MailboxConnectPanel } from "./MailboxConnectPanel";
import { isMailboxConnectConfigured } from "@/lib/mailboxConnect";

export const dynamic = "force-dynamic";

function friendlyMailboxError(raw: string) {
  const s = raw.toLowerCase();
  if (
    s.includes("access_denied") ||
    s.includes("verification") ||
    s.includes("unverified") ||
    s.includes("missing code") ||
    s.includes("access blocked")
  ) {
    return (
      "Google blocked this mailbox. The Gmail app is in testing — only approved testers can connect. " +
      "Add the Google address as a test user in Google Cloud → Auth → Audience, then try again."
    );
  }
  return raw;
}

export default async function EmailSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    connected?: string;
    email?: string;
    provider?: string;
    company?: string;
    error?: string;
  }>;
}) {
  const viewer = await getViewer();
  requireRosterOrAdmin(viewer);
  const sp = await searchParams;

  const data = await getEmailSettingsData();
  const configured = isMailboxConnectConfigured();
  const dashBase =
    process.env.DASHBOARD_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    "https://eod-creator.vercel.app";
  const returnUrl = `${dashBase.replace(/\/+$/, "")}/settings/email`;

  let flash: { kind: "ok" | "error"; message: string } | null = null;
  if (sp.error) {
    flash = { kind: "error", message: friendlyMailboxError(sp.error) };
  } else if (sp.connected === "1") {
    const who = sp.provider === "outlook" ? "Outlook" : sp.provider === "gmail" ? "Gmail" : "Mailbox";
    const client = sp.company ? ` for ${sp.company}` : "";
    flash = {
      kind: "ok",
      message: sp.email
        ? `${who} connected as ${sp.email}${client}. Recent sent mail is being backfilled.`
        : `${who} connected${client}. Recent sent mail is being backfilled.`,
    };
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-zinc-100">Email tracking</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Primary path for <span className="text-zinc-300">Email sent</span>.
          One mailbox per <span className="text-zinc-300">client</span> you sell
          for.{" "}
          <span className="text-zinc-300">Gmail</span> (HDK, LRS, Hughes, ECE,
          Nexgen, Enervia) needs the mailbox on Google&apos;s tester list first.{" "}
          <span className="text-zinc-300">Outlook</span> for Bolton, Phased,
          Sunbridge.
        </p>
      </div>

      {!configured && (
        <div className="mb-4 rounded border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
          Server config incomplete. Dashboard needs{" "}
          <code className="text-amber-100">NODE_SERVICE_URL</code> +{" "}
          <code className="text-amber-100">WEBHOOK_SECRET</code>. Railway needs
          OAuth for Gmail and/or Outlook.
        </div>
      )}

      {!viewer.salesPersonName && (
        <div className="mb-4 rounded border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
          Your login isn&apos;t linked to a roster name. An admin must set{" "}
          <code className="text-amber-100">sales_people.user_id</code>.
        </div>
      )}

      <MailboxConnectPanel
        connections={data.connections}
        companies={data.companies}
        connectedCompanyIds={data.connectedCompanyIds}
        returnUrl={returnUrl}
        unmatchedLast7d={data.unmatchedLast7d}
        flash={flash}
      />

      <div className="mt-8 space-y-3 text-sm text-zinc-500">
        <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-400">
          How it works
        </h2>
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            For each client, pick that client → connect with the recommended
            provider (Gmail for Google Workspace clients, Outlook otherwise).
          </li>
          <li>
            Sent mail from that mailbox is attributed to{" "}
            <span className="text-zinc-300">that client only</span>. Every
            outbound email counts (self/noreply filtered only).
          </li>
          <li>
            Repeat for every client you work. Different clients can use different
            providers or different addresses.
          </li>
          <li>
            Quotes stay on Quotie /{" "}
            <code className="text-zinc-400">/webhook/quote</code>.
          </li>
        </ol>
      </div>
    </div>
  );
}
