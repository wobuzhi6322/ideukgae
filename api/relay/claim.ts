// POST /api/relay/claim — 연결 코드로 디바이스 키 발급 (WEB_TECH_SPEC §2.4·§5)
// 유효(만료 전·미사용) connect_code 행을 찾아 48자 hex 키를 발급하고 해시만
// 저장한다. 원문 키는 이 응답 한 번만 노출. 같은 page의 다른 디바이스는
// active=false(페이지당 1활성 — 새 등록 시 구 키 폐기).

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  TABLES,
  applyCors,
  connectCodeUsable,
  generateDeviceKey,
  handlePreflight,
  hashDeviceKey,
  readJsonBody,
  sendErr,
  sendOk,
  sendServerError,
  serviceClient
} from "../_webServer.js";

type ClaimableDeviceRow = {
  id: string;
  page_id: string;
  connect_code: string | null;
  connect_code_expires_at: string | null;
};

const claimSelect = "id,page_id,connect_code,connect_code_expires_at";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  applyCors(res);
  if (handlePreflight(req, res)) return;
  if (req.method !== "POST") {
    sendErr(res, 405, "method-not-allowed");
    return;
  }

  try {
    const body = await readJsonBody(req);
    const connectCode = typeof body.connectCode === "string" ? body.connectCode.trim() : "";
    if (!connectCode) {
      sendErr(res, 400, "connect-code-invalid");
      return;
    }

    const supabase = serviceClient();
    let deviceResult = await supabase.from(TABLES.relayDevices).select(claimSelect).eq("connect_code", connectCode).maybeSingle();
    if (deviceResult.error) {
      throw new Error(deviceResult.error.message);
    }
    // 발급 측 표기가 대문자인 경우를 허용(입력 대소문자 관용)
    if (!deviceResult.data && connectCode !== connectCode.toUpperCase()) {
      deviceResult = await supabase
        .from(TABLES.relayDevices)
        .select(claimSelect)
        .eq("connect_code", connectCode.toUpperCase())
        .maybeSingle();
      if (deviceResult.error) {
        throw new Error(deviceResult.error.message);
      }
    }
    const device = deviceResult.data as ClaimableDeviceRow | null;
    if (!device || !connectCodeUsable(device.connect_code_expires_at, Date.now())) {
      sendErr(res, 400, "connect-code-invalid");
      return;
    }

    const deviceKey = generateDeviceKey();
    // connect_code 일치 가드로 동시 claim 레이스 차단(먼저 성공한 쪽이 코드를 소모)
    const updateResult = await supabase
      .from(TABLES.relayDevices)
      .update({
        device_key_hash: hashDeviceKey(deviceKey),
        active: true,
        connect_code: null,
        connect_code_expires_at: null,
        last_heartbeat_at: new Date().toISOString()
      })
      .eq("id", device.id)
      .eq("connect_code", device.connect_code)
      .select("id")
      .maybeSingle();
    if (updateResult.error) {
      throw new Error(updateResult.error.message);
    }
    if (!updateResult.data) {
      sendErr(res, 400, "connect-code-invalid");
      return;
    }

    // 같은 page의 다른 디바이스 비활성화(구 키 폐기)
    const deactivateResult = await supabase
      .from(TABLES.relayDevices)
      .update({ active: false })
      .eq("page_id", device.page_id)
      .neq("id", device.id)
      .eq("active", true);
    if (deactivateResult.error) {
      throw new Error(deactivateResult.error.message);
    }

    sendOk(res, { deviceKey });
  } catch (error) {
    sendServerError(res, error);
  }
}
