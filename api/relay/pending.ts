// GET /api/relay/pending — 매칭 후보 목록 (WEB_TECH_SPEC §2.4)
// grace_until이 안 지난 메시지를 내려준다. status 폴링이 lazy expire한
// 'expired' 메시지도 유예창 안이면 지연 매칭 후보로 포함한다(§4 매칭 조건 ③이
// created_at ≤ 입금시각 ≤ grace_until 이므로). 유예창까지 지난 pending은
// 여기서 lazy로 expired 전환한다.

import type { IncomingMessage, ServerResponse } from "node:http";

import type { RelayPendingItem } from "../_webShared.js";
import {
  TABLES,
  applyCors,
  authenticateRelayDevice,
  handlePreflight,
  isMatchableMessage,
  sendErr,
  sendOk,
  sendServerError,
  serviceClient
} from "../_webServer.js";

type PendingRow = {
  id: string;
  code_norm: string;
  amount: number;
  nickname: string;
  message: string;
  status: string;
  created_at: string;
  expires_at: string;
  grace_until: string;
};

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  applyCors(res);
  if (handlePreflight(req, res)) return;
  if (req.method !== "GET") {
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

    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    // lazy expire: 유예창까지 끝난 pending → expired
    const expireResult = await supabase
      .from(TABLES.messages)
      .update({ status: "expired" })
      .eq("page_id", auth.device.page_id)
      .eq("status", "pending")
      .lte("grace_until", nowIso);
    if (expireResult.error) {
      throw new Error(expireResult.error.message);
    }

    const listResult = await supabase
      .from(TABLES.messages)
      .select("id,code_norm,amount,nickname,message,status,created_at,expires_at,grace_until")
      .eq("page_id", auth.device.page_id)
      .in("status", ["pending", "expired"])
      .gt("grace_until", nowIso)
      .order("created_at", { ascending: true });
    if (listResult.error) {
      throw new Error(listResult.error.message);
    }

    const items: RelayPendingItem[] = ((listResult.data ?? []) as PendingRow[])
      .filter((row) => isMatchableMessage(row.status, row.grace_until, now))
      .map((row) => ({
        messageId: row.id,
        codeNorm: row.code_norm,
        amount: row.amount,
        nickname: row.nickname,
        message: row.message,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        graceUntil: row.grace_until
      }));
    sendOk(res, items);
  } catch (error) {
    sendServerError(res, error);
  }
}
