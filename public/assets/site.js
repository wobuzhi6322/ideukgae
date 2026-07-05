const state = {
  config: null,
  release: null,
  supabase: null,
  session: null,
  account: null,
  passwordRecovery: false,
  adminLicenseTarget: null,
  adminDeviceTargetEmail: null,
  theme: "dark"
};

const themeStorageKey = "bbbb-site-theme";

const els = {
  siteStatus: document.getElementById("site-status"),
  releaseStatus: document.getElementById("release-status"),
  releaseName: document.getElementById("release-name"),
  releaseMeta: document.getElementById("release-meta"),
  releaseNotes: document.getElementById("release-notes"),
  releaseLink: document.getElementById("release-link"),
  downloadButton: document.getElementById("download-button"),
  loginForm: document.getElementById("login-form"),
  loginButton: document.getElementById("login-button"),
  signupButton: document.getElementById("signup-button"),
  resetPasswordButton: document.getElementById("reset-password-button"),
  savePasswordButton: document.getElementById("save-password-button"),
  logoutButton: document.getElementById("logout-button"),
  authMessage: document.getElementById("auth-message"),
  email: document.getElementById("email"),
  password: document.getElementById("password"),
  themeToggle: document.getElementById("theme-toggle"),
  headerAccount: document.getElementById("header-account"),
  navAccount: document.getElementById("nav-account"),
  loginDialog: document.getElementById("login-dialog"),
  dashboardMessage: document.getElementById("dashboard-message"),
  profileSection: document.getElementById("profile"),
  dashboardContent: document.getElementById("dashboard-content"),
  profileCard: document.getElementById("profile-card"),
  profileInitial: document.getElementById("profile-initial"),
  userEmail: document.getElementById("user-email"),
  accountRole: document.getElementById("account-role"),
  licensePlan: document.getElementById("license-plan"),
  licenseStatus: document.getElementById("license-status"),
  licenseCode: document.getElementById("license-code"),
  licenseLimits: document.getElementById("license-limits"),
  sharedCodeList: document.getElementById("shared-code-list"),
  deviceList: document.getElementById("device-list"),
  downloadList: document.getElementById("download-list"),
  redeemCodeForm: document.getElementById("redeem-code-form"),
  redeemCodeInput: document.getElementById("redeem-code-input"),
  redeemCodeMessage: document.getElementById("redeem-code-message"),
  redeemCodeResult: document.getElementById("redeem-code-result"),
  adminLicensePanel: document.getElementById("admin-license-panel"),
  adminLicenseForm: document.getElementById("admin-license-form"),
  adminLicenseEmail: document.getElementById("admin-license-email"),
  adminLicensePlan: document.getElementById("admin-license-plan"),
  adminLicenseStatus: document.getElementById("admin-license-status"),
  adminLicenseExpires: document.getElementById("admin-license-expires"),
  adminLicenseNotes: document.getElementById("admin-license-notes"),
  adminLicenseMessage: document.getElementById("admin-license-message"),
  adminLicenseLookup: document.getElementById("admin-license-lookup"),
  adminLicenseUpdate: document.getElementById("admin-license-update"),
  adminLicenseResult: document.getElementById("admin-license-result"),
  adminDeviceLookup: document.getElementById("admin-device-lookup"),
  adminDeviceClearAll: document.getElementById("admin-device-clear-all"),
  adminDeviceMessage: document.getElementById("admin-device-message"),
  adminDeviceResult: document.getElementById("admin-device-result"),
  adminCodeForm: document.getElementById("admin-code-form"),
  adminCodeMode: document.getElementById("admin-code-mode"),
  adminCodePlan: document.getElementById("admin-code-plan"),
  adminCodeDurationUnit: document.getElementById("admin-code-duration-unit"),
  adminCodeDurationValue: document.getElementById("admin-code-duration-value"),
  adminCodeMaxRedemptions: document.getElementById("admin-code-max-redemptions"),
  adminCodeValidUntil: document.getElementById("admin-code-valid-until"),
  adminCodeNotes: document.getElementById("admin-code-notes"),
  adminCodeMessage: document.getElementById("admin-code-message"),
  adminCodeResult: document.getElementById("admin-code-result")
};

init().catch((error) => {
  setText(els.siteStatus, `사이트 초기화 실패: ${error.message}`);
});

async function init() {
  setupTheme();
  if (!els.downloadButton || !els.releaseStatus) {
    return;
  }
  await loadConfig();
  await loadRelease();
  setupDownload();
  setupLoginDialog();
  setupRedeemCodeForm();
  setupAdminLicenseForm();
  setupAdminDevicePanel();
  setupAdminCodeForm();
  setupAuth();
}

function setupTheme() {
  const savedTheme = localStorage.getItem(themeStorageKey);
  applyTheme(savedTheme === "light" ? "light" : "dark");
  els.themeToggle?.addEventListener("click", () => {
    applyTheme(state.theme === "dark" ? "light" : "dark");
  });
}

function applyTheme(theme) {
  state.theme = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = state.theme;
  localStorage.setItem(themeStorageKey, state.theme);
  if (!els.themeToggle) {
    return;
  }
  const isDark = state.theme === "dark";
  els.themeToggle.setAttribute("aria-pressed", String(isDark));
  els.themeToggle.setAttribute("title", isDark ? "화이트 모드로 전환" : "다크 모드로 전환");
  els.themeToggle.setAttribute("aria-label", isDark ? "화이트 모드로 전환" : "다크 모드로 전환");
}

async function loadConfig() {
  const result = await getJson("/api/site-config");
  state.config = result.data;
  if (state.config.supabase.enabled) {
    setText(els.siteStatus, "계정 로그인 기능이 준비되어 있습니다.");
  } else {
    setText(els.siteStatus, "계정 로그인 기능은 준비 중입니다.");
  }
}

async function loadRelease() {
  try {
    const result = await getJson("/api/releases");
    state.release = result.data.release;
    const releasesUrl = result.data.releasesUrl || "#";
    if (els.releaseLink) {
      els.releaseLink.href = releasesUrl;
    }

    if (!state.release) {
      setText(els.releaseStatus, "아직 등록된 최신 버전이 없습니다.");
      setText(els.releaseName, "버전 없음");
      setText(els.releaseMeta, "배포 파일이 등록되면 다운로드 버튼이 활성화됩니다.");
      els.downloadButton.disabled = false;
      setText(els.downloadButton, "릴리즈 페이지 열기");
      return;
    }

    const asset = state.release.downloadAsset;
    const published = state.release.publishedAt ? formatDate(state.release.publishedAt) : "게시일 없음";
    setText(els.releaseStatus, `${state.release.tagName} 다운로드 준비됨`);
    setText(els.releaseName, state.release.name);
    setText(
      els.releaseMeta,
      asset
        ? `${published} · ${asset.name} · ${formatBytes(asset.size)}`
        : `${published} · ZIP 다운로드로 연결`
    );
    if (els.releaseLink) {
      els.releaseLink.href = state.release.htmlUrl;
    }
    els.downloadButton.disabled = false;
    setText(els.downloadButton, "Windows용 다운로드");

    if (els.releaseNotes) {
      els.releaseNotes.classList.remove("is-visible");
      setText(els.releaseNotes, "");
    }
  } catch {
    setText(els.releaseStatus, "최신 버전 확인에 실패했습니다.");
    setText(els.releaseName, "확인 실패");
    setText(els.releaseMeta, "잠시 후 다시 확인해 주세요.");
  }
}

function setupDownload() {
  els.downloadButton.addEventListener("click", () => {
    const release = state.release;
    const url = release?.downloadUrl || state.config?.github?.releasesUrl || "#";
    if (release) {
      void logDownload(release);
    }
    window.open(url, "_blank", "noopener,noreferrer");
  });
}

function setupLoginDialog() {
  els.headerAccount?.addEventListener("click", openAccountTarget);
  els.navAccount?.addEventListener("click", (event) => {
    if (state.session?.user) {
      return;
    }
    event.preventDefault();
    openLoginDialog();
  });
  document.querySelectorAll("[data-close-login]").forEach((button) => {
    button.addEventListener("click", closeLoginDialog);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeLoginDialog();
    }
  });
  window.addEventListener("hashchange", handleAccountHash);
  handleAccountHash();
}

function openAccountTarget(event) {
  event?.preventDefault();
  if (state.session?.user) {
    closeLoginDialog();
    els.profileSection?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  openLoginDialog();
}

function openLoginDialog() {
  els.loginDialog?.classList.remove("is-hidden");
  document.body.classList.add("has-modal");
  window.setTimeout(() => els.email?.focus(), 0);
}

function closeLoginDialog() {
  els.loginDialog?.classList.add("is-hidden");
  document.body.classList.remove("has-modal");
}

function handleAccountHash() {
  if (window.location.hash !== "#login") {
    return;
  }
  if (state.session?.user) {
    closeLoginDialog();
    window.setTimeout(() => els.profileSection?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
    return;
  }
  openLoginDialog();
}

function setupAuth() {
  if (!els.loginForm || !els.authMessage) {
    return;
  }
  if (!state.config?.supabase?.enabled || !window.supabase?.createClient) {
    setText(els.authMessage, "현재 계정 로그인 기능은 준비 중입니다.");
    return;
  }

  state.supabase = window.supabase.createClient(state.config.supabase.url, state.config.supabase.anonKey);
  if (isPasswordRecoveryUrl()) {
    setPasswordRecoveryMode(true);
  }
  state.supabase.auth.getSession().then(({ data }) => {
    state.session = data.session;
    if (state.passwordRecovery && data.session) {
      setPasswordRecoveryMode(true);
    }
    renderSession();
  });
  state.supabase.auth.onAuthStateChange((event, session) => {
    state.session = session;
    if (event === "PASSWORD_RECOVERY") {
      setPasswordRecoveryMode(true);
    }
    renderSession();
  });

  els.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.passwordRecovery) {
      await updatePassword();
      return;
    }
    await signIn();
  });
  els.signupButton?.addEventListener("click", signUp);
  els.resetPasswordButton?.addEventListener("click", sendPasswordResetEmail);
  els.savePasswordButton?.addEventListener("click", updatePassword);
  els.logoutButton?.addEventListener("click", signOut);
}

function setupAdminLicenseForm() {
  els.adminLicenseForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await createAdminLicense();
  });
  els.adminLicenseLookup?.addEventListener("click", lookupAdminLicenses);
  els.adminLicenseUpdate?.addEventListener("click", updateAdminLicense);
}

function setupAdminDevicePanel() {
  els.adminDeviceLookup?.addEventListener("click", () => lookupAdminDevices());
  els.adminDeviceClearAll?.addEventListener("click", clearAllAdminDevices);
  els.adminDeviceResult?.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-admin-device-delete]") : null;
    if (!button) {
      return;
    }
    void deleteAdminDevice(button.dataset.adminDeviceDelete);
  });
}

function setupRedeemCodeForm() {
  els.redeemCodeForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await redeemLicenseCode();
  });
}

function setupAdminCodeForm() {
  els.adminCodeForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await createAdminCode();
  });
  els.adminCodeDurationUnit?.addEventListener("change", syncAdminCodeDurationField);
  syncAdminCodeDurationField();
}

async function signIn() {
  setText(els.authMessage, "로그인 중입니다.");
  const { error } = await state.supabase.auth.signInWithPassword({
    email: els.email.value.trim(),
    password: els.password.value
  });
  setText(els.authMessage, error ? error.message : "로그인되었습니다.");
}

async function signUp() {
  setText(els.authMessage, "회원가입 중입니다.");
  const { error } = await state.supabase.auth.signUp({
    email: els.email.value.trim(),
    password: els.password.value
  });
  setText(els.authMessage, error ? error.message : "회원가입 요청이 완료되었습니다. 메일 인증이 필요할 수 있습니다.");
}

async function sendPasswordResetEmail() {
  const email = els.email?.value.trim();
  if (!email) {
    setText(els.authMessage, "비밀번호를 재설정할 이메일을 입력해 주세요.");
    els.email?.focus();
    return;
  }

  setText(els.authMessage, "비밀번호 재설정 메일을 보내는 중입니다.");
  const { error } = await state.supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin
  });
  setText(els.authMessage, error ? error.message : "비밀번호 재설정 메일을 보냈습니다. 메일함의 링크를 열어 새 비밀번호를 저장하세요.");
}

async function updatePassword() {
  const password = els.password?.value || "";
  if (password.length < 6) {
    setText(els.authMessage, "새 비밀번호는 6자 이상이어야 합니다.");
    els.password?.focus();
    return;
  }

  setText(els.authMessage, "새 비밀번호를 저장하는 중입니다.");
  const { error } = await state.supabase.auth.updateUser({ password });
  if (error) {
    setText(els.authMessage, error.message);
    return;
  }

  setPasswordRecoveryMode(false);
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  setText(els.authMessage, "비밀번호가 변경되었습니다.");
  renderSession();
}

async function signOut() {
  await state.supabase.auth.signOut();
  setText(els.authMessage, "로그아웃되었습니다.");
}

function renderSession() {
  const user = state.session?.user;
  if (state.passwordRecovery) {
    els.profileSection?.classList.add("is-hidden");
    setText(els.headerAccount, "비밀번호 재설정");
    if (els.navAccount) {
      els.navAccount.href = "#login";
    }
    openLoginDialog();
    return;
  }
  if (!user) {
    els.profileSection?.classList.add("is-hidden");
    els.profileCard?.classList.remove("is-hidden");
    els.dashboardContent?.classList.remove("is-hidden");
    setText(els.headerAccount, "로그인");
    if (els.navAccount) {
      els.navAccount.href = "#login";
    }
    state.account = null;
    setText(els.dashboardMessage, "계정의 라이선스, 사용 제한, 공유 코드, 등록 PC를 확인합니다.");
    clearAccountDashboard();
    return;
  }
  const wasDialogOpen = Boolean(els.loginDialog && !els.loginDialog.classList.contains("is-hidden"));
  els.profileSection?.classList.remove("is-hidden");
  els.profileCard?.classList.remove("is-hidden");
  els.dashboardContent?.classList.remove("is-hidden");
  setText(els.headerAccount, "내 프로필");
  if (els.navAccount) {
    els.navAccount.href = "#profile";
  }
  setText(els.dashboardMessage, "계정의 라이선스, 사용 제한, 공유 코드, 등록 PC를 확인합니다.");
  setText(els.userEmail, user.email || user.id);
  setText(els.profileInitial, getProfileInitial(user.email || user.id));
  closeLoginDialog();
  if (wasDialogOpen) {
    window.setTimeout(() => els.profileSection?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }
  void loadAccount();
}

function isPasswordRecoveryUrl() {
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const searchParams = new URLSearchParams(window.location.search);
  return hashParams.get("type") === "recovery" || searchParams.get("type") === "recovery";
}

function setPasswordRecoveryMode(enabled) {
  state.passwordRecovery = enabled;
  els.loginButton?.classList.toggle("is-hidden", enabled);
  els.signupButton?.classList.toggle("is-hidden", enabled);
  els.resetPasswordButton?.classList.toggle("is-hidden", enabled);
  els.savePasswordButton?.classList.toggle("is-hidden", !enabled);
  if (els.password) {
    els.password.value = "";
    els.password.autocomplete = enabled ? "new-password" : "current-password";
    els.password.placeholder = enabled ? "새 비밀번호" : "";
  }
  if (enabled) {
    openLoginDialog();
    els.password?.focus();
    setText(els.authMessage, "새 비밀번호를 입력하고 저장하세요.");
  }
}

async function loadAccount() {
  const token = state.session?.access_token;
  if (!token) {
    return;
  }
  try {
    const result = await getJsonWithAuth("/api/account", token);
    state.account = result.data;
    renderAccount(result.data);
  } catch (error) {
    setText(els.licensePlan, "확인 실패");
    setText(els.licenseStatus, error instanceof Error ? error.message : "계정 정보를 불러오지 못했습니다.");
  }
}

function renderAccount(account) {
  const profile = account.profile || {};
  const license = account.activeLicense;
  setText(els.accountRole, `역할: ${roleLabel(profile.role)}`);
  els.adminLicensePanel?.classList.toggle("is-hidden", profile.role !== "admin");

  if (!license) {
    setText(els.licensePlan, "플랜 없음");
    setText(els.licenseStatus, "관리자가 요금제를 부여하면 라이선스가 표시됩니다.");
    setText(els.licenseCode, "발급 대기");
    replaceRows(els.licenseLimits, [row("상태", "구매 확인 대기")]);
  } else {
    setText(els.licensePlan, planLabel(license.plan));
    setText(els.licenseStatus, `${statusLabel(effectiveLicenseStatus(license))} · ${license.expires_at ? `${formatDateTime(license.expires_at)}까지` : "만료일 없음"}`);
    setText(els.licenseCode, license.license_code || "-");
    replaceRows(els.licenseLimits, [
      row("시그니처", `${license.max_signatures}개`),
      row("미디어", `${license.max_media_mb}MB`),
      row("등록 PC", `${license.max_devices}대`),
      row("공유 코드", license.shared_sync_enabled ? "사용 가능" : "미포함")
    ]);
  }

  replaceRows(
    els.sharedCodeList,
    account.sharedCodes?.length
      ? account.sharedCodes.map((item) => row(item.code, sharedRoleLabel(item.role)))
      : [emptyRow("아직 연결된 공유 코드가 없습니다.")]
  );

  replaceRows(
    els.deviceList,
    account.devices?.length
      ? account.devices.map((item) => row(item.device_name || "이름 없는 PC", item.app_version || formatDate(item.last_seen_at)))
      : [emptyRow("아직 등록된 PC가 없습니다.")]
  );

  replaceRows(
    els.downloadList,
    account.downloads?.length
      ? account.downloads.map((item) => row(item.release_tag, formatDate(item.created_at)))
      : [emptyRow("다운로드 기록이 없습니다.")]
  );
}

function clearAccountDashboard() {
  setText(els.userEmail, "-");
  setText(els.profileInitial, "G");
  setText(els.accountRole, "");
  setText(els.licensePlan, "-");
  setText(els.licenseStatus, "");
  setText(els.licenseCode, "-");
  replaceRows(els.licenseLimits, []);
  replaceRows(els.sharedCodeList, []);
  replaceRows(els.deviceList, []);
  replaceRows(els.downloadList, []);
  els.adminLicensePanel?.classList.add("is-hidden");
  setText(els.adminLicenseMessage, "");
  replaceRows(els.adminLicenseResult, []);
  state.adminDeviceTargetEmail = null;
  setText(els.adminDeviceMessage, "");
  replaceRows(els.adminDeviceResult, []);
  if (els.adminDeviceClearAll) {
    els.adminDeviceClearAll.disabled = true;
  }
  setText(els.redeemCodeMessage, "");
  replaceRows(els.redeemCodeResult, []);
  setText(els.adminCodeMessage, "");
  replaceRows(els.adminCodeResult, []);
  setAdminLicenseTarget(null);
}

async function redeemLicenseCode() {
  const token = state.session?.access_token;
  if (!token) {
    setText(els.redeemCodeMessage, "로그인이 필요합니다.");
    return;
  }
  const code = els.redeemCodeInput?.value.trim();
  if (!code) {
    setText(els.redeemCodeMessage, "등록할 코드를 입력해 주세요.");
    return;
  }

  setText(els.redeemCodeMessage, "코드를 등록하는 중입니다.");
  replaceRows(els.redeemCodeResult, []);

  try {
    const result = await postJsonWithAuth("/api/license-code", token, { code });
    const license = result.data.license;
    setText(els.redeemCodeMessage, "코드가 등록되었습니다.");
    replaceRows(els.redeemCodeResult, [
      row("요금제", planLabel(license.plan)),
      row("상태", statusLabel(license.status)),
      row("만료일", license.expires_at ? formatDateTime(license.expires_at) : "만료일 없음"),
      row("라이선스 코드", license.license_code)
    ]);
    if (els.redeemCodeInput) {
      els.redeemCodeInput.value = "";
    }
    await loadAccount();
  } catch (error) {
    setText(els.redeemCodeMessage, error instanceof Error ? error.message : "코드 등록에 실패했습니다.");
  }
}

async function createAdminLicense() {
  const token = state.session?.access_token;
  if (!token) {
    setText(els.adminLicenseMessage, "관리자 로그인이 필요합니다.");
    return;
  }

  const email = els.adminLicenseEmail?.value.trim();
  if (!email) {
    setText(els.adminLicenseMessage, "사용자 이메일을 입력해 주세요.");
    return;
  }

  setText(els.adminLicenseMessage, "라이선스를 발급하는 중입니다.");
  replaceRows(els.adminLicenseResult, []);

  try {
    const result = await postJsonWithAuth("/api/admin-license", token, {
      email,
      plan: els.adminLicensePlan?.value || "starter",
      status: els.adminLicenseStatus?.value || "active",
      expiresAt: els.adminLicenseExpires?.value || undefined,
      notes: els.adminLicenseNotes?.value.trim() || undefined
    });
    const license = result.data.license;
    setText(els.adminLicenseMessage, "라이선스가 발급되었습니다.");
    setAdminLicenseTarget(license);
    replaceRows(els.adminLicenseResult, [
      row("사용자", email),
      row("요금제", planLabel(license.plan)),
      row("상태", statusLabel(license.status)),
      row("라이선스 코드", license.license_code)
    ]);
    if (state.session?.user?.email?.toLowerCase() === email.toLowerCase()) {
      await loadAccount();
    }
  } catch (error) {
    setText(els.adminLicenseMessage, error instanceof Error ? error.message : "라이선스 발급에 실패했습니다.");
  }
}

async function createAdminCode() {
  const token = state.session?.access_token;
  if (!token) {
    setText(els.adminCodeMessage, "관리자 로그인이 필요합니다.");
    return;
  }

  setText(els.adminCodeMessage, "이용권 코드를 발급하는 중입니다.");
  replaceRows(els.adminCodeResult, []);

  try {
    const result = await postJsonWithAuth("/api/admin-license-code", token, {
      mode: els.adminCodeMode?.value || "account",
      plan: els.adminCodePlan?.value || "starter",
      durationUnit: els.adminCodeDurationUnit?.value || "day",
      durationValue: els.adminCodeDurationValue?.value || "1",
      maxRedemptions: els.adminCodeMaxRedemptions?.value || "1",
      validUntil: els.adminCodeValidUntil?.value || undefined,
      notes: els.adminCodeNotes?.value.trim() || undefined
    });
    const codeInfo = result.data.codeInfo;
    setText(els.adminCodeMessage, "이용권 코드가 발급되었습니다. 원본 코드는 지금만 표시됩니다.");
    replaceRows(els.adminCodeResult, [
      row("발급 코드", result.data.code),
      row("요금제", planLabel(codeInfo.plan)),
      row("기간", durationLabel(codeInfo.duration_hours)),
      row("사용 가능 횟수", `${codeInfo.max_redemptions}회`)
    ]);
  } catch (error) {
    setText(els.adminCodeMessage, error instanceof Error ? error.message : "이용권 코드 발급에 실패했습니다.");
  }
}

async function lookupAdminLicenses() {
  const token = state.session?.access_token;
  if (!token) {
    setText(els.adminLicenseMessage, "관리자 로그인이 필요합니다.");
    return;
  }

  const email = els.adminLicenseEmail?.value.trim();
  if (!email) {
    setText(els.adminLicenseMessage, "조회할 사용자 이메일을 입력해 주세요.");
    return;
  }

  setText(els.adminLicenseMessage, "사용자 라이선스를 조회하는 중입니다.");
  replaceRows(els.adminLicenseResult, []);
  setAdminLicenseTarget(null);

  try {
    const result = await getJsonWithAuth(`/api/admin-license?email=${encodeURIComponent(email)}`, token);
    const { profile, licenses, activeLicense } = result.data;
    const target = activeLicense || licenses?.[0] || null;
    setAdminLicenseTarget(target);
    if (target) {
      fillAdminLicenseForm(target);
    }
    setText(els.adminLicenseMessage, target ? "라이선스를 조회했습니다. 값을 바꾼 뒤 수정할 수 있습니다." : "가입 계정은 있지만 라이선스가 없습니다.");
    renderAdminLicenseLookup(profile, licenses || []);
    await lookupAdminDevices({ quiet: true });
  } catch (error) {
    setText(els.adminLicenseMessage, error instanceof Error ? error.message : "사용자 조회에 실패했습니다.");
  }
}

async function updateAdminLicense() {
  const token = state.session?.access_token;
  const target = state.adminLicenseTarget;
  if (!token) {
    setText(els.adminLicenseMessage, "관리자 로그인이 필요합니다.");
    return;
  }
  if (!target) {
    setText(els.adminLicenseMessage, "먼저 사용자 조회로 수정할 라이선스를 선택해 주세요.");
    return;
  }

  setText(els.adminLicenseMessage, "기존 라이선스를 수정하는 중입니다.");
  try {
    const result = await patchJsonWithAuth("/api/admin-license", token, {
      licenseId: target.id,
      plan: els.adminLicensePlan?.value || target.plan,
      status: els.adminLicenseStatus?.value || target.status,
      expiresAt: els.adminLicenseExpires?.value || undefined,
      notes: els.adminLicenseNotes?.value.trim() || undefined
    });
    const license = result.data.license;
    setAdminLicenseTarget(license);
    setText(els.adminLicenseMessage, "기존 라이선스가 수정되었습니다.");
    replaceRows(els.adminLicenseResult, [
      row("라이선스 코드", license.license_code),
      row("요금제", planLabel(license.plan)),
      row("상태", statusLabel(license.status)),
      row("제한", `${license.max_signatures}개 / ${license.max_media_mb}MB / ${license.max_devices}대`)
    ]);
    if (state.session?.user?.id === license.user_id) {
      await loadAccount();
    }
  } catch (error) {
    setText(els.adminLicenseMessage, error instanceof Error ? error.message : "라이선스 수정에 실패했습니다.");
  }
}

function setAdminLicenseTarget(license) {
  state.adminLicenseTarget = license;
  if (els.adminLicenseUpdate) {
    els.adminLicenseUpdate.disabled = !license;
  }
}

function fillAdminLicenseForm(license) {
  if (els.adminLicensePlan) {
    els.adminLicensePlan.value = license.plan || "starter";
  }
  if (els.adminLicenseStatus) {
    els.adminLicenseStatus.value = license.status || "active";
  }
  if (els.adminLicenseExpires) {
    els.adminLicenseExpires.value = dateInputValue(license.expires_at);
  }
  if (els.adminLicenseNotes) {
    els.adminLicenseNotes.value = license.notes || "";
  }
}

function renderAdminLicenseLookup(profile, licenses) {
  const rows = [
    row("사용자", profile.email || profile.user_id),
    row("권한", roleLabel(profile.role)),
    row("라이선스 수", `${licenses.length}개`)
  ];
  if (!licenses.length) {
    rows.push(emptyRow("발급된 라이선스가 없습니다. 새 라이선스 발급을 사용할 수 있습니다."));
  } else {
    rows.push(...licenses.slice(0, 5).map((license) => row(license.license_code, `${planLabel(license.plan)} · ${statusLabel(license.status)}`)));
  }
  replaceRows(els.adminLicenseResult, rows);
}

async function lookupAdminDevices(options = {}) {
  const token = state.session?.access_token;
  if (!token) {
    setText(els.adminDeviceMessage, "관리자 로그인이 필요합니다.");
    return;
  }

  const email = els.adminLicenseEmail?.value.trim();
  if (!email) {
    setText(els.adminDeviceMessage, "조회할 사용자 이메일을 입력해 주세요.");
    return;
  }

  if (!options.quiet) {
    setText(els.adminDeviceMessage, "등록 PC를 조회하는 중입니다.");
  }
  replaceRows(els.adminDeviceResult, []);
  if (els.adminDeviceClearAll) {
    els.adminDeviceClearAll.disabled = true;
  }

  try {
    const result = await getJsonWithAuth(`/api/admin-devices?email=${encodeURIComponent(email)}`, token);
    state.adminDeviceTargetEmail = email;
    renderAdminDevices(result.data);
    setText(
      els.adminDeviceMessage,
      result.data.devices?.length ? `등록 PC ${result.data.devices.length}대를 조회했습니다.` : "등록된 PC가 없습니다."
    );
  } catch (error) {
    setText(els.adminDeviceMessage, error instanceof Error ? error.message : "등록 PC 조회에 실패했습니다.");
  }
}

async function deleteAdminDevice(deviceId) {
  const token = state.session?.access_token;
  if (!token || !deviceId) {
    setText(els.adminDeviceMessage, "삭제할 PC를 선택해 주세요.");
    return;
  }
  if (!window.confirm("선택한 PC 등록을 해제할까요?")) {
    return;
  }

  setText(els.adminDeviceMessage, "PC 등록을 해제하는 중입니다.");
  try {
    await deleteJsonWithAuth("/api/admin-devices", token, { deviceId });
    setText(els.adminDeviceMessage, "PC 등록을 해제했습니다.");
    await lookupAdminDevices({ quiet: true });
    if (state.session?.user?.email?.toLowerCase() === state.adminDeviceTargetEmail?.toLowerCase()) {
      await loadAccount();
    }
  } catch (error) {
    setText(els.adminDeviceMessage, error instanceof Error ? error.message : "PC 등록 해제에 실패했습니다.");
  }
}

async function clearAllAdminDevices() {
  const token = state.session?.access_token;
  const email = state.adminDeviceTargetEmail || els.adminLicenseEmail?.value.trim();
  if (!token || !email) {
    setText(els.adminDeviceMessage, "먼저 사용자 이메일로 등록 PC를 조회해 주세요.");
    return;
  }
  if (!window.confirm(`${email} 계정의 등록 PC를 모두 해제할까요?`)) {
    return;
  }

  setText(els.adminDeviceMessage, "전체 PC 등록을 해제하는 중입니다.");
  try {
    const result = await deleteJsonWithAuth("/api/admin-devices", token, { email, all: true });
    setText(els.adminDeviceMessage, `PC 등록 ${result.data.deletedCount}개를 해제했습니다.`);
    await lookupAdminDevices({ quiet: true });
    if (state.session?.user?.email?.toLowerCase() === email.toLowerCase()) {
      await loadAccount();
    }
  } catch (error) {
    setText(els.adminDeviceMessage, error instanceof Error ? error.message : "전체 PC 해제에 실패했습니다.");
  }
}

function renderAdminDevices(data) {
  const devices = data.devices || [];
  if (els.adminDeviceClearAll) {
    els.adminDeviceClearAll.disabled = devices.length === 0;
  }
  if (!devices.length) {
    replaceRows(els.adminDeviceResult, [emptyRow("등록된 PC가 없습니다.")]);
    return;
  }
  replaceRows(
    els.adminDeviceResult,
    devices.map((device) => adminDeviceRow(device))
  );
}

function adminDeviceRow(device) {
  const item = document.createElement("li");
  item.className = "admin-device-row";

  const copy = document.createElement("span");
  const name = document.createElement("strong");
  const detail = document.createElement("small");
  name.textContent = device.deviceName || "이름 없는 PC";
  detail.textContent = [
    device.license ? `${planLabel(device.license.plan)} · ${statusLabel(device.license.status)}` : "라이선스 정보 없음",
    device.appVersion ? `앱 ${device.appVersion}` : "",
    device.lastSeenAt ? `마지막 접속 ${formatDateTime(device.lastSeenAt)}` : "",
    device.fingerprintSuffix ? `ID ${device.fingerprintSuffix}` : ""
  ]
    .filter(Boolean)
    .join(" · ");
  copy.append(name, detail);

  const button = document.createElement("button");
  button.className = "button secondary compact-button";
  button.type = "button";
  button.dataset.adminDeviceDelete = device.id;
  button.textContent = "PC 해제";
  item.append(copy, button);
  return item;
}

function syncAdminCodeDurationField() {
  const isUnlimited = els.adminCodeDurationUnit?.value === "unlimited";
  if (els.adminCodeDurationValue) {
    els.adminCodeDurationValue.disabled = isUnlimited;
    els.adminCodeDurationValue.required = !isUnlimited;
  }
}

async function logDownload(release) {
  const token = state.session?.access_token;
  const asset = release.downloadAsset || {};
  try {
    await fetch("/api/download-events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({
        releaseTag: release.tagName,
        assetName: asset.name || "source-zip",
        assetUrl: release.downloadUrl
      })
    });
  } catch {
    // Download logging should never block the user.
  }
}

async function getJson(url) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { accept: "application/json" }
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function getJsonWithAuth(url, token) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`
    }
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function postJsonWithAuth(url, token, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function patchJsonWithAuth(url, token, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function deleteJsonWithAuth(url, token, body) {
  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

function setText(element, value) {
  if (element) {
    element.textContent = value;
  }
}

function replaceRows(target, rows) {
  if (!target) {
    return;
  }
  target.replaceChildren(...rows);
}

function row(label, value) {
  const item = document.createElement("li");
  const labelEl = document.createElement("span");
  const valueEl = document.createElement("strong");
  labelEl.textContent = label;
  valueEl.textContent = value;
  item.append(labelEl, valueEl);
  return item;
}

function emptyRow(value) {
  const item = document.createElement("div");
  item.className = "account-empty";
  item.textContent = value;
  return item;
}

function roleLabel(value) {
  if (value === "admin") {
    return "관리자";
  }
  return "사용자";
}

function planLabel(value) {
  const labels = {
    owner: "관리자",
    starter: "Starter",
    standard: "Standard",
    pro: "Pro"
  };
  return labels[value] || "알 수 없음";
}

function statusLabel(value) {
  const labels = {
    pending: "대기",
    inactive: "비활성 · 결제전",
    active: "활성",
    expired: "만료",
    suspended: "정지"
  };
  return labels[value] || "상태 확인 필요";
}

function sharedRoleLabel(value) {
  const labels = {
    owner: "소유자",
    editor: "편집자",
    viewer: "보기"
  };
  return labels[value] || "보기";
}

function getProfileInitial(value) {
  const trimmed = String(value || "G").trim();
  return (trimmed.charAt(0) || "G").toUpperCase();
}

function formatDate(value) {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(new Date(value));
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function effectiveLicenseStatus(license) {
  if (license?.status === "active" && license.expires_at && new Date(license.expires_at).getTime() < Date.now()) {
    return "expired";
  }
  return license?.status;
}

function dateInputValue(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toISOString().slice(0, 10);
}

function durationLabel(hours) {
  if (hours === null || hours === undefined) {
    return "무기한";
  }
  if (hours % 24 === 0) {
    return `${hours / 24}일`;
  }
  return `${hours}시간`;
}

function formatBytes(size) {
  if (!Number.isFinite(size) || size <= 0) {
    return "크기 정보 없음";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}
