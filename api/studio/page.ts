// =============================================================================
// GET/PATCH /api/studio/page — 채널 페이지 설정 (WSC)
// 계약: docs/WEB_TECH_SPEC.md §2.3 · 타입: api/_webShared.ts StudioPageSettings
// 인증: requireUser + bbbb_streamer_pages.owner_user_id 소유 검증
// 핸들 변경은 30일 1회(handle_changed_at) 제한.
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  HANDLE_HISTORY_TABLE,
  handleChangeBlockedUntil,
  validateHandleChange,
  type HandleHistoryRow
} from "../_handlePolicy.js";
import {
  LIMITS,
  type BroadcastLink,
  type StudioPageSettings,
  type TransferLink,
  type WebErrorCode
} from "../_webShared.js";

// 기존 테스트(tests/studioLogic.test.ts) 호환 재노출 — 정의는 _handlePolicy.ts로 이동
export { handleChangeBlockedUntil };

const pagesTable = "bbbb_streamer_pages";
const pageSelect =
  "id,owner_user_id,handle,banner_url,avatar_url,bio,broadcast_links,preset_amounts,min_amount," +
  "ticker_public,directory_optin,account_display,account_info,transfer_links,status,handle_changed_at";

type PageRow = {
  id: string;
  owner_user_id: string;
  handle: string;
  banner_url: string | null;
  avatar_url: string | null;
  bio: string | null;
  broadcast_links: BroadcastLink[] | null;
  preset_amounts: number[] | null;
  min_amount: number;
  ticker_public: boolean;
  directory_optin: boolean;
  account_display: "link_only" | "full";
  account_info: { bank: string; number: string; holder: string } | null;
  transfer_links: TransferLink[] | null;
  status: string;
  handle_changed_at: string | null;
};

export type StudioPageResponse = StudioPageSettings & { handleChangedAt: string | null };

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "PATCH") {
    sendJson(res, 405, { ok: false, error: "지원하지 않는 메서드입니다.", code: "method-not-allowed" });
    return;
  }

  try {
    const supabase = serviceClient();
    const user = await requireUser(req, supabase);
    const page = await requireOwnedPage(user.id, supabase);

    if (req.method === "GET") {
      sendJson(res, 200, { ok: true, data: toSettings(page) });
      return;
    }

    const body = (await readJson(req)) as Partial<StudioPageSettings> & Record<string, unknown>;
    const patch = buildPagePatch(body, page, Date.now());

    if (typeof patch.handle === "string") {
      const taken = await supabase
        .from(pagesTable)
        .select("id")
        .ilike("handle", patch.handle as string)
        .neq("id", page.id)
        .limit(1)
        .maybeSingle();
      if (taken.error) throw new Error(taken.error.message);
      if (taken.data) throw new ApiError(409, "이미 사용 중인 핸들입니다.", "handle-taken");

      // 90일 재사용 잠금 (구 핸들 301 보호 — 자기 구 핸들 되찾기는 허용)
      const history = await findHandleHistory(supabase, patch.handle as string);
      const verdict = validateHandleChange({
        newHandle: patch.handle as string,
        currentHandle: page.handle,
        handleChangedAt: page.handle_changed_at,
        pageId: page.id,
        historyRow: history,
        nowMs: Date.now()
      });
      if (!verdict.ok) throw new ApiError(verdict.status, verdict.message, verdict.code);
    }

    if (Object.keys(patch).length === 0) {
      sendJson(res, 200, { ok: true, data: toSettings(page) });
      return;
    }

    patch.updated_at = new Date().toISOString();
    const update = await supabase
      .from(pagesTable)
      .update(patch)
      .eq("id", page.id)
      .select(pageSelect)
      .single();
    if (update.error) throw new Error(update.error.message);

    // 핸들이 실제로 바뀌었으면 구 핸들 이력 기록(301·재사용 잠금의 진실)
    if (typeof patch.handle === "string") {
      await recordHandleChange(supabase, page.id, page.handle.toLowerCase(), patch.handle as string);
    }

    sendJson(res, 200, { ok: true, data: toSettings(update.data as unknown as PageRow) });
  } catch (error) {
    sendError(res, error);
  }
}

// ---------------------------------------------------------------------------
// 순수 로직 (tests/studioLogic.test.ts)
// ---------------------------------------------------------------------------

/** http(s) URL 검증. 빈 값/null → null, 위반 시 throw */
export function sanitizeHttpUrl(value: unknown, label = "URL"): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error(`${label} 형식이 올바르지 않습니다.`);
  const url = value.trim();
  if (!url) return null;
  if (url.length > 500 || !/^https?:\/\/\S+$/i.test(url)) {
    throw new Error(`${label}은(는) http(s)로 시작하는 500자 이하 주소여야 합니다.`);
  }
  return url;
}

export function sanitizePresetAmounts(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) {
    throw new Error("프리셋 금액은 1~6개여야 합니다.");
  }
  return value.map((amount) => {
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0 || amount > 100_000_000) {
      throw new Error("프리셋 금액은 1 이상 1억 이하의 정수여야 합니다.");
    }
    return amount;
  });
}

const BROADCAST_PLATFORMS = new Set(["chzzk", "soop", "youtube", "other"]);

export function sanitizeBroadcastLinks(value: unknown): BroadcastLink[] {
  if (!Array.isArray(value) || value.length > 6) throw new Error("방송 링크는 최대 6개입니다.");
  return value.map((item) => {
    const platform = (item as BroadcastLink)?.platform;
    const url = sanitizeHttpUrl((item as BroadcastLink)?.url, "방송 링크");
    if (!BROADCAST_PLATFORMS.has(platform) || !url) throw new Error("방송 링크 형식이 올바르지 않습니다.");
    return { platform, url };
  });
}

export function sanitizeTransferLinks(value: unknown): TransferLink[] {
  if (!Array.isArray(value) || value.length > 4) throw new Error("송금 링크는 최대 4개입니다.");
  return value.map((item) => {
    const type = (item as TransferLink)?.type;
    const url = sanitizeHttpUrl((item as TransferLink)?.url, "송금 링크");
    if ((type !== "toss" && type !== "kakao") || !url) throw new Error("송금 링크 형식이 올바르지 않습니다.");
    return { type, url };
  });
}

export function sanitizeAccountInfo(value: unknown): { bank: string; number: string; holder: string } | null {
  if (value === null || value === undefined) return null;
  const info = value as { bank?: unknown; number?: unknown; holder?: unknown };
  const bank = typeof info.bank === "string" ? info.bank.trim() : "";
  const number = typeof info.number === "string" ? info.number.trim() : "";
  const holder = typeof info.holder === "string" ? info.holder.trim() : "";
  if (!bank && !number && !holder) return null;
  if (!bank || !number || !holder || bank.length > 30 || number.length > 40 || holder.length > 30) {
    throw new Error("계좌 정보는 은행·계좌번호·예금주를 모두 입력해야 합니다.");
  }
  if (!/^[0-9-]+$/.test(number)) throw new Error("계좌번호는 숫자와 하이픈만 입력할 수 있습니다.");
  return { bank, number, holder };
}

/** PATCH 본문 → DB 업데이트 객체(snake_case). 위반 시 throw */
export function buildPagePatch(
  body: Partial<StudioPageSettings> & Record<string, unknown>,
  page: Pick<PageRow, "handle" | "handle_changed_at">,
  nowMs: number
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  if (typeof body.handle === "string" && body.handle.trim().toLowerCase() !== page.handle.toLowerCase()) {
    const handle = body.handle.trim().toLowerCase();
    // 예약어·형식·쿨다운 판정 (이력 잠금은 DB 조회가 필요해 핸들러에서 재판정)
    const verdict = validateHandleChange({
      newHandle: handle,
      currentHandle: page.handle,
      handleChangedAt: page.handle_changed_at,
      pageId: null,
      historyRow: null,
      nowMs
    });
    if (!verdict.ok) throw new ApiError(verdict.status, verdict.message, verdict.code);
    patch.handle = handle;
    patch.handle_changed_at = new Date(nowMs).toISOString();
  }

  if ("bannerUrl" in body) patch.banner_url = sanitizeHttpUrl(body.bannerUrl, "배너 URL");
  if ("avatarUrl" in body) patch.avatar_url = sanitizeHttpUrl(body.avatarUrl, "아바타 URL");

  if ("bio" in body) {
    const bio = typeof body.bio === "string" ? body.bio.trim() : "";
    if (bio.length > LIMITS.bioMax) throw new Error(`소개는 ${LIMITS.bioMax}자 이하여야 합니다.`);
    patch.bio = bio || null;
  }

  if ("broadcastLinks" in body) patch.broadcast_links = sanitizeBroadcastLinks(body.broadcastLinks);
  if ("presetAmounts" in body) patch.preset_amounts = sanitizePresetAmounts(body.presetAmounts);

  if ("minAmount" in body) {
    const min = body.minAmount;
    if (typeof min !== "number" || !Number.isInteger(min) || min < LIMITS.minAmountFloor || min > 100_000_000) {
      throw new Error(`최소 후원액은 ${LIMITS.minAmountFloor}원 이상의 정수여야 합니다.`);
    }
    patch.min_amount = min;
  }

  if ("tickerPublic" in body) {
    if (typeof body.tickerPublic !== "boolean") throw new Error("티커 공개 값이 올바르지 않습니다.");
    patch.ticker_public = body.tickerPublic;
  }
  if ("directoryOptin" in body) {
    if (typeof body.directoryOptin !== "boolean") throw new Error("탐색 노출 값이 올바르지 않습니다.");
    patch.directory_optin = body.directoryOptin;
  }
  if ("accountDisplay" in body) {
    if (body.accountDisplay !== "link_only" && body.accountDisplay !== "full") {
      throw new Error("계좌 노출 방식이 올바르지 않습니다.");
    }
    patch.account_display = body.accountDisplay;
  }
  if ("accountInfo" in body) patch.account_info = sanitizeAccountInfo(body.accountInfo);
  if ("transferLinks" in body) patch.transfer_links = sanitizeTransferLinks(body.transferLinks);

  return patch;
}

function toSettings(row: PageRow): StudioPageResponse {
  return {
    handle: row.handle,
    bannerUrl: row.banner_url,
    avatarUrl: row.avatar_url,
    bio: row.bio,
    broadcastLinks: row.broadcast_links || [],
    presetAmounts: row.preset_amounts || [...LIMITS.presetsDefault],
    minAmount: row.min_amount,
    tickerPublic: row.ticker_public,
    directoryOptin: row.directory_optin,
    accountDisplay: row.account_display,
    accountInfo: row.account_info,
    transferLinks: row.transfer_links || [],
    handleChangedAt: row.handle_changed_at
  };
}

// ---------------------------------------------------------------------------
// 공통 헬퍼 (저장소 관례: api/devices/register.ts 패턴, 파일 자급자족)
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

/** bbbb_handle_history에서 old_handle = 후보 핸들 행 조회 (old_handle이 PK라 최대 1행) */
async function findHandleHistory(
  supabase: ReturnType<typeof serviceClient>,
  handle: string
): Promise<HandleHistoryRow | null> {
  const result = await supabase
    .from(HANDLE_HISTORY_TABLE)
    .select("page_id,changed_at")
    .eq("old_handle", handle)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const row = result.data as { page_id: string; changed_at: string } | null;
  return row ? { pageId: row.page_id, changedAt: row.changed_at } : null;
}

/**
 * 핸들 변경 성공 후 이력 정리:
 * ① 구 핸들 → 새 핸들 매핑 upsert (301의 진실)
 * ② 내 과거 이력 전부 새 핸들로 재조준 (a→b→c 체인에서 @a도 곧장 @c로)
 * ③ 새 핸들이 이력에 남아 있으면 삭제 — 자기 구 핸들 되찾기 시 301 해제
 */
async function recordHandleChange(
  supabase: ReturnType<typeof serviceClient>,
  pageId: string,
  oldHandle: string,
  newHandle: string
): Promise<void> {
  const upsert = await supabase
    .from(HANDLE_HISTORY_TABLE)
    .upsert(
      { old_handle: oldHandle, page_id: pageId, new_handle: newHandle, changed_at: new Date().toISOString() },
      { onConflict: "old_handle" }
    );
  if (upsert.error) throw new Error(upsert.error.message);

  // 과거 이력 재조준 — changed_at은 갱신하지 않는다(재사용 잠금은 버린 시점 기준 유지)
  const retarget = await supabase
    .from(HANDLE_HISTORY_TABLE)
    .update({ new_handle: newHandle })
    .eq("page_id", pageId)
    .neq("new_handle", newHandle);
  if (retarget.error) throw new Error(retarget.error.message);

  const reclaim = await supabase.from(HANDLE_HISTORY_TABLE).delete().eq("old_handle", newHandle);
  if (reclaim.error) throw new Error(reclaim.error.message);
}

async function requireOwnedPage(userId: string, supabase: ReturnType<typeof serviceClient>): Promise<PageRow> {
  const result = await supabase.from(pagesTable).select(pageSelect).eq("owner_user_id", userId).maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) {
    throw new ApiError(404, "채널 페이지가 아직 없습니다. 스트리머 가입에서 핸들을 먼저 만들어 주세요.", "not-found");
  }
  return result.data as unknown as PageRow;
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
    "access-control-allow-methods": "GET,PATCH,OPTIONS",
    "access-control-allow-headers": "authorization,content-type"
  });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}

function setCors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,PATCH,OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization,content-type");
}
