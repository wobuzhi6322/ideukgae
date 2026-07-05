import { describe, expect, it } from "vitest";

import {
  DEPOSIT_CODE_ALPHABET,
  LIMITS,
  RESERVED_HANDLES,
  generateDepositCode,
  handleRejectCode,
  isValidHandle,
  isWithinMatchWindow,
  nicknameCodeBase,
  normalizeDepositTag,
  senderMatchesCode,
  validateDonationInput
} from "../api/_webShared.js";

describe("normalizeDepositTag", () => {
  it("공백 제거·대문자화·NFC 정규화", () => {
    expect(normalizeDepositTag(" 민 수 k3 ")).toBe("민수K3");
    // NFD(자소 분리) 입력도 NFC로 합쳐져 동일해야 한다
    const nfd = "민수".normalize("NFD");
    expect(normalizeDepositTag(`${nfd}K3`)).toBe("민수K3");
  });
});

describe("nicknameCodeBase", () => {
  it("한글·영숫자만 남기고 앞 4자", () => {
    expect(nicknameCodeBase("민수!@#짱123")).toBe("민수짱1");
    expect(nicknameCodeBase("ab")).toBe("ab");
  });
  it("전부 특수문자면 폴백 '후원'", () => {
    expect(nicknameCodeBase("★☆♡")).toBe("후원");
    expect(nicknameCodeBase("")).toBe("후원");
  });
});

describe("generateDepositCode", () => {
  const rig = (values: number[]) => {
    let i = 0;
    return () => values[i++ % values.length];
  };

  it("베이스+접미 2자, 알파벳은 혼동 문자 제외 집합", () => {
    const { code, codeNorm } = generateDepositCode("민수", new Set(), rig([0, 0.5]));
    expect(code.startsWith("민수")).toBe(true);
    const suffix = code.slice(2);
    expect(suffix).toHaveLength(2);
    for (const ch of suffix) {
      expect(DEPOSIT_CODE_ALPHABET).toContain(ch);
    }
    expect(codeNorm).toBe(normalizeDepositTag(code));
  });

  it("충돌 시 재추첨으로 활성 pending과 안 겹치는 코드 발급", () => {
    const first = generateDepositCode("민수", new Set(), rig([0]));
    const second = generateDepositCode("민수", new Set([first.codeNorm]), rig([0, 0, 0, 0.5]));
    expect(second.codeNorm).not.toBe(first.codeNorm);
  });

  it("2자 공간 소진 시 3자로 확장", () => {
    // rand가 항상 0 → 2자 시도는 전부 동일 코드 → taken이면 3자로 확장된다
    const zero = () => 0;
    const twoChar = generateDepositCode("민수", new Set(), zero);
    const escalated = generateDepositCode("민수", new Set([twoChar.codeNorm]), zero);
    expect(escalated.code.length).toBe(twoChar.code.length + 1);
  });

  it("혼동 문자(I,L,O,0,1)는 어떤 코드에도 등장하지 않는다", () => {
    expect(DEPOSIT_CODE_ALPHABET).not.toMatch(/[ILO01]/);
  });
});

describe("senderMatchesCode", () => {
  const { codeNorm } = generateDepositCode("민수", new Set(), () => 0.4);

  it("은행 입금자명 그대로/소문자/공백 섞임 전부 매칭", () => {
    expect(senderMatchesCode(codeNorm, codeNorm)).toBe(true);
    expect(senderMatchesCode(codeNorm.toLowerCase(), codeNorm)).toBe(true);
    expect(senderMatchesCode(` ${codeNorm.slice(0, 2)} ${codeNorm.slice(2)} `, codeNorm)).toBe(true);
  });

  it("다른 코드·빈 값은 매칭 실패", () => {
    expect(senderMatchesCode("홍길동", codeNorm)).toBe(false);
    expect(senderMatchesCode("", codeNorm)).toBe(false);
    expect(senderMatchesCode(codeNorm, "")).toBe(false);
  });
});

describe("isWithinMatchWindow", () => {
  const created = "2026-07-06T10:00:00.000Z";
  const grace = "2026-07-06T11:30:00.000Z";

  it("생성~유예 사이만 참, 경계 포함", () => {
    expect(isWithinMatchWindow(created, grace, Date.parse(created))).toBe(true);
    expect(isWithinMatchWindow(created, grace, Date.parse(grace))).toBe(true);
    expect(isWithinMatchWindow(created, grace, Date.parse(created) - 1)).toBe(false);
    expect(isWithinMatchWindow(created, grace, Date.parse(grace) + 1)).toBe(false);
  });

  it("잘못된 날짜 문자열은 거짓", () => {
    expect(isWithinMatchWindow("nope", grace, Date.parse(created))).toBe(false);
  });
});

describe("isValidHandle / handleRejectCode", () => {
  it("규칙 통과 핸들", () => {
    expect(isValidHandle("gyeideuk-tv")).toBe(true);
    expect(isValidHandle("abc")).toBe(true);
  });

  it("길이·문자·하이픈 경계 위반", () => {
    expect(handleRejectCode("ab")).toBe("handle-invalid");
    expect(handleRejectCode("-abc")).toBe("handle-invalid");
    expect(handleRejectCode("abc-")).toBe("handle-invalid");
    expect(handleRejectCode("ABC")).toBe("handle-invalid");
    expect(handleRejectCode("한글핸들")).toBe("handle-invalid");
    expect(handleRejectCode("a".repeat(21))).toBe("handle-invalid");
  });

  it("예약어 전부 거부", () => {
    for (const reserved of RESERVED_HANDLES) {
      expect(isValidHandle(reserved)).toBe(false);
    }
    expect(handleRejectCode("studio")).toBe("handle-reserved");
  });
});

describe("validateDonationInput", () => {
  const base = { nickname: "민수", message: "응원해요", amount: 5000, minAmount: 1000 };

  it("정상 입력은 null", () => {
    expect(validateDonationInput(base)).toBeNull();
  });

  it("닉네임·메시지·금액 위반 코드", () => {
    expect(validateDonationInput({ ...base, nickname: " " })).toBe("nickname-invalid");
    expect(validateDonationInput({ ...base, nickname: "가".repeat(LIMITS.nicknameMax + 1) })).toBe("nickname-invalid");
    expect(validateDonationInput({ ...base, message: "가".repeat(LIMITS.messageMax + 1) })).toBe("message-too-long");
    expect(validateDonationInput({ ...base, amount: 500 })).toBe("amount-too-small");
    expect(validateDonationInput({ ...base, amount: 0 })).toBe("amount-invalid");
    expect(validateDonationInput({ ...base, amount: 1.5 })).toBe("amount-invalid");
  });
});
