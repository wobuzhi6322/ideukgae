// POST /api/relay/match-report — 입금 보고 (WEB_TECH_SPEC §2.4)
// (page_id, local_donation_id) 유니크가 멱등 키 — 중복 보고는 200 + 기존 기록.
// messageId가 있고 메시지가 아직 매칭 가능(pending|expired + grace_until 이내)
// 하면 status='matched'·matched_at 갱신 후 matched_by='auto'로 기록, 아니면
// messageId를 무시하고 미매칭 입금(수동 매칭 후보)으로 기록한다.

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  TABLES,
  applyCors,
  authenticateRelayDevice,
  handlePreflight,
  isUniqueViolation,
  readJsonBody,
  recordIdempotent,
  resolveMatchOutcome,
  sendErr,
  sendOk,
  sendServerError,
  serviceClient,
  type InsertOutcome,
  type MatchTargetRow,
  type ServiceClient
} from "../_webServer.js";

type MatchRow = {
  id: string;
  message_id: string | null;
  matched_by: "auto" | "manual" | null;
  local_donation_id: string;
  reported_at: string;
};

const matchSelect = "id,message_id,matched_by,local_donation_id,reported_at";
const LOCAL_ID_MAX = 200;
const SENDER_RAW_MAX = 200;

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
    const localDonationId = typeof body.localDonationId === "string" ? body.localDonationId.trim() : "";
    const senderRaw = typeof body.senderRaw === "string" ? body.senderRaw.slice(0, SENDER_RAW_MAX) : "";
    const amount = typeof body.amount === "number" ? body.amount : Number.NaN;
    const requestedMessageId =
      typeof body.messageId === "string" && body.messageId.trim() ? body.messageId.trim() : null;

    if (!localDonationId || localDonationId.length > LOCAL_ID_MAX || !Number.isInteger(amount) || amount <= 0) {
      sendErr(res, 400, "validation-failed");
      return;
    }

    const findExisting = async (): Promise<MatchRow | null> => {
      const result = await supabase
        .from(TABLES.matches)
        .select(matchSelect)
        .eq("page_id", pageId)
        .eq("local_donation_id", localDonationId)
        .maybeSingle();
      if (result.error) {
        throw new Error(result.error.message);
      }
      return result.data as MatchRow | null;
    };

    // 멱등: 이미 기록된 local_donation_id면 메시지 상태를 다시 건드리지 않는다
    const existing = await findExisting();
    if (existing) {
      sendOk(res, toReportResult(existing, true));
      return;
    }

    // messageId 처리 분기 — 매칭 가능할 때만 matched 전환
    const now = Date.now();
    const target = requestedMessageId ? await fetchMessage(supabase, requestedMessageId) : null;
    const outcome = resolveMatchOutcome(target, pageId, now);

    let attachedMessageId: string | null = null;
    if (outcome.attach) {
      // 매칭 가능 상태 가드 포함 갱신 — 레이스로 0행이면 미매칭으로 폴백
      const updateResult = await supabase
        .from(TABLES.messages)
        .update({ status: "matched", matched_at: new Date(now).toISOString() })
        .eq("id", outcome.messageId)
        .eq("page_id", pageId)
        .in("status", ["pending", "expired"])
        .select("id")
        .maybeSingle();
      if (updateResult.error) {
        throw new Error(updateResult.error.message);
      }
      if (updateResult.data) {
        attachedMessageId = outcome.messageId;
      }
    }

    const insert = async (): Promise<InsertOutcome<MatchRow>> => {
      const result = await supabase
        .from(TABLES.matches)
        .insert({
          page_id: pageId,
          message_id: attachedMessageId,
          matched_by: attachedMessageId ? "auto" : null,
          local_donation_id: localDonationId,
          sender_raw: senderRaw,
          amount
        })
        .select(matchSelect)
        .single();
      if (result.error) {
        if (isUniqueViolation(result.error)) return { kind: "conflict" };
        return { kind: "error", message: result.error.message };
      }
      return { kind: "ok", row: result.data as MatchRow };
    };

    const recorded = await recordIdempotent({ findExisting, insert });
    if (recorded.kind === "error") {
      throw new Error(recorded.message);
    }
    sendOk(res, toReportResult(recorded.row, recorded.duplicate));
  } catch (error) {
    sendServerError(res, error);
  }
}

async function fetchMessage(supabase: ServiceClient, messageId: string): Promise<MatchTargetRow | null> {
  const result = await supabase
    .from(TABLES.messages)
    .select("id,page_id,status,grace_until")
    .eq("id", messageId)
    .maybeSingle();
  if (result.error) {
    // 잘못된 uuid 등은 '메시지 없음'으로 취급 → 미매칭 기록으로 폴백
    if (result.error.code === "22P02") return null;
    throw new Error(result.error.message);
  }
  return result.data as MatchTargetRow | null;
}

function toReportResult(row: MatchRow, duplicate: boolean) {
  return {
    recorded: true,
    duplicate,
    matchId: row.id,
    messageId: row.message_id,
    matchedBy: row.matched_by,
    reportedAt: row.reported_at
  };
}
