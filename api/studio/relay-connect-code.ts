// =============================================================================
// POST /api/studio/relay-connect-code — 프로그램 연동 연결 코드 발급 (WSC)
// bbbb_relay_devices에 {page_id, connect_code(8자리 대문자 영숫자),
// connect_code_expires_at(10분)} 신규 행 삽입 후 {code, expiresAt} 반환.
// device_key_hash는 활성화 전 placeholder(pending-uuid) — 로컬 프로그램이
// 연결 코드를 교환할 때(WSE 릴레이 API) 실제 키 해시로 대체된다.
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { WebErrorCode } from "../_webShared.js";

const pagesTable = "bbbb_streamer_pages";
const relayDevicesTable = "bbbb_relay_devices";

export type RelayConnectCodeResponse = {
  code: string;
  expiresAt: string;
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

    // 이전에 발급했으나 활성화되지 않은 placeholder 행 정리(코드 재발급 = 구 코드 무효)
    const cleanup = await supabase
      .from(relayDevicesTable)
      .delete()
      .eq("page_id", page.id)
      .eq("active", false)
      .like("device_key_hash", `${PENDING_KEY_PREFIX}%`);
    if (cleanup.error) throw new Error(cleanup.error.message);

    const code = generateConnectCode();
    const expiresAt = new Date(Date.now() + CONNECT_CODE_TTL_MINUTES * 60_000).toISOString();
    const insert = await supabase
      .from(relayDevicesTable)
      .insert({
        page_id: page.id,
        device_key_hash: `${PENDING_KEY_PREFIX}${randomUUID()}`,
        connect_code: code,
        connect_code_expires_at: expiresAt,
        active: false
      })
      .select("id")
      .single();
    if (insert.error) throw new Error(insert.error.message);

    const data: RelayConnectCodeResponse = { code, expiresAt };
    sendJson(res, 200, { ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
}

// ---------------------------------------------------------------------------
// 순수 로직 (tests/studioLogic.test.ts)
// ---------------------------------------------------------------------------

/** 활성화 전 device_key_hash placeholder 접두어(WSE 릴레이 등록이 실제 해시로 대체) */
export const PENDING_KEY_PREFIX = "pending-";

/** 대문자 영숫자, 혼동 문자(I·L·O·0·1) 제외 */
export const CONNECT_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CONNECT_CODE_LENGTH = 8;
export const CONNECT_CODE_TTL_MINUTES = 10;

/** 8자리 대문자 영숫자 연결 코드. rand 주입은 테스트용 */
export function generateConnectCode(rand: () => number = Math.random): string {
  let code = "";
  for (let i = 0; i < CONNECT_CODE_LENGTH; i += 1) {
    const idx = Math.floor(rand() * CONNECT_CODE_ALPHABET.length) % CONNECT_CODE_ALPHABET.length;
    code += CONNECT_CODE_ALPHABET[idx];
  }
  return code;
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
