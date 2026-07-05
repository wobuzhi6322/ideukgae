// =============================================================================
// GET/POST /api/studio/blocks — 후원자 차단 목록 관리 (WSC)
// 계약: docs/WEB_TECH_SPEC.md §2.3 — 닉네임 또는 입금코드 기준 차단
// POST {blockedValue, reason?} 추가 · POST {blockedValue, remove:true} 해제
// 응답은 항상 최신 전체 목록.
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { WebErrorCode } from "../_webShared.js";

const pagesTable = "bbbb_streamer_pages";
const blocksTable = "bbbb_page_blocks";

export type StudioBlockItem = {
  id: string;
  blockedValue: string;
  reason: string | null;
  createdAt: string;
};

export type StudioBlocksResponse = { blocks: StudioBlockItem[] };

type BlockRow = { id: string; blocked_value: string; reason: string | null; created_at: string };

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "지원하지 않는 메서드입니다.", code: "method-not-allowed" });
    return;
  }

  try {
    const supabase = serviceClient();
    const user = await requireUser(req, supabase);
    const page = await requireOwnedPage(user.id, supabase);

    if (req.method === "POST") {
      const body = await readJson(req);
      const blockedValue = normalizeBlockedValue(body.blockedValue);
      if (body.remove === true) {
        const result = await supabase
          .from(blocksTable)
          .delete()
          .eq("page_id", page.id)
          .eq("blocked_value", blockedValue);
        if (result.error) throw new Error(result.error.message);
      } else {
        const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) || null : null;
        const result = await supabase
          .from(blocksTable)
          .upsert(
            { page_id: page.id, blocked_value: blockedValue, reason },
            { onConflict: "page_id,blocked_value" }
          );
        if (result.error) throw new Error(result.error.message);
      }
    }

    const list = await supabase
      .from(blocksTable)
      .select("id,blocked_value,reason,created_at")
      .eq("page_id", page.id)
      .order("created_at", { ascending: false })
      .limit(200);
    if (list.error) throw new Error(list.error.message);

    const data: StudioBlocksResponse = {
      blocks: ((list.data || []) as BlockRow[]).map((row) => ({
        id: row.id,
        blockedValue: row.blocked_value,
        reason: row.reason,
        createdAt: row.created_at
      }))
    };
    sendJson(res, 200, { ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
}

// ---------------------------------------------------------------------------
// 순수 로직 (tests/studioLogic.test.ts)
// ---------------------------------------------------------------------------

/** 차단 값 정규화: 트림, 1~40자. 위반 시 throw */
export function normalizeBlockedValue(value: unknown): string {
  if (typeof value !== "string") throw new Error("차단할 닉네임 또는 입금코드를 입력해 주세요.");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 40) {
    throw new Error("차단 값은 1~40자여야 합니다.");
  }
  return trimmed;
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
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type"
  });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}

function setCors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization,content-type");
}
