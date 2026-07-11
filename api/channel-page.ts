// GET /@:handle — SSR 채널 페이지 셸 (VIEWER_MESSAGE_RELAY_PLAN §6, 부록 A 3(d))
// public/channel.html 템플릿을 읽어 페이지별 OG 메타태그(카톡·디스코드 미리보기
// 카드)를 <head>에 주입해 서빙한다. 본문 렌더링은 기존 web-channel.js(클라이언트)
// 그대로 — 이 함수는 셸+메타만 담당한다.
// - 미지의 핸들: 템플릿 원본 서빙(클라이언트 JS가 404 UI 처리)
// - 핸들 변경 이력(bbbb_handle_history): 구 핸들 → 301 /@{new_handle}
//   (테이블이 아직 없을 수 있음 — 조회 실패는 무시하고 원본 서빙으로 폴백)
// vercel.json: functions["api/channel-page.ts"].includeFiles = "public/channel.html"

import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { TABLES, serviceClient } from "./_webServer.js";

// 도메인 미확정 — 최후 폴백 상수(중립 플레이스홀더). 실제 오리진은 resolveSiteOrigin()이 요청마다 결정한다.
export const SITE_ORIGIN = "https://ideukgae.vercel.app";
const FALLBACK_OG_IMAGE_PATH = "/assets/gyeideuk-logo.png";
const FAVICON_TAG = `<link rel="icon" type="image/png" href="/assets/gyeideuk-logo.png" />`;

/**
 * 사이트 정본 오리진 결정 (도메인 확정 전까지 배포 오리진이 정본):
 * 1) env SITE_ORIGIN — 정본 도메인(http(s):// 필수, 끝 슬래시 제거)
 * 2) x-forwarded-host(프록시) 또는 host 헤더 — https://{host} (콤마 목록이면 첫 값)
 * 3) SITE_ORIGIN 상수 폴백
 */
export function resolveSiteOrigin(req: Pick<IncomingMessage, "headers">): string {
  const envOrigin = (process.env.SITE_ORIGIN ?? "").trim().replace(/\/+$/, "");
  if (/^https?:\/\//.test(envOrigin)) return envOrigin;

  const rawHost = req.headers["x-forwarded-host"] ?? req.headers.host;
  const host = (Array.isArray(rawHost) ? rawHost[0] : rawHost ?? "").split(",")[0].trim();
  if (host) return `https://${host}`;

  return SITE_ORIGIN;
}

// ---------------------------------------------------------------------------
// 순수 로직 — OG 주입 (tests/channelPageOg.test.ts에서 단위 테스트)
// ---------------------------------------------------------------------------

export type ChannelOgPage = {
  handle: string;
  /** 표시명(웹 프로필 닉네임). 비면 handle로 폴백 */
  displayName: string | null;
  bio: string | null;
  bannerUrl: string | null;
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** bio 앞 80자 — 공백 정리 후 자름. 비면 일반 안내 문구 */
export function ogDescription(bio: string | null, title: string): string {
  const cleaned = (bio ?? "").replace(/\s+/g, " ").trim();
  if (cleaned) return cleaned.slice(0, 80);
  return `${title} 채널에 계좌이체로 후원 메시지를 남겨 보세요.`;
}

function absoluteUrl(url: string, origin: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return url.startsWith("/") ? `${origin}${url}` : `${origin}/${url}`;
}

/**
 * 템플릿 <head>에 페이지별 OG 메타태그를 주입한다.
 * 템플릿에 이미 있는 일반(폴백) og/twitter 메타는 제거 후 페이지별 태그로 대체
 * (중복 og:title은 스크레이퍼마다 해석이 달라 카드가 깨질 수 있다).
 * rel="icon"이 없으면 계이득 로고 파비콘도 추가.
 */
export function injectChannelOg(templateHtml: string, page: ChannelOgPage, origin: string = SITE_ORIGIN): string {
  const title = (page.displayName ?? "").trim() || page.handle;
  const description = ogDescription(page.bio, title);
  const image = page.bannerUrl ? absoluteUrl(page.bannerUrl, origin) : `${origin}${FALLBACK_OG_IMAGE_PATH}`;
  const pageUrl = `${origin}/@${encodeURIComponent(page.handle)}`;

  let html = templateHtml.replace(/[ \t]*<meta\s+(?:property="og:|name="twitter:)[^>]*\/?>\s*\n?/g, "");

  const tags = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="계이득" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:image" content="${escapeHtml(image)}" />`,
    `<meta property="og:url" content="${escapeHtml(pageUrl)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`
  ];
  if (!/<link[^>]+rel="icon"/.test(html)) {
    tags.push(FAVICON_TAG);
  }

  html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)} - 계이득</title>`);
  return html.replace("</head>", `    ${tags.join("\n    ")}\n  </head>`);
}

// ---------------------------------------------------------------------------
// 핸들러
// ---------------------------------------------------------------------------

const HANDLE_HISTORY_TABLE = "bbbb_handle_history";
const NEW_HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/;

function readTemplate(): string {
  return readFileSync(join(process.cwd(), "public", "channel.html"), "utf8");
}

function sendHtml(req: IncomingMessage, res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=0, s-maxage=60"
  });
  res.end(req.method === "HEAD" ? undefined : html);
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!["GET", "HEAD"].includes(req.method || "")) {
    res.writeHead(405, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end("method-not-allowed");
    return;
  }

  const template = readTemplate();
  const url = new URL(req.url ?? "/", "http://localhost");
  const handle = url.searchParams.get("handle")?.trim().toLowerCase() ?? "";
  const messageId = url.searchParams.get("messageId")?.trim() ?? "";
  if (!handle) {
    sendHtml(req, res, template);
    return;
  }

  let page: ChannelOgPage | null = null;
  let ownerUserId: string | null = null;
  try {
    const supabase = serviceClient();
    const pageResult = await supabase
      .from(TABLES.pages)
      .select("handle,owner_user_id,banner_url,bio,status")
      .eq("handle", handle)
      .maybeSingle();
    const row = pageResult.error
      ? null
      : (pageResult.data as {
          handle: string;
          owner_user_id: string;
          banner_url: string | null;
          bio: string | null;
          status: string;
        } | null);
    if (row && row.status === "active") {
      page = { handle: row.handle, displayName: null, bio: row.bio, bannerUrl: row.banner_url };
      ownerUserId = row.owner_user_id;
    }

    if (!page) {
      // 구 핸들 301 (핸들 변경 90일 리다이렉트 — §6.2). 테이블 미존재 가능 → 실패 시 폴백.
      try {
        const historyResult = await supabase
          .from(HANDLE_HISTORY_TABLE)
          .select("new_handle")
          .eq("old_handle", handle)
          .maybeSingle();
        const newHandle = historyResult.error
          ? null
          : (historyResult.data as { new_handle: string | null } | null)?.new_handle;
        if (newHandle && NEW_HANDLE_PATTERN.test(newHandle) && newHandle !== handle) {
          const suffix = messageId ? `/d/${encodeURIComponent(messageId)}` : "";
          res.writeHead(301, {
            location: `/@${newHandle}${suffix}`,
            "cache-control": "public, max-age=0, s-maxage=60"
          });
          res.end();
          return;
        }
      } catch {
        // 이력 조회 실패는 원본 서빙으로 폴백
      }
      sendHtml(req, res, template);
      return;
    }

    // 표시명(웹 프로필 닉네임) — 실패해도 handle 폴백으로 서빙
    try {
      const profileResult = await supabase
        .from(TABLES.profiles)
        .select("nickname")
        .eq("user_id", ownerUserId)
        .maybeSingle();
      const nickname = profileResult.error ? null : (profileResult.data as { nickname: string } | null)?.nickname;
      if (nickname) page = { ...page, displayName: nickname };
    } catch {
      // 닉네임 없이 진행
    }

    sendHtml(req, res, injectChannelOg(template, page, resolveSiteOrigin(req)));
  } catch {
    // Supabase 접근 자체가 실패해도 셸은 서빙한다(클라이언트가 에러 UI 처리)
    sendHtml(req, res, template);
  }
}
