// =============================================================================
// /me 시청자 영역 (WSD) — 홈·프로필·후원 내역·팔로잉·지갑[예약]
// 경로로 섹션 전환: /me /me/profile /me/donations /me/following /me/wallet
// 소비 API: GET/PATCH /api/me/profile(WSA 소유 — 목 폴백 필수),
//           GET /api/me/donations, GET/POST/DELETE /api/me/follows, POST /api/report
// ?mock=1 목 모드 · GW.escapeHtml로 XSS 방지 · 로그인 필수(GW.requireSession)
// =============================================================================

(function () {
  "use strict";

  const GW = window.GW;
  const esc = GW.escapeHtml;
  const MOCK = new URLSearchParams(location.search).get("mock") === "1";
  const SECTIONS = ["home", "profile", "donations", "following", "wallet"];

  const state = {
    session: null,
    section: "home",
    profile: null,
    profileSource: null, // 'api' | 'fallback' | 'mock'
    follows: null,
    donations: { items: [], nextCursor: null, loading: false },
    filters: { handle: "", days: 0 },
    channelOptions: new Map() // handle -> displayName (필터 셀렉트 유지용)
  };

  const els = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    els.content = document.getElementById("me-content");
    els.toastRoot = document.getElementById("toast-root");
    setupTheme();
    setupLogout();

    state.section = currentSection();
    markActiveTab();

    if (MOCK) {
      state.session = { access_token: "mock-token", user: { email: "viewer@example.com" } };
    } else {
      const session = await GW.requireSession();
      if (!session) return; // /login 리다이렉트 중
      state.session = session;
    }

    renderSection();
  }

  function currentSection() {
    const m = /^\/me(?:\/([a-z]+))?\/?$/.exec(location.pathname);
    const section = m && m[1] ? m[1] : "home";
    return SECTIONS.indexOf(section) >= 0 ? section : "home";
  }

  function markActiveTab() {
    document.querySelectorAll(".me-tabs a").forEach((tab) => {
      const isActive = tab.dataset.section === state.section;
      if (isActive) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
      if (MOCK) {
        const url = new URL(tab.href, location.origin);
        url.searchParams.set("mock", "1");
        tab.href = url.pathname + url.search;
      }
    });
  }

  function href(path) {
    return path + (MOCK ? (path.indexOf("?") >= 0 ? "&" : "?") + "mock=1" : "");
  }

  function renderSection() {
    if (state.section === "profile") return renderProfileSection();
    if (state.section === "donations") return renderDonationsSection();
    if (state.section === "following") return renderFollowingSection();
    if (state.section === "wallet") return renderWalletSection();
    return renderHomeSection();
  }

  // ---------------------------------------------------------------------------
  // API 래퍼 (?mock=1이면 목 데이터)
  // ---------------------------------------------------------------------------

  function apiGet(path) {
    if (MOCK) return mockApi(path, "GET", null);
    return GW.api(path, { token: state.session.access_token });
  }

  function apiSend(path, method, body) {
    if (MOCK) return mockApi(path, method, body);
    return GW.api(path, { token: state.session.access_token, method, body });
  }

  /** 프로필: WSA 소유 API. 아직 없거나 실패해도 페이지가 죽지 않게 폴백한다. */
  async function loadProfile(force) {
    if (state.profile && !force) return state.profile;
    if (MOCK) {
      state.profile = await mockApi("/api/me/profile", "GET", null);
      state.profileSource = "mock";
      return state.profile;
    }
    try {
      state.profile = await apiGet("/api/me/profile");
      state.profileSource = "api";
    } catch (err) {
      state.profile = fallbackProfile();
      state.profileSource = "fallback";
    }
    return state.profile;
  }

  function fallbackProfile() {
    const email = (state.session && state.session.user && state.session.user.email) || "";
    return {
      nickname: email ? email.split("@")[0].slice(0, 20) : "시청자",
      avatarUrl: null,
      roles: ["viewer"],
      defaultMessage: null,
      notifyEmail: true
    };
  }

  async function loadFollows(force) {
    if (state.follows && !force) return state.follows;
    const data = await apiGet("/api/me/follows");
    state.follows = data.channels || [];
    state.follows.forEach((channel) => {
      state.channelOptions.set(channel.handle, channel.displayName || channel.handle);
    });
    return state.follows;
  }

  async function loadDonations(reset) {
    if (state.donations.loading) return;
    state.donations.loading = true;
    try {
      if (reset) {
        state.donations.items = [];
        state.donations.nextCursor = null;
      }
      const params = new URLSearchParams();
      if (state.donations.nextCursor) params.set("cursor", state.donations.nextCursor);
      if (state.filters.handle) params.set("handle", state.filters.handle);
      if (state.filters.days > 0) {
        params.set("from", new Date(Date.now() - state.filters.days * 86400000).toISOString());
      }
      const suffix = params.toString();
      const data = await apiGet("/api/me/donations" + (suffix ? "?" + suffix : ""));
      state.donations.items = state.donations.items.concat(data.items || []);
      state.donations.nextCursor = data.nextCursor || null;
      state.donations.items.forEach((item) => {
        if (item.handle) state.channelOptions.set(item.handle, item.displayName || item.handle);
      });
      return state.donations;
    } finally {
      state.donations.loading = false;
    }
  }

  // ---------------------------------------------------------------------------
  // 섹션: 홈
  // ---------------------------------------------------------------------------

  async function renderHomeSection() {
    els.content.innerHTML =
      '<div class="me-cards">' + skeletonCard() + skeletonCard() + skeletonCard() + skeletonCard() + "</div>";

    const [profileResult, followsResult, donationsResult] = await Promise.allSettled([
      loadProfile(false),
      loadFollows(false),
      loadDonations(true)
    ]);

    const cards = [];
    cards.push(
      profileResult.status === "fulfilled"
        ? homeProfileCard(profileResult.value)
        : errorCard("프로필을 불러오지 못했어요.")
    );
    cards.push(
      followsResult.status === "fulfilled"
        ? homeFollowsCard(followsResult.value)
        : errorCard("팔로우 채널을 불러오지 못했어요.")
    );
    cards.push(
      donationsResult.status === "fulfilled"
        ? homeDonationsCard(state.donations.items.slice(0, 3))
        : errorCard("최근 후원을 불러오지 못했어요.")
    );
    cards.push(walletLockedCard(false));

    els.content.innerHTML = '<div class="me-cards">' + cards.join("") + "</div>";
    bindHomeEvents();
  }

  function homeProfileCard(profile) {
    const email = (state.session.user && state.session.user.email) || "";
    const note =
      state.profileSource === "fallback"
        ? '<p class="me-note">프로필 서비스 연결 전이라 기본 정보를 보여드리고 있어요.</p>'
        : "";
    return (
      '<article class="me-card">' +
      '<div class="me-card-head"><h2>내 프로필</h2><a href="' + href("/me/profile") + '">수정</a></div>' +
      '<div class="me-profile-summary">' +
      avatarHtml(profile.avatarUrl, profile.nickname, "me-avatar") +
      '<div class="who"><strong>' + esc(profile.nickname) + "</strong>" +
      (email ? "<span>" + esc(email) + "</span>" : "") +
      "</div></div>" +
      note +
      "</article>"
    );
  }

  function homeFollowsCard(follows) {
    const sorted = follows.slice().sort((a, b) => Number(b.online) - Number(a.online));
    const top = sorted.slice(0, 6);
    let body;
    if (!top.length) {
      body =
        '<div class="me-empty"><p>아직 팔로우한 채널이 없어요.</p>' +
        '<a class="button secondary" href="' + href("/channels") + '">채널 탐색하기</a></div>';
    } else {
      body =
        '<ul class="me-channel-list">' +
        top
          .map(
            (channel) =>
              "<li>" +
              avatarHtml(channel.avatarUrl, channel.displayName || channel.handle, "me-avatar") +
              '<div class="info"><a href="' + esc(pageHref(channel.handle)) + '">' +
              esc(channel.displayName || channel.handle) +
              "</a><p>시그니처 " + Number(channel.signatureCount || 0) + "개</p></div>" +
              '<div class="actions">' + (channel.online ? '<span class="me-live">LIVE</span>' : "") + "</div>" +
              "</li>"
          )
          .join("") +
        "</ul>";
    }
    return (
      '<article class="me-card">' +
      '<div class="me-card-head"><h2>팔로우 채널</h2><a href="' + href("/me/following") + '">더보기</a></div>' +
      body +
      "</article>"
    );
  }

  function homeDonationsCard(items) {
    let body;
    if (!items.length) {
      body =
        '<div class="me-empty"><p>아직 후원 내역이 없어요.</p>' +
        '<a class="button secondary" href="' + href("/channels") + '">채널 탐색하기</a></div>';
    } else {
      body = '<ul class="me-donation-list">' + items.map((item) => donationRowHtml(item, false)).join("") + "</ul>";
    }
    return (
      '<article class="me-card">' +
      '<div class="me-card-head"><h2>최근 후원</h2><a href="' + href("/me/donations") + '">전체 보기</a></div>' +
      body +
      "</article>"
    );
  }

  function bindHomeEvents() {
    bindWalletNotifyButton();
  }

  // ---------------------------------------------------------------------------
  // 섹션: 프로필 편집
  // ---------------------------------------------------------------------------

  async function renderProfileSection() {
    els.content.innerHTML = skeletonPanel();
    try {
      await loadProfile(false);
    } catch (err) {
      renderPanelError("프로필을 불러오지 못했어요.", renderProfileSection);
      return;
    }
    const profile = state.profile;
    const note =
      state.profileSource === "fallback"
        ? '<p class="me-note">프로필 서비스 연결 전에는 저장이 실패할 수 있어요. 저장이 안 되면 잠시 후 다시 시도해 주세요.</p>'
        : "";

    els.content.innerHTML =
      '<div class="me-panel">' +
      "<h2>프로필 편집</h2>" +
      note +
      '<form class="me-form" id="profile-form">' +
      "<label>닉네임" +
      '<input type="text" id="pf-nickname" maxlength="20" required value="' + esc(profile.nickname) + '" />' +
      '<span class="hint">후원 표시명으로도 사용돼요. 바꾸면 다음 후원부터 적용됩니다.</span>' +
      "</label>" +
      "<label>아바타 이미지 URL" +
      '<input type="url" id="pf-avatar" placeholder="https://..." value="' + esc(profile.avatarUrl || "") + '" />' +
      '<span class="hint">비워 두면 닉네임 첫 글자로 표시돼요.</span>' +
      "</label>" +
      "<label>기본 후원 메시지" +
      '<textarea id="pf-message" maxlength="200">' + esc(profile.defaultMessage || "") + "</textarea>" +
      '<span class="counter"><span id="pf-message-count">0</span>/200</span>' +
      "</label>" +
      '<div class="me-check">' +
      '<input type="checkbox" id="pf-notify"' + (profile.notifyEmail ? " checked" : "") + " />" +
      "<div><strong>이메일 알림 받기</strong><span>팔로우 채널 소식과 새 기능 오픈 알림을 이메일로 받아요. (푸시 알림은 준비 중)</span></div>" +
      "</div>" +
      '<div class="me-form-actions"><button class="button primary" type="submit" id="pf-save">저장</button></div>' +
      "</form></div>";

    const messageInput = document.getElementById("pf-message");
    const counter = document.getElementById("pf-message-count");
    const syncCount = () => {
      counter.textContent = String(messageInput.value.length);
    };
    syncCount();
    messageInput.addEventListener("input", syncCount);

    document.getElementById("profile-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const nickname = document.getElementById("pf-nickname").value.trim();
      const avatarUrl = document.getElementById("pf-avatar").value.trim();
      const defaultMessage = messageInput.value;
      const notifyEmail = document.getElementById("pf-notify").checked;
      if (!nickname || nickname.length > 20) {
        toast("닉네임은 1~20자로 입력해 주세요.", "error");
        return;
      }
      if (avatarUrl && !/^https?:\/\//i.test(avatarUrl)) {
        toast("아바타 URL은 http(s) 주소만 사용할 수 있어요.", "error");
        return;
      }
      const saveButton = document.getElementById("pf-save");
      saveButton.disabled = true;
      saveButton.textContent = "저장 중…";
      try {
        await apiSend("/api/me/profile", "PATCH", {
          nickname,
          avatarUrl: avatarUrl || null,
          defaultMessage: defaultMessage || null,
          notifyEmail
        });
        state.profile = { nickname, avatarUrl: avatarUrl || null, roles: state.profile.roles, defaultMessage: defaultMessage || null, notifyEmail };
        toast("프로필을 저장했어요.");
      } catch (err) {
        toast(err && err.message ? err.message : "저장에 실패했어요. 잠시 후 다시 시도해 주세요.", "error");
      } finally {
        saveButton.disabled = false;
        saveButton.textContent = "저장";
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 섹션: 후원 내역
  // ---------------------------------------------------------------------------

  async function renderDonationsSection() {
    els.content.innerHTML = skeletonPanel();
    try {
      await Promise.allSettled([loadFollows(false)]); // 필터 옵션 보강(실패 무시)
      await loadDonations(true);
    } catch (err) {
      renderPanelError("후원 내역을 불러오지 못했어요.", renderDonationsSection);
      return;
    }
    renderDonationsBody();
  }

  function renderDonationsBody() {
    const options = ['<option value="">전체 채널</option>'];
    state.channelOptions.forEach((displayName, handle) => {
      options.push(
        '<option value="' + esc(handle) + '"' + (state.filters.handle === handle ? " selected" : "") + ">" +
          esc(displayName) + " (@" + esc(handle) + ")</option>"
      );
    });
    const periods = [
      { days: 0, label: "전체 기간" },
      { days: 7, label: "최근 7일" },
      { days: 30, label: "최근 30일" },
      { days: 90, label: "최근 90일" }
    ];

    let body;
    if (!state.donations.items.length) {
      const filtered = state.filters.handle || state.filters.days > 0;
      body = filtered
        ? '<div class="me-empty"><p>조건에 맞는 후원 내역이 없어요.</p></div>'
        : '<div class="me-empty"><p>아직 후원 내역이 없어요.</p>' +
          '<a class="button secondary" href="' + href("/channels") + '">채널 탐색하기</a></div>';
    } else {
      body =
        '<ul class="me-donation-list">' +
        state.donations.items.map((item) => donationRowHtml(item, true)).join("") +
        "</ul>" +
        (state.donations.nextCursor
          ? '<div class="me-more"><button class="button secondary" type="button" id="donations-more">더 보기</button></div>'
          : "");
    }

    els.content.innerHTML =
      '<div class="me-panel wide">' +
      "<h2>후원 내역</h2>" +
      '<div class="me-filters" style="margin-top:14px">' +
      '<select id="filter-channel" aria-label="채널 필터">' + options.join("") + "</select>" +
      '<select id="filter-period" aria-label="기간 필터">' +
      periods
        .map(
          (period) =>
            '<option value="' + period.days + '"' + (state.filters.days === period.days ? " selected" : "") + ">" +
            period.label + "</option>"
        )
        .join("") +
      "</select></div>" +
      body +
      "</div>";

    document.getElementById("filter-channel").addEventListener("change", (event) => {
      state.filters.handle = event.target.value;
      reloadDonations();
    });
    document.getElementById("filter-period").addEventListener("change", (event) => {
      state.filters.days = Number(event.target.value) || 0;
      reloadDonations();
    });
    const more = document.getElementById("donations-more");
    if (more) {
      more.addEventListener("click", async () => {
        more.disabled = true;
        more.textContent = "불러오는 중…";
        try {
          await loadDonations(false);
          renderDonationsBody();
        } catch (err) {
          more.disabled = false;
          more.textContent = "더 보기";
          toast("더 불러오지 못했어요. 다시 시도해 주세요.", "error");
        }
      });
    }
    bindReportButtons();
  }

  async function reloadDonations() {
    try {
      await loadDonations(true);
      renderDonationsBody();
    } catch (err) {
      renderPanelError("후원 내역을 불러오지 못했어요.", renderDonationsSection);
    }
  }

  function donationRowHtml(item, withActions) {
    const status = statusMeta(item.status);
    return (
      "<li>" +
      '<div class="meta">' +
      "<span>" + esc(formatDate(item.createdAt)) + "</span>" +
      '<a href="' + esc(pageHref(item.handle)) + '">' + esc(item.displayName || item.handle) + "</a>" +
      '<span class="me-badge ' + status.cls + '">' + status.label + "</span>" +
      "</div>" +
      '<span class="amount">' + esc(GW.formatKrw(item.amount)) + "</span>" +
      (item.message ? '<p class="msg">' + esc(item.message) + "</p>" : "") +
      (withActions
        ? '<div class="row-actions"><button class="me-text-button" type="button" data-report="' +
          esc(item.messageId) + '">문제 신고</button></div>'
        : "") +
      "</li>"
    );
  }

  function bindReportButtons() {
    els.content.querySelectorAll("[data-report]").forEach((button) => {
      button.addEventListener("click", async () => {
        const reason = window.prompt("어떤 문제가 있었는지 알려주세요. (예: 전달되지 않음, 금액 불일치)");
        if (reason === null) return;
        const trimmed = reason.trim();
        if (!trimmed) {
          toast("신고 사유를 입력해 주세요.", "error");
          return;
        }
        try {
          await apiSend("/api/report", "POST", {
            targetType: "message",
            targetId: button.dataset.report,
            reason: trimmed.slice(0, 500)
          });
          toast("신고가 접수되었어요. 확인 후 처리할게요.");
        } catch (err) {
          toast("신고 접수가 아직 준비 중이에요. 잠시 후 다시 시도해 주세요.", "error");
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // 섹션: 팔로잉
  // ---------------------------------------------------------------------------

  async function renderFollowingSection() {
    els.content.innerHTML = skeletonPanel();
    try {
      await loadFollows(true);
    } catch (err) {
      renderPanelError("팔로우 목록을 불러오지 못했어요.", renderFollowingSection);
      return;
    }
    renderFollowingBody();
  }

  function renderFollowingBody() {
    const follows = state.follows || [];
    let body;
    if (!follows.length) {
      body =
        '<div class="me-empty"><p>아직 팔로우한 채널이 없어요.</p>' +
        '<a class="button secondary" href="' + href("/channels") + '">채널 탐색하기</a></div>';
    } else {
      const sorted = follows.slice().sort((a, b) => Number(b.online) - Number(a.online));
      body =
        '<ul class="me-channel-list">' +
        sorted
          .map(
            (channel) =>
              "<li>" +
              avatarHtml(channel.avatarUrl, channel.displayName || channel.handle, "me-avatar") +
              '<div class="info"><a href="' + esc(pageHref(channel.handle)) + '">' +
              esc(channel.displayName || channel.handle) +
              "</a><p>" + (channel.bio ? esc(channel.bio) : "시그니처 " + Number(channel.signatureCount || 0) + "개") + "</p></div>" +
              '<div class="actions">' +
              (channel.online ? '<span class="me-live">LIVE</span>' : "") +
              '<button class="me-text-button" type="button" data-unfollow="' + esc(channel.handle) + '" data-name="' +
              esc(channel.displayName || channel.handle) + '">팔로우 해제</button>' +
              "</div></li>"
          )
          .join("") +
        "</ul>";
    }

    els.content.innerHTML = '<div class="me-panel wide"><h2>팔로잉</h2><div style="margin-top:14px">' + body + "</div></div>";

    els.content.querySelectorAll("[data-unfollow]").forEach((button) => {
      button.addEventListener("click", async () => {
        const handle = button.dataset.unfollow;
        const name = button.dataset.name || handle;
        if (!window.confirm(name + " 채널 팔로우를 해제할까요?")) return;
        button.disabled = true;
        try {
          await apiSend("/api/me/follows", "DELETE", { handle });
          state.follows = (state.follows || []).filter((channel) => channel.handle !== handle);
          renderFollowingBody();
          toast("팔로우를 해제했어요.");
        } catch (err) {
          button.disabled = false;
          toast(err && err.message ? err.message : "해제에 실패했어요. 다시 시도해 주세요.", "error");
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // 섹션: 지갑 [예약]
  // ---------------------------------------------------------------------------

  async function renderWalletSection() {
    els.content.innerHTML = skeletonPanel();
    try {
      await loadProfile(false);
    } catch (err) {
      /* 프로필 실패해도 잠금 화면은 보여준다 */
    }
    els.content.innerHTML = walletLockedCard(true);
    bindWalletNotifyButton();
  }

  function walletLockedCard(full) {
    const notifyOn = Boolean(state.profile && state.profile.notifyEmail);
    const button = notifyOn
      ? '<button class="button secondary" type="button" id="wallet-notify">오픈 알림 신청됨 · 해제하기</button>'
      : '<button class="button primary" type="button" id="wallet-notify">오픈 알림 신청</button>';
    const lockIcon =
      '<span class="me-lock-icon" aria-hidden="true"><svg viewBox="0 0 24 24">' +
      '<rect x="4" y="11" width="16" height="9" rx="2"></rect>' +
      '<path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg></span>';
    const inner =
      lockIcon +
      "<h2>지갑은 준비 중이에요</h2>" +
      "<p>캐시 충전 오픈 준비 중 — 지금은 계좌이체로 후원할 수 있어요.</p>" +
      button +
      '<p class="sub">신청하면 오픈 소식을 가입 이메일로 알려드려요.</p>';
    if (full) {
      return '<div class="me-panel me-locked center wide">' + inner + "</div>";
    }
    return '<article class="me-card me-locked">' + inner + "</article>";
  }

  function bindWalletNotifyButton() {
    const button = document.getElementById("wallet-notify");
    if (!button) return;
    button.addEventListener("click", async () => {
      const profile = state.profile || fallbackProfile();
      const next = !profile.notifyEmail;
      button.disabled = true;
      try {
        await apiSend("/api/me/profile", "PATCH", { notifyEmail: next });
        profile.notifyEmail = next;
        state.profile = profile;
        toast(next ? "오픈 알림을 신청했어요. 이메일로 알려드릴게요." : "오픈 알림 신청을 해제했어요.");
        renderSection();
      } catch (err) {
        button.disabled = false;
        toast("알림 신청을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.", "error");
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 공용 렌더 조각·헬퍼
  // ---------------------------------------------------------------------------

  function avatarHtml(avatarUrl, name, className) {
    if (avatarUrl) {
      return '<span class="' + className + '"><img src="' + esc(avatarUrl) + '" alt="" loading="lazy" /></span>';
    }
    return '<span class="' + className + '" aria-hidden="true">' + esc(String(name || "?").slice(0, 1)) + "</span>";
  }

  function statusMeta(status) {
    if (status === "matched") return { label: "전달됨", cls: "ok" };
    if (status === "pending") return { label: "확인 중", cls: "wait" };
    if (status === "blocked") return { label: "차단됨", cls: "danger" };
    return { label: "만료", cls: "end" };
  }

  function pageHref(handle) {
    return "/@" + handle + (MOCK ? "?mock=1" : "");
  }

  function formatDate(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "2-digit",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(date);
  }

  function skeletonCard() {
    return (
      '<div class="me-skeleton-block" aria-hidden="true">' +
      '<div class="sk-line sk-shimmer"></div>' +
      '<div class="sk-line sk-shimmer"></div>' +
      '<div class="sk-line short sk-shimmer"></div>' +
      "</div>"
    );
  }

  function skeletonPanel() {
    return '<div class="me-panel wide">' + skeletonCard().replace("me-skeleton-block", "me-skeleton-block sk-flat") + "</div>";
  }

  function errorCard(message) {
    return '<article class="me-card"><div class="me-error"><p>' + esc(message) + "</p></div></article>";
  }

  function renderPanelError(message, retryFn) {
    els.content.innerHTML =
      '<div class="me-panel wide"><div class="me-error"><p>' + esc(message) + "</p>" +
      '<button class="button secondary" type="button" id="panel-retry">다시 시도</button></div></div>';
    const retry = document.getElementById("panel-retry");
    if (retry) retry.addEventListener("click", retryFn);
    toast(message, "error");
  }

  // ---------------------------------------------------------------------------
  // 헤더: 테마·로그아웃
  // ---------------------------------------------------------------------------

  function setupTheme() {
    const toggle = document.getElementById("theme-toggle");
    if (!toggle) return;
    const apply = (theme) => {
      const next = theme === "light" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      localStorage.setItem("bbbb-site-theme", next);
      const isDark = next === "dark";
      toggle.setAttribute("aria-pressed", String(isDark));
      const label = isDark ? "화이트 모드로 전환" : "다크 모드로 전환";
      toggle.setAttribute("aria-label", label);
      toggle.setAttribute("title", label);
    };
    apply(document.documentElement.dataset.theme);
    toggle.addEventListener("click", () => {
      apply(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    });
  }

  function setupLogout() {
    const button = document.getElementById("logout-button");
    if (!button) return;
    button.addEventListener("click", async () => {
      if (MOCK) {
        location.href = "/";
        return;
      }
      try {
        const supa = await GW.getClient();
        if (supa) await supa.auth.signOut();
      } catch (err) {
        /* 로그아웃 실패해도 홈으로 */
      }
      location.href = "/";
    });
  }

  // ---------------------------------------------------------------------------
  // 토스트
  // ---------------------------------------------------------------------------

  function toast(message, kind) {
    if (!els.toastRoot) return;
    const node = document.createElement("div");
    node.className = "me-toast" + (kind === "error" ? " error" : "");
    node.textContent = message;
    els.toastRoot.appendChild(node);
    setTimeout(() => node.remove(), 3400);
  }

  // ---------------------------------------------------------------------------
  // 목 데이터 (?mock=1)
  // ---------------------------------------------------------------------------

  const mockDb = {
    profile: {
      nickname: "든든한시청자",
      avatarUrl: null,
      roles: ["viewer"],
      defaultMessage: "오늘도 방송 잘 볼게요!",
      notifyEmail: false
    },
    follows: [
      { handle: "gyeideuk", displayName: "계이득", bannerUrl: null, avatarUrl: null, bio: "계좌 후원 시그니처의 원조 채널", signatureCount: 24, online: true, followedAt: "2026-06-01T10:00:00.000Z" },
      { handle: "mint-radio", displayName: "민트라디오", bannerUrl: null, avatarUrl: null, bio: "새벽 감성 라디오 방송", signatureCount: 8, online: true, followedAt: "2026-06-11T10:00:00.000Z" },
      { handle: "cookingsool", displayName: "쿡킹술사", bannerUrl: null, avatarUrl: null, bio: "요리하며 수다 떠는 방송", signatureCount: 15, online: false, followedAt: "2026-06-20T10:00:00.000Z" },
      { handle: "puzzle-cat", displayName: "퍼즐냥", bannerUrl: null, avatarUrl: null, bio: "퍼즐 게임 전문. 냥이와 함께해요", signatureCount: 5, online: false, followedAt: "2026-06-25T10:00:00.000Z" },
      { handle: "pixel-farm", displayName: "픽셀농장", bannerUrl: null, avatarUrl: null, bio: "농장 시뮬레이션 힐링 방송", signatureCount: 12, online: false, followedAt: "2026-07-01T10:00:00.000Z" }
    ],
    donations: buildMockDonations()
  };

  function buildMockDonations() {
    const channels = [
      { handle: "gyeideuk", displayName: "계이득" },
      { handle: "mint-radio", displayName: "민트라디오" },
      { handle: "cookingsool", displayName: "쿡킹술사" }
    ];
    const statuses = ["matched", "matched", "pending", "expired", "matched"];
    const messages = [
      "오늘 방송 최고였어요!",
      "시그니처 신곡 너무 좋아요",
      "밥 잘 챙겨 드세요",
      "",
      "1등 축하드려요! 다음에도 화이팅"
    ];
    const amounts = [1000, 5000, 10000, 3000, 50000];
    const items = [];
    const base = Date.now() - 3600000;
    for (let i = 0; i < 26; i += 1) {
      const channel = channels[i % channels.length];
      items.push({
        messageId: "mock-msg-" + (1000 + i),
        handle: channel.handle,
        displayName: channel.displayName,
        amount: amounts[i % amounts.length],
        message: messages[i % messages.length],
        status: statuses[i % statuses.length],
        createdAt: new Date(base - i * 2 * 86400000 * 0.35).toISOString()
      });
    }
    return items;
  }

  function mockApi(path, method, body) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          resolve(mockRoute(path, method, body));
        } catch (err) {
          reject(err);
        }
      }, 220);
    });
  }

  function mockRoute(path, method, body) {
    const url = new URL(path, location.origin);
    const pathname = url.pathname;

    if (pathname === "/api/me/profile") {
      if (method === "PATCH") {
        Object.keys(body || {}).forEach((key) => {
          if (key in mockDb.profile) mockDb.profile[key] = body[key];
        });
      }
      return JSON.parse(JSON.stringify(mockDb.profile));
    }

    if (pathname === "/api/me/follows") {
      if (method === "POST") {
        return { followed: true, handle: body && body.handle };
      }
      if (method === "DELETE") {
        const handle = body && body.handle;
        mockDb.follows = mockDb.follows.filter((channel) => channel.handle !== handle);
        return { followed: false, handle };
      }
      return { channels: JSON.parse(JSON.stringify(mockDb.follows)) };
    }

    if (pathname === "/api/me/donations") {
      let items = mockDb.donations.slice();
      const handle = url.searchParams.get("handle");
      const from = url.searchParams.get("from");
      if (handle) items = items.filter((item) => item.handle === handle);
      if (from) {
        const fromMs = Date.parse(from);
        items = items.filter((item) => Date.parse(item.createdAt) >= fromMs);
      }
      const offset = Number(url.searchParams.get("cursor") || 0) || 0;
      const page = items.slice(offset, offset + 20);
      const nextCursor = offset + 20 < items.length ? String(offset + 20) : null;
      return { items: page, nextCursor };
    }

    if (pathname === "/api/report") {
      return { accepted: true };
    }

    throw new Error("목 모드에서 지원하지 않는 요청이에요: " + pathname);
  }
})();
