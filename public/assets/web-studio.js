// =============================================================================
// 계이득 스튜디오 /studio (WSC)
// 로드 순서: supabase CDN → /assets/qr.js(GyeideukQR) → web-common.js(GW.*) → 이 파일(defer)
// 라우팅: /studio/:section (vercel.json rewrite → studio.html)
// ?mock=1 — 백엔드 없이 화면 검증용 목 모드
// =============================================================================

(function () {
  "use strict";

  var GW = window.GW;
  var MOCK = new URLSearchParams(location.search).get("mock") === "1";
  // ?mock=1&empty=1 — 빈 상태 3종(미연동·시그니처 0·후원 0) 검증용
  var MOCK_EMPTY = MOCK && new URLSearchParams(location.search).get("empty") === "1";

  var SECTIONS = {
    dashboard: { title: "대시보드", path: "/studio" },
    page: { title: "채널 페이지 설정", path: "/studio/page" },
    signatures: { title: "시그니처 메뉴판", path: "/studio/signatures" },
    donations: { title: "후원 내역", path: "/studio/donations" },
    relay: { title: "프로그램 연동", path: "/studio/relay" },
    earnings: { title: "수익·정산", path: "/studio/earnings" },
    account: { title: "계정", path: "/studio/account" }
  };

  var MEDIA_LABEL = { image: "이미지", gif: "GIF", video: "영상", audio: "음악" };

  var S = {
    token: null,
    email: null,
    page: null,
    sigEdit: null,
    lastSyncedAt: null,
    donations: null,
    candidates: [],
    filter: "all",
    section: "dashboard",
    online: false,
    lastHeartbeatAt: null,
    feedLoaded: false,
    feedTimer: null,
    codeTimer: null,
    mmMatchId: null
  };

  function $(sel) {
    return document.querySelector(sel);
  }

  function esc(value) {
    return GW.escapeHtml(value);
  }

  function fmtWon(amount) {
    return GW.formatKrw(amount);
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleTimeString("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Seoul"
    });
  }

  function fmtDateTime(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Seoul"
    });
  }

  function toast(message, type) {
    var root = $("#toast-root");
    var node = document.createElement("div");
    node.className = "toast" + (type === "err" ? " err" : type === "ok" ? " okv" : "");
    node.textContent = message;
    root.appendChild(node);
    setTimeout(function () {
      node.remove();
    }, 3600);
  }

  function call(path, opts) {
    if (MOCK) return mockCall(path, opts || {});
    var merged = Object.assign({}, opts || {});
    merged.token = S.token;
    return GW.api(path, merged);
  }

  // ---------------------------------------------------------------------------
  // 게이트 (로딩 / 페이지 없음 / 에러)
  // ---------------------------------------------------------------------------

  function showGate(kind) {
    $("#studio-gate").hidden = false;
    $("#studio-shell").hidden = true;
    $("#studio-tabbar").hidden = true;
    $("#gate-loading").hidden = kind !== "loading";
    $("#gate-nopage").hidden = kind !== "nopage";
    $("#gate-error").hidden = kind !== "error";
  }

  function showShell() {
    $("#studio-gate").hidden = true;
    $("#studio-shell").hidden = false;
    $("#studio-tabbar").hidden = false;
  }

  // ---------------------------------------------------------------------------
  // 라우팅 (데스크톱 사이드바 + 모바일 하단 탭)
  // ---------------------------------------------------------------------------

  function sectionFromPath() {
    var match = /^\/studio(?:\/([a-z-]+))?\/?$/.exec(location.pathname);
    var section = match && match[1] ? match[1] : "dashboard";
    return SECTIONS[section] ? section : "dashboard";
  }

  function navTo(section, push) {
    if (!SECTIONS[section]) section = "dashboard";
    S.section = section;
    if (push !== false) {
      history.pushState(null, "", SECTIONS[section].path + location.search);
    }
    $("#view-title").textContent = SECTIONS[section].title;

    var views = document.querySelectorAll(".studio-view");
    for (var i = 0; i < views.length; i += 1) {
      views[i].hidden = views[i].id !== "view-" + section;
    }
    var navBtns = document.querySelectorAll(".side-nav [data-nav], .studio-tabbar [data-nav]");
    for (var j = 0; j < navBtns.length; j += 1) {
      var active = navBtns[j].getAttribute("data-nav") === section;
      navBtns[j].classList.toggle("active", active);
    }

    if (section === "dashboard") startFeed();
    else stopFeed();

    if (section === "page") renderPageForm();
    if (section === "signatures" && S.sigEdit === null) loadSignatures();
    if (section === "donations") {
      if (S.donations === null) loadDonations();
      loadBlocks();
    }
    if (section === "relay") refreshStatusOnce();
    if (section === "account") renderAccount();
  }

  // ---------------------------------------------------------------------------
  // ① 대시보드 — 피드(10초 폴링) · 오늘 합계 · 연결 상태 · 링크/QR
  // ---------------------------------------------------------------------------

  function startFeed() {
    stopFeed();
    loadFeed();
    S.feedTimer = setInterval(function () {
      if (!document.hidden) loadFeed();
    }, 10000);
  }

  function stopFeed() {
    if (S.feedTimer) {
      clearInterval(S.feedTimer);
      S.feedTimer = null;
    }
  }

  function loadFeed() {
    call("/api/studio/feed")
      .then(function (data) {
        S.feedLoaded = true;
        S.online = data.online;
        S.lastHeartbeatAt = data.lastHeartbeatAt;
        renderConn();
        renderFeed(data);
      })
      .catch(function () {
        if (!S.feedLoaded) {
          $("#feed-skeleton").hidden = true;
          $("#feed-error").hidden = false;
          $("#feed-empty").hidden = true;
          $("#feed-list").hidden = true;
        }
      });
  }

  function refreshStatusOnce() {
    renderConn();
    call("/api/studio/feed")
      .then(function (data) {
        S.online = data.online;
        S.lastHeartbeatAt = data.lastHeartbeatAt;
        renderConn();
      })
      .catch(function () {});
  }

  function renderConn() {
    var chips = [$("#head-conn"), $("#relay-conn")];
    for (var i = 0; i < chips.length; i += 1) {
      if (!chips[i]) continue;
      chips[i].textContent = S.online ? "● 연결됨" : "○ 오프라인";
      chips[i].classList.toggle("conn-on", S.online);
      chips[i].classList.toggle("conn-off", !S.online);
    }
    var stat = $("#stat-conn");
    stat.textContent = S.online ? "● 연결됨" : "○ 오프라인";
    stat.classList.toggle("conn-on", S.online);
    var subText = "마지막 통신 " + (S.lastHeartbeatAt ? fmtDateTime(S.lastHeartbeatAt) : "—");
    $("#stat-conn-sub").textContent = subText;
    $("#relay-conn-sub").textContent = subText;
  }

  function renderFeed(data) {
    $("#stat-total").textContent = fmtWon(data.todayTotal);
    $("#stat-count").textContent = data.todayCount.toLocaleString("ko-KR") + "건";
    $("#feed-updated").textContent = fmtTime(new Date().toISOString()) + " 갱신";
    $("#feed-skeleton").hidden = true;
    $("#feed-error").hidden = true;

    var list = $("#feed-list");
    if (!data.items.length) {
      $("#feed-empty").hidden = false;
      list.hidden = true;
      return;
    }
    $("#feed-empty").hidden = true;
    list.hidden = false;
    list.innerHTML = data.items
      .map(function (item) {
        var badge = item.messageId
          ? item.matchedBy === "manual"
            ? '<span class="feed-badge b-manual">수동</span>'
            : '<span class="feed-badge b-auto">매칭</span>'
          : '<span class="feed-badge b-unmatched">미매칭</span>';
        var name = item.nickname || item.senderRaw || "이름 없음";
        var msg = item.message ? '<span class="feed-msg">' + esc(item.message) + "</span>" : "";
        return (
          "<li>" +
          '<span class="feed-time">' + esc(fmtTime(item.reportedAt)) + "</span>" +
          '<span class="feed-main"><span class="feed-name">' + esc(name) + "</span> " + badge + msg + "</span>" +
          '<span class="feed-amount">' + esc(fmtWon(item.amount || 0)) + "</span>" +
          "</li>"
        );
      })
      .join("");
  }

  function pageUrl() {
    return location.origin + "/@" + S.page.handle;
  }

  function renderPageLink() {
    var url = pageUrl();
    var link = $("#page-link");
    link.textContent = url.replace(/^https?:\/\//, "");
    link.href = url;
    $("#side-page-link").href = url;
    renderQr(url);
  }

  function renderQr(url) {
    $("#qr-download").disabled = !drawQr($("#qr-canvas"), url);
  }

  // qr.js(GyeideukQR)로 캔버스에 QR을 그린다. 성공 여부 반환.
  function drawQr(canvas, url) {
    if (!canvas || !window.GyeideukQR || !window.GyeideukQR.toCanvas) return false;
    try {
      window.GyeideukQR.toCanvas(canvas, url);
      return true;
    } catch (err) {
      return false;
    }
  }

  function downloadQrPng(canvas) {
    var anchor = document.createElement("a");
    anchor.href = canvas.toDataURL("image/png");
    anchor.download = "gyeideuk-" + S.page.handle + "-qr.png";
    anchor.click();
  }

  function bindDashboard() {
    $("#feed-retry").addEventListener("click", function () {
      $("#feed-error").hidden = true;
      $("#feed-skeleton").hidden = false;
      loadFeed();
    });
    $("#copy-link").addEventListener("click", function () {
      copyText(pageUrl());
    });
    $("#qr-download").addEventListener("click", function () {
      downloadQrPng($("#qr-canvas"));
    });
  }

  function copyText(text, okMessage) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          toast(okMessage || "링크를 복사했어요.", "ok");
        },
        function () {
          toast("복사에 실패했어요. 주소를 직접 선택해 주세요.", "err");
        }
      );
    } else {
      toast("이 브라우저에서는 복사를 지원하지 않아요.", "err");
    }
  }

  // ---------------------------------------------------------------------------
  // ② 채널 페이지 설정
  // ---------------------------------------------------------------------------

  function handleBlockedUntil() {
    if (!S.page.handleChangedAt) return null;
    var until = Date.parse(S.page.handleChangedAt) + 30 * 86400000;
    return Date.now() < until ? new Date(until) : null;
  }

  function broadcastUrl(platform) {
    var links = S.page.broadcastLinks || [];
    for (var i = 0; i < links.length; i += 1) {
      if (links[i].platform === platform) return links[i].url;
    }
    return "";
  }

  function transferUrl(type) {
    var links = S.page.transferLinks || [];
    for (var i = 0; i < links.length; i += 1) {
      if (links[i].type === type) return links[i].url;
    }
    return "";
  }

  // 바로가기 정본 URL (기획서 §6.1) — 방송 설명란·홍보물에 박제되는 주소.
  // 도메인 확정 전까지는 배포 오리진이 곧 정본 주소다(QR·복사도 이 값을 따른다).
  function shortcutUrl() {
    return location.origin + "/@" + S.page.handle;
  }

  function renderShortcutCard() {
    var url = shortcutUrl();
    $("#sc-url").textContent = url;
    $("#sc-qr-download").disabled = !drawQr($("#sc-qr-canvas"), url);
  }

  function bindShortcutCard() {
    $("#sc-copy").addEventListener("click", function () {
      copyText(shortcutUrl(), "주소를 복사했어요. 방송 설명란에 붙여넣어 주세요.");
    });
    $("#sc-qr-download").addEventListener("click", function () {
      downloadQrPng($("#sc-qr-canvas"));
    });
  }

  function renderPageForm() {
    var page = S.page;
    renderShortcutCard();
    $("#ps-handle").value = page.handle;
    var blocked = handleBlockedUntil();
    $("#ps-handle").disabled = Boolean(blocked);
    $("#ps-handle-note").textContent = blocked
      ? "핸들은 30일에 1번만 변경할 수 있어요. 다음 변경 가능일: " + blocked.toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })
      : "핸들은 30일에 1번만 변경할 수 있어요. 변경하면 이전 주소로 들어온 시청자에게 새 주소를 안내해야 합니다.";

    $("#ps-banner").value = page.bannerUrl || "";
    $("#ps-avatar").value = page.avatarUrl || "";
    $("#ps-bio").value = page.bio || "";
    $("#ps-bio-count").textContent = String(($("#ps-bio").value || "").length);

    $("#ps-link-chzzk").value = broadcastUrl("chzzk");
    $("#ps-link-soop").value = broadcastUrl("soop");
    $("#ps-link-youtube").value = broadcastUrl("youtube");

    var presets = (page.presetAmounts && page.presetAmounts.length ? page.presetAmounts : [1000, 5000, 10000, 50000]).slice(0, 4);
    for (var i = 0; i < 4; i += 1) {
      $("#ps-preset-" + (i + 1)).value = presets[i] != null ? presets[i] : "";
    }
    $("#ps-min").value = page.minAmount;

    var radios = document.querySelectorAll('input[name="account-display"]');
    for (var j = 0; j < radios.length; j += 1) {
      radios[j].checked = radios[j].value === page.accountDisplay;
    }
    $("#ps-account-box").hidden = page.accountDisplay !== "full";
    $("#ps-acc-bank").value = page.accountInfo ? page.accountInfo.bank : "";
    $("#ps-acc-number").value = page.accountInfo ? page.accountInfo.number : "";
    $("#ps-acc-holder").value = page.accountInfo ? page.accountInfo.holder : "";

    $("#ps-toss").value = transferUrl("toss");
    $("#ps-kakao").value = transferUrl("kakao");

    $("#ps-ticker").checked = Boolean(page.tickerPublic);
    $("#ps-directory").checked = Boolean(page.directoryOptin);
    $("#ps-save-note").textContent = "";
  }

  function collectPageForm() {
    var body = {};
    var handle = $("#ps-handle").value.trim().toLowerCase();
    if (!$("#ps-handle").disabled && handle && handle !== S.page.handle.toLowerCase()) {
      body.handle = handle;
    }

    body.bannerUrl = $("#ps-banner").value.trim() || null;
    body.avatarUrl = $("#ps-avatar").value.trim() || null;
    body.bio = $("#ps-bio").value.trim();

    var broadcastLinks = [];
    var platforms = [
      ["chzzk", $("#ps-link-chzzk").value.trim()],
      ["soop", $("#ps-link-soop").value.trim()],
      ["youtube", $("#ps-link-youtube").value.trim()]
    ];
    for (var i = 0; i < platforms.length; i += 1) {
      if (platforms[i][1]) broadcastLinks.push({ platform: platforms[i][0], url: platforms[i][1] });
    }
    body.broadcastLinks = broadcastLinks;

    var presets = [];
    for (var j = 1; j <= 4; j += 1) {
      var raw = $("#ps-preset-" + j).value;
      var amount = Number(raw);
      if (!raw || !Number.isInteger(amount) || amount <= 0) {
        throw new Error("프리셋 금액 4개를 모두 양의 정수로 입력해 주세요.");
      }
      presets.push(amount);
    }
    body.presetAmounts = presets;

    var min = Number($("#ps-min").value);
    if (!Number.isInteger(min) || min < 100) {
      throw new Error("최소 후원액은 100원 이상의 정수여야 해요.");
    }
    body.minAmount = min;

    var display = document.querySelector('input[name="account-display"]:checked');
    body.accountDisplay = display ? display.value : "link_only";

    var bank = $("#ps-acc-bank").value.trim();
    var number = $("#ps-acc-number").value.trim();
    var holder = $("#ps-acc-holder").value.trim();
    if (!bank && !number && !holder) {
      body.accountInfo = null;
      if (body.accountDisplay === "full") {
        throw new Error("계좌 직접 노출을 켜려면 은행·계좌번호·예금주를 입력해 주세요.");
      }
    } else if (!bank || !number || !holder) {
      throw new Error("계좌 정보는 은행·계좌번호·예금주를 모두 입력해야 해요.");
    } else {
      body.accountInfo = { bank: bank, number: number, holder: holder };
    }

    var transferLinks = [];
    if ($("#ps-toss").value.trim()) transferLinks.push({ type: "toss", url: $("#ps-toss").value.trim() });
    if ($("#ps-kakao").value.trim()) transferLinks.push({ type: "kakao", url: $("#ps-kakao").value.trim() });
    body.transferLinks = transferLinks;

    body.tickerPublic = $("#ps-ticker").checked;
    body.directoryOptin = $("#ps-directory").checked;
    return body;
  }

  function bindPageForm() {
    $("#ps-bio").addEventListener("input", function () {
      $("#ps-bio-count").textContent = String($("#ps-bio").value.length);
    });
    var radios = document.querySelectorAll('input[name="account-display"]');
    for (var i = 0; i < radios.length; i += 1) {
      radios[i].addEventListener("change", function (event) {
        $("#ps-account-box").hidden = event.target.value !== "full";
      });
    }
    $("#page-form").addEventListener("submit", function (event) {
      event.preventDefault();
      var body;
      try {
        body = collectPageForm();
      } catch (err) {
        toast(err.message, "err");
        return;
      }
      if (body.handle) {
        var sure = window.confirm(
          "핸들을 @" + body.handle + " 으로 변경할까요?\n이전 주소는 더 이상 연결되지 않고, 30일 동안 다시 바꿀 수 없어요."
        );
        if (!sure) return;
      }
      var button = $("#ps-save");
      button.disabled = true;
      call("/api/studio/page", { method: "PATCH", body: body })
        .then(function (data) {
          S.page = data;
          renderPageForm();
          renderPageLink();
          toast("저장했어요.", "ok");
          $("#ps-save-note").textContent = fmtTime(new Date().toISOString()) + " 저장됨";
        })
        .catch(function (err) {
          toast(err.message || "저장에 실패했어요.", "err");
        })
        .then(function () {
          button.disabled = false;
        });
    });
  }

  // ---------------------------------------------------------------------------
  // ③ 시그니처 메뉴판
  // ---------------------------------------------------------------------------

  function loadSignatures() {
    $("#sig-skeleton").hidden = false;
    $("#sig-empty").hidden = true;
    $("#sig-error").hidden = true;
    $("#sig-editor").hidden = true;
    call("/api/studio/signatures")
      .then(function (data) {
        S.sigEdit = data.signatures.map(function (row) {
          return Object.assign({}, row);
        });
        S.lastSyncedAt = data.lastSyncedAt;
        $("#sig-skeleton").hidden = true;
        $("#sig-synced-at").textContent = "마지막 동기화 " + (S.lastSyncedAt ? fmtDateTime(S.lastSyncedAt) : "—");
        if (!S.sigEdit.length) {
          $("#sig-empty").hidden = false;
          return;
        }
        $("#sig-editor").hidden = false;
        renderSigRows();
      })
      .catch(function () {
        S.sigEdit = null;
        $("#sig-skeleton").hidden = true;
        $("#sig-error").hidden = false;
      });
  }

  function renderSigRows() {
    var rows = S.sigEdit
      .map(function (row, idx) {
        var thumb = row.thumbUrl
          ? '<img class="sig-thumb" src="' + esc(row.thumbUrl) + '" alt="" loading="lazy" />'
          : '<span class="sig-thumb-fallback">' + esc(MEDIA_LABEL[row.mediaType] || row.mediaType) + "</span>";
        return (
          "<tr data-idx=\"" + idx + "\">" +
          "<td>" + thumb + "</td>" +
          '<td class="sig-title-cell"><span class="sig-local-title">' + esc(row.title) +
          '<span class="sig-media-badge">' + esc(MEDIA_LABEL[row.mediaType] || row.mediaType) + "</span></span>" +
          '<input type="text" class="sig-webtitle" maxlength="60" placeholder="웹 제목 (비우면 프로그램 제목)" value="' + esc(row.webTitle || "") + '" /></td>' +
          "<td>" + esc(fmtWon(row.amount)) + "</td>" +
          '<td><label class="toggle-row"><input type="checkbox" class="sig-published"' + (row.published ? " checked" : "") + " /> <span>공개</span></label></td>" +
          '<td><button type="button" class="pin-btn' + (row.pinned ? " on" : "") + '">' + (row.pinned ? "★ 추천" : "☆ 추천") + "</button></td>" +
          '<td><span class="sort-btns">' +
          '<button type="button" class="sig-up" aria-label="위로"' + (idx === 0 ? " disabled" : "") + ">↑</button>" +
          '<button type="button" class="sig-down" aria-label="아래로"' + (idx === S.sigEdit.length - 1 ? " disabled" : "") + ">↓</button>" +
          "</span></td>" +
          "</tr>"
        );
      })
      .join("");
    $("#sig-rows").innerHTML = rows;
  }

  function sigRowIndex(target) {
    var tr = target.closest("tr[data-idx]");
    return tr ? Number(tr.getAttribute("data-idx")) : -1;
  }

  function bindSignatures() {
    $("#sig-retry").addEventListener("click", loadSignatures);

    $("#sig-rows").addEventListener("input", function (event) {
      var idx = sigRowIndex(event.target);
      if (idx < 0) return;
      if (event.target.classList.contains("sig-webtitle")) {
        S.sigEdit[idx].webTitle = event.target.value.trim() || null;
      }
    });

    $("#sig-rows").addEventListener("change", function (event) {
      var idx = sigRowIndex(event.target);
      if (idx < 0) return;
      if (event.target.classList.contains("sig-published")) {
        S.sigEdit[idx].published = event.target.checked;
      }
    });

    $("#sig-rows").addEventListener("click", function (event) {
      var idx = sigRowIndex(event.target);
      if (idx < 0) return;
      if (event.target.closest(".pin-btn")) {
        var row = S.sigEdit[idx];
        if (!row.pinned) {
          var pinnedCount = S.sigEdit.filter(function (item) {
            return item.pinned;
          }).length;
          if (pinnedCount >= 3) {
            toast("추천 고정은 최대 3개까지예요.", "err");
            return;
          }
        }
        row.pinned = !row.pinned;
        renderSigRows();
        return;
      }
      if (event.target.closest(".sig-up") && idx > 0) {
        var up = S.sigEdit.splice(idx, 1)[0];
        S.sigEdit.splice(idx - 1, 0, up);
        renderSigRows();
        return;
      }
      if (event.target.closest(".sig-down") && idx < S.sigEdit.length - 1) {
        var down = S.sigEdit.splice(idx, 1)[0];
        S.sigEdit.splice(idx + 1, 0, down);
        renderSigRows();
      }
    });

    $("#sig-save").addEventListener("click", function () {
      var items = S.sigEdit.map(function (row, idx) {
        return {
          id: row.id,
          published: row.published,
          pinned: row.pinned,
          webTitle: row.webTitle || null,
          sort: idx * 10
        };
      });
      var button = $("#sig-save");
      button.disabled = true;
      call("/api/studio/signatures", { method: "PATCH", body: { items: items } })
        .then(function (data) {
          S.sigEdit = data.signatures.map(function (row) {
            return Object.assign({}, row);
          });
          renderSigRows();
          toast("메뉴판을 저장했어요.", "ok");
          $("#sig-save-note").textContent = fmtTime(new Date().toISOString()) + " 저장됨";
        })
        .catch(function (err) {
          toast(err.message || "저장에 실패했어요.", "err");
        })
        .then(function () {
          button.disabled = false;
        });
    });
  }

  // ---------------------------------------------------------------------------
  // ④ 후원 내역 — 매칭 로그 · 수동 매칭 · 차단
  // ---------------------------------------------------------------------------

  function loadDonations() {
    $("#don-skeleton").hidden = false;
    $("#don-empty").hidden = true;
    $("#don-error").hidden = true;
    $("#don-table-wrap").hidden = true;
    var chips = document.querySelectorAll(".filter-row .chip");
    for (var i = 0; i < chips.length; i += 1) {
      chips[i].classList.toggle("active", chips[i].getAttribute("data-filter") === S.filter);
    }
    call("/api/studio/donations?filter=" + encodeURIComponent(S.filter))
      .then(function (data) {
        S.donations = data.items;
        S.candidates = data.candidates || [];
        $("#don-skeleton").hidden = true;
        if (!data.items.length) {
          $("#don-empty").hidden = false;
          return;
        }
        $("#don-table-wrap").hidden = false;
        renderDonations();
      })
      .catch(function () {
        S.donations = null;
        $("#don-skeleton").hidden = true;
        $("#don-error").hidden = false;
      });
  }

  function donStatus(item) {
    if (!item.messageId) return '<span class="feed-badge b-unmatched">미매칭</span>';
    if (item.matchedBy === "manual") return '<span class="feed-badge b-manual">수동</span>';
    return '<span class="feed-badge b-auto">자동</span>';
  }

  function renderDonations() {
    $("#don-rows").innerHTML = S.donations
      .map(function (item) {
        var msg = item.messageId
          ? '<span class="don-nick">' + esc(item.nickname || "") + "</span> <span class=\"don-msg\">" + esc(item.message || "") + "</span>"
          : '<span class="don-nick">—</span>';
        var actions = [];
        if (!item.messageId) {
          actions.push('<button type="button" class="btn btn-ghost btn-sm don-mm" data-match="' + esc(item.matchId) + '">수동 매칭</button>');
        }
        if (item.nickname) {
          actions.push('<button type="button" class="btn btn-ghost btn-sm don-block" data-nick="' + esc(item.nickname) + '">차단</button>');
        }
        return (
          "<tr>" +
          "<td>" + esc(fmtDateTime(item.reportedAt)) + "</td>" +
          "<td>" + esc(item.senderRaw || "—") + "</td>" +
          "<td>" + esc(item.amount != null ? fmtWon(item.amount) : "—") + "</td>" +
          "<td>" + donStatus(item) + "</td>" +
          "<td>" + msg + "</td>" +
          "<td>" + actions.join(" ") + "</td>" +
          "</tr>"
        );
      })
      .join("");
  }

  function openManualMatch(matchId) {
    var item = null;
    for (var i = 0; i < S.donations.length; i += 1) {
      if (S.donations[i].matchId === matchId) item = S.donations[i];
    }
    if (!item) return;
    S.mmMatchId = matchId;
    $("#mm-summary").textContent =
      "입금자명 " + (item.senderRaw || "—") + " · " + (item.amount != null ? fmtWon(item.amount) : "금액 미상") +
      " · " + fmtDateTime(item.reportedAt);

    var candidates = S.candidates.slice().sort(function (a, b) {
      var aSame = item.amount != null && a.amount === item.amount ? 0 : 1;
      var bSame = item.amount != null && b.amount === item.amount ? 0 : 1;
      if (aSame !== bSame) return aSame - bSame;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
    var select = $("#mm-select");
    select.innerHTML = candidates
      .map(function (row) {
        return (
          '<option value="' + esc(row.messageId) + '">' +
          esc(
            row.nickname + " · " + fmtWon(row.amount) + " · 코드 " + row.depositCode +
            " · " + (row.status === "expired" ? "만료" : "대기") + " · " + fmtDateTime(row.createdAt)
          ) +
          "</option>"
        );
      })
      .join("");
    var hasCandidates = candidates.length > 0;
    select.hidden = !hasCandidates;
    $("#mm-empty").hidden = hasCandidates;
    $("#mm-confirm").disabled = !hasCandidates;
    $("#mm-modal").hidden = false;
  }

  function closeManualMatch() {
    $("#mm-modal").hidden = true;
    S.mmMatchId = null;
  }

  function bindDonations() {
    $("#don-retry").addEventListener("click", loadDonations);

    var chips = document.querySelectorAll(".filter-row .chip");
    for (var i = 0; i < chips.length; i += 1) {
      chips[i].addEventListener("click", function (event) {
        S.filter = event.currentTarget.getAttribute("data-filter");
        loadDonations();
      });
    }

    $("#don-rows").addEventListener("click", function (event) {
      var mm = event.target.closest(".don-mm");
      if (mm) {
        openManualMatch(mm.getAttribute("data-match"));
        return;
      }
      var block = event.target.closest(".don-block");
      if (block) {
        $("#block-value").value = block.getAttribute("data-nick");
        $("#block-value").focus();
        toast("차단 값을 채웠어요. [차단 추가]를 눌러 확정해 주세요.");
      }
    });

    $("#mm-cancel").addEventListener("click", closeManualMatch);
    $("#mm-modal").addEventListener("click", function (event) {
      if (event.target === $("#mm-modal")) closeManualMatch();
    });
    $("#mm-confirm").addEventListener("click", function () {
      var messageId = $("#mm-select").value;
      if (!S.mmMatchId || !messageId) return;
      var button = $("#mm-confirm");
      button.disabled = true;
      call("/api/studio/manual-match", { method: "POST", body: { matchId: S.mmMatchId, messageId: messageId } })
        .then(function () {
          toast("수동 매칭을 저장했어요. 방송 재생 없이 기록만 남습니다.", "ok");
          closeManualMatch();
          loadDonations();
        })
        .catch(function (err) {
          toast(err.message || "수동 매칭에 실패했어요.", "err");
        })
        .then(function () {
          button.disabled = false;
        });
    });

    $("#block-form").addEventListener("submit", function (event) {
      event.preventDefault();
      var value = $("#block-value").value.trim();
      if (!value) {
        toast("차단할 닉네임 또는 입금코드를 입력해 주세요.", "err");
        return;
      }
      call("/api/studio/blocks", {
        method: "POST",
        body: { blockedValue: value, reason: $("#block-reason").value.trim() }
      })
        .then(function (data) {
          renderBlocks(data.blocks);
          $("#block-value").value = "";
          $("#block-reason").value = "";
          toast("차단했어요.", "ok");
        })
        .catch(function (err) {
          toast(err.message || "차단에 실패했어요.", "err");
        });
    });

    $("#block-list").addEventListener("click", function (event) {
      var btn = event.target.closest(".block-remove");
      if (!btn) return;
      call("/api/studio/blocks", {
        method: "POST",
        body: { blockedValue: btn.getAttribute("data-value"), remove: true }
      })
        .then(function (data) {
          renderBlocks(data.blocks);
          toast("차단을 해제했어요.", "ok");
        })
        .catch(function (err) {
          toast(err.message || "해제에 실패했어요.", "err");
        });
    });
  }

  function loadBlocks() {
    call("/api/studio/blocks")
      .then(function (data) {
        renderBlocks(data.blocks);
      })
      .catch(function () {});
  }

  function renderBlocks(blocks) {
    $("#block-empty").hidden = blocks.length > 0;
    $("#block-list").innerHTML = blocks
      .map(function (row) {
        return (
          "<li>" +
          '<span class="block-value">' + esc(row.blockedValue) + "</span>" +
          '<span class="block-reason">' + esc(row.reason || "") + "</span>" +
          '<button type="button" class="btn btn-ghost btn-sm block-remove" data-value="' + esc(row.blockedValue) + '">해제</button>' +
          "</li>"
        );
      })
      .join("");
  }

  // ---------------------------------------------------------------------------
  // ⑤ 프로그램 연동 — 연결 코드
  // ---------------------------------------------------------------------------

  function bindRelay() {
    $("#relay-issue").addEventListener("click", function () {
      var button = $("#relay-issue");
      button.disabled = true;
      call("/api/studio/relay-connect-code", { method: "POST", body: {} })
        .then(function (data) {
          $("#relay-code-box").hidden = false;
          $("#relay-code").textContent = data.code;
          startCodeTimer(data.expiresAt);
          button.textContent = "연결 코드 재발급";
        })
        .catch(function (err) {
          toast(err.message || "코드 발급에 실패했어요.", "err");
        })
        .then(function () {
          button.disabled = false;
        });
    });
  }

  function startCodeTimer(expiresAt) {
    stopCodeTimer();
    var tick = function () {
      var remain = Date.parse(expiresAt) - Date.now();
      if (remain <= 0) {
        $("#relay-code-timer").textContent = "코드가 만료됐어요. 다시 발급해 주세요.";
        stopCodeTimer();
        return;
      }
      var minutes = Math.floor(remain / 60000);
      var seconds = Math.floor((remain % 60000) / 1000);
      $("#relay-code-timer").textContent =
        minutes + "분 " + (seconds < 10 ? "0" : "") + seconds + "초 후 만료 · 프로그램 /admin 고급 탭에 입력";
    };
    tick();
    S.codeTimer = setInterval(tick, 1000);
  }

  function stopCodeTimer() {
    if (S.codeTimer) {
      clearInterval(S.codeTimer);
      S.codeTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // ⑦ 계정
  // ---------------------------------------------------------------------------

  function renderAccount() {
    $("#acct-email").textContent = S.email || "—";
    $("#acct-roles").textContent = "스트리머";
  }

  // ---------------------------------------------------------------------------
  // 목 모드 (?mock=1) — 백엔드 없이 화면 검증
  // ---------------------------------------------------------------------------

  var M = null;

  function isoAgo(msAgo) {
    return new Date(Date.now() - msAgo).toISOString();
  }

  function mockStore() {
    if (MOCK_EMPTY) {
      return {
        page: {
          handle: "gyeideuk",
          bannerUrl: null,
          avatarUrl: null,
          bio: null,
          broadcastLinks: [],
          presetAmounts: [1000, 5000, 10000, 50000],
          minAmount: 1000,
          tickerPublic: false,
          directoryOptin: false,
          accountDisplay: "link_only",
          accountInfo: null,
          transferLinks: [],
          handleChangedAt: null
        },
        signatures: [],
        matches: [],
        candidates: [],
        blocks: [],
        device: { lastHeartbeatAt: null, online: false }
      };
    }
    return {
      page: {
        handle: "gyeideuk",
        bannerUrl: null,
        avatarUrl: null,
        bio: "계좌 입금 알림을 방송 리액션으로 바꾸는 채널입니다.",
        broadcastLinks: [{ platform: "chzzk", url: "https://chzzk.naver.com/gyeideuk" }],
        presetAmounts: [1000, 5000, 10000, 50000],
        minAmount: 1000,
        tickerPublic: true,
        directoryOptin: true,
        accountDisplay: "link_only",
        accountInfo: null,
        transferLinks: [{ type: "toss", url: "https://toss.me/gyeideuk" }],
        handleChangedAt: null
      },
      signatures: [
        { id: "s1", localSignatureId: "L1", title: "풍선 100개", webTitle: null, amount: 1000, mediaType: "image", thumbUrl: null, published: true, pinned: true, sort: 0, syncedAt: isoAgo(45 * 60000) },
        { id: "s2", localSignatureId: "L2", title: "박수 갈채", webTitle: "박수", amount: 3000, mediaType: "gif", thumbUrl: null, published: true, pinned: false, sort: 10, syncedAt: isoAgo(45 * 60000) },
        { id: "s3", localSignatureId: "L3", title: "레게노 영상", webTitle: null, amount: 5000, mediaType: "video", thumbUrl: null, published: true, pinned: true, sort: 20, syncedAt: isoAgo(45 * 60000) },
        { id: "s4", localSignatureId: "L4", title: "환호성", webTitle: null, amount: 10000, mediaType: "audio", thumbUrl: null, published: false, pinned: false, sort: 30, syncedAt: isoAgo(45 * 60000) },
        { id: "s5", localSignatureId: "L5", title: "불꽃놀이 풀버전", webTitle: "불꽃놀이", amount: 50000, mediaType: "video", thumbUrl: null, published: true, pinned: false, sort: 40, syncedAt: isoAgo(45 * 60000) }
      ],
      matches: [
        { matchId: "m1", messageId: "d1", matchedBy: "auto", senderRaw: "민수K3", amount: 5000, nickname: "민수", message: "오늘 방송 최고예요!", reportedAt: isoAgo(4 * 60000) },
        { matchId: "m2", messageId: null, matchedBy: null, senderRaw: "김철수", amount: 10000, nickname: null, message: null, reportedAt: isoAgo(18 * 60000) },
        { matchId: "m3", messageId: "d3", matchedBy: "auto", senderRaw: "지연T7", amount: 1000, nickname: "지연", message: "풍선 갑니다~", reportedAt: isoAgo(42 * 60000) },
        { matchId: "m4", messageId: "d4", matchedBy: "manual", senderRaw: "박영희", amount: 3000, nickname: "영희", message: "늦었지만 축하해요", reportedAt: isoAgo(3 * 3600000) },
        { matchId: "m5", messageId: null, matchedBy: null, senderRaw: "이름없음", amount: 2000, nickname: null, message: null, reportedAt: isoAgo(5 * 3600000) },
        { matchId: "m6", messageId: "d6", matchedBy: "auto", senderRaw: "수진M2", amount: 50000, nickname: "수진", message: "불꽃놀이 부탁해요!", reportedAt: isoAgo(26 * 3600000) }
      ],
      candidates: [
        { messageId: "c1", nickname: "철수", message: "방금 보냈어요! 확인 부탁드려요", amount: 10000, depositCode: "철수Q4", status: "expired", createdAt: isoAgo(50 * 60000), expiresAt: isoAgo(20 * 60000) },
        { messageId: "c2", nickname: "하늘", message: "응원합니다", amount: 2000, depositCode: "하늘W8", status: "pending", createdAt: isoAgo(9 * 60000), expiresAt: isoAgo(-21 * 60000) }
      ],
      blocks: [{ id: "b1", blockedValue: "악성도배러", reason: "채팅 도배", createdAt: isoAgo(3 * 86400000) }],
      device: { lastHeartbeatAt: isoAgo(25000), online: true }
    };
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function mockCall(path, opts) {
    var method = opts.method || (opts.body !== undefined ? "POST" : "GET");
    var pure = path.split("?")[0];
    var query = new URLSearchParams(path.indexOf("?") >= 0 ? path.slice(path.indexOf("?") + 1) : "");
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        try {
          resolve(mockRoute(pure, query, method, opts.body || {}));
        } catch (err) {
          reject(err);
        }
      }, 260);
    });
  }

  function mockRoute(path, query, method, body) {
    if (path === "/api/studio/page" && method === "GET") return clone(M.page);
    if (path === "/api/studio/page" && method === "PATCH") {
      if (body.handle) {
        M.page.handle = body.handle;
        M.page.handleChangedAt = new Date().toISOString();
      }
      var keys = ["bannerUrl", "avatarUrl", "bio", "broadcastLinks", "presetAmounts", "minAmount", "tickerPublic", "directoryOptin", "accountDisplay", "accountInfo", "transferLinks"];
      for (var i = 0; i < keys.length; i += 1) {
        if (Object.prototype.hasOwnProperty.call(body, keys[i])) M.page[keys[i]] = body[keys[i]];
      }
      if (typeof M.page.bio === "string" && !M.page.bio) M.page.bio = null;
      return clone(M.page);
    }
    if (path === "/api/studio/feed") {
      var total = 0;
      var count = 0;
      var dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      for (var j = 0; j < M.matches.length; j += 1) {
        if (Date.parse(M.matches[j].reportedAt) >= dayStart.getTime()) {
          total += M.matches[j].amount || 0;
          count += 1;
        }
      }
      return clone({
        handle: M.page.handle,
        items: M.matches,
        todayTotal: total,
        todayCount: count,
        online: M.device.online,
        lastHeartbeatAt: M.device.lastHeartbeatAt
      });
    }
    if (path === "/api/studio/signatures" && method === "GET") {
      return clone({ signatures: M.signatures, lastSyncedAt: M.signatures.length ? M.signatures[0].syncedAt : null });
    }
    if (path === "/api/studio/signatures" && method === "PATCH") {
      var items = body.items || [];
      for (var k = 0; k < items.length; k += 1) {
        for (var n = 0; n < M.signatures.length; n += 1) {
          if (M.signatures[n].id === items[k].id) {
            if ("published" in items[k]) M.signatures[n].published = items[k].published;
            if ("pinned" in items[k]) M.signatures[n].pinned = items[k].pinned;
            if ("webTitle" in items[k]) M.signatures[n].webTitle = items[k].webTitle;
            if ("sort" in items[k]) M.signatures[n].sort = items[k].sort;
          }
        }
      }
      M.signatures.sort(function (a, b) {
        return a.sort - b.sort;
      });
      return clone({ signatures: M.signatures, lastSyncedAt: M.signatures.length ? M.signatures[0].syncedAt : null });
    }
    if (path === "/api/studio/donations") {
      var filter = query.get("filter") || "all";
      var filtered = M.matches.filter(function (item) {
        if (filter === "unmatched") return !item.messageId;
        if (filter === "auto") return item.matchedBy === "auto";
        if (filter === "manual") return item.matchedBy === "manual";
        return true;
      });
      return clone({ items: filtered, candidates: M.candidates });
    }
    if (path === "/api/studio/manual-match" && method === "POST") {
      var target = null;
      for (var p = 0; p < M.matches.length; p += 1) {
        if (M.matches[p].matchId === body.matchId) target = M.matches[p];
      }
      var candidate = null;
      for (var q = 0; q < M.candidates.length; q += 1) {
        if (M.candidates[q].messageId === body.messageId) candidate = M.candidates[q];
      }
      if (!target || !candidate) throw new Error("대상을 찾을 수 없어요. 새로고침 후 다시 시도해 주세요.");
      target.messageId = candidate.messageId;
      target.matchedBy = "manual";
      target.nickname = candidate.nickname;
      target.message = candidate.message;
      M.candidates = M.candidates.filter(function (row) {
        return row.messageId !== candidate.messageId;
      });
      return { matchId: body.matchId, messageId: body.messageId, matchedAt: new Date().toISOString() };
    }
    if (path === "/api/studio/blocks") {
      if (method === "POST") {
        if (body.remove) {
          M.blocks = M.blocks.filter(function (row) {
            return row.blockedValue !== body.blockedValue;
          });
        } else {
          var exists = M.blocks.some(function (row) {
            return row.blockedValue === body.blockedValue;
          });
          if (!exists) {
            M.blocks.unshift({
              id: "b" + Math.random().toString(36).slice(2, 8),
              blockedValue: body.blockedValue,
              reason: body.reason || null,
              createdAt: new Date().toISOString()
            });
          }
        }
      }
      return clone({ blocks: M.blocks });
    }
    if (path === "/api/studio/relay-connect-code" && method === "POST") {
      var alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
      var code = "";
      for (var r = 0; r < 8; r += 1) {
        code += alphabet[Math.floor(Math.random() * alphabet.length)];
      }
      return { code: code, expiresAt: new Date(Date.now() + 10 * 60000).toISOString() };
    }
    throw new Error("알 수 없는 요청: " + path);
  }

  // ---------------------------------------------------------------------------
  // 초기화
  // ---------------------------------------------------------------------------

  function bindNav() {
    document.addEventListener("click", function (event) {
      var btn = event.target.closest("[data-nav]");
      if (btn) navTo(btn.getAttribute("data-nav"));
    });
    window.addEventListener("popstate", function () {
      navTo(sectionFromPath(), false);
    });
    window.addEventListener("pagehide", function () {
      stopFeed();
      stopCodeTimer();
    });
  }

  function loadShell() {
    showGate("loading");
    call("/api/studio/page")
      .then(function (data) {
        S.page = data;
        showShell();
        renderPageLink();
        navTo(sectionFromPath(), false);
      })
      .catch(function (err) {
        if (err && (err.status === 404 || err.code === "not-found")) {
          showGate("nopage");
          return;
        }
        $("#gate-error-message").textContent = (err && err.message) || "잠시 후 다시 시도해 주세요.";
        showGate("error");
      });
  }

  function init() {
    bindNav();
    bindDashboard();
    bindPageForm();
    bindShortcutCard();
    bindSignatures();
    bindDonations();
    bindRelay();
    $("#gate-retry").addEventListener("click", loadShell);

    if (MOCK) {
      $("#mock-badge").hidden = false;
      M = mockStore();
      S.email = "streamer@example.com";
      loadShell();
      return;
    }

    GW.requireSession("/studio").then(function (session) {
      if (!session) return;
      S.token = session.access_token;
      S.email = (session.user && session.user.email) || null;
      loadShell();
    });
  }

  init();
})();
