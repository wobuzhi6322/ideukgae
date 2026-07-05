// =============================================================================
// /channels 채널 탐색 (WSD) — GET /api/channels?q=&cursor= 소비
// 공개 페이지(로그인 불필요) · ?mock=1 목 모드 · GW.escapeHtml로 XSS 방지
// =============================================================================

(function () {
  "use strict";

  const GW = window.GW;
  const esc = GW.escapeHtml;
  const MOCK = new URLSearchParams(location.search).get("mock") === "1";
  const SEARCH_DEBOUNCE_MS = 300;

  const state = {
    q: "",
    cursor: null,
    channels: [],
    loading: false,
    requestSeq: 0
  };

  const els = {};

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    els.grid = document.getElementById("channel-grid");
    els.more = document.getElementById("channel-more");
    els.moreButton = document.getElementById("channel-more-button");
    els.search = document.getElementById("channel-search");
    els.account = document.getElementById("account-button");
    els.toastRoot = document.getElementById("toast-root");

    setupTheme();
    setupAccountButton();

    let timer = null;
    els.search.addEventListener("input", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => applySearch(els.search.value), SEARCH_DEBOUNCE_MS);
    });
    els.search.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        if (timer) clearTimeout(timer);
        applySearch(els.search.value);
      }
    });
    els.moreButton.addEventListener("click", () => load(false));

    load(true);
  }

  function applySearch(value) {
    const q = String(value || "").trim();
    if (q === state.q) return;
    state.q = q;
    load(true);
  }

  // -------------------------------------------------------------------------
  // 데이터 로드
  // -------------------------------------------------------------------------

  async function load(reset) {
    if (state.loading && !reset) return; // 새 검색(reset)은 진행 중 요청을 대체한다
    state.loading = true;
    const seq = ++state.requestSeq;
    if (reset) {
      state.cursor = null;
      state.channels = [];
      renderSkeleton();
    } else {
      els.moreButton.disabled = true;
      els.moreButton.textContent = "불러오는 중…";
    }

    try {
      const data = MOCK ? await mockChannels() : await fetchChannels();
      if (seq !== state.requestSeq) return; // 최신 검색만 반영
      state.channels = state.channels.concat(data.channels);
      state.cursor = data.nextCursor;
      renderGrid();
    } catch (err) {
      if (seq !== state.requestSeq) return;
      renderError(err && err.message ? err.message : "채널 목록을 불러오지 못했어요.");
    } finally {
      if (seq === state.requestSeq) {
        state.loading = false;
        els.moreButton.disabled = false;
        els.moreButton.textContent = "더 보기";
      }
    }
  }

  function fetchChannels() {
    const params = new URLSearchParams();
    if (state.q) params.set("q", state.q);
    if (state.cursor) params.set("cursor", state.cursor);
    const suffix = params.toString();
    return GW.api("/api/channels" + (suffix ? "?" + suffix : ""));
  }

  // -------------------------------------------------------------------------
  // 렌더링
  // -------------------------------------------------------------------------

  function renderSkeleton() {
    let html = "";
    for (let i = 0; i < 6; i += 1) {
      html +=
        '<div class="ch-skeleton" aria-hidden="true">' +
        '<div class="sk-banner sk-shimmer"></div>' +
        '<div class="sk-line sk-shimmer"></div>' +
        '<div class="sk-line short sk-shimmer"></div>' +
        "</div>";
    }
    els.grid.innerHTML = html;
    els.more.hidden = true;
  }

  function renderGrid() {
    if (!state.channels.length) {
      renderEmpty();
      return;
    }
    els.grid.innerHTML = state.channels.map(cardHtml).join("");
    els.more.hidden = !state.cursor;
  }

  function cardHtml(channel) {
    const name = channel.displayName || channel.handle;
    const banner = channel.bannerUrl
      ? '<img class="ch-banner" src="' + esc(channel.bannerUrl) + '" alt="" loading="lazy" />'
      : '<div class="ch-banner-fallback" aria-hidden="true"></div>';
    const avatar = channel.avatarUrl
      ? '<span class="ch-avatar"><img src="' + esc(channel.avatarUrl) + '" alt="" loading="lazy" /></span>'
      : '<span class="ch-avatar" aria-hidden="true">' + esc(name.slice(0, 1)) + "</span>";
    const live = channel.online ? '<span class="ch-live">LIVE</span>' : "";
    const bio = channel.bio ? esc(channel.bio) : "소개가 아직 없어요";
    return (
      '<a class="ch-card" href="' + esc(pageHref(channel.handle)) + '">' +
      banner +
      live +
      '<div class="ch-body">' +
      avatar +
      '<strong class="ch-name">' + esc(name) + "</strong>" +
      '<span class="ch-handle">@' + esc(channel.handle) + "</span>" +
      '<p class="ch-bio">' + bio + "</p>" +
      '<div class="ch-meta"><span class="ch-count">시그니처 ' + Number(channel.signatureCount || 0) + "개</span></div>" +
      "</div></a>"
    );
  }

  function renderEmpty() {
    els.more.hidden = true;
    if (state.q) {
      els.grid.innerHTML =
        '<div class="ch-empty">' +
        "<h2>검색 결과가 없어요</h2>" +
        "<p>다른 채널명이나 핸들로 다시 검색해 보세요.</p>" +
        '<button class="button secondary" type="button" data-action="reset-search">전체 채널 보기</button>' +
        "</div>";
      const reset = els.grid.querySelector('[data-action="reset-search"]');
      if (reset) {
        reset.addEventListener("click", () => {
          els.search.value = "";
          applySearch("");
        });
      }
      return;
    }
    els.grid.innerHTML =
      '<div class="ch-empty">' +
      "<h2>채널이 곧 입점합니다</h2>" +
      "<p>내 방송에 후원 페이지를 붙이고 첫 입점 채널이 되어 보세요.</p>" +
      '<a class="button primary" href="/signup?role=streamer">스트리머로 시작하기</a>' +
      "</div>";
  }

  function renderError(message) {
    els.more.hidden = true;
    els.grid.innerHTML =
      '<div class="ch-error">' +
      "<h2>채널 목록을 불러오지 못했어요</h2>" +
      '<p>' + esc(message) + "</p>" +
      '<button class="button secondary" type="button" data-action="retry">다시 시도</button>' +
      "</div>";
    const retry = els.grid.querySelector('[data-action="retry"]');
    if (retry) {
      retry.addEventListener("click", () => load(true));
    }
    toast("채널 목록을 불러오지 못했어요.", "error");
  }

  function pageHref(handle) {
    return "/@" + handle + (MOCK ? "?mock=1" : "");
  }

  // -------------------------------------------------------------------------
  // 헤더: 테마 토글 · 계정 버튼
  // -------------------------------------------------------------------------

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

  async function setupAccountButton() {
    if (!els.account) return;
    if (MOCK) return; // 목 모드는 비로그인 표시 유지
    try {
      const session = await GW.getSession();
      if (session) {
        els.account.textContent = "내 페이지";
        els.account.href = "/me";
      }
    } catch (err) {
      /* 세션 확인 실패 시 로그인 버튼 유지 */
    }
  }

  // -------------------------------------------------------------------------
  // 토스트
  // -------------------------------------------------------------------------

  function toast(message, kind) {
    if (!els.toastRoot) return;
    const node = document.createElement("div");
    node.className = "ch-toast" + (kind === "error" ? " error" : "");
    node.textContent = message;
    els.toastRoot.appendChild(node);
    setTimeout(() => node.remove(), 3400);
  }

  // -------------------------------------------------------------------------
  // 목 데이터 (?mock=1)
  // -------------------------------------------------------------------------

  const MOCK_CHANNELS = [
    { handle: "gyeideuk", displayName: "계이득", bannerUrl: null, avatarUrl: null, bio: "계좌 후원 시그니처의 원조 채널", signatureCount: 24, online: true },
    { handle: "mint-radio", displayName: "민트라디오", bannerUrl: null, avatarUrl: null, bio: "새벽 감성 라디오 방송", signatureCount: 8, online: true },
    { handle: "cookingsool", displayName: "쿡킹술사", bannerUrl: null, avatarUrl: null, bio: "요리하며 수다 떠는 방송", signatureCount: 15, online: false },
    { handle: "puzzle-cat", displayName: "퍼즐냥", bannerUrl: null, avatarUrl: null, bio: "퍼즐 게임 전문. 냥이와 함께해요", signatureCount: 5, online: false },
    { handle: "daily-run", displayName: "달리는하루", bannerUrl: null, avatarUrl: null, bio: null, signatureCount: 3, online: false },
    { handle: "pixel-farm", displayName: "픽셀농장", bannerUrl: null, avatarUrl: null, bio: "농장 시뮬레이션 힐링 방송", signatureCount: 12, online: true },
    { handle: "night-owl", displayName: "밤부엉이", bannerUrl: null, avatarUrl: null, bio: "심야 공포 게임 전문", signatureCount: 9, online: false },
    { handle: "seongyo-dan", displayName: "성교단", bannerUrl: null, avatarUrl: null, bio: "리듬 게임 랭커 도전기", signatureCount: 7, online: false }
  ];

  function mockChannels() {
    const q = state.q.trim().toLowerCase();
    const filtered = MOCK_CHANNELS.filter((channel) => {
      if (!q) return true;
      return (
        channel.handle.toLowerCase().includes(q) ||
        (channel.displayName || "").toLowerCase().includes(q)
      );
    });
    return new Promise((resolve) => {
      setTimeout(() => resolve({ channels: filtered, nextCursor: null }), 250);
    });
  }
})();
