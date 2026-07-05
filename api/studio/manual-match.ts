// =============================================================================
// POST /api/studio/manual-match — 미매칭 입금 ↔ 메시지 수동 짝짓기 (WSC)
// 계약: docs/WEB_TECH_SPEC.md §2.3 — {match_id, message_id} → 기록만, 재재생 없음
// 조건: 매칭 행은 message_id null(미매칭), 메시지는 pending/expired(만료 직후 포함).
// 결과: match.matched_by='manual' + message.status='matched'.
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { WebErrorCode } from "../_webShared.js";

const pagesTable = "bbbb_streamer_pages";
const matchesTable = "bbbb_donation_matches";
const messagesTable = "bbbb_donation_messages";

export type ManualMatchResponse = {
  matchId: string;
  messageId: string;
  matchedAt: string;
};

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "지원하지 않는 메서드입니다.", code: "method-not-allowed" });
    return;
  }

  try {
    const supabase = serviceClient();
    const user = await requireUser(req, supabase);
    const page = await requireOwnedPage(user.id, supabase);

    const body = await readJson(req);
    const matchId = stringValue(body.matchId);
    const messageId = stringValue(body.messageId);
    if (!matchId || !messageId) {
      throw new ApiError(400, "matchId와 messageId가 필요합니다.", "validation-failed");
    }

    const match = await supabase
      .from(matchesTable)
      .select("id,message_id,matched_by,sender_raw,amount")
      .eq("id", matchId)
      .eq("page_id", page.id)
      .maybeSingle();
    if (match.error) throw new Error(match.error.message);
    if (!match.data) throw new ApiError(404, "해당 입금 기록을 찾을 수 없습니다.", "not-found");
    if (match.data.message_id) {
      throw new ApiError(400, "이미 메시지와 짝지어진 입금입니다.", "validation-failed");
    }

    const message = await supabase
      .from(messagesTable)
      .select("id,status")
      .eq("id", messageId)
      .eq("page_id", page.id)
      .maybeSingle();
    if (message.error) throw new Error(message.error.message);
    if (!message.data) throw new ApiError(404, "해당 후원 메시지를 찾을 수 없습니다.", "not-found");
    if (message.data.status !== "pending" && message.data.status !== "expired") {
      throw new ApiError(400, "대기 중이거나 만료된 메시지만 수동 매칭할 수 있습니다.", "validation-failed");
    }

    const linked = await supabase
      .from(matchesTable)
      .select("id")
      .eq("page_id", page.id)
      .eq("message_id", messageId)
      .limit(1)
      .maybeSingle();
    if (linked.error) throw new Error(linked.error.message);
    if (linked.data) {
      throw new ApiError(400, "이미 다른 입금과 짝지어진 메시지입니다.", "validation-failed");
    }

    const matchedAt = new Date().toISOString();
    const updateMatch = await supabase
      .from(matchesTable)
      .update({ message_id: messageId, matched_by: "manual" })
      .eq("id", matchId)
      .eq("page_id", page.id)
      .is("message_id", null)
      .select("id")
      .maybeSingle();
    if (updateMatch.error) throw new Error(updateMatch.error.message);
    if (!updateMatch.data) {
      throw new ApiError(409, "다른 곳에서 먼저 처리되었습니다. 새로고침 후 확인해 주세요.", "validation-failed");
    }

    const updateMessage = await supabase
      .from(messagesTable)
      .update({ status: "matched", matched_at: matchedAt })
      .eq("id", messageId)
      .eq("page_id", page.id);
    if (updateMessage.error) throw new Error(updateMessage.error.message);

    const data: ManualMatchResponse = { matchId, messageId, matchedAt };
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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
    "access-control-allow-methods": "POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type"
  });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}

function setCors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization,content-type");
}
