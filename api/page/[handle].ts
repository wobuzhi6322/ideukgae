// GET /api/page/:handle — 공개 페이지 뷰 (WEB_TECH_SPEC §2.1)
// active 페이지 + published 시그니처(pinned 우선, 금액 오름차순) + 디바이스
// online 여부. suspended/hidden은 존재를 숨기기 위해 동일하게 404 not-found.

import type { IncomingMessage, ServerResponse } from "node:http";

import type { PublicPageView, PublicSignatureCard } from "../_webShared.js";
import {
  TABLES,
  applyCors,
  handlePreflight,
  isDeviceOnline,
  publicAccountInfo,
  routeParam,
  sanitizeBroadcastLinks,
  sanitizePresetAmounts,
  sanitizeTransferLinks,
  sendErr,
  sendOk,
  sendServerError,
  serviceClient
} from "../_webServer.js";

type PageRow = {
  id: string;
  owner_user_id: string;
  handle: string;
  banner_url: string | null;
  avatar_url: string | null;
  bio: string | null;
  broadcast_links: unknown;
  preset_amounts: unknown;
  min_amount: number;
  ticker_public: boolean;
  account_display: string;
  account_info: unknown;
  transfer_links: unknown;
  status: string;
};

type SignatureRow = {
  id: string;
  title: string;
  web_title: string | null;
  amount: number;
  media_type: PublicSignatureCard["mediaType"];
  thumb_url: string | null;
  pinned: boolean;
};

const pageSelect =
  "id,owner_user_id,handle,banner_url,avatar_url,bio,broadcast_links,preset_amounts," +
  "min_amount,ticker_public,account_display,account_info,transfer_links,status";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  applyCors(res);
  if (handlePreflight(req, res)) return;
  if (req.method !== "GET") {
    sendErr(res, 405, "method-not-allowed");
    return;
  }

  try {
    // 경로: /api/page/:handle → 세그먼트 ['api','page',handle]
    const handle = routeParam(req, "handle", 2)?.toLowerCase();
    if (!handle) {
      sendErr(res, 404, "not-found");
      return;
    }

    const supabase = serviceClient();
    const pageResult = await supabase.from(TABLES.pages).select(pageSelect).eq("handle", handle).maybeSingle();
    if (pageResult.error) {
      throw new Error(pageResult.error.message);
    }
    const page = pageResult.data as PageRow | null;
    if (!page || page.status !== "active") {
      // hidden/suspended도 404 — 존재 여부를 구분해 주지 않는다 (§5)
      sendErr(res, 404, "not-found");
      return;
    }

    const [profileResult, signaturesResult, devicesResult] = await Promise.all([
      supabase.from(TABLES.profiles).select("nickname").eq("user_id", page.owner_user_id).maybeSingle(),
      supabase
        .from(TABLES.signatures)
        .select("id,title,web_title,amount,media_type,thumb_url,pinned")
        .eq("page_id", page.id)
        .eq("published", true)
        .order("pinned", { ascending: false })
        .order("amount", { ascending: true })
        .order("sort", { ascending: true }),
      supabase.from(TABLES.relayDevices).select("last_heartbeat_at").eq("page_id", page.id).eq("active", true)
    ]);
    if (signaturesResult.error) {
      throw new Error(signaturesResult.error.message);
    }
    if (devicesResult.error) {
      throw new Error(devicesResult.error.message);
    }

    const nickname = (profileResult.data as { nickname: string } | null)?.nickname;
    const now = Date.now();
    const online = ((devicesResult.data ?? []) as { last_heartbeat_at: string | null }[]).some((device) =>
      isDeviceOnline(device.last_heartbeat_at, now)
    );

    const signatures: PublicSignatureCard[] = ((signaturesResult.data ?? []) as SignatureRow[]).map((row) => ({
      id: row.id,
      title: row.web_title ?? row.title,
      amount: row.amount,
      mediaType: row.media_type,
      thumbUrl: row.thumb_url,
      pinned: row.pinned
    }));

    const view: PublicPageView = {
      handle: page.handle,
      displayName: nickname || page.handle,
      bannerUrl: page.banner_url,
      avatarUrl: page.avatar_url,
      bio: page.bio,
      broadcastLinks: sanitizeBroadcastLinks(page.broadcast_links),
      presetAmounts: sanitizePresetAmounts(page.preset_amounts),
      minAmount: page.min_amount,
      tickerPublic: page.ticker_public,
      online,
      signatures,
      transferLinks: sanitizeTransferLinks(page.transfer_links),
      accountInfo: publicAccountInfo(page.account_display, page.account_info)
    };
    sendOk(res, view);
  } catch (error) {
    sendServerError(res, error);
  }
}
