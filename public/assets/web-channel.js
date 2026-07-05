// =============================================================================
// 계이득 웹 후원 플랫폼 — 채널 후원 페이지 (/@handle) (WSB)
// 계약: api/_webShared.ts (PublicPageView·DonationMessageCreated·DonationMessageStatus)
// 명세: donation-system/docs/WEB_PAGE_SPECS.md §3·§3.1, WEB_TECH_SPEC.md §2.1
// 목 모드: ?mock=1 — 백엔드 없이 화면 검증.
//   보조 파라미터: &offline=1(방송 준비 중) &nobanner=1(배너 없음) &many=1(13개+ 아코디언)
//                 &account=full(계좌 직노출) &outcome=pending|expired(모달 상태 시나리오)
//                 &handle=xxx(핸들 지정) &d=xxx(/d/:messageId 재진입 시뮬레이션)
// =============================================================================

(function () {
  "use strict";

  var GW = window.GW;
  var esc = GW.escapeHtml;
  var params = new URLSearchParams(location.search);
  var MOCK = params.get("mock") === "1";

  var STORAGE_KEY = "gw:donation:last";
  var POLL_MS = 5000;
  var COUNTDOWN_MS = 1000;
  var GRACE_MS = 60 * 60 * 1000; // 만료 후 지연 매칭 허용창(폴링 유지 한도)
  var SIG_FOLD_COUNT = 12;
  var MOCK_MATCH_AFTER_MS = 15000;

  function $(id) {
    return document.getElementById(id);
  }

  var els = {
    loading: $("channel-loading"),
    error: $("channel-error"),
    errorTitle: $("channel-error-title"),
    errorText: $("channel-error-text"),
    retry: $("channel-retry"),
    content: $("channel-content"),
    header: $("channel-header"),
    sigGrid: $("signature-grid"),
    sigMore: $("signature-more"),
    sigEmpty: $("signature-empty"),
    offlineBanner: $("offline-banner"),
    form: $("donation-form"),
    presetChips: $("preset-chips"),
    amountInput: $("amount-input"),
    amountHint: $("amount-hint"),
    nicknameInput: $("nickname-input"),
    messageInput: $("message-input"),
    messageCounter: $("message-counter"),
    formError: $("form-error"),
    donateTransfer: $("donate-transfer"),
    transferModal: $("transfer-modal"),
    transferWindow: $("transfer-window"),
    transferClose: $("transfer-close"),
    transferGuide: $("transfer-guide"),
    depositCodeBox: $("deposit-code-box"),
    depositCode: $("deposit-code"),
    copyCode: $("copy-code"),
    restoreNote: $("transfer-restore-note"),
    transferAmount: $("transfer-amount"),
    accountRow: $("account-row"),
    transferAccount: $("transfer-account"),
    copyAccount: $("copy-account"),
    transferLinks: $("transfer-links"),
    timerWrap: $("transfer-timer-wrap"),
    timer: $("transfer-timer"),
    transferStatus: $("transfer-status"),
    reportModal: $("report-modal"),
    reportOpen: $("report-open"),
    reportForm: $("report-form"),
    reportReason: $("report-reason"),
    reportMessage: $("report-message"),
    reportSubmit: $("report-submit")
  };

  var state = {
    handle: null,
    resumeMessageId: null,
    page: null,
    selectedSigId: null,
    showAllSigs: false,
    submitting: false,
    activeRecord: null,
    timers: { countdown: null, poll: null },
    lastFocus: null
  };

  // ---------------------------------------------------------------------------
  // 유틸
  // ---------------------------------------------------------------------------

  function show(el) {
    if (el) el.classList.remove("is-hidden");
  }

  function hide(el) {
    if (el) el.classList.add("is-hidden");
  }

  // http(s) 절대 URL 또는 동일 출처 경로만 허용 (javascript: 등 차단)
  function safeUrl(url) {
    var value = String(url || "");
    if (/^https?:\/\//i.test(value)) return value;
    if (value.charAt(0) === "/" && value.charAt(1) !== "/") return value;
    return "";
  }

  function stopTimer(name) {
    if (state.timers[name]) {
      clearInterval(state.timers[name]);
      state.timers[name] = null;
    }
  }

  function stopAllTimers() {
    stopTimer("countdown");
    stopTimer("poll");
  }

  // 페이지 이탈 시 폴링·카운트다운 정리 (명세: 타이머 누수 금지)
  window.addEventListener("pagehide", stopAllTimers);

  function copyText(text, feedbackEl, doneLabel) {
    var original = feedbackEl.textContent;
    var markDone = function () {
      feedbackEl.textContent = doneLabel || "복사됨!";
      feedbackEl.disabled = true;
      setTimeout(function () {
        feedbackEl.textContent = original;
        feedbackEl.disabled = false;
      }, 1500);
    };
    var fallback = function () {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand("copy");
        markDone();
      } catch (err) {
        /* 복사 실패는 치명적이지 않다 */
      }
      document.body.removeChild(area);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(markDone, fallback);
    } else {
      fallback();
    }
  }

  function loadRecord() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  function saveRecord(record) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
    } catch (err) {
      /* 저장 실패해도 흐름은 계속 */
    }
  }

  var ERROR_COPY = {
    "amount-too-small": "최소 후원 금액보다 적어요.",
    "amount-invalid": "금액을 올바르게 입력해 주세요.",
    "message-too-long": "메시지는 200자까지 입력할 수 있어요.",
    "nickname-invalid": "닉네임을 확인해 주세요 (20자 이내).",
    "blocked-word": "메시지에 사용할 수 없는 표현이 있어요.",
    "blocked-donor": "이 채널에 후원 메시지를 보낼 수 없어요.",
    "rate-limited": "요청이 너무 잦아요. 잠시 후 다시 시도해 주세요.",
    "page-suspended": "지금은 후원을 받을 수 없는 채널이에요.",
    "not-found": "채널을 찾을 수 없어요."
  };

  function errorCopy(err) {
    return (err && err.code && ERROR_COPY[err.code]) || (err && err.message) || "요청에 실패했어요. 잠시 후 다시 시도해 주세요.";
  }

  // ---------------------------------------------------------------------------
  // 목 데이터 (?mock=1)
  // ---------------------------------------------------------------------------

  var MOCK_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

  function mockDepositCode(nickname) {
    var base = String(nickname || "")
      .normalize("NFC")
      .replace(/[^0-9A-Za-z가-힣]/g, "")
      .slice(0, 4) || "후원";
    var suffix = "";
    for (var i = 0; i < 2; i += 1) {
      suffix += MOCK_CODE_ALPHABET[Math.floor(Math.random() * MOCK_CODE_ALPHABET.length)];
    }
    return base + suffix;
  }

  function mockSignatures() {
    var sigs = [
      { id: "sig-01", title: "환영 인사", amount: 1000, mediaType: "image", thumbUrl: "/assets/product-media.png", pinned: false },
      { id: "sig-02", title: "박수 갈채", amount: 3000, mediaType: "gif", thumbUrl: "/assets/product-signatures.png", pinned: false },
      { id: "sig-03", title: "풀콤보 리액션", amount: 5000, mediaType: "video", thumbUrl: "/assets/gyeideuk-hero.png", pinned: true },
      { id: "sig-04", title: "노래 한 곡 신청", amount: 5000, mediaType: "audio", thumbUrl: null, pinned: false },
      { id: "sig-05", title: "벽지 5분 교체", amount: 10000, mediaType: "image", thumbUrl: "/assets/gyeideuk-product-visual.png", pinned: true },
      { id: "sig-06", title: "하이라이트 리플레이", amount: 20000, mediaType: "video", thumbUrl: "/assets/product-media.png", pinned: false },
      { id: "sig-07", title: "생일 축하 세리머니 풀버전", amount: 30000, mediaType: "video", thumbUrl: null, pinned: false },
      { id: "sig-08", title: "레전드 소원권", amount: 50000, mediaType: "gif", thumbUrl: "/assets/product-signatures.png", pinned: false }
    ];
    if (params.get("many") === "1") {
      for (var i = 9; i <= 16; i += 1) {
        sigs.push({
          id: "sig-" + (i < 10 ? "0" + i : i),
          title: "추가 시그니처 " + i,
          amount: i * 1000,
          mediaType: "image",
          thumbUrl: i % 2 === 0 ? "/assets/product-media.png" : null,
          pinned: false
        });
      }
    }
    return sigs;
  }

  function mockPage(handle) {
    var offline = params.get("offline") === "1";
    return {
      handle: handle,
      displayName: "계이득 데모 채널",
      bannerUrl: params.get("nobanner") === "1" ? null : "/assets/gyeideuk-hero.png",
      avatarUrl: null,
      bio: "계좌 후원을 방송 리액션으로 — 시그니처 메뉴에서 골라 주세요.",
      broadcastLinks: [
        { platform: "chzzk", url: "https://chzzk.naver.com/" },
        { platform: "soop", url: "https://www.sooplive.co.kr/" },
        { platform: "youtube", url: "https://www.youtube.com/" }
      ],
      presetAmounts: [1000, 5000, 10000, 50000],
      minAmount: 1000,
      tickerPublic: false,
      online: !offline,
      signatures: mockSignatures(),
      transferLinks: [
        { type: "toss", url: "https://toss.me/demo" },
        { type: "kakao", url: "https://qr.kakaopay.com/demo" }
      ],
      accountInfo:
        params.get("account") === "full"
          ? { bank: "카카오뱅크", number: "3333-01-1234567", holder: "김계이" }
          : null
    };
  }

  function mockCreate(body) {
    var outcome = params.get("outcome") || null;
    var ttlMs = outcome === "expired" ? 20 * 1000 : 30 * 60 * 1000;
    return {
      messageId: "mock-" + Date.now().toString(36),
      depositCode: mockDepositCode(body.nickname),
      amount: body.amount,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      transferLinks: state.page.transferLinks,
      accountInfo: state.page.accountInfo
    };
  }

  function mockStatus(record) {
    var now = Date.now();
    var created = Date.parse(record.createdAt || "") || now;
    var expires = Date.parse(record.expiresAt || "") || now;
    var outcome = record.mockOutcome;
    if (outcome === "pending" || outcome === "expired") {
      return { status: now > expires ? "expired" : "pending", matchedAt: null };
    }
    if (now - created >= MOCK_MATCH_AFTER_MS) {
      return { status: "matched", matchedAt: new Date(created + MOCK_MATCH_AFTER_MS).toISOString() };
    }
    return { status: "pending", matchedAt: null };
  }

  function delay(value, ms) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve(value);
      }, ms);
    });
  }

  // ---------------------------------------------------------------------------
  // API 래퍼 (목/실제 분기)
  // ---------------------------------------------------------------------------

  function fetchPage(handle) {
    if (MOCK) return delay(mockPage(handle), 350);
    return GW.api("/api/page/" + encodeURIComponent(handle));
  }

  function createDonationMessage(body) {
    if (MOCK) return delay(mockCreate(body), 450);
    return GW.api("/api/page/" + encodeURIComponent(state.handle) + "/donation-message", { body: body });
  }

  function fetchStatus(record) {
    if (record.mock) return Promise.resolve(mockStatus(record));
    return GW.api("/api/donation-message/" + encodeURIComponent(record.messageId) + "/status");
  }

  function sendReport(reason) {
    if (MOCK) return delay(null, 400);
    return GW.api("/api/report", {
      body: { targetType: "page", targetId: state.handle, reason: reason }
    });
  }

  // ---------------------------------------------------------------------------
  // ① 채널 헤더
  // ---------------------------------------------------------------------------

  var PLATFORM_LABEL = { chzzk: "치지직", soop: "SOOP", youtube: "YouTube", other: "방송 보러 가기" };
  var EXTERNAL_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M9 5H5v14h14v-4"/></svg>';

  function renderHeader(page) {
    var bannerUrl = safeUrl(page.bannerUrl);
    var banner = bannerUrl
      ? '<img class="ch-banner" src="' + esc(bannerUrl) + '" alt="" />'
      : '<div class="ch-banner ch-banner--plain" aria-hidden="true"></div>';

    var avatarUrl = safeUrl(page.avatarUrl);
    var avatar = avatarUrl
      ? '<img class="ch-avatar" src="' + esc(avatarUrl) + '" alt="" />'
      : '<span class="ch-avatar ch-avatar--fallback" aria-hidden="true">' +
        esc((page.displayName || "?").slice(0, 1)) +
        "</span>";

    var live = page.online ? '<span class="live-badge"><i aria-hidden="true"></i>LIVE</span>' : "";

    var links = (page.broadcastLinks || [])
      .map(function (link) {
        var url = safeUrl(link.url);
        if (!url) return "";
        var label = PLATFORM_LABEL[link.platform] || PLATFORM_LABEL.other;
        return (
          '<a class="bcast-link" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' +
          EXTERNAL_ICON + esc(label) + "</a>"
        );
      })
      .join("");

    els.header.innerHTML =
      banner +
      '<div class="ch-id-row">' +
      avatar +
      '<div class="ch-title-block">' +
      '<div class="ch-name-row">' +
      '<h1 class="ch-name">' + esc(page.displayName) + "</h1>" +
      live +
      '<span class="ch-handle">@' + esc(page.handle) + "</span>" +
      "</div>" +
      (page.bio ? '<p class="ch-bio">' + esc(page.bio) + "</p>" : "") +
      (links ? '<div class="bcast-links">' + links + "</div>" : "") +
      "</div></div>";
  }

  // ---------------------------------------------------------------------------
  // ② 시그니처 메뉴판
  // ---------------------------------------------------------------------------

  var TYPE_LABEL = { gif: "GIF", video: "영상", audio: "음악" };
  var TYPE_ICON = {
    image:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m4 19 6-6 4 4 3-3 3 3"/></svg>',
    gif:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7.5 10.5v3M12 9v6M16.5 9v6M14.5 12h2"/></svg>',
    video:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m10 9 5 3-5 3z"/></svg>',
    audio:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>'
  };

  function sortedSignatures() {
    return (state.page.signatures || []).slice().sort(function (a, b) {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return a.amount - b.amount;
    });
  }

  function renderSignatures() {
    var all = sortedSignatures();
    if (!all.length) {
      hide(els.sigGrid);
      hide(els.sigMore);
      show(els.sigEmpty);
      return;
    }
    hide(els.sigEmpty);
    show(els.sigGrid);

    var visible = state.showAllSigs ? all : all.slice(0, SIG_FOLD_COUNT);
    els.sigGrid.innerHTML = visible
      .map(function (sig) {
        var thumbUrl = safeUrl(sig.thumbUrl);
        var thumb = thumbUrl
          ? '<img src="' + esc(thumbUrl) + '" alt="" loading="lazy" />'
          : '<span class="sig-thumb-fallback">' + (TYPE_ICON[sig.mediaType] || TYPE_ICON.image) + "</span>";
        var typeBadge = TYPE_LABEL[sig.mediaType]
          ? '<span class="sig-type">' + TYPE_LABEL[sig.mediaType] + "</span>"
          : "";
        return (
          '<button type="button" class="sig-card' +
          (state.selectedSigId === sig.id ? " is-selected" : "") +
          '" data-sig-id="' + esc(sig.id) + '" data-amount="' + Number(sig.amount) + '">' +
          '<span class="sig-thumb">' +
          thumb +
          (sig.pinned ? '<span class="sig-pin">추천</span>' : "") +
          typeBadge +
          "</span>" +
          '<span class="sig-body">' +
          '<span class="sig-amount">' + esc(GW.formatKrw(sig.amount)) + "</span>" +
          '<span class="sig-title">' + esc(sig.title) + "</span>" +
          "</span></button>"
        );
      })
      .join("");

    if (all.length > SIG_FOLD_COUNT) {
      show(els.sigMore);
      els.sigMore.textContent = state.showAllSigs ? "접기" : "전체 보기 (" + all.length + "개)";
      els.sigMore.setAttribute("aria-expanded", state.showAllSigs ? "true" : "false");
    } else {
      hide(els.sigMore);
    }
  }

  function selectSignature(sigId, amount) {
    state.selectedSigId = sigId;
    els.amountInput.value = String(amount);
    syncChipHighlight(amount);
    renderSignatures();
    $("donation-section").scrollIntoView({ behavior: "smooth", block: "start" });
    setFormError("");
  }

  function clearSignatureSelectionIfMismatch() {
    if (!state.selectedSigId) return;
    var all = state.page.signatures || [];
    var current = null;
    for (var i = 0; i < all.length; i += 1) {
      if (all[i].id === state.selectedSigId) current = all[i];
    }
    if (!current || Number(parseAmount()) !== Number(current.amount)) {
      state.selectedSigId = null;
      renderSignatures();
    }
  }

  // ---------------------------------------------------------------------------
  // ③ 후원 폼
  // ---------------------------------------------------------------------------

  function renderForm(page) {
    if (!page.online) show(els.offlineBanner);
    else hide(els.offlineBanner);

    var presets = page.presetAmounts && page.presetAmounts.length ? page.presetAmounts : [1000, 5000, 10000, 50000];
    els.presetChips.innerHTML = presets
      .map(function (amount) {
        return (
          '<button type="button" class="preset-chip" data-amount="' + Number(amount) + '">' +
          esc(GW.formatKrw(amount)) + "</button>"
        );
      })
      .join("");
    els.amountHint.textContent = "최소 " + GW.formatKrw(page.minAmount) + "부터 후원할 수 있어요.";
  }

  function parseAmount() {
    var raw = String(els.amountInput.value || "").replace(/[^\d]/g, "");
    return raw ? parseInt(raw, 10) : NaN;
  }

  function syncChipHighlight(amount) {
    var chips = els.presetChips.querySelectorAll(".preset-chip");
    for (var i = 0; i < chips.length; i += 1) {
      chips[i].classList.toggle("is-active", Number(chips[i].dataset.amount) === Number(amount));
    }
  }

  function updateMessageCounter() {
    var len = els.messageInput.value.length;
    els.messageCounter.textContent = len + "/200";
    els.messageCounter.classList.toggle("is-full", len >= 200);
  }

  function setFormError(text) {
    els.formError.textContent = text || "";
  }

  function validateForm() {
    var amount = parseAmount();
    if (!Number.isInteger(amount) || amount <= 0) return "후원 금액을 입력해 주세요.";
    if (amount < state.page.minAmount) return "최소 " + GW.formatKrw(state.page.minAmount) + "부터 후원할 수 있어요.";
    var nickname = els.nicknameInput.value.trim();
    if (!nickname) return "닉네임을 입력해 주세요.";
    if (nickname.length > 20) return "닉네임은 20자까지 쓸 수 있어요.";
    if (els.messageInput.value.length > 200) return "메시지는 200자까지 입력할 수 있어요.";
    return null;
  }

  function submitDonation(event) {
    event.preventDefault();
    if (state.submitting) return;
    var problem = validateForm();
    if (problem) {
      setFormError(problem);
      return;
    }
    setFormError("");
    state.submitting = true;
    els.donateTransfer.disabled = true;
    els.donateTransfer.textContent = "입금코드 발급 중…";

    var body = {
      nickname: els.nicknameInput.value.trim(),
      message: els.messageInput.value,
      amount: parseAmount()
    };

    createDonationMessage(body)
      .then(function (created) {
        var record = {
          handle: state.handle,
          messageId: created.messageId,
          depositCode: created.depositCode,
          amount: created.amount,
          expiresAt: created.expiresAt,
          transferLinks: created.transferLinks || [],
          accountInfo: created.accountInfo || null,
          createdAt: new Date().toISOString(),
          mock: MOCK,
          mockOutcome: params.get("outcome") || null
        };
        saveRecord(record);
        openTransferModal(record, { restored: false });
      })
      .catch(function (err) {
        setFormError(errorCopy(err));
      })
      .then(function () {
        state.submitting = false;
        els.donateTransfer.disabled = false;
        els.donateTransfer.textContent = "계좌이체로 후원";
      });
  }

  // ---------------------------------------------------------------------------
  // ④ 이체 안내 모달
  // ---------------------------------------------------------------------------

  function usesRealPath() {
    return location.pathname.indexOf("/@") === 0;
  }

  function openTransferModal(record, opts) {
    opts = opts || {};
    state.activeRecord = record;
    stopAllTimers();

    // 코드·계좌·링크 영역
    if (record.depositCode) {
      show(els.depositCodeBox);
      show(els.transferGuide);
      hide(els.restoreNote);
      els.depositCode.textContent = record.depositCode;
    } else {
      hide(els.depositCodeBox);
      hide(els.transferGuide);
      show(els.restoreNote);
    }
    els.transferAmount.textContent = record.amount ? GW.formatKrw(record.amount) : "—";

    if (record.accountInfo && record.accountInfo.number) {
      show(els.accountRow);
      els.transferAccount.textContent =
        record.accountInfo.bank + " " + record.accountInfo.number + " (" + record.accountInfo.holder + ")";
    } else {
      hide(els.accountRow);
    }

    els.transferLinks.innerHTML = (record.transferLinks || [])
      .map(function (link) {
        var url = safeUrl(link.url);
        if (!url) return "";
        if (link.type === "toss") {
          return '<a class="transfer-link toss" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">토스로 송금하기</a>';
        }
        if (link.type === "kakao") {
          return '<a class="transfer-link kakao" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">카카오페이로 송금하기</a>';
        }
        return "";
      })
      .join("");

    els.transferWindow.scrollTop = 0;
    setTransferStage("checking");
    show(els.timerWrap);
    els.timerWrap.classList.remove("is-over");

    state.lastFocus = document.activeElement;
    show(els.transferModal);
    document.body.classList.add("gw-modal-open");
    els.transferClose.focus();

    startCountdown(record);
    startPolling(record);

    if (!opts.restored && usesRealPath() && record.messageId) {
      history.replaceState(null, "", "/@" + state.handle + "/d/" + encodeURIComponent(record.messageId));
    }
  }

  function closeTransferModal() {
    stopAllTimers();
    hide(els.transferModal);
    document.body.classList.remove("gw-modal-open");
    state.activeRecord = null;
    if (usesRealPath()) {
      history.replaceState(null, "", "/@" + state.handle);
    }
    if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
  }

  function formatRemaining(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(total / 60);
    var s = total % 60;
    return (m < 10 ? "0" + m : String(m)) + ":" + (s < 10 ? "0" + s : String(s));
  }

  function startCountdown(record) {
    var expires = Date.parse(record.expiresAt || "");
    if (Number.isNaN(expires)) {
      hide(els.timerWrap);
      return;
    }
    var tick = function () {
      var remain = expires - Date.now();
      els.timer.textContent = formatRemaining(remain);
      if (remain <= 0) {
        els.timerWrap.classList.add("is-over");
        stopTimer("countdown");
        // 서버 status가 아직 pending이어도 로컬 시계 기준으로 만료 카피를 노출
        if (state.activeRecord === record && !els.transferStatus.classList.contains("is-matched")) {
          setTransferStage("expired");
        }
      }
    };
    tick();
    state.timers.countdown = setInterval(tick, COUNTDOWN_MS);
  }

  function setTransferStage(stage) {
    var el = els.transferStatus;
    el.classList.remove("is-matched", "is-expired", "is-blocked");
    if (stage === "checking") {
      el.innerHTML = '<span class="transfer-status-inner"><span class="status-dot" aria-hidden="true"></span>입금 확인 중…</span>';
    } else if (stage === "matched") {
      el.classList.add("is-matched");
      el.innerHTML = '<span class="transfer-status-inner">✅ 방송에 전달되었습니다!</span>';
      hide(els.timerWrap);
    } else if (stage === "expired") {
      el.classList.add("is-expired");
      el.innerHTML =
        '<span class="transfer-status-inner">시간이 지났어요. 입금하셨다면 후원은 정상 전달되며, 메시지 없이 표시될 수 있어요.</span>';
    } else if (stage === "blocked") {
      el.classList.add("is-blocked");
      el.innerHTML = '<span class="transfer-status-inner">이 후원 메시지는 전달할 수 없어요.</span>';
      hide(els.timerWrap);
    }
  }

  function startPolling(record) {
    var expires = Date.parse(record.expiresAt || "") || Date.now();
    var poll = function () {
      if (state.activeRecord !== record) return;
      fetchStatus(record)
        .then(function (st) {
          if (state.activeRecord !== record) return;
          if (st.status === "matched") {
            setTransferStage("matched");
            stopAllTimers();
          } else if (st.status === "blocked") {
            setTransferStage("blocked");
            stopAllTimers();
          } else if (st.status === "expired") {
            setTransferStage("expired");
            // 지연 매칭(grace) 안에서는 계속 확인, 그 이후에는 중단
            if (Date.now() > expires + GRACE_MS) stopTimer("poll");
          }
          // pending이면 "입금 확인 중…" 유지
        })
        .catch(function () {
          /* 일시 오류는 다음 폴링에서 재시도 */
        });
    };
    poll();
    state.timers.poll = setInterval(poll, POLL_MS);
  }

  // /d/:messageId 재진입 — 로컬스토리지 기록 복원, 없으면 상태 전용 뷰
  function resumeFromMessageId(messageId) {
    var stored = loadRecord();
    if (stored && stored.messageId === messageId && stored.handle === state.handle) {
      openTransferModal(stored, { restored: true });
      return;
    }
    openTransferModal(
      {
        handle: state.handle,
        messageId: messageId,
        depositCode: null,
        amount: null,
        expiresAt: null,
        transferLinks: [],
        accountInfo: null,
        createdAt: null,
        mock: MOCK,
        mockOutcome: params.get("outcome") || null
      },
      { restored: true }
    );
  }

  // ---------------------------------------------------------------------------
  // ⑥ 신고 모달
  // ---------------------------------------------------------------------------

  function openReportModal() {
    els.reportReason.value = "";
    els.reportMessage.textContent = "";
    state.lastFocus = document.activeElement;
    show(els.reportModal);
    document.body.classList.add("gw-modal-open");
    els.reportReason.focus();
  }

  function closeReportModal() {
    hide(els.reportModal);
    if (els.transferModal.classList.contains("is-hidden")) {
      document.body.classList.remove("gw-modal-open");
    }
    if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
  }

  function submitReport(event) {
    event.preventDefault();
    var reason = els.reportReason.value.trim();
    if (!reason) {
      els.reportMessage.textContent = "신고 사유를 입력해 주세요.";
      return;
    }
    els.reportSubmit.disabled = true;
    els.reportMessage.textContent = "";
    sendReport(reason)
      .then(function () {
        els.reportMessage.textContent = "신고가 접수되었어요. 확인 후 조치할게요.";
        setTimeout(closeReportModal, 1600);
      })
      .catch(function (err) {
        els.reportMessage.textContent = errorCopy(err);
      })
      .then(function () {
        els.reportSubmit.disabled = false;
      });
  }

  // ---------------------------------------------------------------------------
  // 로드·이벤트 배선
  // ---------------------------------------------------------------------------

  function showFatal(title, text) {
    hide(els.loading);
    hide(els.content);
    show(els.error);
    els.errorTitle.textContent = title;
    els.errorText.textContent = text || "";
  }

  function loadPage() {
    show(els.loading);
    hide(els.error);
    hide(els.content);
    fetchPage(state.handle)
      .then(function (page) {
        state.page = page;
        document.title = page.displayName + " 후원 - 계이득";
        renderHeader(page);
        renderSignatures();
        renderForm(page);
        hide(els.loading);
        show(els.content);
        if (state.resumeMessageId) {
          var id = state.resumeMessageId;
          state.resumeMessageId = null;
          resumeFromMessageId(id);
        }
      })
      .catch(function (err) {
        if (err && (err.status === 404 || err.code === "not-found" || err.code === "page-suspended")) {
          showFatal("채널을 찾을 수 없어요", "주소가 맞는지 확인해 주세요. 채널이 비공개로 전환되었을 수도 있어요.");
          hide(els.retry);
        } else {
          showFatal("페이지를 불러오지 못했어요", errorCopy(err));
          show(els.retry);
        }
      });
  }

  function bindEvents() {
    els.retry.addEventListener("click", loadPage);

    // 시그니처 카드 탭 → 금액 자동 입력 + 하이라이트 + 폼 스크롤
    els.sigGrid.addEventListener("click", function (event) {
      var card = event.target.closest(".sig-card");
      if (!card) return;
      selectSignature(card.dataset.sigId, Number(card.dataset.amount));
    });

    els.sigMore.addEventListener("click", function () {
      state.showAllSigs = !state.showAllSigs;
      renderSignatures();
    });

    // 프리셋 칩
    els.presetChips.addEventListener("click", function (event) {
      var chip = event.target.closest(".preset-chip");
      if (!chip) return;
      els.amountInput.value = String(chip.dataset.amount);
      syncChipHighlight(Number(chip.dataset.amount));
      clearSignatureSelectionIfMismatch();
      setFormError("");
    });

    els.amountInput.addEventListener("input", function () {
      syncChipHighlight(parseAmount());
      clearSignatureSelectionIfMismatch();
    });

    els.messageInput.addEventListener("input", updateMessageCounter);
    els.form.addEventListener("submit", submitDonation);

    // 이체 모달
    els.transferModal.addEventListener("click", function (event) {
      if (event.target.closest("[data-close-transfer]")) closeTransferModal();
    });
    els.copyCode.addEventListener("click", function () {
      if (state.activeRecord && state.activeRecord.depositCode) {
        copyText(state.activeRecord.depositCode, els.copyCode);
      }
    });
    els.copyAccount.addEventListener("click", function () {
      var info = state.activeRecord && state.activeRecord.accountInfo;
      if (info && info.number) copyText(info.number, els.copyAccount, "복사됨");
    });

    // 신고 모달
    els.reportOpen.addEventListener("click", openReportModal);
    els.reportModal.addEventListener("click", function (event) {
      if (event.target.closest("[data-close-report]")) closeReportModal();
    });
    els.reportForm.addEventListener("submit", submitReport);

    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      if (!els.reportModal.classList.contains("is-hidden")) closeReportModal();
      else if (!els.transferModal.classList.contains("is-hidden")) closeTransferModal();
    });
  }

  function init() {
    var parsed = GW.parseHandlePath(location.pathname);
    var handle = (parsed && parsed.handle) || (MOCK ? params.get("handle") || "gyeideuk" : null);
    if (!handle) {
      showFatal("잘못된 주소예요", "채널 주소는 /@핸들 형식이에요.");
      hide(els.retry);
      return;
    }
    state.handle = handle;
    state.resumeMessageId = (parsed && parsed.messageId) || (MOCK ? params.get("d") : null) || null;
    updateMessageCounter();
    bindEvents();
    loadPage();
  }

  init();
})();
