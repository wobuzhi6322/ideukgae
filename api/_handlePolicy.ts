// =============================================================================
// 핸들 변경 정책 (VIEWER_MESSAGE_RELAY_PLAN §6.2 — P1 바로가기)
// 규칙:
//   ① 예약어·형식 위반 거부 (_webShared handleRejectCode)
//   ② 30일 1회 변경 (bbbb_streamer_pages.handle_changed_at)
//   ③ 구 핸들 90일 재사용 잠금 (bbbb_handle_history) — 방송 설명란에 박제된
//      링크의 301 리다이렉트를 지키기 위해 타인이 그 기간 안에 가져갈 수 없다.
//      단, 자기 페이지의 구 핸들 되찾기는 허용(그 시점에 이력 행 삭제 = 301 해제).
// 순수 로직만 담는다(테스트: tests/handlePolicy.test.ts). DB 접근은 호출자 몫.
// =============================================================================

import { handleRejectCode, LIMITS, type WebErrorCode } from "./_webShared.js";

/** 핸들 변경 이력 테이블 (RLS 활성·정책 없음 = service role 전용, SSR 301도 service key) */
export const HANDLE_HISTORY_TABLE = "bbbb_handle_history";

/** 구 핸들 재사용 잠금·301 유지 기간(일) */
export const HANDLE_REUSE_LOCK_DAYS = 90;

/** bbbb_handle_history에서 old_handle = 후보 핸들로 조회한 행 */
export type HandleHistoryRow = {
  /** 그 구 핸들을 남긴 페이지 */
  pageId: string;
  changedAt: string;
};

export type HandleChangeVerdict =
  | { ok: true }
  | { ok: false; status: number; code: WebErrorCode; message: string };

/** 핸들 변경 쿨다운(30일 1회): 변경 불가면 해제 시각 ISO, 가능하면 null */
export function handleChangeBlockedUntil(handleChangedAt: string | null, nowMs: number): string | null {
  if (!handleChangedAt) return null;
  const changed = Date.parse(handleChangedAt);
  if (Number.isNaN(changed)) return null;
  const until = changed + LIMITS.handleChangeCooldownDays * 86_400_000;
  return nowMs < until ? new Date(until).toISOString() : null;
}

/** 구 핸들 재사용 잠금(90일): 잠겨 있으면 해제 시각 ISO, 아니면 null */
export function handleReuseLockedUntil(changedAtIso: string, nowMs: number): string | null {
  const changed = Date.parse(changedAtIso);
  if (Number.isNaN(changed)) return null;
  const until = changed + HANDLE_REUSE_LOCK_DAYS * 86_400_000;
  return nowMs < until ? new Date(until).toISOString() : null;
}

/**
 * 핸들 변경(또는 온보딩 시 핸들 선점) 정책 판정.
 * - newHandle은 정규화(trim·소문자) 완료 상태로 전달할 것.
 * - currentHandle: 기존 페이지 핸들. 온보딩(페이지 없음)이면 "".
 * - pageId: 내 페이지 id. 온보딩이면 null — 이력 되찾기 예외가 성립하지 않는다.
 * - historyRow: bbbb_handle_history에서 old_handle = newHandle로 조회한 행(없으면 null).
 * 중복(handle-taken) 검사는 라이브 페이지 테이블 대상이라 호출자가 별도로 수행한다.
 */
export function validateHandleChange(input: {
  newHandle: string;
  currentHandle: string;
  handleChangedAt: string | null;
  pageId: string | null;
  historyRow: HandleHistoryRow | null;
  nowMs: number;
}): HandleChangeVerdict {
  const reject = handleRejectCode(input.newHandle);
  if (reject) {
    return {
      ok: false,
      status: 400,
      code: reject,
      message:
        reject === "handle-reserved"
          ? "사용할 수 없는 핸들입니다. 다른 핸들을 골라 주세요."
          : "핸들은 소문자·숫자·하이픈 3~20자이며 예약어는 쓸 수 없습니다."
    };
  }

  // 동일 핸들(대소문자 차이 포함)은 변경이 아니다 — 쿨다운·잠금 미적용
  if (input.currentHandle && input.newHandle === input.currentHandle.trim().toLowerCase()) {
    return { ok: true };
  }

  const blockedUntil = handleChangeBlockedUntil(input.handleChangedAt, input.nowMs);
  if (blockedUntil) {
    return {
      ok: false,
      status: 400,
      code: "validation-failed",
      message: `핸들은 30일에 1번만 변경할 수 있습니다. ${blockedUntil.slice(0, 10)} 이후 다시 시도해 주세요.`
    };
  }

  if (input.historyRow) {
    const mine = input.pageId !== null && input.historyRow.pageId === input.pageId;
    if (!mine) {
      const lockedUntil = handleReuseLockedUntil(input.historyRow.changedAt, input.nowMs);
      if (lockedUntil) {
        return {
          ok: false,
          status: 409,
          code: "handle-taken",
          message: `최근까지 다른 채널이 쓰던 핸들입니다. ${lockedUntil.slice(0, 10)} 이후 사용할 수 있습니다.`
        };
      }
    }
  }

  return { ok: true };
}
