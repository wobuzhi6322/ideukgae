// =============================================================================
// GET /api/channels?q=&cursor= — 채널 탐색 디렉토리 (WSD, 공개·비로그인)
// 계약: docs/WEB_TECH_SPEC.md §2.1 · docs/WEB_PAGE_SPECS.md §5
// 노출 조건: directory_optin=true AND status='active' AND 공개 시그니처 ≥ 1
// 정렬: 최근 활동순(created_at desc) · 커서 페이지네이션 20개
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import type { IncomingMessage, ServerResponse } from "node:http";

import { LIMITS, type ChannelCard, type WebErrorCode } from "./_webShared.js";

const pagesTable = "bbbb_streamer_pages";
const profilesTable = "bbbb_web_profiles";
const signaturesTable = "bbbb_page_signatures";
const relayDevicesTable = "bbbb_relay_devices";

export const CHANNELS_PAGE_SIZE = 20;
const BATCH_SIZE = 100;
const MAX_BATCHES = 5;
const QUERY_MAX_LENGTH = 50;

export type ChannelsListData = {
  channels: ChannelCard[];
  nextCursor: string | null;
};

type PageRow = {
  id: string;
  owner_user_id: string;
  handle: string;
  banner_url: string | null;
  avatar_url: string | null;
  bio: string | null;
  created_at: string;
};

// ---------------------------------------------------------------------------
// 순수 헬퍼 (tests/wsdViewer.test.ts에서 검증)
// ---------------------------------------------------------------------------

export type ListCursor = { createdAt: string; id: string };

export function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.createdAt, i: cursor.id }), "utf8").toString("base64url");
}

export function decodeCursor(raw: string | null | undefined): ListCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { t?: unknown; i?: unknown };
    if (typeof parsed.t !== "string" || typeof parsed.i !== "string" || !parsed.i) return null;
    if (Number.isNaN(Date.parse(parsed.t))) return null;
    return { createdAt: parsed.t, id: parsed.i };
  } catch {
    return null;
  }
}

/** 검색어(q)가 핸들 또는 채널명에 부분 일치하는가 (대소문자 무시, 빈 q는 전체) */
export function matchesChannelQuery(q: string, handle: string, displayName: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return handle.toLowerCase().includes(needle) || displayName.toLowerCase().includes(needle);
}

/** last_heartbeat_at이 3분(LIMITS.heartbeatOnlineSeconds) 이내면 온라인 */
export function isOnlineHeartbeat(lastHeartbeatAt: string | null | undefined, nowMs: number): boolean {
  if (!lastHeartbeatAt) return false;
  const at = Date.parse(lastHeartbeatAt);
  if (Number.isNaN(at)) return false;
  return nowMs - at <= LIMITS.heartbeatOnlineSeconds * 1000;
}

// ---------------------------------------------------------------------------
// 핸들러
// ---------------------------------------------------------------------------

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== "GET") {
    sendError(res, 405, "method-not-allowed", "허용되지 않는 요청입니다.");
    return;
  }

  try {
    const url = new URL(req.url || "/", "http://local");
    const q = (url.searchParams.get("q") || "").slice(0, QUERY_MAX_LENGTH);
    const cursorRaw = url.searchParams.get("cursor");
    const cursor = decodeCursor(cursorRaw);
    if (cursorRaw && !cursor) {
      sendError(res, 400, "validation-failed", "잘못된 커서입니다.");
      return;
    }

    const supabase = serviceClient();
    const data = await listChannels(supabase, q, cursor);
    sendJson(res, 200, { ok: true, data });
  } catch (error) {
    sendError(res, 500, "validation-failed", error instanceof Error ? error.message : "channels-failed");
  }
}

async function listChannels(
  supabase: ReturnType<typeof serviceClient>,
  q: string,
  cursor: ListCursor | null
): Promise<ChannelsListData> {
  const nowMs = Date.now();
  const channels: ChannelCard[] = [];
  let nextCursor: string | null = null;
  let after = cursor;
  let filled = false;
  let exhausted = false;

  for (let batch = 0; batch < MAX_BATCHES && !filled && !exhausted; batch += 1) {
    let query = supabase
      .from(pagesTable)
      .select("id,owner_user_id,handle,banner_url,avatar_url,bio,created_at")
      .eq("directory_optin", true)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(BATCH_SIZE);
    if (after) {
      query = query.or(`created_at.lt.${after.createdAt},and(created_at.eq.${after.createdAt},id.lt.${after.id})`);
    }
    const result = await query;
    if (result.error) {
      throw new Error(result.error.message);
    }
    const rows = (result.data || []) as PageRow[];
    if (!rows.length) {
      exhausted = true;
      break;
    }

    const pageIds = rows.map((row) => row.id);
    const ownerIds = rows.map((row) => row.owner_user_id);
    const [signatureCounts, nicknames, onlinePages] = await Promise.all([
      fetchPublishedSignatureCounts(supabase, pageIds),
      fetchNicknames(supabase, ownerIds),
      fetchOnlinePages(supabase, pageIds, nowMs)
    ]);

    for (const row of rows) {
      const signatureCount = signatureCounts.get(row.id) || 0;
      if (signatureCount < 1) continue;
      const displayName = nicknames.get(row.owner_user_id) || row.handle;
      if (!matchesChannelQuery(q, row.handle, displayName)) continue;
      channels.push({
        handle: row.handle,
        displayName,
        bannerUrl: row.banner_url,
        avatarUrl: row.avatar_url,
        bio: row.bio,
        signatureCount,
        online: onlinePages.has(row.id)
      });
      if (channels.length >= CHANNELS_PAGE_SIZE) {
        nextCursor = encodeCursor({ createdAt: row.created_at, id: row.id });
        filled = true;
        break;
      }
    }

    if (!filled) {
      const last = rows[rows.length - 1];
      after = { createdAt: last.created_at, id: last.id };
      if (rows.length < BATCH_SIZE) {
        exhausted = true;
      }
    }
  }

  // MAX_BATCHES를 소진했지만 목록 뒤가 남아 있을 수 있으면 이어보기 커서를 준다.
  if (!filled && !exhausted && after) {
    nextCursor = encodeCursor(after);
  }
  return { channels, nextCursor };
}

async function fetchPublishedSignatureCounts(
  supabase: ReturnType<typeof serviceClient>,
  pageIds: string[]
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!pageIds.length) return counts;
  // 초기 디렉토리 규모(페이지×시그니처 수백 건)에 맞춘 단순 집계.
  const result = await supabase
    .from(signaturesTable)
    .select("page_id")
    .in("page_id", pageIds)
    .eq("published", true)
    .limit(5000);
  if (result.error) {
    throw new Error(result.error.message);
  }
  for (const row of (result.data || []) as { page_id: string }[]) {
    counts.set(row.page_id, (counts.get(row.page_id) || 0) + 1);
  }
  return counts;
}

async function fetchNicknames(
  supabase: ReturnType<typeof serviceClient>,
  userIds: string[]
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!userIds.length) return names;
  const result = await supabase.from(profilesTable).select("user_id,nickname").in("user_id", userIds);
  if (result.error) {
    throw new Error(result.error.message);
  }
  for (const row of (result.data || []) as { user_id: string; nickname: string | null }[]) {
    if (row.nickname) names.set(row.user_id, row.nickname);
  }
  return names;
}

async function fetchOnlinePages(
  supabase: ReturnType<typeof serviceClient>,
  pageIds: string[],
  nowMs: number
): Promise<Set<string>> {
  const online = new Set<string>();
  if (!pageIds.length) return online;
  const result = await supabase
    .from(relayDevicesTable)
    .select("page_id,last_heartbeat_at")
    .in("page_id", pageIds)
    .eq("active", true);
  if (result.error) {
    throw new Error(result.error.message);
  }
  for (const row of (result.data || []) as { page_id: string; last_heartbeat_at: string | null }[]) {
    if (isOnlineHeartbeat(row.last_heartbeat_at, nowMs)) {
      online.add(row.page_id);
    }
  }
  return online;
}

// ---------------------------------------------------------------------------
// 공통 유틸 (저장소 관례: 파일 자급자족 — devices/register.ts 참조)
// ---------------------------------------------------------------------------

function serviceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

function sendError(res: ServerResponse, status: number, code: WebErrorCode, message: string): void {
  sendJson(res, status, { ok: false, error: message, code });
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
