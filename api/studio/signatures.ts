// =============================================================================
// GET/PATCH /api/studio/signatures — 시그니처 메뉴판 관리 (WSC)
// 계약: docs/WEB_TECH_SPEC.md §2.3 · 타입: api/_webShared.ts StudioSignatureRow
// 진실은 로컬(동기화는 릴레이가 push) — 여기서는 published/pinned/webTitle/sort만 편집.
// pinned는 최대 LIMITS.pinnedMax(3)개.
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import type { IncomingMessage, ServerResponse } from "node:http";

import { LIMITS, type StudioSignatureRow, type WebErrorCode } from "../_webShared.js";

const pagesTable = "bbbb_streamer_pages";
const signaturesTable = "bbbb_page_signatures";
const signatureSelect =
  "id,page_id,local_signature_id,title,web_title,amount,media_type,thumb_url,published,pinned,sort,synced_at";

type SignatureDbRow = {
  id: string;
  page_id: string;
  local_signature_id: string;
  title: string;
  web_title: string | null;
  amount: number;
  media_type: StudioSignatureRow["mediaType"];
  thumb_url: string | null;
  published: boolean;
  pinned: boolean;
  sort: number;
  synced_at: string;
};

export type StudioSignaturesResponse = {
  signatures: StudioSignatureRow[];
  lastSyncedAt: string | null;
};

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

    if (req.method === "PATCH") {
      const body = await readJson(req);
      const items = Array.isArray((body as { items?: unknown }).items)
        ? ((body as { items: SignatureEditItem[] }).items)
        : null;
      if (!items || items.length === 0 || items.length > 200) {
        throw new ApiError(400, "저장할 항목이 없습니다.", "validation-failed");
      }

      const current = await listSignatures(page.id, supabase);
      const applied = applySignatureEdits(
        current.map((row) => ({ id: row.id, pinned: row.pinned })),
        items
      );
      if ("error" in applied) throw new ApiError(400, applied.error, "validation-failed");

      for (const [id, update] of applied.updates) {
        const result = await supabase.from(signaturesTable).update(update).eq("id", id).eq("page_id", page.id);
        if (result.error) throw new Error(result.error.message);
      }
    }

    const rows = await listSignatures(page.id, supabase);
    sendJson(res, 200, { ok: true, data: toResponse(rows) });
  } catch (error) {
    sendError(res, error);
  }
}

// ---------------------------------------------------------------------------
// 순수 로직 (tests/studioLogic.test.ts)
// ---------------------------------------------------------------------------

export type SignatureEditItem = {
  id: string;
  published?: boolean;
  pinned?: boolean;
  webTitle?: string | null;
  sort?: number;
};

/**
 * 일괄 편집 검증: id 존재·타입·webTitle 길이·pinned 총량(≤ pinnedMax).
 * 통과 시 id → DB 업데이트 객체(snake_case) 맵 반환.
 */
export function applySignatureEdits(
  current: ReadonlyArray<{ id: string; pinned: boolean }>,
  items: ReadonlyArray<SignatureEditItem>
): { error: string } | { updates: Map<string, Record<string, unknown>> } {
  const known = new Map(current.map((row) => [row.id, row]));
  const updates = new Map<string, Record<string, unknown>>();
  const pinnedAfter = new Map(current.map((row) => [row.id, row.pinned]));

  for (const item of items) {
    if (!item || typeof item.id !== "string" || !known.has(item.id)) {
      return { error: "알 수 없는 시그니처가 포함되어 있습니다. 새로고침 후 다시 시도해 주세요." };
    }
    const update: Record<string, unknown> = {};
    if ("published" in item) {
      if (typeof item.published !== "boolean") return { error: "공개 여부 값이 올바르지 않습니다." };
      update.published = item.published;
    }
    if ("pinned" in item) {
      if (typeof item.pinned !== "boolean") return { error: "추천 고정 값이 올바르지 않습니다." };
      update.pinned = item.pinned;
      pinnedAfter.set(item.id, item.pinned);
    }
    if ("webTitle" in item) {
      if (item.webTitle !== null && typeof item.webTitle !== "string") {
        return { error: "웹 제목 값이 올바르지 않습니다." };
      }
      const trimmed = typeof item.webTitle === "string" ? item.webTitle.trim() : "";
      if (trimmed.length > LIMITS.webTitleMax) {
        return { error: `웹 제목은 ${LIMITS.webTitleMax}자 이하여야 합니다.` };
      }
      update.web_title = trimmed || null;
    }
    if ("sort" in item) {
      if (typeof item.sort !== "number" || !Number.isInteger(item.sort) || Math.abs(item.sort) > 1_000_000) {
        return { error: "정렬 값이 올바르지 않습니다." };
      }
      update.sort = item.sort;
    }
    if (Object.keys(update).length > 0) {
      updates.set(item.id, { ...(updates.get(item.id) || {}), ...update });
    }
  }

  let pinnedCount = 0;
  for (const pinned of pinnedAfter.values()) {
    if (pinned) pinnedCount += 1;
  }
  if (pinnedCount > LIMITS.pinnedMax) {
    return { error: `추천 고정은 최대 ${LIMITS.pinnedMax}개까지 지정할 수 있습니다.` };
  }
  return { updates };
}

function toResponse(rows: SignatureDbRow[]): StudioSignaturesResponse {
  let lastSyncedAt: string | null = null;
  const signatures = rows.map((row) => {
    if (!lastSyncedAt || row.synced_at > lastSyncedAt) lastSyncedAt = row.synced_at;
    return {
      id: row.id,
      title: row.title,
      amount: row.amount,
      mediaType: row.media_type,
      thumbUrl: row.thumb_url,
      pinned: row.pinned,
      localSignatureId: row.local_signature_id,
      webTitle: row.web_title,
      published: row.published,
      sort: row.sort,
      syncedAt: row.synced_at
    } satisfies StudioSignatureRow;
  });
  return { signatures, lastSyncedAt };
}

async function listSignatures(pageId: string, supabase: ReturnType<typeof serviceClient>): Promise<SignatureDbRow[]> {
  const result = await supabase
    .from(signaturesTable)
    .select(signatureSelect)
    .eq("page_id", pageId)
    .order("sort", { ascending: true })
    .order("amount", { ascending: true });
  if (result.error) throw new Error(result.error.message);
  return (result.data || []) as SignatureDbRow[];
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
