"use server";

import { revalidatePath } from "next/cache";
import { getViewer } from "@/lib/viewer";
import { createAdminClient } from "@/lib/supabase/admin";

function canManage(viewer: { isAdmin: boolean; isConversion: boolean }) {
  return viewer.isAdmin || viewer.isConversion;
}

export async function saveAdAccountForm(formData: FormData): Promise<void> {
  await saveAdAccount(formData);
}

export async function addManualSpendForm(formData: FormData): Promise<void> {
  await addManualSpend(formData);
}

export async function syncMetaSpendForm(formData: FormData): Promise<void> {
  await syncMetaSpend(formData);
}

export async function saveAdAccount(formData: FormData): Promise<{ ok: true } | { ok: false; error: string }> {
  const viewer = await getViewer();
  if (!canManage(viewer)) return { ok: false, error: "Not allowed" };
  const companyId = String(formData.get("companyId") || "");
  const slug = String(formData.get("slug") || "");
  if (!companyId) return { ok: false, error: "Missing company" };

  const pixelId = String(formData.get("pixelId") || "").trim() || null;
  const adAccountId = String(formData.get("adAccountId") || "").trim().replace(/^act_/, "") || null;
  const token = String(formData.get("accessToken") || "").trim();

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("company_ad_accounts")
    .select("meta_access_token")
    .eq("company_id", companyId)
    .maybeSingle();

  const { error } = await admin.from("company_ad_accounts").upsert({
    company_id: companyId,
    pixel_id: pixelId,
    meta_ad_account_id: adAccountId ? `act_${adAccountId}` : null,
    meta_access_token: token || existing?.meta_access_token || null,
    updated_at: new Date().toISOString(),
    updated_by: viewer.user.id,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/conversion");
  revalidatePath(`/conversion/${slug}`);
  return { ok: true };
}

export async function addManualSpend(formData: FormData): Promise<{ ok: true } | { ok: false; error: string }> {
  const viewer = await getViewer();
  if (!canManage(viewer)) return { ok: false, error: "Not allowed" };
  const companyId = String(formData.get("companyId") || "");
  const slug = String(formData.get("slug") || "");
  const spendOn = String(formData.get("spendOn") || "");
  const campaignName = String(formData.get("campaignName") || "").trim() || "Manual";
  const spend = Number(formData.get("spend"));
  if (!companyId || !/^\d{4}-\d{2}-\d{2}$/.test(spendOn)) return { ok: false, error: "Need a date" };
  if (!Number.isFinite(spend) || spend < 0) return { ok: false, error: "Need a spend amount" };

  const admin = createAdminClient();
  const { error } = await admin.from("ad_spend").insert({
    company_id: companyId,
    provider: "manual",
    spend_on: spendOn,
    campaign_name: campaignName,
    spend,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/conversion");
  revalidatePath(`/conversion/${slug}`);
  return { ok: true };
}

export async function syncMetaSpend(formData: FormData): Promise<{ ok: true; days: number } | { ok: false; error: string }> {
  const viewer = await getViewer();
  if (!canManage(viewer)) return { ok: false, error: "Not allowed" };
  const companyId = String(formData.get("companyId") || "");
  const slug = String(formData.get("slug") || "");
  const from = String(formData.get("from") || "");
  const to = String(formData.get("to") || "");
  if (!companyId) return { ok: false, error: "Missing company" };

  const admin = createAdminClient();
  const { data: acct } = await admin
    .from("company_ad_accounts")
    .select("meta_ad_account_id, meta_access_token")
    .eq("company_id", companyId)
    .maybeSingle();
  if (!acct?.meta_ad_account_id || !acct.meta_access_token) {
    return { ok: false, error: "Save a Meta ad account ID and access token first" };
  }

  const actId = acct.meta_ad_account_id.startsWith("act_")
    ? acct.meta_ad_account_id
    : `act_${acct.meta_ad_account_id}`;
  const url = new URL(`https://graph.facebook.com/v21.0/${actId}/insights`);
  url.searchParams.set("level", "campaign");
  url.searchParams.set("time_increment", "1");
  url.searchParams.set("fields", "campaign_id,campaign_name,spend,impressions,clicks,inline_link_clicks,date_start");
  url.searchParams.set("time_range", JSON.stringify({ since: from, until: to }));
  url.searchParams.set("access_token", acct.meta_access_token);
  url.searchParams.set("limit", "500");

  const res = await fetch(url.toString());
  const json = await res.json() as {
    data?: {
      campaign_id?: string;
      campaign_name?: string;
      spend?: string;
      impressions?: string;
      clicks?: string;
      inline_link_clicks?: string;
      date_start?: string;
    }[];
    error?: { message?: string };
  };
  if (!res.ok || json.error) {
    return { ok: false, error: json.error?.message || `Meta API ${res.status}` };
  }

  const rows = json.data || [];
  await admin.from("ad_spend")
    .delete()
    .eq("company_id", companyId)
    .eq("provider", "meta")
    .gte("spend_on", from)
    .lte("spend_on", to);
  if (rows.length > 0) {
    const { error } = await admin.from("ad_spend").insert(rows.filter(r => r.date_start).map(row => ({
      company_id: companyId,
      provider: "meta",
      spend_on: row.date_start,
      campaign_id: row.campaign_id || null,
      campaign_name: row.campaign_name || null,
      spend: Number(row.spend) || 0,
      impressions: Number(row.impressions) || 0,
      clicks: Number(row.clicks) || 0,
      link_clicks: Number(row.inline_link_clicks) || 0,
    })));
    if (error) return { ok: false, error: error.message };
  }
  revalidatePath("/conversion");
  revalidatePath(`/conversion/${slug}`);
  return { ok: true, days: rows.length };
}
