import { createClient } from "@supabase/supabase-js";
import type { IncomingMessage, ServerResponse } from "node:http";

import { LIMITS, type WebErrorCode, type WebProfile } from "../_webShared.js";

// =============================================================================
// GET/PATCH /api/me/profile — WEB_TECH_SPEC §2.2
// GET: 프로필+roles 반환 (없으면 이메일 앞부분 닉네임으로 자동 생성)
// PATCH: nickname · avatarUrl · defaultMessage · notifyEmail 수정 (WebProfile)
// =============================================================================

const profilesTable = "bbbb_web_profiles";
const profileSelect = "user_id,nickname,avatar_url,roles,default_message,notify_email";

type ProfileRow = {
  user_id: string;
  nickname: string;
  avatar_url: string | null;
  roles: string[] | null;
  default_message: string | null;
  notify_email: boolean;
};

export type ProfilePatch = {
  nickname?: string;
  avatarUrl?: string | null;
  defaultMessage?: string | null;
  notifyEmail?: boolean;
};

// ---------------------------------------------------------------------------
// 순수 로직 (단위 테스트 대상)
// ---------------------------------------------------------------------------

/** 프로필 자동 생성용 닉네임: 이메일 앞부분에서 허용 문자만, 최대 20자, 비면 '후원자' */
export function nicknameFromEmail(email: string | null): string {
  const local = (email || "").split("@")[0] || "";
  const cleaned = local.normalize("NFC").replace(/[^0-9A-Za-z가-힣._-]/g, "").slice(0, LIMITS.nicknameMax);
  return cleaned || "후원자";
}

/** PATCH 본문 검증: 위반 시 코드, 정상이면 정제된 patch */
export function parseProfilePatch(body: Record<string, unknown>): { patch: ProfilePatch; code: WebErrorCode | null } {
  const patch: ProfilePatch = {};

  if (body.nickname !== undefined) {
    if (typeof body.nickname !== "string") return { patch, code: "nickname-invalid" };
    const nickname = body.nickname.trim();
    if (!nickname || nickname.length > LIMITS.nicknameMax) return { patch, code: "nickname-invalid" };
    patch.nickname = nickname;
  }

  if (body.avatarUrl !== undefined) {
    if (body.avatarUrl === null) {
      patch.avatarUrl = null;
    } else if (typeof body.avatarUrl === "string" && body.avatarUrl.length <= 500) {
      patch.avatarUrl = body.avatarUrl.trim() || null;
    } else {
      return { patch, code: "validation-failed" };
    }
  }

  if (body.defaultMessage !== undefined) {
    if (body.defaultMessage === null) {
      patch.defaultMessage = null;
    } else if (typeof body.defaultMessage === "string") {
      if (body.defaultMessage.length > LIMITS.messageMax) return { patch, code: "message-too-long" };
      patch.defaultMessage = body.defaultMessage;
    } else {
      return { patch, code: "validation-failed" };
    }
  }

  if (body.notifyEmail !== undefined) {
    if (typeof body.notifyEmail !== "boolean") return { patch, code: "validation-failed" };
    patch.notifyEmail = body.notifyEmail;
  }

  if (Object.keys(patch).length === 0) return { patch, code: "validation-failed" };
  return { patch, code: null };
}

/** DB roles 값 → WebProfile.roles (알 수 없는 값 제거, viewer 보장) */
export function toWebRoles(roles: unknown): WebProfile["roles"] {
  const list = Array.isArray(roles)
    ? roles.filter((role): role is "viewer" | "streamer" => role === "viewer" || role === "streamer")
    : [];
  return list.length ? [...new Set(list)] : ["viewer"];
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

  if (req.method !== "GET" && req.method !== "PATCH") {
    sendJson(res, 405, { ok: false, error: "허용되지 않은 요청입니다.", code: "method-not-allowed" });
    return;
  }

  try {
    const supabase = serviceClient();
    const user = await requireUser(req, supabase);

    if (req.method === "GET") {
      const row = await getOrCreateProfile(supabase, user.id, user.email || null);
      sendJson(res, 200, { ok: true, data: toWebProfile(row) });
      return;
    }

    const body = await readJson(req);
    const parsed = parseProfilePatch(body);
    if (parsed.code) {
      sendJson(res, 400, { ok: false, error: patchErrorMessage(parsed.code), code: parsed.code });
      return;
    }

    const existing = await findProfile(supabase, user.id);
    const row = existing
      ? await updateProfile(supabase, user.id, parsed.patch)
      : await insertProfile(supabase, user.id, parsed.patch, user.email || null);
    sendJson(res, 200, { ok: true, data: toWebProfile(row) });
  } catch (error) {
    if (error instanceof ApiError) {
      sendJson(res, error.status, { ok: false, error: error.message, code: error.code });
      return;
    }
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : "profile-failed" });
  }
}

function toWebProfile(row: ProfileRow): WebProfile {
  return {
    nickname: row.nickname,
    avatarUrl: row.avatar_url,
    roles: toWebRoles(row.roles),
    defaultMessage: row.default_message,
    notifyEmail: row.notify_email
  };
}

function patchErrorMessage(code: WebErrorCode): string {
  if (code === "nickname-invalid") return `닉네임은 1~${LIMITS.nicknameMax}자로 입력해 주세요.`;
  if (code === "message-too-long") return `기본 메시지는 ${LIMITS.messageMax}자 이하로 입력해 주세요.`;
  return "수정할 항목을 확인해 주세요.";
}

async function findProfile(supabase: Supa, userId: string): Promise<ProfileRow | null> {
  const result = await supabase.from(profilesTable).select(profileSelect).eq("user_id", userId).maybeSingle();
  if (result.error) {
    throw new Error(result.error.message);
  }
  return (result.data as ProfileRow | null) || null;
}

async function getOrCreateProfile(supabase: Supa, userId: string, email: string | null): Promise<ProfileRow> {
  const existing = await findProfile(supabase, userId);
  if (existing) {
    return existing;
  }
  const insert = await supabase
    .from(profilesTable)
    .insert({ user_id: userId, nickname: nicknameFromEmail(email), roles: ["viewer"] })
    .select(profileSelect)
    .single();
  if (insert.error) {
    // 동시 생성 경합: 이미 생겼으면 다시 읽는다
    const retry = await findProfile(supabase, userId);
    if (retry) return retry;
    throw new Error(insert.error.message);
  }
  return insert.data as ProfileRow;
}

async function insertProfile(supabase: Supa, userId: string, patch: ProfilePatch, email: string | null): Promise<ProfileRow> {
  const insert = await supabase
    .from(profilesTable)
    .insert({
      user_id: userId,
      nickname: patch.nickname ?? nicknameFromEmail(email),
      avatar_url: patch.avatarUrl ?? null,
      default_message: patch.defaultMessage ?? null,
      notify_email: patch.notifyEmail ?? true,
      roles: ["viewer"]
    })
    .select(profileSelect)
    .single();
  if (insert.error) {
    throw new Error(insert.error.message);
  }
  return insert.data as ProfileRow;
}

async function updateProfile(supabase: Supa, userId: string, patch: ProfilePatch): Promise<ProfileRow> {
  const values: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.nickname !== undefined) values.nickname = patch.nickname;
  if (patch.avatarUrl !== undefined) values.avatar_url = patch.avatarUrl;
  if (patch.defaultMessage !== undefined) values.default_message = patch.defaultMessage;
  if (patch.notifyEmail !== undefined) values.notify_email = patch.notifyEmail;
  const update = await supabase.from(profilesTable).update(values).eq("user_id", userId).select(profileSelect).single();
  if (update.error) {
    throw new Error(update.error.message);
  }
  return update.data as ProfileRow;
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
