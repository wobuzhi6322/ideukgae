// =============================================================================
// GET /api/studio/feed — 대시보드 실시간 피드 (WSC, 10초 폴링)
// 계약: docs/WEB_TECH_SPEC.md §2.3 — 최근 매칭 50건 + 오늘 합계·건수(KST)
// + 프로그램 연결 상태(online: 마지막 heartbeat ≤ LIMITS.heartbeatOnlineSeconds)
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import type { IncomingMessage, ServerResponse } from "node:http";

import { LIMITS, type StudioDonationRow, type WebErrorCode } from "../_webShared.js";

const pagesTable = "bbbb_streamer_pages";
const matchesTable = "bbbb_donation_matches";
const messagesTable = "bbbb_donation_messages";
const relayDevicesTable = "bbbb_relay_devices";

export type StudioFeedResponse = {
  handle: string;
  items: StudioDonationRow[];
  todayTotal: number;
  todayCount: number;
  online: boolean;
  lastHeartbeatAt: string | null;
};

type MatchRow = {
  id: string;
  message_id: string | null;
  matched_by: "auto" | "manual" | null;
  sender_raw: string | null;
  amount: number | null;
  reported_at: string;
};

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "지원하지 않는 메서드입니다.", code: "method-not-allowed" });
    return;
  }

  try {
    const supabase = serviceClient();
    const user = await requireUser(req, supabase);
    const page = await requireOwnedPage(user.id, supabase);

    const matches = await supabase
      .from(matchesTable)
      .select("id,message_id,matched_by,sender_raw,amount,reported_at")
      .eq("page_id", page.id)
      .order("reported_at", { ascending: false })
      .limit(50);
    if (matches.error) throw new Error(matches.error.message);
    const matchRows = (matches.data || []) as MatchRow[];

    const messageIds = matchRows.map((row) => row.message_id).filter((id): id is string => Boolean(id));
    const messageMap = new Map<string, { nickname: string; message: string }>();
    if (messageIds.length > 0) {
      const messages = await supabase.from(messagesTable).select("id,nickname,message").in("id", messageIds);
      if (messages.error) throw new Error(messages.error.message);
      for (const row of (messages.data || []) as Array<{ id: string; nickname: string; message: string }>) {
        messageMap.set(row.id, { nickname: row.nickname, message: row.message });
      }
    }

    const items: StudioDonationRow[] = matchRows.map((row) => {
      const message = row.message_id ? messageMap.get(row.message_id) : undefined;
      return {
        matchId: row.id,
        messageId: row.message_id,
        matchedBy: row.matched_by,
        senderRaw: row.sender_raw,
        amount: row.amount,
        nickname: message ? message.nickname : null,
        message: message ? message.message : null,
        reportedAt: row.reported_at
      };
    });

    const todayStart = kstDayStartIso(Date.now());
    const today = await supabase
      .from(matchesTable)
      .select("amount")
      .eq("page_id", page.id)
      .gte("reported_at", todayStart)
      .limit(2000);
    if (today.error) throw new Error(today.error.message);
    const todayRows = (today.data || []) as Array<{ amount: number | null }>;
    const todayTotal = todayRows.reduce((sum, row) => sum + (row.amount || 0), 0);
    const todayCount = todayRows.length;

    const device = await supabase
      .from(relayDevicesTable)
      .select("last_heartbeat_at")
      .eq("page_id", page.id)
      .eq("active", true)
      .order("last_heartbeat_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (device.error) throw new Error(device.error.message);
    const lastHeartbeatAt = device.data ? (device.data.last_heartbeat_at as string | null) : null;

    const data: StudioFeedResponse = {
      handle: page.handle,
      items,
      todayTotal,
      todayCount,
      online: isDeviceOnline(lastHeartbeatAt, Date.now()),
      lastHeartbeatAt
    };
    sendJson(res, 200, { ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
}

// ---------------------------------------------------------------------------
// 순수 로직 (tests/studioLogic.test.ts)
// ---------------------------------------------------------------------------

/** UTC 저장·KST 표시 원칙: KST 기준 오늘 0시를 UTC ISO로 */
export function kstDayStartIso(nowMs: number): string {
  const KST_OFFSET_MS = 9 * 3600 * 1000;
  const kstDayStart = Math.floor((nowMs + KST_OFFSET_MS) / 86_400_000) * 86_400_000;
  return new Date(kstDayStart - KST_OFFSET_MS).toISOString();
}

/** 마지막 heartbeat가 LIMITS.heartbeatOnlineSeconds(180초) 이내면 온라인 */
export function isDeviceOnline(lastHeartbeatAt: string | null, nowMs: number): boolean {
  if (!lastHeartbeatAt) return false;
  const at = Date.parse(lastHeartbeatAt);
  if (Number.isNaN(at)) return false;
  return nowMs - at <= LIMITS.heartbeatOnlineSeconds * 1000;
}

// ---------------------------------------------------------------------------
// 공통 헬퍼 (api/devices/register.ts 패턴)
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: WebErrorCode
  ) {
    super(message);
  }
}

async function requireOwnedPage(
  userId: string,
  supabase: ReturnType<typeof serviceClient>
): Promise<{ id: string; handle: string }> {
  const result = await supabase.from(pagesTable).select("id,handle").eq("owner_user_id", userId).maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) {
    throw new ApiError(404, "채널 페이지가 아직 없습니다. 스트리머 가입에서 핸들을 먼저 만들어 주세요.", "not-found");
  }
  return result.data as { id: string; handle: string };
}

async function requireUser(req: IncomingMessage, supabase: ReturnType<typeof serviceClient>) {
  const token = bearerToken(req);
  if (!token) throw new ApiError(401, "로그인이 필요합니다.", "auth-required");
  const result = await supabase.auth.getUser(token);
  if (result.error || !result.data.user) throw new ApiError(401, "로그인 세션을 확인할 수 없습니다.", "auth-required");
  return result.data.user;
}

function serviceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function bearerToken(req: IncomingMessage): string | undefined {
  const value = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof ApiError) {
    sendJson(res, error.status, { ok: false, error: error.message, code: error.code });
    return;
  }
  sendJson(res, 400, {
    ok: false,
    error: error instanceof Error ? error.message : "요청을 처리하지 못했습니다.",
    code: "validation-failed"
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "authorization,content-type"
  });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}

function setCors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization,content-type");
}
