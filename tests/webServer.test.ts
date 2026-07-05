import { describe, expect, it } from "vitest";

import { LIMITS, generateDepositCode, normalizeDepositTag } from "../api/_webShared.js";
import {
  DEVICE_KEY_HEX_LENGTH,
  PAGE_DONATION_MSG_PER_MIN,
  connectCodeUsable,
  decodeThumbBase64,
  deviceKeyMatchesHash,
  generateDeviceKey,
  hashDeviceKey,
  hashIp,
  isBlockedNickname,
  isDeviceKeyFormat,
  isDeviceOnline,
  isMatchableMessage,
  isPastGrace,
  isUniqueViolation,
  issueDepositCode,
  publicAccountInfo,
  recordIdempotent,
  resolveMatchOutcome,
  sanitizePresetAmounts,
  sanitizeTransferLinks,
  shouldGraceExpire,
  shouldLazyExpire,
  type InsertOutcome,
  type MatchTargetRow
} from "../api/_webServer.js";

// ---------------------------------------------------------------------------
// 디바이스 키 해시 왕복
// ---------------------------------------------------------------------------

describe("device key", () => {
  it("48자 소문자 hex 키 생성(주입 바이트로 결정적)", () => {
    const key = generateDeviceKey();
    expect(key).toMatch(/^[0-9a-f]{48}$/);
    expect(key).toHaveLength(DEVICE_KEY_HEX_LENGTH);

    const fixed = generateDeviceKey((size) => Buffer.alloc(size, 0xab));
    expect(fixed).toBe("ab".repeat(24));
    expect(isDeviceKeyFormat(fixed)).toBe(true);
  });

  it("해시 왕복: 같은 키만 저장 해시와 대조 성공", () => {
    const key = generateDeviceKey();
    const stored = hashDeviceKey(key);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDeviceKey(key)).toBe(stored); // 결정적
    expect(deviceKeyMatchesHash(key, stored)).toBe(true);
    expect(deviceKeyMatchesHash(generateDeviceKey(), stored)).toBe(false);
  });

  it("형식 위반 키는 거부(길이·비 hex)", () => {
    expect(isDeviceKeyFormat("")).toBe(false);
    expect(isDeviceKeyFormat("a".repeat(47))).toBe(false);
    expect(isDeviceKeyFormat("g".repeat(48))).toBe(false);
    expect(isDeviceKeyFormat("A".repeat(48))).toBe(true); // 대소문자 관용
  });

  it("IP 해시는 결정적이며 원문과 다르다", () => {
    expect(hashIp("1.2.3.4")).toBe(hashIp("1.2.3.4"));
    expect(hashIp("1.2.3.4")).not.toBe(hashIp("1.2.3.5"));
    expect(hashIp("1.2.3.4")).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// 만료·유예 lazy 전환 판정
// ---------------------------------------------------------------------------

describe("expiry/grace 판정", () => {
  const expires = "2026-07-06T10:30:00.000Z";
  const grace = "2026-07-06T11:30:00.000Z";
  const beforeExpiry = Date.parse(expires) - 1;
  const afterExpiry = Date.parse(expires) + 1;
  const atGrace = Date.parse(grace);
  const afterGrace = Date.parse(grace) + 1;

  it("shouldLazyExpire: pending + expires_at 경과만 참(경계는 아직 유효)", () => {
    expect(shouldLazyExpire("pending", expires, afterExpiry)).toBe(true);
    expect(shouldLazyExpire("pending", expires, Date.parse(expires))).toBe(false);
    expect(shouldLazyExpire("pending", expires, beforeExpiry)).toBe(false);
    expect(shouldLazyExpire("matched", expires, afterExpiry)).toBe(false);
    expect(shouldLazyExpire("expired", expires, afterExpiry)).toBe(false);
    expect(shouldLazyExpire("pending", "broken-date", afterExpiry)).toBe(false);
  });

  it("isPastGrace: 경계 포함 유효, 잘못된 날짜는 경과 취급", () => {
    expect(isPastGrace(grace, atGrace)).toBe(false);
    expect(isPastGrace(grace, afterGrace)).toBe(true);
    expect(isPastGrace("broken-date", atGrace)).toBe(true);
  });

  it("isMatchableMessage: expired여도 유예창 안이면 지연 매칭 후보", () => {
    expect(isMatchableMessage("pending", grace, afterExpiry)).toBe(true);
    expect(isMatchableMessage("expired", grace, afterExpiry)).toBe(true); // status 폴링이 lazy expire한 케이스
    expect(isMatchableMessage("expired", grace, atGrace)).toBe(true); // 경계 포함
    expect(isMatchableMessage("pending", grace, afterGrace)).toBe(false);
    expect(isMatchableMessage("expired", grace, afterGrace)).toBe(false);
    expect(isMatchableMessage("matched", grace, afterExpiry)).toBe(false);
    expect(isMatchableMessage("blocked", grace, afterExpiry)).toBe(false);
  });

  it("shouldGraceExpire: 유예까지 끝난 pending만 릴레이 lazy expire 대상", () => {
    expect(shouldGraceExpire("pending", grace, afterGrace)).toBe(true);
    expect(shouldGraceExpire("pending", grace, atGrace)).toBe(false);
    expect(shouldGraceExpire("expired", grace, afterGrace)).toBe(false);
  });

  it("connectCodeUsable: 만료 전(경계 포함)만 사용 가능, null·과거는 불가", () => {
    const codeExpires = "2026-07-06T10:10:00.000Z";
    expect(connectCodeUsable(codeExpires, Date.parse(codeExpires))).toBe(true);
    expect(connectCodeUsable(codeExpires, Date.parse(codeExpires) - 1)).toBe(true);
    expect(connectCodeUsable(codeExpires, Date.parse(codeExpires) + 1)).toBe(false);
    expect(connectCodeUsable(null, Date.parse(codeExpires))).toBe(false);
    expect(connectCodeUsable("broken-date", Date.parse(codeExpires))).toBe(false);
  });

  it("isDeviceOnline: 마지막 heartbeat 180초(경계 포함) 이내", () => {
    const last = "2026-07-06T10:00:00.000Z";
    const windowMs = LIMITS.heartbeatOnlineSeconds * 1000;
    expect(isDeviceOnline(last, Date.parse(last) + windowMs)).toBe(true);
    expect(isDeviceOnline(last, Date.parse(last) + windowMs + 1)).toBe(false);
    expect(isDeviceOnline(null, Date.parse(last))).toBe(false);
    expect(isDeviceOnline("broken-date", Date.parse(last))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// match-report 분기 · 멱등 충돌 처리
// ---------------------------------------------------------------------------

describe("resolveMatchOutcome", () => {
  const now = Date.parse("2026-07-06T10:40:00.000Z");
  const grace = "2026-07-06T11:30:00.000Z";
  const message = (over: Partial<MatchTargetRow> = {}): MatchTargetRow => ({
    id: "msg-1",
    page_id: "page-1",
    status: "pending",
    grace_until: grace,
    ...over
  });

  it("pending·expired(유예창 내) 메시지는 attach", () => {
    expect(resolveMatchOutcome(message(), "page-1", now)).toEqual({ attach: true, messageId: "msg-1" });
    expect(resolveMatchOutcome(message({ status: "expired" }), "page-1", now)).toEqual({
      attach: true,
      messageId: "msg-1"
    });
  });

  it("메시지 없음·타 페이지·매칭 불가면 messageId 무시(미매칭 기록)", () => {
    expect(resolveMatchOutcome(null, "page-1", now)).toEqual({ attach: false, reason: "no-message" });
    expect(resolveMatchOutcome(message({ page_id: "page-2" }), "page-1", now)).toEqual({
      attach: false,
      reason: "wrong-page"
    });
    expect(resolveMatchOutcome(message({ status: "matched" }), "page-1", now)).toEqual({
      attach: false,
      reason: "not-matchable"
    });
    expect(resolveMatchOutcome(message(), "page-1", Date.parse(grace) + 1)).toEqual({
      attach: false,
      reason: "not-matchable"
    });
  });
});

describe("recordIdempotent (멱등 충돌 처리 분기)", () => {
  type Row = { id: string };

  it("기존 기록이 있으면 insert 없이 duplicate 반환", async () => {
    let inserted = 0;
    const result = await recordIdempotent<Row>({
      findExisting: async () => ({ id: "m-1" }),
      insert: async () => {
        inserted += 1;
        return { kind: "ok", row: { id: "m-new" } };
      }
    });
    expect(result).toEqual({ kind: "ok", row: { id: "m-1" }, duplicate: true });
    expect(inserted).toBe(0);
  });

  it("신규면 insert 결과를 duplicate=false로 반환", async () => {
    const result = await recordIdempotent<Row>({
      findExisting: async () => null,
      insert: async () => ({ kind: "ok", row: { id: "m-new" } })
    });
    expect(result).toEqual({ kind: "ok", row: { id: "m-new" }, duplicate: false });
  });

  it("동시 보고 레이스(23505)면 기존 행을 다시 읽어 duplicate 처리", async () => {
    let looked = 0;
    const result = await recordIdempotent<Row>({
      findExisting: async () => (looked++ === 0 ? null : { id: "m-raced" }),
      insert: async () => ({ kind: "conflict" })
    });
    expect(result).toEqual({ kind: "ok", row: { id: "m-raced" }, duplicate: true });
    expect(looked).toBe(2);
  });

  it("insert 에러는 그대로 전파", async () => {
    const result = await recordIdempotent<Row>({
      findExisting: async () => null,
      insert: async () => ({ kind: "error", message: "boom" })
    });
    expect(result).toEqual({ kind: "error", message: "boom" });
  });

  it("isUniqueViolation은 23505만 참", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ code: "22P02" })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 입금코드 발급 재시도
// ---------------------------------------------------------------------------

describe("issueDepositCode (코드 충돌 재시도)", () => {
  type Row = { id: string; codeNorm: string };

  it("첫 시도에 성공하면 그대로 반환", async () => {
    let fetches = 0;
    const result = await issueDepositCode<Row>(
      "민수",
      async () => {
        fetches += 1;
        return new Set<string>();
      },
      async (code) => ({ kind: "ok", row: { id: "d-1", codeNorm: code.codeNorm } })
    );
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.row.codeNorm).toBe(result.code.codeNorm);
      expect(result.code.code.startsWith("민수")).toBe(true);
    }
    expect(fetches).toBe(1);
  });

  it("유니크 충돌(23505) 시 taken 집합을 다시 읽어 1회 재추첨", async () => {
    // 서버(DB)에는 이미 taken인데 첫 fetch가 그걸 못 본 상황을 재연
    const serverTaken = new Set<string>([generateDepositCode("민수", new Set(), () => 0).codeNorm]);
    let fetches = 0;
    const inserts: string[] = [];
    const result = await issueDepositCode<Row>(
      "민수",
      async () => {
        fetches += 1;
        return fetches === 1 ? new Set<string>() : serverTaken;
      },
      async (code) => {
        inserts.push(code.codeNorm);
        if (serverTaken.has(code.codeNorm)) return { kind: "conflict" };
        return { kind: "ok", row: { id: "d-2", codeNorm: code.codeNorm } };
      },
      { rand: () => 0 } // 재추첨 없이는 항상 같은 코드가 나오는 최악 조건
    );
    expect(result.kind).toBe("ok");
    expect(fetches).toBe(2); // 충돌 후 재조회
    expect(inserts).toHaveLength(2);
    expect(inserts[0]).not.toBe(inserts[1]); // 두 번째 시도는 taken을 피해 재추첨
    if (result.kind === "ok") {
      expect(serverTaken.has(result.code.codeNorm)).toBe(false);
    }
  });

  it("재시도까지 전부 충돌하면 exhausted", async () => {
    const result = await issueDepositCode<Row>(
      "민수",
      async () => new Set<string>(),
      async () => ({ kind: "conflict" })
    );
    expect(result).toEqual({ kind: "exhausted" });
  });

  it("generateDepositCode 소진(2·3자 전부 taken)도 exhausted", async () => {
    // rand=0 고정이면 접미는 항상 'AA'/'AAA' — 둘 다 taken이면 생성기가 던진다
    const base = "민수";
    const taken = new Set<string>([
      normalizeDepositTag(`${base}AA`),
      normalizeDepositTag(`${base}AAA`)
    ]);
    let inserts = 0;
    const result = await issueDepositCode<Row>(
      base,
      async () => taken,
      async () => {
        inserts += 1;
        return { kind: "conflict" };
      },
      { rand: () => 0 }
    );
    expect(result).toEqual({ kind: "exhausted" });
    expect(inserts).toBe(0); // insert 시도 전에 소진 판정
  });

  it("insert 일반 에러는 error로 전파", async () => {
    const result = await issueDepositCode<Row>(
      "민수",
      async () => new Set<string>(),
      async () => ({ kind: "error", message: "db down" })
    );
    expect(result).toEqual({ kind: "error", message: "db down" });
  });
});

// ---------------------------------------------------------------------------
// 차단·정제 헬퍼
// ---------------------------------------------------------------------------

describe("isBlockedNickname", () => {
  it("공백·대소문자·NFD 변형까지 정규화 비교로 차단", () => {
    expect(isBlockedNickname("민수", ["민수"])).toBe(true);
    expect(isBlockedNickname(" 민 수 ", ["민수"])).toBe(true);
    expect(isBlockedNickname("BadGuy", ["badguy"])).toBe(true);
    expect(isBlockedNickname("민수".normalize("NFD"), ["민수"])).toBe(true);
  });

  it("불일치·빈 목록은 통과", () => {
    expect(isBlockedNickname("민수", ["철수"])).toBe(false);
    expect(isBlockedNickname("민수", [])).toBe(false);
  });
});

describe("decodeThumbBase64", () => {
  it("정상 base64는 원본 버퍼로 왕복", () => {
    const original = Buffer.from("thumb-bytes");
    const result = decodeThumbBase64(original.toString("base64"));
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.buffer.equals(original)).toBe(true);
    }
  });

  it("data URI 접두는 벗겨서 처리", () => {
    const original = Buffer.from([1, 2, 3, 4]);
    const result = decodeThumbBase64(`data:image/jpeg;base64,${original.toString("base64")}`);
    expect(result.kind).toBe("ok");
  });

  it("LIMITS.thumbMaxKb 초과는 too-large", () => {
    const oversized = Buffer.alloc(LIMITS.thumbMaxKb * 1024 + 1, 1);
    const result = decodeThumbBase64(oversized.toString("base64"));
    expect(result).toEqual({ kind: "too-large", bytes: oversized.length });
    // 경계(정확히 200KB)는 허용
    const exact = Buffer.alloc(LIMITS.thumbMaxKb * 1024, 1);
    expect(decodeThumbBase64(exact.toString("base64")).kind).toBe("ok");
  });

  it("빈 문자열·비 base64는 invalid", () => {
    expect(decodeThumbBase64("")).toEqual({ kind: "invalid" });
    expect(decodeThumbBase64("!!!not-base64!!!")).toEqual({ kind: "invalid" });
  });
});

describe("공개 뷰 정제 헬퍼", () => {
  it("publicAccountInfo: full일 때만, 필드가 온전할 때만 노출", () => {
    const info = { bank: "국민", number: "123-456", holder: "김계이" };
    expect(publicAccountInfo("full", info)).toEqual(info);
    expect(publicAccountInfo("link_only", info)).toBeNull();
    expect(publicAccountInfo("full", { bank: "국민" })).toBeNull();
    expect(publicAccountInfo("full", null)).toBeNull();
  });

  it("sanitizeTransferLinks: toss/kakao 외 항목·비정상 구조 제거", () => {
    expect(
      sanitizeTransferLinks([
        { type: "toss", url: "https://toss.me/a" },
        { type: "paypal", url: "https://paypal.me/a" },
        { type: "kakao" },
        "garbage"
      ])
    ).toEqual([{ type: "toss", url: "https://toss.me/a" }]);
    expect(sanitizeTransferLinks(null)).toEqual([]);
  });

  it("sanitizePresetAmounts: 비정상 값은 기본 프리셋으로 폴백", () => {
    expect(sanitizePresetAmounts([1000, 5000])).toEqual([1000, 5000]);
    expect(sanitizePresetAmounts([1000, -5, 2.5])).toEqual([1000]);
    expect(sanitizePresetAmounts("nope")).toEqual([...LIMITS.presetsDefault]);
    expect(sanitizePresetAmounts([])).toEqual([...LIMITS.presetsDefault]);
  });

  it("page 단위 레이트리밋 상한은 20건/분(IP 컬럼 부재 대체 — 통합자 보고 사항)", () => {
    expect(PAGE_DONATION_MSG_PER_MIN).toBe(20);
    expect(PAGE_DONATION_MSG_PER_MIN).toBeGreaterThan(LIMITS.donationMsgPerMinPerIp);
  });
});
