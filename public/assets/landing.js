// 랜딩 인터랙티브 데모 — 백엔드 없음, 이 페이지 안에서만 동작
(function () {
  "use strict";

  var SIGS = [
    { emoji: "👋", title: "환영 인사", amount: 1000 },
    { emoji: "🔥", title: "풀콤보 리액션", amount: 5000 },
    { emoji: "🎵", title: "노래 한 곡 신청", amount: 10000 },
    { emoji: "🎉", title: "레전드 소원권", amount: 50000 }
  ];
  var FAKE_DONORS = ["하늘", "민수", "도라", "제이", "츄로", "감자", "루나", "백호"];
  var FAKE_MSGS = [
    "오늘 방송도 최고예요!",
    "형 이거 보고 구독 눌렀다",
    "노래 신청 갑니다~",
    "처음 왔는데 재밌네요",
    "무야호!!",
    "밥은 먹고 방송하세요"
  ];

  var overlayHost = document.getElementById("demo-overlay");
  var ticker = document.getElementById("demo-ticker");
  var nickInput = document.getElementById("demo-nick");
  var viewerEl = document.getElementById("demo-viewers");
  var lastManualAt = 0;
  var overlayTimer = null;

  function formatKrw(n) {
    return n.toLocaleString("ko-KR") + "원";
  }

  function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  function fire(name, sig, message) {
    if (!overlayHost) return;
    overlayHost.innerHTML = "";
    if (overlayTimer) clearTimeout(overlayTimer);

    var box = document.createElement("div");
    box.className = "demo-alert";
    box.innerHTML =
      '<div class="demo-alert-emoji">' + sig.emoji + "</div>" +
      '<div class="demo-alert-body">' +
      '<div class="demo-alert-head"><strong></strong><span class="demo-alert-amount"></span></div>' +
      '<div class="demo-alert-title"></div>' +
      '<div class="demo-alert-msg"></div>' +
      '<div class="demo-alert-bar"><i></i></div>' +
      "</div>";
    box.querySelector("strong").textContent = name + "님";
    box.querySelector(".demo-alert-amount").textContent = formatKrw(sig.amount);
    box.querySelector(".demo-alert-title").textContent = sig.title;
    box.querySelector(".demo-alert-msg").textContent = message;

    for (var i = 0; i < 6; i += 1) {
      var s = document.createElement("i");
      s.className = "demo-spark demo-spark-" + i;
      box.appendChild(s);
    }

    overlayHost.appendChild(box);
    overlayTimer = setTimeout(function () {
      box.classList.add("out");
      setTimeout(function () {
        if (box.parentNode) box.parentNode.removeChild(box);
      }, 350);
    }, 3400);

    if (ticker) {
      var item = document.createElement("span");
      item.className = "demo-ticker-item";
      item.textContent = name + "님이 " + formatKrw(sig.amount) + " 후원";
      ticker.insertBefore(item, ticker.firstChild);
      while (ticker.children.length > 6) ticker.removeChild(ticker.lastChild);
    }
  }

  // 카드 클릭 → 내 닉네임으로 발사
  document.querySelectorAll(".demo-sig").forEach(function (card, idx) {
    card.addEventListener("click", function () {
      lastManualAt = Date.now();
      var sig = SIGS[idx] || SIGS[0];
      var name = (nickInput && nickInput.value.trim()) || "시청자";
      document.querySelectorAll(".demo-sig.picked").forEach(function (el) {
        el.classList.remove("picked");
      });
      card.classList.add("picked");
      fire(name.slice(0, 10), sig, pick(FAKE_MSGS));
    });
  });

  // 유휴 시 자동 데모 (모션 최소화 설정이면 끔)
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduced) {
    setInterval(function () {
      if (document.hidden) return;
      if (Date.now() - lastManualAt < 12000) return;
      fire(pick(FAKE_DONORS), pick(SIGS), pick(FAKE_MSGS));
    }, 7000);
  }

  // 시청자 수 잔잔하게 흔들기
  if (viewerEl && !reduced) {
    var viewers = 1284;
    setInterval(function () {
      if (document.hidden) return;
      viewers += Math.floor(Math.random() * 11) - 4;
      viewerEl.textContent = viewers.toLocaleString("ko-KR");
    }, 2500);
  }

  // 스크롤 진입 연출
  if ("IntersectionObserver" in window && !reduced) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 }
    );
    document.querySelectorAll(".reveal").forEach(function (el) {
      io.observe(el);
    });
  } else {
    document.querySelectorAll(".reveal").forEach(function (el) {
      el.classList.add("in");
    });
  }
})();
