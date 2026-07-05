// POST /api/relay/heartbeat — 60초 주기 생존 신호 (WEB_TECH_SPEC §2.4)
// last_heartbeat_at 갱신(online 판정은 마지막 heartbeat 180초 이내),
// 응답으로 서버 지시(시그니처 재동기화 요청 플래그)를 내려준다.

import type { IncomingMessage, ServerResponse } from "node:http";

import type { RelayHeartbeatResponse } from "../_webShared.js";
import {
  TABLES,
  applyCors,
  authenticateRelayDevice,
  handlePreflight,
  sendErr,
  sendOk,
  sendServerError,
  serviceClient
} from "../_webServer.js";

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

    const updateResult = await supabase
      .from(TABLES.relayDevices)
      .update({ last_heartbeat_at: new Date().toISOString() })
      .eq("id", auth.device.id);
    if (updateResult.error) {
      throw new Error(updateResult.error.message);
    }

    const response: RelayHeartbeatResponse = {
      requestSignatureSync: auth.device.signatures_dirty
    };
    sendOk(res, response);
  } catch (error) {
    sendServerError(res, error);
  }
}
