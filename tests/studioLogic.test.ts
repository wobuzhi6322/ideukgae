import { describe, expect, it } from "vitest";

import { LIMITS } from "../api/_webShared.js";
import { normalizeBlockedValue } from "../api/studio/blocks.js";
import { isDeviceOnline, kstDayStartIso } from "../api/studio/feed.js";
import {
  buildPagePatch,
  handleChangeBlockedUntil,
  sanitizeAccountInfo,
  sanitizeBroadcastLinks,
  sanitizeHttpUrl,
  sanitizePresetAmounts,
  sanitizeTransferLinks
} from "../api/studio/page.js";
import {
  CONNECT_CODE_ALPHABET,
  CONNECT_CODE_LENGTH,
  generateConnectCode
} from "../api/studio/relay-connect-code.js";
import { applySignatureEdits } from "../api/studio/signatures.js";

// ---------------------------------------------------------------------------
// 연결 코드 (relay-connect-code)
// ---------------------------------------------------------------------------

describe("generateConnectCode", () => {
  it("8자리 대문자 영숫자, 알파벳 집합 내 문자만", () => {
    const code = generateConnectCode();
    expect(code).toHaveLength(CONNECT_CODE_LENGTH);
    for (const ch of code) {
      expect(CONNECT_CODE_ALPHABET).toContain(ch);
    }
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
  });

  it("혼동 문자(I,L,O,0,1)는 알파벳에 없다", () => {
    expect(CONNECT_CODE_ALPHABET).not.toMatch(/[ILO01]/);
  });

  it("rand 주입 시 결정적", () => {
    const zero = () => 0;
    expect(generateConnectCode(zero)).toBe("A".repeat(CONNECT_CODE_LENGTH));
    const last = () => 0.999999;
    expect(generateConnectCode(last)).toBe("9".repeat(CONNECT_CODE_LENGTH));
  });
});

// ---------------------------------------------------------------------------
// 대시보드 (feed)
// ---------------------------------------------------------------------------

describe("kstDayStartIso", () => {
  it("KST 낮 시간대 → 그날 KST 0시(= 전날 15:00 UTC)", () => {
    // 2026-07-06 12:00 KST = 03:00 UTC
    expect(kstDayStartIso(Date.parse("2026-07-06T03:00:00.000Z"))).toBe("2026-07-05T15:00:00.000Z");
  });

  it("KST 새벽(UTC 전날 밤)도 같은 KST 날짜로 계산", () => {
    // 2026-07-06 01:00 KST = 2026-07-05 16:00 UTC
    expect(kstDayStartIso(Date.parse("2026-07-05T16:00:00.000Z"))).toBe("2026-07-05T15:00:00.000Z");
  });

  it("KST 자정 직전은 전날로", () => {
    // 2026-07-05 23:59 KST = 14:59 UTC
    expect(kstDayStartIso(Date.parse("2026-07-05T14:59:00.000Z"))).toBe("2026-07-04T15:00:00.000Z");
  });
});

describe("isDeviceOnline", () => {
  const now = Date.parse("2026-07-06T03:00:00.000Z");

  it("heartbeat 180초 이내면 온라인, 경계 포함", () => {
    expect(isDeviceOnline(new Date(now - 10_000).toISOString(), now)).toBe(true);
    expect(isDeviceOnline(new Date(now - LIMITS.heartbeatOnlineSeconds * 1000).toISOString(), now)).toBe(true);
    expect(isDeviceOnline(new Date(now - LIMITS.heartbeatOnlineSeconds * 1000 - 1).toISOString(), now)).toBe(false);
  });

  it("null·잘못된 값은 오프라인", () => {
    expect(isDeviceOnline(null, now)).toBe(false);
    expect(isDeviceOnline("nope", now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 채널 페이지 설정 (page)
// ---------------------------------------------------------------------------

describe("handleChangeBlockedUntil", () => {
  const now = Date.parse("2026-07-06T00:00:00.000Z");

  it("변경 이력이 없으면 즉시 가능", () => {
    expect(handleChangeBlockedUntil(null, now)).toBeNull();
  });

  it("30일 이내 변경 이력은 해제 시각 반환", () => {
    const changed = new Date(now - 10 * 86_400_000).toISOString();
    const until = handleChangeBlockedUntil(changed, now);
    expect(until).toBe(new Date(now + 20 * 86_400_000).toISOString());
  });

  it("30일 경과 시 가능", () => {
    const changed = new Date(now - LIMITS.handleChangeCooldownDays * 86_400_000).toISOString();
    expect(handleChangeBlockedUntil(changed, now)).toBeNull();
  });
});

describe("buildPagePatch", () => {
  const now = Date.parse("2026-07-06T00:00:00.000Z");
  const page = { handle: "gyeideuk", handle_changed_at: null };

  it("핸들 변경: 소문자화 + handle_changed_at 기록", () => {
    const patch = buildPagePatch({ handle: "New-Handle" }, page, now);
    expect(patch.handle).toBe("new-handle");
    expect(patch.handle_changed_at).toBe(new Date(now).toISOString());
  });

  it("동일 핸들(대소문자 차이 포함)은 변경으로 치지 않는다", () => {
    const patch = buildPagePatch({ handle: "GyeIdeuk" }, page, now);
    expect(patch.handle).toBeUndefined();
  });

  it("쿨다운 중 핸들 변경은 거부", () => {
    const recent = { handle: "gyeideuk", handle_changed_at: new Date(now - 86_400_000).toISOString() };
    expect(() => buildPagePatch({ handle: "other-handle" }, recent, now)).toThrow(/30일에 1번/);
  });

  it("예약어·형식 위반 핸들 거부", () => {
    expect(() => buildPagePatch({ handle: "studio" }, page, now)).toThrow();
    expect(() => buildPagePatch({ handle: "-bad-" }, page, now)).toThrow();
  });

  it("min_amount 하한·bio 길이·불리언 검증", () => {
    expect(() => buildPagePatch({ minAmount: LIMITS.minAmountFloor - 1 }, page, now)).toThrow();
    expect(buildPagePatch({ minAmount: 1000 }, page, now).min_amount).toBe(1000);
    expect(() => buildPagePatch({ bio: "가".repeat(LIMITS.bioMax + 1) }, page, now)).toThrow();
    expect(() => buildPagePatch({ tickerPublic: "yes" as unknown as boolean }, page, now)).toThrow();
    expect(buildPagePatch({ directoryOptin: true }, page, now).directory_optin).toBe(true);
  });

  it("빈 문자열 bio·URL은 null로 정규화", () => {
    const patch = buildPagePatch({ bio: "  ", bannerUrl: "" }, page, now);
    expect(patch.bio).toBeNull();
    expect(patch.banner_url).toBeNull();
  });
});

describe("sanitize 헬퍼", () => {
  it("sanitizeHttpUrl: http(s)만 허용, 빈 값은 null", () => {
    expect(sanitizeHttpUrl("https://chzzk.naver.com/abc")).toBe("https://chzzk.naver.com/abc");
    expect(sanitizeHttpUrl(null)).toBeNull();
    expect(sanitizeHttpUrl("   ")).toBeNull();
    expect(() => sanitizeHttpUrl("javascript:alert(1)")).toThrow();
    expect(() => sanitizeHttpUrl("ftp://x")).toThrow();
  });

  it("sanitizePresetAmounts: 1~6개 양의 정수", () => {
    expect(sanitizePresetAmounts([1000, 5000, 10000, 50000])).toEqual([1000, 5000, 10000, 50000]);
    expect(() => sanitizePresetAmounts([])).toThrow();
    expect(() => sanitizePresetAmounts([0])).toThrow();
    expect(() => sanitizePresetAmounts([1.5])).toThrow();
    expect(() => sanitizePresetAmounts("1000" as unknown as number[])).toThrow();
  });

  it("sanitizeBroadcastLinks: 플랫폼 화이트리스트", () => {
    expect(sanitizeBroadcastLinks([{ platform: "chzzk", url: "https://chzzk.naver.com/x" }])).toEqual([
      { platform: "chzzk", url: "https://chzzk.naver.com/x" }
    ]);
    expect(() => sanitizeBroadcastLinks([{ platform: "twitch", url: "https://t.tv/x" }])).toThrow();
    expect(() => sanitizeBroadcastLinks([{ platform: "chzzk", url: "not-url" }])).toThrow();
  });

  it("sanitizeTransferLinks: toss·kakao만", () => {
    expect(sanitizeTransferLinks([{ type: "toss", url: "https://toss.me/x" }])).toEqual([
      { type: "toss", url: "https://toss.me/x" }
    ]);
    expect(() => sanitizeTransferLinks([{ type: "bank", url: "https://x.com" }])).toThrow();
  });

  it("sanitizeAccountInfo: 전부 입력 또는 null", () => {
    expect(sanitizeAccountInfo(null)).toBeNull();
    expect(sanitizeAccountInfo({ bank: "", number: "", holder: "" })).toBeNull();
    expect(sanitizeAccountInfo({ bank: "국민", number: "123-45-678", holder: "김계이" })).toEqual({
      bank: "국민",
      number: "123-45-678",
      holder: "김계이"
    });
    expect(() => sanitizeAccountInfo({ bank: "국민", number: "", holder: "김계이" })).toThrow();
    expect(() => sanitizeAccountInfo({ bank: "국민", number: "abc", holder: "김계이" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 시그니처 일괄 편집 (signatures)
// ---------------------------------------------------------------------------

describe("applySignatureEdits", () => {
  const current = [
    { id: "a", pinned: true },
    { id: "b", pinned: true },
    { id: "c", pinned: false },
    { id: "d", pinned: false }
  ];

  it("정상 편집 → snake_case 업데이트 맵", () => {
    const result = applySignatureEdits(current, [
      { id: "c", published: true, webTitle: "  풍선 100개  ", sort: 10 },
      { id: "d", pinned: true }
    ]);
    expect("updates" in result).toBe(true);
    if ("updates" in result) {
      expect(result.updates.get("c")).toEqual({ published: true, web_title: "풍선 100개", sort: 10 });
      expect(result.updates.get("d")).toEqual({ pinned: true });
    }
  });

  it("빈 웹 제목은 null(로컬 제목으로 복귀)", () => {
    const result = applySignatureEdits(current, [{ id: "a", webTitle: "   " }]);
    if ("updates" in result) {
      expect(result.updates.get("a")).toEqual({ web_title: null });
    } else {
      throw new Error("updates expected");
    }
  });

  it("핀 총량이 pinnedMax를 넘으면 에러", () => {
    const result = applySignatureEdits(current, [
      { id: "c", pinned: true },
      { id: "d", pinned: true }
    ]);
    expect("error" in result && result.error).toMatch(new RegExp(`${LIMITS.pinnedMax}개`));
  });

  it("핀 해제와 동시에 다른 핀 지정은 허용", () => {
    const result = applySignatureEdits(current, [
      { id: "a", pinned: false },
      { id: "c", pinned: true }
    ]);
    expect("updates" in result).toBe(true);
  });

  it("알 수 없는 id·타입 위반·웹 제목 길이 초과는 에러", () => {
    expect("error" in applySignatureEdits(current, [{ id: "zzz", published: true }])).toBe(true);
    expect(
      "error" in applySignatureEdits(current, [{ id: "a", published: "yes" as unknown as boolean }])
    ).toBe(true);
    expect(
      "error" in applySignatureEdits(current, [{ id: "a", webTitle: "가".repeat(LIMITS.webTitleMax + 1) }])
    ).toBe(true);
    expect("error" in applySignatureEdits(current, [{ id: "a", sort: 1.5 }])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 차단 (blocks)
// ---------------------------------------------------------------------------

describe("normalizeBlockedValue", () => {
  it("트림 후 1~40자", () => {
    expect(normalizeBlockedValue("  악성유저  ")).toBe("악성유저");
    expect(() => normalizeBlockedValue("   ")).toThrow();
    expect(() => normalizeBlockedValue("가".repeat(41))).toThrow();
    expect(() => normalizeBlockedValue(123)).toThrow();
  });
});
