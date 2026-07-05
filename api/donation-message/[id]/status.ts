// GET /api/donation-message/:id/status — 5초 폴링용 상태 조회 (WEB_TECH_SPEC §2.1)
// expires_at이 지났는데 pending이면 lazy로 expired 전환 후 반환.
// 응답은 sendJson이 cache-control: no-store를 항상 싣는다.

import type { IncomingMessage, ServerResponse } from "node:http";

import type { DonationMessageStatus } from "../../_webShared.js";
import {
  TABLES,
  applyCors,
  handlePreflight,
  routeParam,
  sendErr,
  sendOk,
  sendServerError,
  serviceClient,
  shouldLazyExpire
} from "../../_webServer.js";

type MessageRow = {
  id: string;
  status: DonationMessageStatus["status"];
  expires_at: string;
  matched_at: string | null;
};

const messageSelect = "id,status,expires_at,matched_at";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  applyCors(res);
  if (handlePreflight(req, res)) return;
  if (req.method !== "GET") {
    sendErr(res, 405, "method-not-allowed");
    return;
  }

  try {
    // 경로: /api/donation-message/:id/status → 세그먼트 ['api','donation-message',id,'status']
    const id = routeParam(req, "id", 2);
    if (!id) {
      sendErr(res, 404, "not-found");
      return;
    }

    const supabase = serviceClient();
    const fetchResult = await supabase.from(TABLES.messages).select(messageSelect).eq("id", id).maybeSingle();
    if (fetchResult.error) {
      // 22P02 = invalid uuid 입력 — 존재하지 않는 메시지와 동일 취급
      if (fetchResult.error.code === "22P02") {
        sendErr(res, 404, "not-found");
        return;
      }
      throw new Error(fetchResult.error.message);
    }
    let row = fetchResult.data as MessageRow | null;
    if (!row) {
      sendErr(res, 404, "not-found");
      return;
    }

    if (shouldLazyExpire(row.status, row.expires_at, Date.now())) {
      // status='pending' 가드로 매칭과의 레이스에서 매칭 결과를 덮지 않는다
      const updateResult = await supabase
        .from(TABLES.messages)
        .update({ status: "expired" })
        .eq("id", row.id)
        .eq("status", "pending")
        .select(messageSelect)
        .maybeSingle();
      if (updateResult.error) {
        throw new Error(updateResult.error.message);
      }
      if (updateResult.data) {
        row = updateResult.data as MessageRow;
      } else {
        // 전환 직전에 matched 등으로 바뀐 경우 — 최신 상태를 다시 읽는다
        const refetch = await supabase.from(TABLES.messages).select(messageSelect).eq("id", row.id).maybeSingle();
        if (refetch.error) {
          throw new Error(refetch.error.message);
        }
        row = (refetch.data as MessageRow | null) ?? row;
      }
    }

    const status: DonationMessageStatus = {
      status: row.status,
      matchedAt: row.matched_at
    };
    sendOk(res, status);
  } catch (error) {
    sendServerError(res, error);
  }
}
