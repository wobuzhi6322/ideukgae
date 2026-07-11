// =============================================================================
// 계이득 웹 — 가입·로그인 페이지 스크립트 (WSA)
// 로드 순서: supabase-js CDN → web-common.js(GW.*) → web-auth.js
// /signup: 역할 카드 → 계정 정보 → (스트리머) 핸들 발급
// /login : 이메일 로그인 → roles 기반 랜딩(/studio | /me), ?next=는 GW.safeNext
// =============================================================================

(function () {
  "use strict";

  var GW = window.GW;
  var HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/;
  var PENDING_KEY = "bbbb-web-pending-signup";

  var page = document.body ? document.body.getAttribute("data-auth-page") : null;
  if (!GW || !page) {
    return;
  }
  if (page === "signup") {
    initSignupPage();
  } else if (page === "login") {
    initLoginPage();
  }

  // ---------------------------------------------------------------------------
  // 공통
  // ---------------------------------------------------------------------------

  function setText(el, value) {
    if (el) {
      el.textContent = value == null ? "" : value;
    }
  }

  function readPending() {
    try {
      var raw = localStorage.getItem(PENDING_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  function savePending(value) {
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify(value));
    } catch (err) {
      /* 저장 실패해도 가입 흐름은 계속 */
    }
  }

  function clearPending() {
    try {
      localStorage.removeItem(PENDING_KEY);
    } catch (err) {
      /* noop */
    }
  }

  function hasStreamerRole(profile) {
    return Boolean(profile && Array.isArray(profile.roles) && profile.roles.indexOf("streamer") >= 0);
  }

  /** 로그인 완료 후 공통 랜딩: 대기 중 가입 정보 반영 → roles 기반 이동 */
  async function landAfterLogin(session) {
    var token = session.access_token;
    var pending = readPending();

    if (pending && pending.nickname) {
      try {
        await GW.api("/api/me/profile", { method: "PATCH", token: token, body: { nickname: pending.nickname } });
      } catch (err) {
        /* 닉네임 반영 실패는 랜딩을 막지 않는다 — /me 프로필에서 다시 수정 가능 */
      }
    }

    var profile = null;
    try {
      profile = await GW.api("/api/me/profile", { token: token });
    } catch (err) {
      profile = null;
    }

    if (pending && pending.role === "streamer" && !hasStreamerRole(profile)) {
      clearPending();
      location.href = "/signup?step=handle";
      return;
    }
    clearPending();

    var fallback = hasStreamerRole(profile) ? "/studio" : "/me";
    location.href = GW.safeNext(fallback);
  }

  // ---------------------------------------------------------------------------
  // /login
  // ---------------------------------------------------------------------------

  function initLoginPage() {
    var form = document.getElementById("login-form");
    var email = document.getElementById("login-email");
    var password = document.getElementById("login-password");
    var submit = document.getElementById("login-submit");
    var message = document.getElementById("login-message");
    if (!form || !email || !password) {
      return;
    }

    initPasswordReset(email);
    var recovery = initPasswordRecovery(form, message);

    // 이미 로그인된 상태면 바로 역할 랜딩으로 — 단, 재설정 메일로 돌아온
    // 복구 세션(type=recovery)이면 랜딩 대신 새 비밀번호 폼을 유지한다.
    if (!recovery.active()) {
      GW.getSession().then(function (session) {
        if (recovery.active()) {
          return null;
        }
        if (session) {
          setText(message, "이미 로그인되어 있어요. 이동 중입니다.");
          return landAfterLogin(session);
        }
        return null;
      });
    }

    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      var emailValue = email.value.trim();
      var passwordValue = password.value;
      if (!emailValue || !passwordValue) {
        setText(message, "이메일과 비밀번호를 입력해 주세요.");
        return;
      }

      if (submit) submit.disabled = true;
      setText(message, "로그인 중입니다.");
      try {
        var supa = await GW.getClient();
        if (!supa) {
          setText(message, "지금은 로그인할 수 없어요. 잠시 후 다시 시도해 주세요.");
          return;
        }
        var result = await supa.auth.signInWithPassword({ email: emailValue, password: passwordValue });
        if (result.error) {
          setText(message, result.error.message);
          return;
        }
        setText(message, "로그인되었습니다. 이동 중입니다.");
        await landAfterLogin(result.data.session);
      } catch (err) {
        setText(message, err && err.message ? err.message : "로그인에 실패했습니다.");
      } finally {
        if (submit) submit.disabled = false;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // /login — 비밀번호 재설정 메일 요청 (api/auth-password-reset: POST {email})
  // ---------------------------------------------------------------------------

  function initPasswordReset(loginEmail) {
    var toggle = document.getElementById("reset-toggle");
    var form = document.getElementById("reset-form");
    var email = document.getElementById("reset-email");
    var submit = document.getElementById("reset-submit");
    var message = document.getElementById("reset-message");
    if (!toggle || !form || !email) {
      return;
    }

    toggle.addEventListener("click", function () {
      var show = form.classList.contains("is-hidden");
      form.classList.toggle("is-hidden", !show);
      toggle.setAttribute("aria-expanded", show ? "true" : "false");
      if (show) {
        if (!email.value && loginEmail) {
          email.value = loginEmail.value.trim();
        }
        email.focus();
      }
    });

    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      var emailValue = email.value.trim();
      if (!emailValue) {
        setText(message, "이메일을 입력해 주세요.");
        email.focus();
        return;
      }

      if (submit) submit.disabled = true;
      setText(message, "재설정 메일을 보내는 중입니다.");
      try {
        await GW.api("/api/auth-password-reset", { body: { email: emailValue } });
        setText(message, "비밀번호 재설정 메일을 보냈습니다. 메일함을 확인해 주세요.");
      } catch (err) {
        setText(message, err && err.message ? err.message : "재설정 메일 전송에 실패했습니다. 잠시 후 다시 시도해 주세요.");
      } finally {
        if (submit) submit.disabled = false;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // /login — 복구 세션 랜딩(재설정 메일 링크 → URL 해시 type=recovery /
  // onAuthStateChange PASSWORD_RECOVERY). 로그인 폼을 숨기고 새 비밀번호 폼으로 전환.
  // ---------------------------------------------------------------------------

  function initPasswordRecovery(loginForm, loginMessage) {
    var form = document.getElementById("recovery-form");
    var passwordInput = document.getElementById("recovery-password");
    var confirmInput = document.getElementById("recovery-password-confirm");
    var submit = document.getElementById("recovery-submit");
    var message = document.getElementById("recovery-message");
    var active = false;

    if (!form || !passwordInput || !confirmInput) {
      return { active: function () { return false; } };
    }

    function enterRecoveryMode() {
      if (active) return;
      active = true;
      loginForm.classList.add("is-hidden");
      form.classList.remove("is-hidden");
      document.querySelectorAll(".auth-alt, .social-block, #reset-form").forEach(function (el) {
        el.classList.add("is-hidden");
      });
      var title = document.getElementById("login-title");
      if (title) title.textContent = "비밀번호 재설정";
      var lead = document.querySelector(".auth-lead");
      if (lead) lead.textContent = "새 비밀번호를 설정하면 바로 이용할 수 있어요.";
      window.setTimeout(function () {
        passwordInput.focus();
      }, 0);
    }

    var hash = location.hash || "";
    if (hash.indexOf("type=recovery") >= 0) {
      enterRecoveryMode();
    } else if (hash.indexOf("error_code=otp_expired") >= 0) {
      setText(loginMessage, "재설정 링크가 만료되었거나 이미 사용되었어요. 재설정 메일을 다시 요청해 주세요.");
    }

    // 클라이언트 생성 → supabase-js가 해시의 복구 토큰을 세션으로 교환한다.
    GW.getClient().then(function (supa) {
      if (!supa) return;
      supa.auth.onAuthStateChange(function (event) {
        if (event === "PASSWORD_RECOVERY") {
          enterRecoveryMode();
        }
      });
    });

    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      var passwordValue = passwordInput.value;
      if (passwordValue.length < 6) {
        setText(message, "비밀번호는 6자 이상이어야 해요.");
        passwordInput.focus();
        return;
      }
      if (passwordValue !== confirmInput.value) {
        setText(message, "비밀번호가 서로 달라요. 같은 비밀번호를 다시 입력해 주세요.");
        confirmInput.focus();
        return;
      }

      if (submit) submit.disabled = true;
      setText(message, "비밀번호를 변경하는 중입니다.");
      try {
        var supa = await GW.getClient();
        if (!supa) {
          setText(message, "지금은 변경할 수 없어요. 잠시 후 다시 시도해 주세요.");
          return;
        }
        var result = await supa.auth.updateUser({ password: passwordValue });
        if (result.error) {
          setText(message, result.error.message);
          return;
        }
        setText(message, "비밀번호가 변경되었습니다. 이동 중입니다.");
        var session = await GW.getSession();
        if (session) {
          await landAfterLogin(session);
        } else {
          location.href = "/login";
        }
      } catch (err) {
        setText(message, err && err.message ? err.message : "비밀번호 변경에 실패했습니다.");
      } finally {
        if (submit) submit.disabled = false;
      }
    });

    return {
      active: function () {
        return active;
      }
    };
  }

  // ---------------------------------------------------------------------------
  // /signup
  // ---------------------------------------------------------------------------

  function initSignupPage() {
    var els = {
      dots: [
        document.getElementById("step-dot-1"),
        document.getElementById("step-dot-2"),
        document.getElementById("step-dot-3")
      ],
      stepRole: document.getElementById("signup-step-role"),
      stepAccount: document.getElementById("signup-step-account"),
      stepHandle: document.getElementById("signup-step-handle"),
      roleSummary: document.getElementById("signup-role-summary"),
      form: document.getElementById("signup-form"),
      email: document.getElementById("signup-email"),
      password: document.getElementById("signup-password"),
      nickname: document.getElementById("signup-nickname"),
      back: document.getElementById("signup-back"),
      submit: document.getElementById("signup-submit"),
      message: document.getElementById("signup-message"),
      handleForm: document.getElementById("handle-form"),
      handleInput: document.getElementById("handle-input"),
      handleStatus: document.getElementById("handle-status"),
      handleSubmit: document.getElementById("handle-submit"),
      handleMessage: document.getElementById("handle-message")
    };
    if (!els.stepRole || !els.form || !els.handleForm) {
      return;
    }

    var state = {
      role: null,
      token: null,
      checkSeq: 0,
      checkTimer: null,
      handleOk: false
    };

    document.querySelectorAll(".role-card").forEach(function (card) {
      card.addEventListener("click", function () {
        selectRole(card.getAttribute("data-role"));
      });
    });
    els.back?.addEventListener("click", function () {
      showStep(1);
    });
    els.form.addEventListener("submit", onSignupSubmit);
    els.handleInput?.addEventListener("input", onHandleInput);
    els.handleForm.addEventListener("submit", onHandleSubmit);

    bootFromQuery();

    function bootFromQuery() {
      var params = new URLSearchParams(location.search);
      if (params.get("step") === "handle") {
        // 메일 인증 후 로그인 → 핸들 단계 이어가기 (세션 필수)
        state.role = "streamer";
        GW.getSession().then(function (session) {
          if (!session) {
            location.href = "/login?next=" + encodeURIComponent("/signup?step=handle");
            return;
          }
          state.token = session.access_token;
          showStep(3);
        });
        return;
      }
      var role = params.get("role");
      if (role === "streamer" || role === "viewer") {
        selectRole(role);
      }
    }

    function selectRole(role) {
      if (role !== "streamer" && role !== "viewer") {
        return;
      }
      state.role = role;
      setText(
        els.roleSummary,
        role === "streamer"
          ? "스트리머로 시작 — 가입 후 핸들을 만들고 스튜디오로 이동해요."
          : "시청자로 시작 — 가입 후 내 페이지로 이동해요."
      );
      showStep(2);
    }

    function showStep(step) {
      els.stepRole.classList.toggle("is-hidden", step !== 1);
      els.stepAccount.classList.toggle("is-hidden", step !== 2);
      els.stepHandle.classList.toggle("is-hidden", step !== 3);
      // 3단계 칩은 스트리머 흐름에서만 노출
      if (els.dots[2]) {
        els.dots[2].classList.toggle("is-hidden", state.role !== "streamer");
      }
      els.dots.forEach(function (dot, index) {
        if (!dot) return;
        var number = index + 1;
        dot.classList.toggle("is-active", number === step);
        dot.classList.toggle("is-done", number < step);
      });
      if (step === 2) {
        window.setTimeout(function () {
          els.email?.focus();
        }, 0);
      }
      if (step === 3) {
        window.setTimeout(function () {
          els.handleInput?.focus();
        }, 0);
      }
    }

    async function onSignupSubmit(event) {
      event.preventDefault();
      var emailValue = els.email.value.trim();
      var passwordValue = els.password.value;
      var nicknameValue = els.nickname.value.trim();
      if (!state.role) {
        showStep(1);
        return;
      }
      if (!emailValue) {
        setText(els.message, "이메일을 입력해 주세요.");
        els.email.focus();
        return;
      }
      if (passwordValue.length < 6) {
        setText(els.message, "비밀번호는 6자 이상이어야 해요.");
        els.password.focus();
        return;
      }
      if (!nicknameValue || nicknameValue.length > 20) {
        setText(els.message, "닉네임은 1~20자로 입력해 주세요.");
        els.nickname.focus();
        return;
      }

      if (els.submit) els.submit.disabled = true;
      setText(els.message, "가입 처리 중입니다.");
      try {
        var supa = await GW.getClient();
        if (!supa) {
          setText(els.message, "지금은 가입할 수 없어요. 잠시 후 다시 시도해 주세요.");
          return;
        }
        var result = await supa.auth.signUp({ email: emailValue, password: passwordValue });
        if (result.error) {
          setText(els.message, result.error.message);
          return;
        }

        var session = result.data.session;
        if (!session) {
          // 메일 인증이 필요한 프로젝트 설정: 로그인 후 이어서 진행
          savePending({ nickname: nicknameValue, role: state.role });
          setText(els.message, "확인 메일을 보냈어요. 메일 인증 후 로그인하면 설정이 이어집니다.");
          return;
        }

        state.token = session.access_token;
        try {
          await GW.api("/api/me/profile", {
            method: "PATCH",
            token: state.token,
            body: { nickname: nicknameValue }
          });
        } catch (err) {
          /* 닉네임 저장 실패해도 가입은 완료 — /me 프로필에서 수정 가능 */
        }

        if (state.role === "streamer") {
          setText(els.message, "");
          showStep(3);
          return;
        }
        setText(els.message, "가입이 완료되었습니다. 이동 중입니다.");
        location.href = "/me";
      } catch (err) {
        setText(els.message, err && err.message ? err.message : "가입에 실패했습니다.");
      } finally {
        if (els.submit) els.submit.disabled = false;
      }
    }

    function onHandleInput() {
      var value = els.handleInput.value.trim().toLowerCase();
      state.handleOk = false;
      if (els.handleSubmit) els.handleSubmit.disabled = true;
      setText(els.handleMessage, "");
      if (state.checkTimer) {
        window.clearTimeout(state.checkTimer);
        state.checkTimer = null;
      }

      if (!value) {
        setHandleStatus("", "");
        return;
      }
      if (!HANDLE_PATTERN.test(value)) {
        setHandleStatus("소문자 영문·숫자·하이픈으로 3~20자, 하이픈은 처음·끝 불가예요.", "is-bad");
        return;
      }

      setHandleStatus("사용 가능 여부를 확인하는 중…", "");
      state.checkTimer = window.setTimeout(function () {
        void checkHandleAvailability(value);
      }, 350);
    }

    async function checkHandleAvailability(value) {
      var seq = ++state.checkSeq;
      try {
        var token = await ensureToken();
        if (!token) return;
        var data = await GW.api("/api/onboard-streamer?handle=" + encodeURIComponent(value), { token: token });
        if (seq !== state.checkSeq) {
          return; // 더 새 입력의 검사 결과가 우선
        }
        if (data.available) {
          state.handleOk = true;
          if (els.handleSubmit) els.handleSubmit.disabled = false;
          setHandleStatus("@" + value + " 사용할 수 있어요.", "is-ok");
        } else {
          setHandleStatus(data.message || "사용할 수 없는 핸들입니다.", "is-bad");
        }
      } catch (err) {
        if (seq !== state.checkSeq) {
          return;
        }
        setHandleStatus(err && err.message ? err.message : "핸들 확인에 실패했어요. 잠시 후 다시 시도해 주세요.", "is-bad");
      }
    }

    async function onHandleSubmit(event) {
      event.preventDefault();
      var value = els.handleInput.value.trim().toLowerCase();
      if (!HANDLE_PATTERN.test(value) || !state.handleOk) {
        setText(els.handleMessage, "사용 가능한 핸들인지 먼저 확인해 주세요.");
        return;
      }

      if (els.handleSubmit) els.handleSubmit.disabled = true;
      setText(els.handleMessage, "핸들을 만드는 중입니다.");
      try {
        var token = await ensureToken();
        if (!token) return;
        await GW.api("/api/onboard-streamer", { token: token, body: { handle: value } });
        clearPending();
        setText(els.handleMessage, "완료되었습니다. 스튜디오로 이동 중입니다.");
        location.href = "/studio";
      } catch (err) {
        setText(els.handleMessage, err && err.message ? err.message : "핸들 생성에 실패했습니다.");
        if (err && err.code === "handle-taken") {
          state.handleOk = false;
          setHandleStatus("이미 사용 중인 핸들입니다. 다른 핸들을 입력해 주세요.", "is-bad");
        } else if (els.handleSubmit) {
          els.handleSubmit.disabled = false;
        }
      }
    }

    async function ensureToken() {
      if (state.token) {
        return state.token;
      }
      var session = await GW.getSession();
      if (!session) {
        location.href = "/login?next=" + encodeURIComponent("/signup?step=handle");
        return null;
      }
      state.token = session.access_token;
      return state.token;
    }

    function setHandleStatus(text, tone) {
      if (!els.handleStatus) return;
      els.handleStatus.textContent = text;
      els.handleStatus.classList.toggle("is-ok", tone === "is-ok");
      els.handleStatus.classList.toggle("is-bad", tone === "is-bad");
    }
  }
})();
