// 테마 부트스트랩 + 토글 (통합자 소유 — 트랙 수정 금지)
// <head>에서 v2.css 다음에 동기 로드해야 첫 페인트 깜빡임(FOUC)이 없다.
// 저장 키는 구 사이트와 동일(bbbb-site-theme) — terms/privacy(site.js)와 자동 동기화.
(function () {
  "use strict";

  var KEY = "bbbb-site-theme";
  var saved = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch (err) {}
  // D 디자인: 크림 라이트가 기본, 다크는 딥네이비 나이트
  document.documentElement.setAttribute("data-theme", saved === "dark" ? "dark" : "light");

  function wire() {
    // id="theme-toggle"(terms/privacy 구형 버튼)은 site.js가 관리 — 이중 바인딩 방지로 건너뜀
    var buttons = document.querySelectorAll(".theme-toggle:not(#theme-toggle)");
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].addEventListener("click", function () {
        var next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
        document.documentElement.setAttribute("data-theme", next);
        try {
          localStorage.setItem(KEY, next);
        } catch (err) {}
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
