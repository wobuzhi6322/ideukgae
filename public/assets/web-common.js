// =============================================================================
// 계이득 웹 후원 플랫폼 — 공통 클라이언트 헬퍼 (WS0 계약)
// 로드 순서: supabase-js CDN → web-common.js → 페이지 스크립트
// 응답 봉투 { ok, data | error } 처리와 세션 부트스트랩을 모든 페이지가 공유한다.
// 이 파일은 통합자 소유 — 트랙에서 수정 금지 (필요 시 통합자에 요청).
// =============================================================================

(function () {
  "use strict";

  const GW = (window.GW = window.GW || {});

  let configPromise = null;
  let client = null;
  let clientPromise = null;

  GW.loadConfig = function () {
    if (!configPromise) {
      configPromise = fetch("/api/site-config")
        .then((res) => res.json())
        .then((payload) => (payload && payload.ok ? payload.data : payload) || null)
        .catch(() => null);
    }
    return configPromise;
  };

  GW.getClient = function () {
    if (client) return Promise.resolve(client);
    if (!clientPromise) {
      clientPromise = GW.loadConfig().then((config) => {
        const supa = config && (config.supabase || config);
        if (!supa || !supa.url || !supa.anonKey || !window.supabase?.createClient) {
          return null;
        }
        client = window.supabase.createClient(supa.url, supa.anonKey);
        return client;
      });
    }
    return clientPromise;
  };

  GW.getSession = async function () {
    const supa = await GW.getClient();
    if (!supa) return null;
    const result = await supa.auth.getSession();
    return result?.data?.session || null;
  };

  /** 로그인 필수 페이지: 세션 없으면 /login?next=... 이동 후 null 반환 */
  GW.requireSession = async function (nextPath) {
    const session = await GW.getSession();
    if (!session) {
      const next = encodeURIComponent(nextPath || location.pathname + location.search);
      location.href = "/login?next=" + next;
      return null;
    }
    return session;
  };

  /**
   * API 호출: GW.api("/api/page/handle") / GW.api(path, {body, token, deviceKey, method})
   * 성공 시 data 반환, 실패 시 Error(message)+{code,status} throw.
   */
  GW.api = async function (path, opts) {
    opts = opts || {};
    const headers = {};
    const hasBody = opts.body !== undefined;
    if (hasBody) headers["content-type"] = "application/json";
    if (opts.token) headers.authorization = "Bearer " + opts.token;
    if (opts.deviceKey) headers["x-device-key"] = opts.deviceKey;
    const res = await fetch(path, {
      method: opts.method || (hasBody ? "POST" : "GET"),
      headers,
      body: hasBody ? JSON.stringify(opts.body) : undefined
    });
    let payload = null;
    try {
      payload = await res.json();
    } catch (err) {
      payload = null;
    }
    if (!payload || payload.ok !== true) {
      const error = new Error((payload && payload.error) || "요청에 실패했습니다 (" + res.status + ")");
      error.code = payload && payload.code;
      error.status = res.status;
      throw error;
    }
    return payload.data;
  };

  GW.escapeHtml = function (value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  };

  GW.formatKrw = function (amount) {
    return Number(amount || 0).toLocaleString("ko-KR") + "원";
  };

  /** '/@handle' 또는 '/@handle/d/:messageId' 경로 해석 */
  GW.parseHandlePath = function (pathname) {
    const m = /^\/@([a-z0-9-]+)(?:\/d\/([A-Za-z0-9-]+))?\/?$/.exec(pathname || location.pathname);
    return m ? { handle: m[1], messageId: m[2] || null } : null;
  };

  /** ?next= 안전 처리(오픈 리다이렉트 방지: 사이트 내부 경로만 허용) */
  GW.safeNext = function (fallback) {
    const raw = new URLSearchParams(location.search).get("next") || "";
    return raw.startsWith("/") && !raw.startsWith("//") ? raw : fallback || "/";
  };
})();
