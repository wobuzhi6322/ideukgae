import { describe, expect, it } from "vitest";

import { LIMITS, handleRejectCode } from "../api/_webShared.js";
import { nicknameFromEmail, parseProfilePatch, toWebRoles } from "../api/me/profile.js";
import { handleErrorMessage, normalizeHandleInput, rolesWithStreamer } from "../api/onboard-streamer.js";

// =============================================================================
// WSA — /api/me/profile · /api/onboard-streamer 순수 로직
// =============================================================================

describe("nicknameFromEmail", () => {
  it("이메일 앞부분을 닉네임으로 사용", () => {
    expect(nicknameFromEmail("minsu@example.com")).toBe("minsu");
    expect(nicknameFromEmail("min.su_99@example.com")).toBe("min.su_99");
  });

  it("허용 문자만 남기고 최대 20자로 자른다", () => {
    expect(nicknameFromEmail("min+su!@example.com")).toBe("minsu");
    expect(nicknameFromEmail(`${"a".repeat(30)}@example.com`)).toBe("a".repeat(LIMITS.nicknameMax));
  });

  it("비거나 정제 후 빈 값이면 '후원자' 폴백", () => {
    expect(nicknameFromEmail(null)).toBe("후원자");
    expect(nicknameFromEmail("")).toBe("후원자");
    expect(nicknameFromEmail("+++@example.com")).toBe("후원자");
  });
});

describe("parseProfilePatch", () => {
  it("정상 patch: 필드별 정제 값 반환", () => {
    const parsed = parseProfilePatch({
      nickname: " 민수 ",
      avatarUrl: "https://cdn.example.com/a.png",
      defaultMessage: "응원해요",
      notifyEmail: false
    });
    expect(parsed.code).toBeNull();
    expect(parsed.patch).toEqual({
      nickname: "민수",
      avatarUrl: "https://cdn.example.com/a.png",
      defaultMessage: "응원해요",
      notifyEmail: false
    });
  });

  it("부분 patch 허용 (WebProfile 필드 일부만)", () => {
    const parsed = parseProfilePatch({ notifyEmail: true });
    expect(parsed.code).toBeNull();
    expect(parsed.patch).toEqual({ notifyEmail: true });
  });

  it("빈 본문은 validation-failed", () => {
    expect(parseProfilePatch({}).code).toBe("validation-failed");
    expect(parseProfilePatch({ unknownField: 1 }).code).toBe("validation-failed");
  });

  it("닉네임 위반: 공백만·초과 길이·비문자열", () => {
    expect(parseProfilePatch({ nickname: "  " }).code).toBe("nickname-invalid");
    expect(parseProfilePatch({ nickname: "가".repeat(LIMITS.nicknameMax + 1) }).code).toBe("nickname-invalid");
    expect(parseProfilePatch({ nickname: 3 }).code).toBe("nickname-invalid");
  });

  it("기본 메시지 초과는 message-too-long, null은 초기화 허용", () => {
    expect(parseProfilePatch({ defaultMessage: "가".repeat(LIMITS.messageMax + 1) }).code).toBe("message-too-long");
    const cleared = parseProfilePatch({ defaultMessage: null });
    expect(cleared.code).toBeNull();
    expect(cleared.patch.defaultMessage).toBeNull();
  });

  it("avatarUrl·notifyEmail 타입 위반은 validation-failed", () => {
    expect(parseProfilePatch({ avatarUrl: 123 }).code).toBe("validation-failed");
    expect(parseProfilePatch({ avatarUrl: "x".repeat(501) }).code).toBe("validation-failed");
    expect(parseProfilePatch({ notifyEmail: "yes" }).code).toBe("validation-failed");
  });

  it("avatarUrl null·빈 문자열은 null로 정규화", () => {
    expect(parseProfilePatch({ avatarUrl: null }).patch.avatarUrl).toBeNull();
    expect(parseProfilePatch({ avatarUrl: "  " }).patch.avatarUrl).toBeNull();
  });
});

describe("toWebRoles", () => {
  it("알 수 없는 역할 제거·중복 제거", () => {
    expect(toWebRoles(["viewer", "admin", "viewer", "streamer"])).toEqual(["viewer", "streamer"]);
  });

  it("비배열·빈 배열은 viewer 폴백", () => {
    expect(toWebRoles(null)).toEqual(["viewer"]);
    expect(toWebRoles([])).toEqual(["viewer"]);
    expect(toWebRoles("streamer")).toEqual(["viewer"]);
  });
});

describe("normalizeHandleInput", () => {
  it("트림 + 소문자화", () => {
    expect(normalizeHandleInput("  GyeIdeuk-TV  ")).toBe("gyeideuk-tv");
  });

  it("문자열이 아니면 빈 값", () => {
    expect(normalizeHandleInput(undefined)).toBe("");
    expect(normalizeHandleInput(null)).toBe("");
    expect(normalizeHandleInput(42)).toBe("");
  });

  it("정규화 결과가 _webShared 핸들 규칙과 그대로 연결된다", () => {
    expect(handleRejectCode(normalizeHandleInput(" MyChannel "))).toBeNull();
    expect(handleRejectCode(normalizeHandleInput(" STUDIO "))).toBe("handle-reserved");
    expect(handleRejectCode(normalizeHandleInput("-bad-"))).toBe("handle-invalid");
    expect(handleRejectCode(normalizeHandleInput(""))).toBe("handle-invalid");
  });
});

describe("rolesWithStreamer", () => {
  it("viewer 유지 + streamer 추가", () => {
    expect(rolesWithStreamer(["viewer"])).toEqual(["viewer", "streamer"]);
  });

  it("이미 streamer면 그대로 (중복 없음)", () => {
    expect(rolesWithStreamer(["viewer", "streamer"])).toEqual(["viewer", "streamer"]);
  });

  it("빈 값·비배열·오염 값도 항상 ['viewer','streamer']", () => {
    expect(rolesWithStreamer([])).toEqual(["viewer", "streamer"]);
    expect(rolesWithStreamer(null)).toEqual(["viewer", "streamer"]);
    expect(rolesWithStreamer(["admin", 7])).toEqual(["viewer", "streamer"]);
  });
});

describe("handleErrorMessage", () => {
  it("핸들 에러 코드별 한국어 안내가 있다", () => {
    expect(handleErrorMessage("handle-invalid")).toContain("3~20자");
    expect(handleErrorMessage("handle-reserved")).toContain("사용할 수 없는");
    expect(handleErrorMessage("handle-taken")).toContain("이미 사용 중");
  });
});
