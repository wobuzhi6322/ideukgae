import { describe, expect, it } from "vitest";

import {
  HANDLE_REUSE_LOCK_DAYS,
  handleChangeBlockedUntil,
  handleReuseLockedUntil,
  validateHandleChange
} from "../api/_handlePolicy.js";
import { LIMITS } from "../api/_webShared.js";

const DAY = 86_400_000;
const now = Date.parse("2026-07-11T00:00:00.000Z");

const base = {
  currentHandle: "gyeideuk-tv",
  handleChangedAt: null as string | null,
  pageId: "page-1" as string | null,
  historyRow: null,
  nowMs: now
};

// ---------------------------------------------------------------------------
// validateHandleChange — ① 예약어·형식
// ---------------------------------------------------------------------------

describe("validateHandleChange: 예약어·형식", () => {
  it("예약어 핸들은 handle-reserved로 거부", () => {
    for (const reserved of ["studio", "relay", "gaeideuk", "channel", "admin", "login"]) {
      const verdict = validateHandleChange({ ...base, newHandle: reserved });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.code).toBe("handle-reserved");
        expect(verdict.status).toBe(400);
      }
    }
  });

  it("형식 위반은 handle-invalid로 거부", () => {
    for (const bad of ["-bad-", "ab", "ABC", "한글핸들", "a".repeat(21)]) {
      const verdict = validateHandleChange({ ...base, newHandle: bad });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe("handle-invalid");
    }
  });

  it("정상 핸들은 통과", () => {
    expect(validateHandleChange({ ...base, newHandle: "dalbit" }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateHandleChange — ② 30일 쿨다운
// ---------------------------------------------------------------------------

describe("validateHandleChange: 30일 쿨다운", () => {
  it("최근 변경(10일 전) 후 다른 핸들로 변경은 거부", () => {
    const verdict = validateHandleChange({
      ...base,
      newHandle: "dalbit",
      handleChangedAt: new Date(now - 10 * DAY).toISOString()
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("validation-failed");
      expect(verdict.message).toMatch(/30일에 1번/);
    }
  });

  it("30일 경과 후에는 허용", () => {
    const verdict = validateHandleChange({
      ...base,
      newHandle: "dalbit",
      handleChangedAt: new Date(now - LIMITS.handleChangeCooldownDays * DAY).toISOString()
    });
    expect(verdict.ok).toBe(true);
  });

  it("동일 핸들(대소문자·공백 차이)은 변경이 아니므로 쿨다운 미적용", () => {
    const verdict = validateHandleChange({
      ...base,
      newHandle: "gyeideuk-tv",
      handleChangedAt: new Date(now - DAY).toISOString()
    });
    expect(verdict.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateHandleChange — ③ 90일 재사용 잠금 · ④ 자기 구 핸들 되찾기
// ---------------------------------------------------------------------------

describe("validateHandleChange: 90일 재사용 잠금", () => {
  it("다른 페이지가 89일 전에 버린 핸들은 handle-taken(409)", () => {
    const verdict = validateHandleChange({
      ...base,
      newHandle: "dalbit",
      historyRow: { pageId: "page-other", changedAt: new Date(now - 89 * DAY).toISOString() }
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("handle-taken");
      expect(verdict.status).toBe(409);
    }
  });

  it("90일이 지난 이력은 재사용 허용", () => {
    const verdict = validateHandleChange({
      ...base,
      newHandle: "dalbit",
      historyRow: { pageId: "page-other", changedAt: new Date(now - HANDLE_REUSE_LOCK_DAYS * DAY).toISOString() }
    });
    expect(verdict.ok).toBe(true);
  });

  it("자기 페이지의 구 핸들 되찾기는 잠금 기간 내에도 허용", () => {
    const verdict = validateHandleChange({
      ...base,
      newHandle: "dalbit",
      historyRow: { pageId: "page-1", changedAt: new Date(now - DAY).toISOString() }
    });
    expect(verdict.ok).toBe(true);
  });

  it("온보딩(pageId=null)은 되찾기 예외 없이 잠금 적용", () => {
    const verdict = validateHandleChange({
      newHandle: "dalbit",
      currentHandle: "",
      handleChangedAt: null,
      pageId: null,
      historyRow: { pageId: "page-other", changedAt: new Date(now - DAY).toISOString() },
      nowMs: now
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("handle-taken");
  });

  it("온보딩: 이력이 없으면 허용", () => {
    const verdict = validateHandleChange({
      newHandle: "dalbit",
      currentHandle: "",
      handleChangedAt: null,
      pageId: null,
      historyRow: null,
      nowMs: now
    });
    expect(verdict.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 시각 헬퍼
// ---------------------------------------------------------------------------

describe("handleChangeBlockedUntil", () => {
  it("이력 없음·잘못된 값은 즉시 가능", () => {
    expect(handleChangeBlockedUntil(null, now)).toBeNull();
    expect(handleChangeBlockedUntil("nope", now)).toBeNull();
  });

  it("30일 이내면 해제 시각, 경계(정확히 30일)는 가능", () => {
    expect(handleChangeBlockedUntil(new Date(now - 10 * DAY).toISOString(), now)).toBe(
      new Date(now + 20 * DAY).toISOString()
    );
    expect(handleChangeBlockedUntil(new Date(now - LIMITS.handleChangeCooldownDays * DAY).toISOString(), now)).toBeNull();
  });
});

describe("handleReuseLockedUntil", () => {
  it("90일 이내면 해제 시각, 경계(정확히 90일)는 해제", () => {
    expect(handleReuseLockedUntil(new Date(now - DAY).toISOString(), now)).toBe(
      new Date(now + (HANDLE_REUSE_LOCK_DAYS - 1) * DAY).toISOString()
    );
    expect(handleReuseLockedUntil(new Date(now - HANDLE_REUSE_LOCK_DAYS * DAY).toISOString(), now)).toBeNull();
  });

  it("잘못된 시각 문자열은 잠금 없음", () => {
    expect(handleReuseLockedUntil("nope", now)).toBeNull();
  });
});
