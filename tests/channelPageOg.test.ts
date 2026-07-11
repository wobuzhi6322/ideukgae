// api/channel-page.ts — OG 메타 주입 순수 로직 단위 테스트
// (핸들러 자체는 Supabase I/O — 여기서는 injectChannelOg·ogDescription·escapeHtml·resolveSiteOrigin만)

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SITE_ORIGIN,
  escapeHtml,
  injectChannelOg,
  ogDescription,
  resolveSiteOrigin,
  type ChannelOgPage
} from "../api/channel-page.js";

const MINIMAL_TEMPLATE = [
  "<!doctype html>",
  '<html lang="ko">',
  "  <head>",
  '    <meta charset="utf-8" />',
  "    <title>채널 후원 - 계이득</title>",
  '    <meta property="og:title" content="채널 후원 - 계이득" />',
  '    <meta property="og:image" content="https://gaeideuk.com/assets/gyeideuk-logo.png" />',
  '    <meta name="twitter:card" content="summary_large_image" />',
  "  </head>",
  "  <body></body>",
  "</html>"
].join("\n");

function page(overrides: Partial<ChannelOgPage> = {}): ChannelOgPage {
  return {
    handle: "dalbit",
    displayName: "달빛토끼",
    bio: "오늘도 즐거운 방송!",
    bannerUrl: "https://cdn.example.com/banner.png",
    ...overrides
  };
}

describe("injectChannelOg", () => {
  it("페이지별 og 태그 세트를 <head>에 주입한다", () => {
    const html = injectChannelOg(MINIMAL_TEMPLATE, page());
    expect(html).toContain('<meta property="og:title" content="달빛토끼" />');
    expect(html).toContain('<meta property="og:description" content="오늘도 즐거운 방송!" />');
    expect(html).toContain('<meta property="og:image" content="https://cdn.example.com/banner.png" />');
    expect(html).toContain(`<meta property="og:url" content="${SITE_ORIGIN}/@dalbit" />`);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(html).toContain('<meta property="og:type" content="website" />');
    expect(html).toContain('<meta property="og:site_name" content="계이득" />');
    // 주입은 </head> 앞(head 내부)이어야 한다
    expect(html.indexOf('property="og:title"')).toBeLessThan(html.indexOf("</head>"));
  });

  it("템플릿의 일반 폴백 og/twitter 태그를 제거해 중복이 없다", () => {
    const html = injectChannelOg(MINIMAL_TEMPLATE, page());
    expect(html.match(/property="og:title"/g)).toHaveLength(1);
    expect(html.match(/property="og:image"/g)).toHaveLength(1);
    expect(html.match(/name="twitter:card"/g)).toHaveLength(1);
    expect(html).not.toContain('content="채널 후원 - 계이득"');
  });

  it("bio의 HTML 특수문자를 이스케이프한다(태그 주입 불가)", () => {
    const html = injectChannelOg(MINIMAL_TEMPLATE, page({ bio: `<script>alert("x")</script> & '인용'` }));
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;인용&#39;");
  });

  it("배너가 없으면 절대URL 계이득 로고로 폴백한다", () => {
    const html = injectChannelOg(MINIMAL_TEMPLATE, page({ bannerUrl: null }));
    expect(html).toContain(`<meta property="og:image" content="${SITE_ORIGIN}/assets/gyeideuk-logo.png" />`);
  });

  it("상대경로 배너는 절대URL로 변환한다", () => {
    const html = injectChannelOg(MINIMAL_TEMPLATE, page({ bannerUrl: "/assets/banner.png" }));
    expect(html).toContain(`content="${SITE_ORIGIN}/assets/banner.png"`);
  });

  it("표시명이 비면 handle로 폴백하고 <title>도 갱신한다", () => {
    const html = injectChannelOg(MINIMAL_TEMPLATE, page({ displayName: null }));
    expect(html).toContain('<meta property="og:title" content="dalbit" />');
    expect(html).toContain("<title>dalbit - 계이득</title>");
  });

  it("bio가 비면 일반 안내 문구, 길면 앞 80자만", () => {
    const short = injectChannelOg(MINIMAL_TEMPLATE, page({ bio: null }));
    expect(short).toContain("달빛토끼 채널에 계좌이체로 후원 메시지를 남겨 보세요.");

    const long = "가".repeat(200);
    expect(ogDescription(long, "달빛토끼")).toHaveLength(80);
    expect(ogDescription("  줄\n바꿈   포함  ", "x")).toBe("줄 바꿈 포함");
  });

  it("rel=icon이 없으면 파비콘을 추가하고, 있으면 중복 추가하지 않는다", () => {
    const withoutIcon = injectChannelOg(MINIMAL_TEMPLATE, page());
    expect(withoutIcon).toContain('<link rel="icon" type="image/png" href="/assets/gyeideuk-logo.png" />');

    const templateWithIcon = MINIMAL_TEMPLATE.replace(
      "</head>",
      '  <link rel="icon" type="image/png" href="/assets/gyeideuk-logo.png" />\n  </head>'
    );
    const withIcon = injectChannelOg(templateWithIcon, page());
    expect(withIcon.match(/rel="icon"/g)).toHaveLength(1);
  });

  it("실제 public/channel.html 템플릿에서도 중복 없이 주입된다", () => {
    const template = readFileSync(join(process.cwd(), "public", "channel.html"), "utf8");
    const html = injectChannelOg(template, page());
    expect(html.match(/property="og:title"/g)).toHaveLength(1);
    expect(html.match(/property="og:image"/g)).toHaveLength(1);
    expect(html.match(/property="og:site_name"/g)).toHaveLength(1);
    expect(html.match(/name="twitter:card"/g)).toHaveLength(1);
    expect(html.match(/rel="icon"/g)).toHaveLength(1);
    expect(html).toContain('<meta property="og:title" content="달빛토끼" />');
  });
});

describe("escapeHtml", () => {
  it("&, <, >, 따옴표를 모두 치환한다", () => {
    expect(escapeHtml(`a&b<c>"d"'e'`)).toBe("a&amp;b&lt;c&gt;&quot;d&quot;&#39;e&#39;");
  });
});

describe("resolveSiteOrigin", () => {
  const savedEnv = process.env.SITE_ORIGIN;

  beforeEach(() => {
    delete process.env.SITE_ORIGIN;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.SITE_ORIGIN;
    } else {
      process.env.SITE_ORIGIN = savedEnv;
    }
  });

  function req(headers: Record<string, string | string[]> = {}) {
    return { headers };
  }

  it("env SITE_ORIGIN이 있으면 최우선이고 끝 슬래시를 제거한다", () => {
    process.env.SITE_ORIGIN = "https://relay.example.com/";
    expect(resolveSiteOrigin(req({ "x-forwarded-host": "other.example.com" }))).toBe("https://relay.example.com");
  });

  it("env SITE_ORIGIN이 http(s) 형식이 아니면 무시하고 헤더로 폴백한다", () => {
    process.env.SITE_ORIGIN = "relay.example.com";
    expect(resolveSiteOrigin(req({ host: "deploy.vercel.app" }))).toBe("https://deploy.vercel.app");
  });

  it("env가 없으면 x-forwarded-host를 host보다 우선한다", () => {
    expect(resolveSiteOrigin(req({ "x-forwarded-host": "front.example.com", host: "internal.local" }))).toBe(
      "https://front.example.com"
    );
  });

  it("x-forwarded-host가 콤마 목록이면 첫 값을 쓴다", () => {
    expect(resolveSiteOrigin(req({ "x-forwarded-host": "front.example.com, proxy.internal" }))).toBe(
      "https://front.example.com"
    );
  });

  it("x-forwarded-host가 없으면 host 헤더로 https 오리진을 만든다", () => {
    expect(resolveSiteOrigin(req({ host: "deploy.vercel.app" }))).toBe("https://deploy.vercel.app");
  });

  it("env·헤더 모두 없으면 SITE_ORIGIN 상수로 폴백한다", () => {
    expect(resolveSiteOrigin(req())).toBe(SITE_ORIGIN);
  });
});
