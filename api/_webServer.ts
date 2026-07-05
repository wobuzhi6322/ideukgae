// =============================================================================
// 웹 후원 플랫폼 서버 공용 헬퍼 (WSE)
// 공개 API·릴레이 엔드포인트가 공유하는 순수 로직(디바이스 키 해시, 만료/유예
// 판정, 입금코드 재시도, 멱등 기록)과 HTTP·Supabase 유틸을 모은다.
// 순수 로직은 tests/webServer.test.ts에서 단위 테스트한다.
// Vercel 라우팅 규칙: '_' 접두 파일은 엔드포인트로 노출되지 않는다.
// 계약(타입·상수·코드 생성 규칙)은 api/_webShared.ts 것만 사용한다(수정 금지).
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  LIMITS,
  RELAY_DEVICE_KEY_HEADER,
  generateDepositCode,
  normalizeDepositTag,
  type BroadcastLink,
  type DepositCode,
  type PublicPageView,
  type TransferLink,
  type WebErrorCode
} from "./_webShared.js";

// ---------------------------------------------------------------------------
// 테이블·버킷 상수
// ---------------------------------------------------------------------------

export const TABLES = {
  profiles: "bbbb_web_profiles",
  pages: "bbbb_streamer_pages",
  signatures: "bbbb_page_signatures",
  messages: "bbbb_donation_messages",
  matches: "bbbb_donation_matches",
  blocks: "bbbb_page_blocks",
  relayDevices: "bbbb_relay_devices",
  reports: "bbbb_web_reports"
} as const;

export const THUMB_BUCKET = "bbbb-web-thumbs";

/**
 * 후원 메시지 레이트리밋(분당, page 단위).
 * 계약은 IP+page 기준 분당 LIMITS.donationMsgPerMinPerIp(5)건이지만,
 * bbbb_donation_messages에 ip_hash 컬럼이 없어 IP별 생성 이력을 저장·집계할 수
 * 없다(스키마는 WS0 소유 — 트랙 임의 컬럼 추가 금지). 그래서 생성 시각 기반
 * 카운트 쿼리로 page 단위 분당 20건 상한을 대신 적용한다.
 * ip_hash 컬럼이 추가되면 IP 단위 제한으로 복원할 것(통합자 보고 사항).
 */
export const PAGE_DONATION_MSG_PER_MIN = 20;

// ---------------------------------------------------------------------------
// 순수 로직 — 디바이스 키
// ---------------------------------------------------------------------------

/** 릴레이 디바이스 키 원문 길이(48자 hex = 24바이트) */
export const DEVICE_KEY_HEX_LENGTH = 48;

/** 48자 hex 디바이스 키 생성. 원문은 claim 응답 한 번만 노출되고 서버는 해시만 저장. */
export function generateDeviceKey(bytes: (size: number) => Buffer = randomBytes): string {
  return bytes(DEVICE_KEY_HEX_LENGTH / 2).toString("hex");
}

export function isDeviceKeyFormat(value: string): boolean {
  return new RegExp(`^[0-9a-f]{${DEVICE_KEY_HEX_LENGTH}}$`, "i").test(value);
}

/** sha256 hex — bbbb_relay_devices.device_key_hash 저장 형식 */
export function hashDeviceKey(deviceKey: string): string {
  return createHash("sha256").update(deviceKey, "utf8").digest("hex");
}

export function deviceKeyMatchesHash(deviceKey: string, deviceKeyHash: string): boolean {
  return hashDeviceKey(deviceKey) === deviceKeyHash;
}

/** 신고자 IP 저장용 해시(원문 IP는 저장하지 않는다) */
export function hashIp(ip: string): string {
  return createHash("sha256").update(ip, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// 순수 로직 — 만료·유예 판정
//
// 상태 전이는 전부 lazy(조회 시점 판정)다. 배경:
// - expires_at(생성+30분): 뷰어 입장에서 입금 안내가 유효한 시한. status 폴링이
//   지나면 pending → expired로 전환해 보여준다.
// - grace_until(만료+60분): "지연 매칭 허용창". 은행 입금이 늦게 파싱돼도 이
//   창 안이면 매칭을 받아준다. 따라서 status가 lazy expire로 'expired'가 된
//   메시지도 grace_until 전이면 릴레이 pending 목록·match-report 대상에 남는다.
//   (status='pending'만 매칭 대상으로 삼으면 뷰어 폴링이 만료 전환을 일으키는
//   순간 유예창이 무력화되므로, '매칭 가능' 판정은 pending|expired + 유예창으로
//   정의한다.)
// ---------------------------------------------------------------------------

/** status 조회 시 pending → expired lazy 전환 대상인가 (expires_at 경과) */
export function shouldLazyExpire(status: string, expiresAtIso: string, nowMs: number): boolean {
  if (status !== "pending") return false;
  const expires = Date.parse(expiresAtIso);
  return !Number.isNaN(expires) && nowMs > expires;
}

/** grace_until 경과 여부(잘못된 날짜는 경과로 간주 — 매칭 불가 쪽이 안전) */
export function isPastGrace(graceUntilIso: string, nowMs: number): boolean {
  const grace = Date.parse(graceUntilIso);
  return Number.isNaN(grace) || nowMs > grace;
}

/**
 * 메시지가 아직 매칭 가능한가 = 릴레이 pending 목록 노출 여부.
 * matched/blocked는 제외, pending·expired는 grace_until까지 허용(경계 포함).
 */
export function isMatchableMessage(status: string, graceUntilIso: string, nowMs: number): boolean {
  return (status === "pending" || status === "expired") && !isPastGrace(graceUntilIso, nowMs);
}

/** 릴레이 pending 조회에서 lazy expire 대상인가 (pending인데 유예창까지 끝남) */
export function shouldGraceExpire(status: string, graceUntilIso: string, nowMs: number): boolean {
  return status === "pending" && isPastGrace(graceUntilIso, nowMs);
}

/** 연결 코드 유효 판정(10분 창은 발급 측이 connect_code_expires_at으로 기록) */
export function connectCodeUsable(expiresAtIso: string | null, nowMs: number): boolean {
  if (!expiresAtIso) return false;
  const expires = Date.parse(expiresAtIso);
  return !Number.isNaN(expires) && nowMs <= expires;
}

/** 디바이스 온라인 판정: 마지막 heartbeat가 LIMITS.heartbeatOnlineSeconds 이내 */
export function isDeviceOnline(lastHeartbeatAtIso: string | null, nowMs: number): boolean {
  if (!lastHeartbeatAtIso) return false;
  const last = Date.parse(lastHeartbeatAtIso);
  return !Number.isNaN(last) && nowMs - last <= LIMITS.heartbeatOnlineSeconds * 1000;
}

// ---------------------------------------------------------------------------
// 순수 로직 — match-report 분기·멱등 기록
// ---------------------------------------------------------------------------

export type MatchTargetRow = {
  id: string;
  page_id: string;
  status: string;
  grace_until: string;
};

export type MatchOutcome =
  | { attach: true; messageId: string }
  | { attach: false; reason: "no-message" | "wrong-page" | "not-matchable" };

/**
 * match-report의 messageId 처리 분기.
 * 메시지가 없거나, 다른 페이지 소속이거나, 유예창 밖/이미 matched·blocked면
 * messageId를 무시하고 미매칭 입금으로 기록한다(계약 §2.4).
 */
export function resolveMatchOutcome(
  message: MatchTargetRow | null,
  devicePageId: string,
  nowMs: number
): MatchOutcome {
  if (!message) return { attach: false, reason: "no-message" };
  if (message.page_id !== devicePageId) return { attach: false, reason: "wrong-page" };
  if (!isMatchableMessage(message.status, message.grace_until, nowMs)) {
    return { attach: false, reason: "not-matchable" };
  }
  return { attach: true, messageId: message.id };
}

/** Postgres unique 위반(23505) 여부 — 멱등 키·pending 코드 충돌 공용 판정 */
export function isUniqueViolation(error: { code?: string | undefined } | null | undefined): boolean {
  return error?.code === "23505";
}

export type InsertOutcome<T> =
  | { kind: "ok"; row: T }
  | { kind: "conflict" }
  | { kind: "error"; message: string };

export type IdempotentRecordResult<T> =
  | { kind: "ok"; row: T; duplicate: boolean }
  | { kind: "error"; message: string };

/**
 * (page_id, local_donation_id) 멱등 기록 오케스트레이션(순수 — I/O 주입).
 * 기존 행이 있으면 insert 없이 그대로 반환, insert가 unique 충돌하면(동시 요청
 * 레이스) 기존 행을 다시 읽어 duplicate로 반환한다.
 */
export async function recordIdempotent<T>(deps: {
  findExisting: () => Promise<T | null>;
  insert: () => Promise<InsertOutcome<T>>;
}): Promise<IdempotentRecordResult<T>> {
  const existing = await deps.findExisting();
  if (existing) return { kind: "ok", row: existing, duplicate: true };
  const inserted = await deps.insert();
  if (inserted.kind === "ok") return { kind: "ok", row: inserted.row, duplicate: false };
  if (inserted.kind === "conflict") {
    const raced = await deps.findExisting();
    if (raced) return { kind: "ok", row: raced, duplicate: true };
    return { kind: "error", message: "idempotent-conflict-without-row" };
  }
  return { kind: "error", message: inserted.message };
}

// ---------------------------------------------------------------------------
// 순수 로직 — 입금코드 발급 재시도
// ---------------------------------------------------------------------------

export type CodeIssueResult<T> =
  | { kind: "ok"; row: T; code: DepositCode }
  | { kind: "exhausted" }
  | { kind: "error"; message: string };

/**
 * 활성 pending 코드 집합 조회 → generateDepositCode → insert 를 오케스트레이션.
 * 부분 유니크 인덱스(page_id, code_norm where pending) 충돌(23505) 시 집합을
 * 다시 읽어 재추첨한다. 기본 2회 시도(충돌 1회 재시도) — 계약 §2.1 ②.
 */
export async function issueDepositCode<T>(
  nickname: string,
  fetchTakenNorms: () => Promise<ReadonlySet<string>>,
  insertWithCode: (code: DepositCode) => Promise<InsertOutcome<T>>,
  options: { attempts?: number; rand?: () => number } = {}
): Promise<CodeIssueResult<T>> {
  const attempts = options.attempts ?? 2;
  const rand = options.rand ?? Math.random;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const taken = await fetchTakenNorms();
    let code: DepositCode;
    try {
      code = generateDepositCode(nickname, taken, rand);
    } catch {
      return { kind: "exhausted" };
    }
    const outcome = await insertWithCode(code);
    if (outcome.kind === "ok") return { kind: "ok", row: outcome.row, code };
    if (outcome.kind === "error") return { kind: "error", message: outcome.message };
    // conflict → 다음 시도에서 taken 집합을 다시 읽어 재추첨
  }
  return { kind: "exhausted" };
}

// ---------------------------------------------------------------------------
// 순수 로직 — 차단·jsonb 정제
// ---------------------------------------------------------------------------

/** bbbb_page_blocks.blocked_value(닉네임 or 코드)와 닉네임을 정규화 비교 */
export function isBlockedNickname(nickname: string, blockedValues: readonly string[]): boolean {
  const norm = normalizeDepositTag(nickname);
  if (!norm) return false;
  return blockedValues.some((value) => normalizeDepositTag(value) === norm);
}

export type ThumbDecodeResult =
  | { kind: "ok"; buffer: Buffer }
  | { kind: "too-large"; bytes: number }
  | { kind: "invalid" };

/** base64 썸네일 디코드 + 크기 검사(LIMITS.thumbMaxKb 초과는 거부) */
export function decodeThumbBase64(thumbBase64: string, maxKb: number = LIMITS.thumbMaxKb): ThumbDecodeResult {
  const raw = thumbBase64.replace(/^data:[^;,]*;base64,/, "").replace(/\s+/g, "");
  if (!raw || raw.length % 4 === 1 || !/^[0-9A-Za-z+/]+={0,2}$/.test(raw)) {
    return { kind: "invalid" };
  }
  const buffer = Buffer.from(raw, "base64");
  if (buffer.length === 0) return { kind: "invalid" };
  if (buffer.length > maxKb * 1024) return { kind: "too-large", bytes: buffer.length };
  return { kind: "ok", buffer };
}

export function sanitizeBroadcastLinks(value: unknown): BroadcastLink[] {
  if (!Array.isArray(value)) return [];
  const platforms: BroadcastLink["platform"][] = ["chzzk", "soop", "youtube", "other"];
  const links: BroadcastLink[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const url = (item as Record<string, unknown>).url;
    if (typeof url !== "string" || !url) continue;
    const platform = (item as Record<string, unknown>).platform;
    links.push({
      platform: platforms.includes(platform as BroadcastLink["platform"])
        ? (platform as BroadcastLink["platform"])
        : "other",
      url
    });
  }
  return links;
}

export function sanitizeTransferLinks(value: unknown): TransferLink[] {
  if (!Array.isArray(value)) return [];
  const links: TransferLink[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const type = (item as Record<string, unknown>).type;
    const url = (item as Record<string, unknown>).url;
    if ((type === "toss" || type === "kakao") && typeof url === "string" && url) {
      links.push({ type, url });
    }
  }
  return links;
}

export function sanitizePresetAmounts(value: unknown): number[] {
  if (!Array.isArray(value)) return [...LIMITS.presetsDefault];
  const amounts = value.filter((item): item is number => Number.isInteger(item) && item > 0);
  return amounts.length ? amounts : [...LIMITS.presetsDefault];
}

/** account_display='full'일 때만 계좌 정보 노출(계약 §1.1·§2.1) */
export function publicAccountInfo(accountDisplay: string, accountInfo: unknown): PublicPageView["accountInfo"] {
  if (accountDisplay !== "full" || !accountInfo || typeof accountInfo !== "object") return null;
  const record = accountInfo as Record<string, unknown>;
  const bank = record.bank;
  const number = record.number;
  const holder = record.holder;
  if (typeof bank !== "string" || typeof number !== "string" || typeof holder !== "string") return null;
  if (!bank || !number || !holder) return null;
  return { bank, number, holder };
}

// ---------------------------------------------------------------------------
// HTTP 유틸 (api/devices/register.ts 관례 준수: CORS·OPTIONS 204·{ok,data} 봉투)
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-device-key"
};

export function applyCors(res: ServerResponse): void {
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(name, value);
  }
}

/** OPTIONS 프리플라이트 처리. true를 반환하면 응답이 끝난 것. */
export function handlePreflight(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== "OPTIONS") return false;
  res.writeHead(204);
  res.end();
  return true;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...CORS_HEADERS
  });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}

export function sendOk<T>(res: ServerResponse, data: T, status = 200): void {
  sendJson(res, status, { ok: true, data });
}

export function sendErr(res: ServerResponse, status: number, code: WebErrorCode, message?: string): void {
  sendJson(res, status, { ok: false, error: message ?? code, code });
}

export function sendServerError(res: ServerResponse, error: unknown): void {
  sendJson(res, 500, {
    ok: false,
    error: error instanceof Error ? error.message : "internal-error"
  });
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Vercel 동적 세그먼트 추출: 쿼리스트링(?handle=...)을 우선 사용하고,
 * 없으면 pathname 세그먼트(0-기준 인덱스)로 폴백한다.
 */
export function routeParam(req: IncomingMessage, name: string, segmentIndex: number): string | null {
  const url = new URL(req.url ?? "/", "http://localhost");
  const fromQuery = url.searchParams.get(name);
  if (fromQuery && fromQuery !== `[${name}]`) return fromQuery;
  const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  const value = segments[segmentIndex];
  if (!value || value === `[${name}]`) return null;
  return value;
}

export function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function bearerToken(req: IncomingMessage): string | undefined {
  const value = headerValue(req.headers.authorization);
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

export function clientIp(req: IncomingMessage): string {
  const forwarded = headerValue(req.headers["x-forwarded-for"]);
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = headerValue(req.headers["x-real-ip"]);
  if (real) return real.trim();
  return req.socket?.remoteAddress ?? "0.0.0.0";
}

export function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function isoAfterMinutes(baseMs: number, minutes: number): string {
  return new Date(baseMs + minutes * 60_000).toISOString();
}

// ---------------------------------------------------------------------------
// Supabase (service role 전용 — RLS 정책 없는 bbbb_* 테이블 접근)
// ---------------------------------------------------------------------------

export function serviceClient() {
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

export type ServiceClient = ReturnType<typeof serviceClient>;

// ---------------------------------------------------------------------------
// 릴레이 인증 (X-Device-Key → sha256 해시 대조 + active)
// ---------------------------------------------------------------------------

export const relayDeviceSelect = "id,page_id,active,signatures_dirty,last_heartbeat_at";

export type RelayDeviceRow = {
  id: string;
  page_id: string;
  active: boolean;
  signatures_dirty: boolean;
  last_heartbeat_at: string | null;
};

export type RelayAuthResult =
  | { ok: true; device: RelayDeviceRow }
  | { ok: false; status: number; code: WebErrorCode };

export async function authenticateRelayDevice(req: IncomingMessage, supabase: ServiceClient): Promise<RelayAuthResult> {
  const key = headerValue(req.headers[RELAY_DEVICE_KEY_HEADER])?.trim();
  if (!key || !isDeviceKeyFormat(key)) {
    return { ok: false, status: 401, code: "device-key-invalid" };
  }
  const result = await supabase
    .from(TABLES.relayDevices)
    .select(relayDeviceSelect)
    .eq("device_key_hash", hashDeviceKey(key))
    .maybeSingle();
  if (result.error) {
    throw new Error(result.error.message);
  }
  const device = result.data as RelayDeviceRow | null;
  if (!device || !device.active) {
    return { ok: false, status: 401, code: "device-key-invalid" };
  }
  return { ok: true, device };
}
