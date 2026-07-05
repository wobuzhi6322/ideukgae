// POST /api/relay/signatures-sync — 시그니처 메뉴판 캐시 push (WEB_TECH_SPEC §2.4·§1.2)
// (page_id, local_signature_id) 기준 upsert, 목록에 없는 기존 행 삭제(진실은
// 로컬). thumbBase64가 있으면 bbbb-web-thumbs 버킷에 {pageId}/{localSignatureId}.jpg
// 로 업로드 후 thumb_url 갱신 — 200KB 초과분은 해당 항목 썸네일만 스킵 표시.
// 완료 시 디바이스 signatures_dirty=false.
// published/pinned/web_title/sort는 스튜디오(WSC) 소유 컬럼이라 여기서 건드리지
// 않는다(upsert 페이로드에서 제외 → 기존 값 유지).

import type { IncomingMessage, ServerResponse } from "node:http";

import type { PublicSignatureCard, RelaySignatureSyncItem } from "../_webShared.js";
import {
  TABLES,
  THUMB_BUCKET,
  applyCors,
  authenticateRelayDevice,
  decodeThumbBase64,
  handlePreflight,
  readJsonBody,
  sendErr,
  sendOk,
  sendServerError,
  serviceClient
} from "../_webServer.js";

const MEDIA_TYPES: PublicSignatureCard["mediaType"][] = ["image", "gif", "video", "audio"];
const LOCAL_ID_MAX = 200;
const TITLE_MAX = 200;

type ParsedItem = {
  localSignatureId: string;
  title: string;
  amount: number;
  mediaType: PublicSignatureCard["mediaType"];
  thumbBase64: string | null;
};

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  applyCors(res);
  if (handlePreflight(req, res)) return;
  if (req.method !== "POST") {
    sendErr(res, 405, "method-not-allowed");
    return;
  }

  try {
    const supabase = serviceClient();
    const auth = await authenticateRelayDevice(req, supabase);
    if (!auth.ok) {
      sendErr(res, auth.status, auth.code);
      return;
    }
    const pageId = auth.device.page_id;

    const body = await readJsonBody(req);
    const items = parseItems(body.signatures);
    if (!items) {
      sendErr(res, 400, "validation-failed");
      return;
    }

    const nowIso = new Date().toISOString();

    // upsert (page_id, local_signature_id 기준) — 목록 순서를 sort 힌트로 쓰지
    // 않는다(sort는 스튜디오 소유). synced_at만 갱신.
    if (items.length > 0) {
      const upsertResult = await supabase.from(TABLES.signatures).upsert(
        items.map((item) => ({
          page_id: pageId,
          local_signature_id: item.localSignatureId,
          title: item.title,
          amount: item.amount,
          media_type: item.mediaType,
          synced_at: nowIso
        })),
        { onConflict: "page_id,local_signature_id" }
      );
      if (upsertResult.error) {
        throw new Error(upsertResult.error.message);
      }
    }

    // 목록에 없는 기존 행 삭제 — id 이스케이프 문제를 피하려고 JS에서 차집합 계산
    const existingResult = await supabase.from(TABLES.signatures).select("local_signature_id").eq("page_id", pageId);
    if (existingResult.error) {
      throw new Error(existingResult.error.message);
    }
    const incomingIds = new Set(items.map((item) => item.localSignatureId));
    const staleIds = ((existingResult.data ?? []) as { local_signature_id: string }[])
      .map((row) => row.local_signature_id)
      .filter((id) => !incomingIds.has(id));
    if (staleIds.length > 0) {
      const deleteResult = await supabase
        .from(TABLES.signatures)
        .delete()
        .eq("page_id", pageId)
        .in("local_signature_id", staleIds);
      if (deleteResult.error) {
        throw new Error(deleteResult.error.message);
      }
      // 고아 썸네일 정리(실패해도 동기화는 계속)
      await supabase.storage
        .from(THUMB_BUCKET)
        .remove(staleIds.map((id) => thumbPath(pageId, id)))
        .catch(() => undefined);
    }

    // 썸네일 업로드: 200KB 초과·비정상 base64는 해당 항목만 스킵 표시
    const thumbSkipped: string[] = [];
    const thumbFailed: string[] = [];
    for (const item of items) {
      if (item.thumbBase64 === null) continue;
      const decoded = decodeThumbBase64(item.thumbBase64);
      if (decoded.kind !== "ok") {
        thumbSkipped.push(item.localSignatureId);
        continue;
      }
      const path = thumbPath(pageId, item.localSignatureId);
      const upload = await supabase.storage.from(THUMB_BUCKET).upload(path, decoded.buffer, {
        contentType: "image/jpeg",
        upsert: true
      });
      if (upload.error) {
        thumbFailed.push(item.localSignatureId);
        continue;
      }
      const publicUrl = supabase.storage.from(THUMB_BUCKET).getPublicUrl(path).data.publicUrl;
      const thumbUpdate = await supabase
        .from(TABLES.signatures)
        // 경로가 고정이라 CDN 캐시 무효화를 위해 버전 쿼리를 붙인다
        .update({ thumb_url: `${publicUrl}?v=${Date.now()}` })
        .eq("page_id", pageId)
        .eq("local_signature_id", item.localSignatureId);
      if (thumbUpdate.error) {
        thumbFailed.push(item.localSignatureId);
      }
    }

    const dirtyResult = await supabase
      .from(TABLES.relayDevices)
      .update({ signatures_dirty: false })
      .eq("id", auth.device.id);
    if (dirtyResult.error) {
      throw new Error(dirtyResult.error.message);
    }

    sendOk(res, {
      upserted: items.length,
      deleted: staleIds.length,
      thumbSkipped,
      thumbFailed
    });
  } catch (error) {
    sendServerError(res, error);
  }
}

function thumbPath(pageId: string, localSignatureId: string): string {
  return `${pageId}/${encodeURIComponent(localSignatureId)}.jpg`;
}

function parseItems(value: unknown): ParsedItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: ParsedItem[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const record = raw as Partial<RelaySignatureSyncItem> & Record<string, unknown>;
    const localSignatureId = typeof record.localSignatureId === "string" ? record.localSignatureId.trim() : "";
    const title = typeof record.title === "string" ? record.title.trim().slice(0, TITLE_MAX) : "";
    const amount = typeof record.amount === "number" ? record.amount : Number.NaN;
    const mediaType = record.mediaType;
    const thumbBase64 =
      typeof record.thumbBase64 === "string" && record.thumbBase64 ? record.thumbBase64 : null;
    if (
      !localSignatureId ||
      localSignatureId.length > LOCAL_ID_MAX ||
      seen.has(localSignatureId) ||
      !Number.isInteger(amount) ||
      amount <= 0 ||
      !MEDIA_TYPES.includes(mediaType as PublicSignatureCard["mediaType"])
    ) {
      return null;
    }
    seen.add(localSignatureId);
    items.push({
      localSignatureId,
      title,
      amount,
      mediaType: mediaType as PublicSignatureCard["mediaType"],
      thumbBase64
    });
  }
  return items;
}
