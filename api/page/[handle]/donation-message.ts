// POST /api/page/:handle/donation-message — 후원 메시지 발급 (WEB_TECH_SPEC §2.1·§4)
// 검증 → 차단 검사 → 레이트리밋 → 활성 pending 코드 집합 → 입금코드 발급 →
// insert(expires_at=+30분, grace_until=만료+60분). 부분 유니크 인덱스
// (page_id, code_norm where pending) 충돌 시 1회 재추첨.

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  LIMITS,
  normalizeDepositTag,
  validateDonationInput,
  type DonationMessageCreated
} from "../../_webShared.js";
import {
  PAGE_DONATION_MSG_PER_MIN,
  TABLES,
  applyCors,
  bearerToken,
  handlePreflight,
  isUniqueViolation,
  isoAfterMinutes,
  issueDepositCode,
  isBlockedNickname,
  publicAccountInfo,
  readJsonBody,
  routeParam,
  sanitizeTransferLinks,
  sendErr,
  sendOk,
  sendServerError,
  serviceClient,
  type InsertOutcome,
  type ServiceClient
} from "../../_webServer.js";

type PageRow = {
  id: string;
  min_amount: number;
  account_display: string;
  account_info: unknown;
  transfer_links: unknown;
  status: string;
};

type InsertedMessageRow = {
  id: string;
  deposit_code: string;
  amount: number;
  expires_at: string;
};

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  applyCors(res);
  if (handlePreflight(req, res)) return;
  if (req.method !== "POST") {
    sendErr(res, 405, "method-not-allowed");
    return;
  }

  try {
    // 경로: /api/page/:handle/donation-message → 세그먼트 ['api','page',handle,'donation-message']
    const handle = routeParam(req, "handle", 2)?.toLowerCase();
    if (!handle) {
      sendErr(res, 404, "not-found");
      return;
    }

    const supabase = serviceClient();
    const pageResult = await supabase
      .from(TABLES.pages)
      .select("id,min_amount,account_display,account_info,transfer_links,status")
      .eq("handle", handle)
      .maybeSingle();
    if (pageResult.error) {
      throw new Error(pageResult.error.message);
    }
    const page = pageResult.data as PageRow | null;
    if (!page || page.status !== "active") {
      sendErr(res, 404, "not-found");
      return;
    }

    const body = await readJsonBody(req);
    const nickname = typeof body.nickname === "string" ? body.nickname.trim() : "";
    const message = typeof body.message === "string" ? body.message : "";
    const amount = typeof body.amount === "number" ? body.amount : Number.NaN;

    const rejectCode = validateDonationInput({ nickname, message, amount, minAmount: page.min_amount });
    if (rejectCode) {
      sendErr(res, 400, rejectCode);
      return;
    }

    // 차단 검사: blocked_value(닉네임 or 코드)를 정규화 비교
    const blocksResult = await supabase.from(TABLES.blocks).select("blocked_value").eq("page_id", page.id);
    if (blocksResult.error) {
      throw new Error(blocksResult.error.message);
    }
    const blockedValues = ((blocksResult.data ?? []) as { blocked_value: string }[]).map((row) => row.blocked_value);
    if (isBlockedNickname(nickname, blockedValues)) {
      sendErr(res, 403, "blocked-donor");
      return;
    }

    // 레이트리밋: 계약은 IP+page 분당 5건이지만 ip_hash 저장 컬럼이 없어 IP별
    // 판정이 불가 → 생성 시각 기반 카운트로 page 단위 분당 20건 상한 대체.
    // (자세한 사유는 _webServer.PAGE_DONATION_MSG_PER_MIN 주석 참조)
    const now = Date.now();
    const windowStartIso = new Date(now - 60_000).toISOString();
    const countResult = await supabase
      .from(TABLES.messages)
      .select("id", { count: "exact", head: true })
      .eq("page_id", page.id)
      .gte("created_at", windowStartIso);
    if (countResult.error) {
      throw new Error(countResult.error.message);
    }
    if ((countResult.count ?? 0) >= PAGE_DONATION_MSG_PER_MIN) {
      sendErr(res, 429, "rate-limited");
      return;
    }

    // 로그인 시청자면 viewer_user_id를 연결(비로그인·검증 실패는 null)
    const viewerUserId = await resolveViewerUserId(req, supabase);

    const expiresAt = isoAfterMinutes(now, LIMITS.messageTtlMinutes);
    const graceUntil = isoAfterMinutes(now, LIMITS.messageTtlMinutes + LIMITS.graceMinutes);

    const fetchTakenNorms = async (): Promise<ReadonlySet<string>> => {
      const pendingResult = await supabase
        .from(TABLES.messages)
        .select("code_norm")
        .eq("page_id", page.id)
        .eq("status", "pending");
      if (pendingResult.error) {
        throw new Error(pendingResult.error.message);
      }
      return new Set(
        ((pendingResult.data ?? []) as { code_norm: string }[]).map((row) => normalizeDepositTag(row.code_norm))
      );
    };

    const insertWithCode = async (code: { code: string; codeNorm: string }): Promise<InsertOutcome<InsertedMessageRow>> => {
      const insertResult = await supabase
        .from(TABLES.messages)
        .insert({
          page_id: page.id,
          viewer_user_id: viewerUserId,
          nickname,
          message,
          amount,
          deposit_code: code.code,
          code_norm: code.codeNorm,
          status: "pending",
          expires_at: expiresAt,
          grace_until: graceUntil
        })
        .select("id,deposit_code,amount,expires_at")
        .single();
      if (insertResult.error) {
        if (isUniqueViolation(insertResult.error)) return { kind: "conflict" };
        return { kind: "error", message: insertResult.error.message };
      }
      return { kind: "ok", row: insertResult.data as InsertedMessageRow };
    };

    const issued = await issueDepositCode(nickname, fetchTakenNorms, insertWithCode);
    if (issued.kind === "exhausted") {
      sendErr(res, 409, "code-exhausted");
      return;
    }
    if (issued.kind === "error") {
      throw new Error(issued.message);
    }

    const created: DonationMessageCreated = {
      messageId: issued.row.id,
      depositCode: issued.row.deposit_code,
      amount: issued.row.amount,
      expiresAt: issued.row.expires_at,
      transferLinks: sanitizeTransferLinks(page.transfer_links),
      accountInfo: publicAccountInfo(page.account_display, page.account_info)
    };
    sendOk(res, created);
  } catch (error) {
    sendServerError(res, error);
  }
}

async function resolveViewerUserId(req: IncomingMessage, supabase: ServiceClient): Promise<string | null> {
  const token = bearerToken(req);
  if (!token) return null;
  try {
    const result = await supabase.auth.getUser(token);
    return result.error ? null : result.data.user?.id ?? null;
  } catch {
    return null;
  }
}
