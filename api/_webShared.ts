// =============================================================================
// 웹 후원 플랫폼 공유 계약 모듈 (WS0)
// 계약 문서: donation-system/docs/WEB_TECH_SPEC.md
// 이 파일의 타입·상수·규칙이 트랙 간 계약이다. 변경은 통합자 승인 필요.
// Vercel 라우팅 규칙: '_' 접두 파일은 엔드포인트로 노출되지 않는다.
// =============================================================================

// ---------------------------------------------------------------------------
// 응답 봉투 (저장소 기존 관례: { ok, data } / { ok:false, error })
// ---------------------------------------------------------------------------

export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = { ok: false; error: string; code?: WebErrorCode };
export type ApiResult<T> = ApiOk<T> | ApiErr;

export type WebErrorCode =
  | "method-not-allowed"
  | "auth-required"
  | "forbidden"
  | "not-found"
  | "handle-taken"
  | "handle-invalid"
  | "handle-reserved"
  | "amount-too-small"
  | "amount-invalid"
  | "message-too-long"
  | "nickname-invalid"
  | "blocked-word"
  | "blocked-donor"
  | "rate-limited"
  | "message-expired"
  | "code-exhausted"
  | "device-key-invalid"
  | "connect-code-invalid"
  | "page-suspended"
  | "validation-failed";

// ---------------------------------------------------------------------------
// 한도·상수 (WEB_TECH_SPEC·WEB_PAGE_SPECS 준거)
// ---------------------------------------------------------------------------

export const LIMITS = {
  nicknameMax: 20,
  messageMax: 200,
  bioMax: 500,
  webTitleMax: 60,
  minAmountFloor: 100,
  minAmountDefault: 1000,
  presetsDefault: [1000, 5000, 10000, 50000] as readonly number[],
  messageTtlMinutes: 30,
  graceMinutes: 60,
  heartbeatOnlineSeconds: 180,
  relayPollSeconds: 30,
  heartbeatIntervalSeconds: 60,
  thumbMaxKb: 200,
  donationMsgPerMinPerIp: 5,
  pinnedMax: 3,
  handleChangeCooldownDays: 30
} as const;

// ---------------------------------------------------------------------------
// 핸들 규칙
// ---------------------------------------------------------------------------

export const RESERVED_HANDLES: readonly string[] = [
  "admin", "api", "app", "assets", "auth", "about", "account", "ads",
  "bbbb", "blog", "channels", "dev", "docs", "download", "downloads",
  "gyeideuk", "help", "home", "login", "logout", "me", "news", "ops",
  "overlay", "privacy", "releases", "root", "settings", "signup", "site",
  "static", "studio", "support", "terms", "test", "wallet", "ws", "www"
];

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/;

export function isValidHandle(handle: string): boolean {
  return HANDLE_PATTERN.test(handle) && !RESERVED_HANDLES.includes(handle);
}

export function handleRejectCode(handle: string): WebErrorCode | null {
  if (!HANDLE_PATTERN.test(handle)) return "handle-invalid";
  if (RESERVED_HANDLES.includes(handle)) return "handle-reserved";
  return null;
}

// ---------------------------------------------------------------------------
// 입금코드 (WEB_TECH_SPEC §4)
// 형식: 닉네임 앞 4자(한글 유지) + 대문자 영숫자 2자(부족 시 3자).
// 은행 입금자명 제약(한글·영숫자, 특수문자 불가, 통상 ≤10자) 안에서 동작한다.
// ---------------------------------------------------------------------------

/** 혼동 문자(I, L, O, 0, 1) 제외 알파벳 */
export const DEPOSIT_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** 매칭 비교용 정규화: NFC → 공백 전부 제거 → 대문자화 */
export function normalizeDepositTag(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, "").toUpperCase();
}

/** 닉네임에서 코드 베이스 추출: 한글·영숫자만 남기고 앞 4자, 비면 '후원' */
export function nicknameCodeBase(nickname: string): string {
  const cleaned = nickname.normalize("NFC").replace(/[^0-9A-Za-z가-힣]/g, "");
  return cleaned.slice(0, 4) || "후원";
}

export type DepositCode = { code: string; codeNorm: string };

/**
 * 활성 pending 코드 집합(takenNorms, code_norm 기준)과 충돌하지 않는 코드를 발급한다.
 * 접미 2자로 40회 시도 → 실패 시 3자로 확장. rand 주입은 테스트용.
 */
export function generateDepositCode(
  nickname: string,
  takenNorms: ReadonlySet<string>,
  rand: () => number = Math.random
): DepositCode {
  const base = nicknameCodeBase(nickname);
  for (let suffixLen = 2; suffixLen <= 3; suffixLen += 1) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      let suffix = "";
      for (let i = 0; i < suffixLen; i += 1) {
        const idx = Math.floor(rand() * DEPOSIT_CODE_ALPHABET.length) % DEPOSIT_CODE_ALPHABET.length;
        suffix += DEPOSIT_CODE_ALPHABET[idx];
      }
      const code = `${base}${suffix}`;
      const codeNorm = normalizeDepositTag(code);
      if (!takenNorms.has(codeNorm)) {
        return { code, codeNorm };
      }
    }
  }
  throw new Error("code-exhausted");
}

/** 리스너가 파싱한 입금자명(raw)이 코드에 매칭되는가 (①항: 포함 판정) */
export function senderMatchesCode(senderRaw: string, codeNorm: string): boolean {
  if (!senderRaw || !codeNorm) return false;
  return normalizeDepositTag(senderRaw).includes(codeNorm);
}

/** 매칭 시간창 판정 (③항): 메시지 생성 ≤ 입금시각 ≤ grace_until */
export function isWithinMatchWindow(createdAtIso: string, graceUntilIso: string, depositAtMs: number): boolean {
  const created = Date.parse(createdAtIso);
  const grace = Date.parse(graceUntilIso);
  if (Number.isNaN(created) || Number.isNaN(grace)) return false;
  return depositAtMs >= created && depositAtMs <= grace;
}

// ---------------------------------------------------------------------------
// 입력 검증 (공용)
// ---------------------------------------------------------------------------

export function validateDonationInput(input: {
  nickname: string;
  message: string;
  amount: number;
  minAmount: number;
}): WebErrorCode | null {
  const nickname = input.nickname.trim();
  if (!nickname || nickname.length > LIMITS.nicknameMax) return "nickname-invalid";
  if (input.message.length > LIMITS.messageMax) return "message-too-long";
  if (!Number.isInteger(input.amount) || input.amount <= 0) return "amount-invalid";
  if (input.amount < input.minAmount) return "amount-too-small";
  return null;
}

// ---------------------------------------------------------------------------
// 도메인 타입 — 공개 API (WEB_TECH_SPEC §2.1)
// ---------------------------------------------------------------------------

export type BroadcastLink = { platform: "chzzk" | "soop" | "youtube" | "other"; url: string };
export type TransferLink = { type: "toss" | "kakao"; url: string };

export type PublicSignatureCard = {
  id: string;
  title: string;
  amount: number;
  mediaType: "image" | "gif" | "video" | "audio";
  thumbUrl: string | null;
  pinned: boolean;
};

export type PublicPageView = {
  handle: string;
  displayName: string;
  bannerUrl: string | null;
  avatarUrl: string | null;
  bio: string | null;
  broadcastLinks: BroadcastLink[];
  presetAmounts: number[];
  minAmount: number;
  tickerPublic: boolean;
  online: boolean;
  signatures: PublicSignatureCard[];
  transferLinks: TransferLink[];
  /** account_display='full'일 때만 채워짐 */
  accountInfo: { bank: string; number: string; holder: string } | null;
};

export type ChannelCard = {
  handle: string;
  displayName: string;
  bannerUrl: string | null;
  avatarUrl: string | null;
  bio: string | null;
  signatureCount: number;
  online: boolean;
};

export type CreateDonationMessageBody = {
  nickname: string;
  message: string;
  amount: number;
};

export type DonationMessageCreated = {
  messageId: string;
  depositCode: string;
  amount: number;
  expiresAt: string;
  transferLinks: TransferLink[];
  accountInfo: PublicPageView["accountInfo"];
};

export type DonationMessageStatus = {
  status: "pending" | "matched" | "expired" | "blocked";
  matchedAt: string | null;
};

export type ReportBody = {
  targetType: "page" | "signature" | "message";
  targetId: string;
  reason: string;
};

// ---------------------------------------------------------------------------
// 도메인 타입 — 시청자 (§2.2)
// ---------------------------------------------------------------------------

export type WebProfile = {
  nickname: string;
  avatarUrl: string | null;
  roles: ("viewer" | "streamer")[];
  defaultMessage: string | null;
  notifyEmail: boolean;
};

export type MyDonationItem = {
  messageId: string;
  handle: string;
  displayName: string;
  amount: number;
  message: string;
  status: DonationMessageStatus["status"];
  createdAt: string;
};

// ---------------------------------------------------------------------------
// 도메인 타입 — 스튜디오 (§2.3)
// ---------------------------------------------------------------------------

export type StudioPageSettings = {
  handle: string;
  /** 핸들 마지막 변경 시각(30일 쿨다운 UI용) — 서버가 additive로 내려줌 */
  handleChangedAt?: string | null;
  bannerUrl: string | null;
  avatarUrl: string | null;
  bio: string | null;
  broadcastLinks: BroadcastLink[];
  presetAmounts: number[];
  minAmount: number;
  tickerPublic: boolean;
  directoryOptin: boolean;
  accountDisplay: "link_only" | "full";
  accountInfo: PublicPageView["accountInfo"];
  transferLinks: TransferLink[];
};

export type StudioSignatureRow = PublicSignatureCard & {
  localSignatureId: string;
  webTitle: string | null;
  published: boolean;
  sort: number;
  syncedAt: string;
};

export type StudioDonationRow = {
  matchId: string;
  messageId: string | null;
  matchedBy: "auto" | "manual" | null;
  senderRaw: string | null;
  amount: number | null;
  nickname: string | null;
  message: string | null;
  reportedAt: string;
};

// ---------------------------------------------------------------------------
// 도메인 타입 — 릴레이 (§2.4, 인증: X-Device-Key)
// ---------------------------------------------------------------------------

export const RELAY_DEVICE_KEY_HEADER = "x-device-key";

export type RelayPendingItem = {
  messageId: string;
  codeNorm: string;
  amount: number;
  nickname: string;
  message: string;
  createdAt: string;
  expiresAt: string;
  graceUntil: string;
};

export type RelayMatchReportBody = {
  /** 멱등 키: 로컬 후원 이벤트 식별자 */
  localDonationId: string;
  senderRaw: string;
  amount: number;
  /** null = 미매칭 입금 보고(수동 매칭 후보) */
  messageId: string | null;
};

export type RelaySignatureSyncItem = {
  localSignatureId: string;
  title: string;
  amount: number;
  mediaType: PublicSignatureCard["mediaType"];
  /** base64 (≤ LIMITS.thumbMaxKb KB), null이면 썸네일 유지 */
  thumbBase64: string | null;
};

export type RelaySignaturesSyncBody = { signatures: RelaySignatureSyncItem[] };

export type RelayHeartbeatResponse = {
  /** 서버가 시그니처 재동기화를 요구할 때 true */
  requestSignatureSync: boolean;
};
