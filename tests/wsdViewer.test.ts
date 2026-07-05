// WSD 트랙 단위 테스트 — /api/channels · /api/me/donations 순수 헬퍼
import { describe, expect, it } from "vitest";

import {
  decodeCursor,
  encodeCursor,
  isOnlineHeartbeat,
  matchesChannelQuery
} from "../api/channels.js";
import { effectiveDonationStatus, firstOf } from "../api/me/donations.js";

describe("encodeCursor / decodeCursor", () => {
  it("라운드트립 보존", () => {
    const cursor = { createdAt: "2026-07-06T05:00:00.123456+00:00", id: "8b0f2a44-0000-4000-8000-000000000001" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("빈 값·깨진 값·형식 위반은 null", () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("not-base64url-json")).toBeNull();
    // JSON이지만 필드 누락
    const missing = Buffer.from(JSON.stringify({ t: "2026-07-06T05:00:00Z" }), "utf8").toString("base64url");
    expect(decodeCursor(missing)).toBeNull();
    // 날짜가 파싱 불가
    const badDate = Buffer.from(JSON.stringify({ t: "nope", i: "x" }), "utf8").toString("base64url");
    expect(decodeCursor(badDate)).toBeNull();
  });
});

describe("matchesChannelQuery", () => {
  it("빈 검색어는 전체 통과", () => {
    expect(matchesChannelQuery("", "gyeideuk", "계이득")).toBe(true);
    expect(matchesChannelQuery("   ", "gyeideuk", "계이득")).toBe(true);
  });

  it("핸들·채널명 부분 일치(대소문자 무시)", () => {
    expect(matchesChannelQuery("GYEI", "gyeideuk", "계이득")).toBe(true);
    expect(matchesChannelQuery("이득", "gyeideuk", "계이득")).toBe(true);
    expect(matchesChannelQuery("deuk", "gyeideuk", "계이득")).toBe(true);
  });

  it("불일치는 거짓", () => {
    expect(matchesChannelQuery("민트", "gyeideuk", "계이득")).toBe(false);
  });
});

describe("isOnlineHeartbeat", () => {
  const now = Date.parse("2026-07-06T12:00:00.000Z");

  it("3분 이내면 온라인, 경계 포함", () => {
    expect(isOnlineHeartbeat("2026-07-06T11:59:00.000Z", now)).toBe(true);
    expect(isOnlineHeartbeat("2026-07-06T11:57:00.000Z", now)).toBe(true); // 정확히 180초
    expect(isOnlineHeartbeat("2026-07-06T11:56:59.999Z", now)).toBe(false);
  });

  it("없거나 깨진 값은 오프라인", () => {
    expect(isOnlineHeartbeat(null, now)).toBe(false);
    expect(isOnlineHeartbeat(undefined, now)).toBe(false);
    expect(isOnlineHeartbeat("invalid", now)).toBe(false);
  });
});

describe("effectiveDonationStatus", () => {
  const now = Date.parse("2026-07-06T12:00:00.000Z");

  it("pending + 만료 시각 경과 → expired 표시", () => {
    expect(effectiveDonationStatus("pending", "2026-07-06T11:00:00.000Z", now)).toBe("expired");
  });

  it("pending + 만료 전(경계 포함) → pending 유지", () => {
    expect(effectiveDonationStatus("pending", "2026-07-06T12:00:00.000Z", now)).toBe("pending");
    expect(effectiveDonationStatus("pending", "2026-07-06T12:30:00.000Z", now)).toBe("pending");
  });

  it("pending 외 상태는 그대로", () => {
    expect(effectiveDonationStatus("matched", "2026-07-06T11:00:00.000Z", now)).toBe("matched");
    expect(effectiveDonationStatus("expired", "2026-07-06T11:00:00.000Z", now)).toBe("expired");
    expect(effectiveDonationStatus("blocked", "2026-07-06T11:00:00.000Z", now)).toBe("blocked");
  });

  it("만료 시각이 깨진 값이면 pending 유지(오탐 방지)", () => {
    expect(effectiveDonationStatus("pending", "invalid", now)).toBe("pending");
  });
});

describe("firstOf", () => {
  it("객체/배열/빈 값 정규화", () => {
    expect(firstOf({ handle: "a" })).toEqual({ handle: "a" });
    expect(firstOf([{ handle: "a" }, { handle: "b" }])).toEqual({ handle: "a" });
    expect(firstOf([])).toBeNull();
    expect(firstOf(null)).toBeNull();
    expect(firstOf(undefined)).toBeNull();
  });
});
