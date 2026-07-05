// POST /api/report — 신고 접수 → bbbb_web_reports(/ops 큐) (WEB_TECH_SPEC §2.1·§5)
// IP는 해시만 저장(원문 미보관). 접수는 202.

import type { IncomingMessage, ServerResponse } from "node:http";

import type { ReportBody } from "./_webShared.js";
import {
  TABLES,
  applyCors,
  clientIp,
  handlePreflight,
  hashIp,
  readJsonBody,
  sendErr,
  sendOk,
  sendServerError,
  serviceClient
} from "./_webServer.js";

const REASON_MAX = 500;
const TARGET_ID_MAX = 200;
const TARGET_TYPES: ReportBody["targetType"][] = ["page", "signature", "message"];

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  applyCors(res);
  if (handlePreflight(req, res)) return;
  if (req.method !== "POST") {
    sendErr(res, 405, "method-not-allowed");
    return;
  }

  try {
    const body = await readJsonBody(req);
    const targetType = body.targetType;
    const targetId = typeof body.targetId === "string" ? body.targetId.trim() : "";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";

    if (
      !TARGET_TYPES.includes(targetType as ReportBody["targetType"]) ||
      !targetId ||
      targetId.length > TARGET_ID_MAX ||
      !reason ||
      reason.length > REASON_MAX
    ) {
      sendErr(res, 400, "validation-failed");
      return;
    }

    const supabase = serviceClient();
    const insertResult = await supabase.from(TABLES.reports).insert({
      target_type: targetType,
      target_id: targetId,
      reason,
      reporter_ip_hash: hashIp(clientIp(req))
    });
    if (insertResult.error) {
      throw new Error(insertResult.error.message);
    }
    sendOk(res, { accepted: true }, 202);
  } catch (error) {
    sendServerError(res, error);
  }
}
