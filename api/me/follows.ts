// =============================================================================
// /api/me/follows — 팔로우 목록·추가·해제 (WSD, 로그인)
// 계약: docs/WEB_TECH_SPEC.md §2.2 · docs/WEB_PAGE_SPECS.md §4 (/me/following)
//   GET             → { channels: FollowedChannel[] } (라이브·시그니처 수 포함)
//   POST   {handle} → { followed: true, handle }
//   DELETE {handle} → { followed: false, handle }
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { ChannelCard, WebErrorCode } from "../_webShared.js";
import { isOnlineHeartbeat } from "../channels.js";

const followsTable = "bbbb_page_follows";
const pagesTable = "bbbb_streamer_pages";
const profilesTable = "bbbb_web_profiles";
const signaturesTable = "bbbb_page_signatures";
const relayDevicesTable = "bbbb_relay_devices";

const FOLLOWS_MAX = 200;

export type FollowedChannel = ChannelCard & { followedAt: string };
export type MyFollowsData = { channels: FollowedChannel[] };
export type FollowMutationData = { followed: boolean; handle: string };

type FollowRow = {
  created_at: string;
  page: PageRef | PageRef[] | null;
};

type PageRef = {
  id: string;
  owner_user_id: string;
  handle: string;
  banner_url: string | null;
  avatar_url: string | null;
  bio: string | null;
  status: "active" | "hidden" | "suspended";
};

type FollowBody = { handle?: unknown };

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") {
    sendError(res, 405, "method-not-allowed", "허용되지 않는 요청입니다.");
    return;
  }

  try {
    const supabase = serviceClient();
    const user = await requireUser(req, supabase);
    if (!user) {
      sendError(res, 401, "auth-required", "로그인이 필요합니다.");
      return;
    }

    if (req.method === "GET") {
      const data = await listFollows(supabase, user.id);
      sendJson(res, 200, { ok: true, data });
      return;
    }

    const body = (await readJson(req)) as FollowBody;
    const handle = typeof body.handle === "string" ? body.handle.trim().toLowerCase() : "";
    if (!handle) {
      sendError(res, 400, "validation-failed", "채널 핸들이 필요합니다.");
      return;
    }

    const page = await supabase
      .from(pagesTable)
      .select("id,status")
      .eq("handle", handle)
      .maybeSingle();
    if (page.error) {
      throw new Error(page.error.message);
    }
    const pageRow = page.data as { id: string; status: string } | null;
    if (!pageRow || pageRow.status === "suspended") {
      sendError(res, 404, "not-found", "채널을 찾을 수 없습니다.");
      return;
    }

    if (req.method === "POST") {
      const insert = await supabase
        .from(followsTable)
        .upsert(
          { viewer_user_id: user.id, page_id: pageRow.id },
          { onConflict: "viewer_user_id,page_id", ignoreDuplicates: true }
        );
      if (insert.error) {
        throw new Error(insert.error.message);
      }
      sendJson(res, 200, { ok: true, data: { followed: true, handle } satisfies FollowMutationData });
      return;
    }

    const remove = await supabase
      .from(followsTable)
      .delete()
      .eq("viewer_user_id", user.id)
      .eq("page_id", pageRow.id);
    if (remove.error) {
      throw new Error(remove.error.message);
    }
    sendJson(res, 200, { ok: true, data: { followed: false, handle } satisfies FollowMutationData });
  } catch (error) {
    sendError(res, 500, "validation-failed", error instanceof Error ? error.message : "follows-failed");
  }
}

async function listFollows(supabase: ReturnType<typeof serviceClient>, userId: string): Promise<MyFollowsData> {
  const result = await supabase
    .from(followsTable)
    .select(`created_at,page:${pagesTable}(id,owner_user_id,handle,banner_url,avatar_url,bio,status)`)
    .eq("viewer_user_id", userId)
    .order("created_at", { ascending: false })
    .limit(FOLLOWS_MAX);
  if (result.error) {
    throw new Error(result.error.message);
  }

  const rows = (result.data || []) as unknown as FollowRow[];
  const pages: { followedAt: string; page: PageRef }[] = [];
  for (const row of rows) {
    const page = firstOf(row.page);
    if (page && page.status === "active") {
      pages.push({ followedAt: row.created_at, page });
    }
  }

  const pageIds = pages.map((entry) => entry.page.id);
  const ownerIds = Array.from(new Set(pages.map((entry) => entry.page.owner_user_id)));
  const nowMs = Date.now();
  const [signatureCounts, nicknames, onlinePages] = await Promise.all([
    fetchPublishedSignatureCounts(supabase, pageIds),
    fetchNicknames(supabase, ownerIds),
    fetchOnlinePages(supabase, pageIds, nowMs)
  ]);

  const channels: FollowedChannel[] = pages.map((entry) => ({
    handle: entry.page.handle,
    displayName: nicknames.get(entry.page.owner_user_id) || entry.page.handle,
    bannerUrl: entry.page.banner_url,
    avatarUrl: entry.page.avatar_url,
    bio: entry.page.bio,
    signatureCount: signatureCounts.get(entry.page.id) || 0,
    online: onlinePages.has(entry.page.id),
    followedAt: entry.followedAt
  }));
  return { channels };
}

function firstOf<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

async function fetchPublishedSignatureCounts(
  supabase: ReturnType<typeof serviceClient>,
  pageIds: string[]
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!pageIds.length) return counts;
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

async function requireUser(req: IncomingMessage, supabase: ReturnType<typeof serviceClient>) {
  const token = bearerToken(req);
  if (!token) return null;
  const result = await supabase.auth.getUser(token);
  if (result.error || !result.data.user) return null;
  return result.data.user;
}

function bearerToken(req: IncomingMessage): string | undefined {
  const value = headerValue(req.headers.authorization);
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (!chunks.length) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

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
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type"
  });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}

function setCors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization,content-type");
}
