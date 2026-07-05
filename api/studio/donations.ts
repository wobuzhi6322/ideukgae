// =============================================================================
// GET /api/studio/donations?filter= — 후원 매칭 로그 (WSC)
// 계약: docs/WEB_TECH_SPEC.md §2.3 — donation_matches ⋈ donation_messages
// filter: all(기본) | unmatched | auto | manual
// candidates: 수동 매칭 후보(미매칭 상태의 pending/expired 메시지, 최근 24시간)
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { StudioDonationRow, WebErrorCode } from "../_webShared.js";

const pagesTable = "bbbb_streamer_pages";
const matchesTable = "bbbb_donation_matches";
const messagesTable = "bbbb_donation_messages";

export type ManualMatchCandidate = {
  messageId: string;
  nickname: string;
  message: string;
  amount: number;
  depositCode: string;
  status: "pending" | "expired";
  createdAt: string;
  expiresAt: string;
};

export type StudioDonationsResponse = {
  items: StudioDonationRow[];
  candidates: ManualMatchCandidate[];
};

type MatchRow = {
  id: string;
  message_id: string | null;
  matched_by: "auto" | "manual" | null;
  local_donation_id: string;
  sender_raw: string | null;
  amount: number | null;
  reported_at: string;
};

type MessageRow = {
  id: string;
  nickname: string;
  message: string;
  amount: number;
  deposit_code: string;
  status: string;
  created_at: string;
  expires_at: string;
};

const FILTERS = new Set(["all", "unmatched", "auto", "manual"]);

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

    const url = new URL(req.url || "/", "http://localhost");
    const filter = url.searchParams.get("filter") || "all";
    if (!FILTERS.has(filter)) {
      throw new ApiError(400, "filter는 all·unmatched·auto·manual 중 하나여야 합니다.", "validation-failed");
    }

    let query = supabase
      .from(matchesTable)
      .select("id,message_id,matched_by,local_donation_id,sender_raw,amount,reported_at")
      .eq("page_id", page.id)
      .order("reported_at", { ascending: false })
      .limit(100);
    if (filter === "unmatched") query = query.is("message_id", null);
    if (filter === "auto" || filter === "manual") query = query.eq("matched_by", filter);

    const matches = await query;
    if (matches.error) throw new Error(matches.error.message);
    const matchRows = (matches.data || []) as MatchRow[];

    const messageIds = matchRows.map((row) => row.message_id).filter((id): id is string => Boolean(id));
    const messageMap = new Map<string, MessageRow>();
    if (messageIds.length > 0) {
      const messages = await supabase
        .from(messagesTable)
        .select("id,nickname,message,amount,deposit_code,status,created_at,expires_at")
        .in("id", messageIds);
      if (messages.error) throw new Error(messages.error.message);
      for (const row of (messages.data || []) as MessageRow[]) {
        messageMap.set(row.id, row);
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

    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const candidateQuery = await supabase
      .from(messagesTable)
      .select("id,nickname,message,amount,deposit_code,status,created_at,expires_at")
      .eq("page_id", page.id)
      .in("status", ["pending", "expired"])
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(30);
    if (candidateQuery.error) throw new Error(candidateQuery.error.message);
    const candidates: ManualMatchCandidate[] = ((candidateQuery.data || []) as MessageRow[]).map((row) => ({
      messageId: row.id,
      nickname: row.nickname,
      message: row.message,
      amount: row.amount,
      depositCode: row.deposit_code,
      status: row.status === "expired" ? "expired" : "pending",
      createdAt: row.created_at,
      expiresAt: row.expires_at
    }));

    const data: StudioDonationsResponse = { items, candidates };
    sendJson(res, 200, { ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
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

async function requireOwnedPage(userId: string, supabase: ReturnType<typeof serviceClient>): Promise<{ id: string }> {
  const result = await supabase.from(pagesTable).select("id").eq("owner_user_id", userId).maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) {
    throw new ApiError(404, "채널 페이지가 아직 없습니다. 스트리머 가입에서 핸들을 먼저 만들어 주세요.", "not-found");
  }
  return result.data as { id: string };
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
