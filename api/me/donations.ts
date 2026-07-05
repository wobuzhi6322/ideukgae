// =============================================================================
// GET /api/me/donations?cursor=&handle=&from=&to= — 내 후원 내역 (WSD, 로그인)
// 계약: docs/WEB_TECH_SPEC.md §2.2 · docs/WEB_PAGE_SPECS.md §4 (/me/donations)
// viewer_user_id 기준 bbbb_donation_messages ⋈ bbbb_streamer_pages.
// 커서 페이지네이션 20개 · 채널(handle)·기간(from/to) 필터.
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { MyDonationItem, WebErrorCode } from "../_webShared.js";
import { decodeCursor, encodeCursor } from "../channels.js";

const messagesTable = "bbbb_donation_messages";
const pagesTable = "bbbb_streamer_pages";
const profilesTable = "bbbb_web_profiles";

export const DONATIONS_PAGE_SIZE = 20;

export type MyDonationsData = {
  items: MyDonationItem[];
  nextCursor: string | null;
};

type MessageRow = {
  id: string;
  nickname: string;
  message: string;
  amount: number;
  status: MyDonationItem["status"];
  expires_at: string;
  created_at: string;
  page: PageRef | PageRef[] | null;
};

type PageRef = { handle: string; owner_user_id: string };

// ---------------------------------------------------------------------------
// 순수 헬퍼 (tests/wsdViewer.test.ts에서 검증)
// ---------------------------------------------------------------------------

/**
 * 표시용 상태: DB status가 아직 'pending'이어도 expires_at이 지났으면 '만료'로 보인다.
 * (grace 창에서 늦게 매칭되면 이후 조회에서 '전달됨'으로 바뀐다 — §3.1 만료 카피와 동일 사상)
 */
export function effectiveDonationStatus(
  status: MyDonationItem["status"],
  expiresAtIso: string,
  nowMs: number
): MyDonationItem["status"] {
  if (status !== "pending") return status;
  const expires = Date.parse(expiresAtIso);
  if (!Number.isNaN(expires) && nowMs > expires) return "expired";
  return "pending";
}

/** PostgREST 임베드가 객체/배열 어느 쪽으로 와도 첫 항목을 취한다 */
export function firstOf<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
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
    const supabase = serviceClient();
    const user = await requireUser(req, supabase);
    if (!user) {
      sendError(res, 401, "auth-required", "로그인이 필요합니다.");
      return;
    }

    const url = new URL(req.url || "/", "http://local");
    const cursorRaw = url.searchParams.get("cursor");
    const cursor = decodeCursor(cursorRaw);
    if (cursorRaw && !cursor) {
      sendError(res, 400, "validation-failed", "잘못된 커서입니다.");
      return;
    }
    const handle = (url.searchParams.get("handle") || "").trim().toLowerCase();
    const fromRaw = url.searchParams.get("from");
    const toRaw = url.searchParams.get("to");
    if ((fromRaw && Number.isNaN(Date.parse(fromRaw))) || (toRaw && Number.isNaN(Date.parse(toRaw)))) {
      sendError(res, 400, "validation-failed", "기간 값이 올바르지 않습니다.");
      return;
    }

    let pageId: string | null = null;
    if (handle) {
      const page = await supabase.from(pagesTable).select("id").eq("handle", handle).maybeSingle();
      if (page.error) {
        throw new Error(page.error.message);
      }
      if (!page.data) {
        // 존재하지 않는 채널 필터 → 빈 목록
        sendJson(res, 200, { ok: true, data: { items: [], nextCursor: null } satisfies MyDonationsData });
        return;
      }
      pageId = (page.data as { id: string }).id;
    }

    let query = supabase
      .from(messagesTable)
      .select(`id,nickname,message,amount,status,expires_at,created_at,page:${pagesTable}(handle,owner_user_id)`)
      .eq("viewer_user_id", user.id)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(DONATIONS_PAGE_SIZE + 1);
    if (pageId) query = query.eq("page_id", pageId);
    if (fromRaw) query = query.gte("created_at", new Date(fromRaw).toISOString());
    if (toRaw) query = query.lte("created_at", new Date(toRaw).toISOString());
    if (cursor) {
      query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
    }

    const result = await query;
    if (result.error) {
      throw new Error(result.error.message);
    }
    const rows = (result.data || []) as unknown as MessageRow[];
    const hasMore = rows.length > DONATIONS_PAGE_SIZE;
    const pageRows = hasMore ? rows.slice(0, DONATIONS_PAGE_SIZE) : rows;

    const ownerIds = pageRows
      .map((row) => firstOf(row.page)?.owner_user_id)
      .filter((value): value is string => Boolean(value));
    const nicknames = await fetchNicknames(supabase, Array.from(new Set(ownerIds)));

    const nowMs = Date.now();
    const items: MyDonationItem[] = pageRows.map((row) => {
      const page = firstOf(row.page);
      const handleValue = page?.handle || "";
      return {
        messageId: row.id,
        handle: handleValue,
        displayName: (page && nicknames.get(page.owner_user_id)) || handleValue || "알 수 없는 채널",
        amount: row.amount,
        message: row.message,
        status: effectiveDonationStatus(row.status, row.expires_at, nowMs),
        createdAt: row.created_at
      };
    });

    const last = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null;
    sendJson(res, 200, { ok: true, data: { items, nextCursor } satisfies MyDonationsData });
  } catch (error) {
    sendError(res, 500, "validation-failed", error instanceof Error ? error.message : "donations-failed");
  }
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
