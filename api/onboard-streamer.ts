import { createClient } from "@supabase/supabase-js";
import type { IncomingMessage, ServerResponse } from "node:http";

import { HANDLE_HISTORY_TABLE, validateHandleChange, type HandleHistoryRow } from "./_handlePolicy.js";
import { handleRejectCode, type WebErrorCode } from "./_webShared.js";
import { nicknameFromEmail } from "./me/profile.js";

// =============================================================================
// /api/onboard-streamer — WSA 트랙 (WEB_PAGE_SPECS §2)
// GET ?handle= : 핸들 실시간 검사 (형식·예약어·중복)
// POST {handle}: bbbb_streamer_pages 생성 + profiles.roles에 'streamer' 추가
// =============================================================================

const pagesTable = "bbbb_streamer_pages";
const profilesTable = "bbbb_web_profiles";
const pageSelect = "id,owner_user_id,handle";

type PageRow = {
  id: string;
  owner_user_id: string;
  handle: string;
};

// ---------------------------------------------------------------------------
// 순수 로직 (단위 테스트 대상)
// ---------------------------------------------------------------------------

/** 입력 핸들 정규화: 문자열만 허용, 트림 + 소문자화 */
export function normalizeHandleInput(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** roles 배열에 'streamer' 보장 (viewer 유지, 알 수 없는 값 제거, 중복 제거) */
export function rolesWithStreamer(roles: unknown): ("viewer" | "streamer")[] {
  const known = Array.isArray(roles)
    ? roles.filter((role): role is "viewer" | "streamer" => role === "viewer" || role === "streamer")
    : [];
  return [...new Set<"viewer" | "streamer">(["viewer", ...known, "streamer"])];
}

export function handleErrorMessage(code: WebErrorCode): string {
  if (code === "handle-invalid") return "핸들은 소문자 영문·숫자·하이픈으로 3~20자입니다. 하이픈은 처음과 끝에 올 수 없어요.";
  if (code === "handle-reserved") return "사용할 수 없는 핸들입니다. 다른 핸들을 골라 주세요.";
  if (code === "handle-taken") return "이미 사용 중인 핸들입니다.";
  return "핸들을 확인해 주세요.";
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

  if (req.method !== "GET" && req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "허용되지 않은 요청입니다.", code: "method-not-allowed" });
    return;
  }

  try {
    const supabase = serviceClient();
    const user = await requireUser(req, supabase);

    if (req.method === "GET") {
      await checkHandle(req, res, supabase, user.id);
      return;
    }

    await onboard(req, res, supabase, user.id, user.email || null);
  } catch (error) {
    if (error instanceof ApiError) {
      sendJson(res, error.status, { ok: false, error: error.message, code: error.code });
      return;
    }
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : "onboard-failed" });
  }
}

/** GET ?handle= — 실시간 핸들 검사. 응답: {handle, available, code} */
async function checkHandle(req: IncomingMessage, res: ServerResponse, supabase: Supa, userId: string): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");
  const handle = normalizeHandleInput(url.searchParams.get("handle"));
  let code: WebErrorCode | null = handleRejectCode(handle);
  let message: string | null = null;
  if (!code) {
    const owner = await findPageByHandle(supabase, handle);
    if (owner && owner.owner_user_id !== userId) {
      code = "handle-taken";
    }
  }
  if (!code) {
    // 최근 90일 내 다른 채널이 버린 핸들은 301 보호를 위해 선점 불가 (§6.2 재사용 잠금)
    const verdict = await checkHandleHistoryLock(supabase, handle);
    if (!verdict.ok) {
      code = verdict.code;
      message = verdict.message;
    }
  }
  sendJson(res, 200, {
    ok: true,
    data: { handle, available: code === null, code, message: message ?? (code ? handleErrorMessage(code) : null) }
  });
}

/** POST {handle} — 페이지 생성 + roles에 streamer 추가 */
async function onboard(req: IncomingMessage, res: ServerResponse, supabase: Supa, userId: string, email: string | null): Promise<void> {
  const body = await readJson(req);
  const handle = normalizeHandleInput(body.handle);
  const reject = handleRejectCode(handle);
  if (reject) {
    sendJson(res, 400, { ok: false, error: handleErrorMessage(reject), code: reject });
    return;
  }

  // 이미 내 페이지가 있으면 멱등 처리(핸들 변경은 /studio 소관 — 30일 1회 규칙)
  const mine = await findPageByOwner(supabase, userId);
  if (mine) {
    const roles = await ensureStreamerRole(supabase, userId, email);
    sendJson(res, 200, { ok: true, data: { handle: mine.handle, roles, created: false } });
    return;
  }

  const taken = await findPageByHandle(supabase, handle);
  if (taken) {
    sendJson(res, 409, { ok: false, error: handleErrorMessage("handle-taken"), code: "handle-taken" });
    return;
  }

  // 최근 90일 내 다른 채널이 버린 핸들은 선점 불가 — 구 핸들 301 보호 (§6.2)
  const historyVerdict = await checkHandleHistoryLock(supabase, handle);
  if (!historyVerdict.ok) {
    sendJson(res, historyVerdict.status, { ok: false, error: historyVerdict.message, code: historyVerdict.code });
    return;
  }

  const insert = await supabase
    .from(pagesTable)
    .insert({ owner_user_id: userId, handle })
    .select(pageSelect)
    .single();
  if (insert.error) {
    // 유니크 인덱스 경합(동시 가입): 중복이면 handle-taken으로 응답
    if (insert.error.code === "23505") {
      sendJson(res, 409, { ok: false, error: handleErrorMessage("handle-taken"), code: "handle-taken" });
      return;
    }
    throw new Error(insert.error.message);
  }

  const roles = await ensureStreamerRole(supabase, userId, email);
  sendJson(res, 200, { ok: true, data: { handle: (insert.data as PageRow).handle, roles, created: true } });
}

/**
 * 온보딩 핸들의 90일 재사용 잠금 판정 (bbbb_handle_history — _handlePolicy 규칙).
 * 신규 페이지는 "자기 구 핸들 되찾기" 예외가 성립하지 않는다(pageId=null).
 */
async function checkHandleHistoryLock(
  supabase: Supa,
  handle: string
): Promise<ReturnType<typeof validateHandleChange>> {
  const result = await supabase
    .from(HANDLE_HISTORY_TABLE)
    .select("page_id,changed_at")
    .eq("old_handle", handle)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const row = result.data as { page_id: string; changed_at: string } | null;
  const historyRow: HandleHistoryRow | null = row ? { pageId: row.page_id, changedAt: row.changed_at } : null;
  return validateHandleChange({
    newHandle: handle,
    currentHandle: "",
    handleChangedAt: null,
    pageId: null,
    historyRow,
    nowMs: Date.now()
  });
}

async function findPageByOwner(supabase: Supa, userId: string): Promise<PageRow | null> {
  const result = await supabase.from(pagesTable).select(pageSelect).eq("owner_user_id", userId).maybeSingle();
  if (result.error) {
    throw new Error(result.error.message);
  }
  return (result.data as PageRow | null) || null;
}

async function findPageByHandle(supabase: Supa, handle: string): Promise<PageRow | null> {
  const result = await supabase.from(pagesTable).select(pageSelect).eq("handle", handle).maybeSingle();
  if (result.error) {
    throw new Error(result.error.message);
  }
  return (result.data as PageRow | null) || null;
}

/** 프로필이 없으면 생성하고, roles에 'streamer'를 보장한다. 최종 roles 반환. */
async function ensureStreamerRole(supabase: Supa, userId: string, email: string | null): Promise<("viewer" | "streamer")[]> {
  const existing = await supabase.from(profilesTable).select("user_id,nickname,roles").eq("user_id", userId).maybeSingle();
  if (existing.error) {
    throw new Error(existing.error.message);
  }

  if (!existing.data) {
    const roles = rolesWithStreamer([]);
    const insert = await supabase
      .from(profilesTable)
      .insert({ user_id: userId, nickname: nicknameFromEmail(email), roles });
    if (insert.error) {
      throw new Error(insert.error.message);
    }
    return roles;
  }

  const roles = rolesWithStreamer((existing.data as { roles: string[] | null }).roles);
  const update = await supabase
    .from(profilesTable)
    .update({ roles, updated_at: new Date().toISOString() })
    .eq("user_id", userId);
  if (update.error) {
    throw new Error(update.error.message);
  }
  return roles;
}

// ---------------------------------------------------------------------------
// 공통 유틸 (api/devices/register.ts 관례)
// ---------------------------------------------------------------------------

type Supa = ReturnType<typeof serviceClient>;

class ApiError extends Error {
  status: number;
  code: WebErrorCode;

  constructor(status: number, code: WebErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
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

async function requireUser(req: IncomingMessage, supabase: Supa) {
  const token = bearerToken(req);
  if (!token) {
    throw new ApiError(401, "auth-required", "로그인이 필요합니다.");
  }
  const result = await supabase.auth.getUser(token);
  if (result.error || !result.data.user) {
    throw new ApiError(401, "auth-required", "로그인 세션을 확인할 수 없습니다.");
  }
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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (!chunks.length) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
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
