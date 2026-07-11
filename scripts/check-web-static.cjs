#!/usr/bin/env node
// =============================================================================
// 계이득(ideukgae) 릴레이 사이트 — 정적 계약 검사기 (standalone 저장소 전용)
//
// package.json "check" 스크립트가 tsc --noEmit 다음에 실행한다.
// 위반이 하나라도 있으면 각 건을 FAIL: 로 출력하고 exit 1.
//
// 검사 계약:
//   1. vercel.json — 파싱 가능, rewrites 배열 사용(이 저장소는 routes가 아니라
//      REWRITES 방식). /@:handle/d/:messageId → /api/channel-page (messageId·handle
//      파라미터 전달), /@:handle → /api/channel-page (handle 파라미터 전달),
//      상세(/d/) rewrite가 더 앞(구체적인 것 먼저). admin 참조 0건.
//      functions["api/channel-page.ts"].includeFiles에 public/channel.html 포함.
//   2. api/channel-page.ts · api/_webServer.ts 존재.
//   3. public/ 필수 페이지 9종 — viewport 메타, rel="icon" 파비콘,
//      /assets/v2.css 링크가 해당 페이지의 web-*.css 링크보다 먼저
//      (v2.css가 이 저장소의 디자인 베이스 — web-tokens.css·site.css는
//      존재하지 않으므로 요구하지 않는다), /assets/site.js 참조 금지.
//      * "admin" 검사 범위: href/src/action 속성값, admin.html, /api/admin 참조만
//        위반으로 본다. studio.html의 "프로그램 관리 화면(/admin)" 같은 본문 카피는
//        데스크톱 프로그램의 로컬 관리 화면 안내(페어링 절차)라서 정상이다.
//   4. api/ 하위 어떤 파일도 이 저장소에 존재하지 않는 프로그램 사이트 모듈
//      (admin*, shared-code, shared-profile, account, devices/register, releases)을
//      import하지 않는다.
//   5. (정보성) api/ 안 BBBB_SHARED_ADMIN_TOKEN 사용처 스캔 — 없으면 env 불필요 안내.
// =============================================================================

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const failures = [];
const infos = [];

function fail(message) {
  failures.push(message);
}

function info(message) {
  infos.push(message);
}

function readTextIfExists(relPath) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, "utf8");
}

// ---------------------------------------------------------------------------
// 1. vercel.json — rewrites 방식
// ---------------------------------------------------------------------------

function checkVercelJson() {
  const raw = readTextIfExists("vercel.json");
  if (raw === null) {
    fail("vercel.json: 파일이 없습니다");
    return;
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    fail(`vercel.json: JSON 파싱 실패 — ${err.message}`);
    return;
  }

  // admin 참조 금지 — rewrites 배열 포함 파일 전체를 본다 (functions 키 등 포함).
  const adminLine = raw.split(/\r?\n/).find((line) => /admin/i.test(line));
  if (adminLine !== undefined) {
    fail(`vercel.json: admin 참조가 남아 있습니다 — "${adminLine.trim()}"`);
  }

  const rewrites = Array.isArray(json.rewrites) ? json.rewrites : null;
  if (!rewrites) {
    fail("vercel.json: rewrites 배열이 없습니다 (이 저장소는 rewrites 방식)");
  } else {
    const isHandleSource = (r) =>
      r && typeof r.source === "string" && r.source.startsWith("/@");
    const isDetailSource = (r) =>
      isHandleSource(r) && (r.source.includes("/d/") || r.source.includes(":messageId"));

    // /@:handle/d/:messageId → /api/channel-page
    const detailIdx = rewrites.findIndex((r) => isDetailSource(r));
    if (detailIdx === -1) {
      fail('vercel.json: "/@:handle/d/:messageId" (후원 메시지 상세) rewrite가 없습니다');
    } else {
      const detail = rewrites[detailIdx];
      if (!detail.source.includes(":handle") || !detail.source.includes(":messageId")) {
        fail(
          `vercel.json: 상세 rewrite source에 :handle·:messageId 파라미터가 없습니다 (현재: ${JSON.stringify(detail.source)})`
        );
      }
      if (
        typeof detail.destination !== "string" ||
        !detail.destination.startsWith("/api/channel-page")
      ) {
        fail(
          `vercel.json: /@handle/d/ rewrite destination이 /api/channel-page가 아닙니다 (현재: ${JSON.stringify(detail.destination)})`
        );
      } else if (
        detail.destination.includes("?") &&
        (!detail.destination.includes("handle=") || !detail.destination.includes("messageId="))
      ) {
        // 쿼리를 명시했다면 handle·messageId를 넘겨야 한다.
        // (쿼리가 없으면 Vercel이 미사용 source 파라미터를 자동으로 query에 붙인다.)
        fail(
          `vercel.json: 상세 rewrite destination 쿼리에 handle=·messageId= 전달이 없습니다 (현재: ${JSON.stringify(detail.destination)})`
        );
      }
    }

    // /@:handle → /api/channel-page
    const handleIdx = rewrites.findIndex((r) => isHandleSource(r) && !isDetailSource(r));
    if (handleIdx === -1) {
      fail('vercel.json: "/@:handle" (채널 페이지) rewrite가 없습니다');
    } else {
      const handle = rewrites[handleIdx];
      if (!handle.source.includes(":handle")) {
        fail(
          `vercel.json: 채널 rewrite source에 :handle 파라미터가 없습니다 (현재: ${JSON.stringify(handle.source)})`
        );
      }
      if (
        typeof handle.destination !== "string" ||
        !handle.destination.startsWith("/api/channel-page")
      ) {
        fail(
          `vercel.json: /@handle rewrite destination이 /api/channel-page가 아닙니다 (현재: ${JSON.stringify(handle.destination)})`
        );
      } else if (handle.destination.includes("?") && !handle.destination.includes("handle=")) {
        fail(
          `vercel.json: 채널 rewrite destination 쿼리에 handle= 전달이 없습니다 (현재: ${JSON.stringify(handle.destination)})`
        );
      }
    }

    // 구체적인 rewrite 먼저 — 상세(/d/)가 /@:handle보다 앞이어야 한다.
    if (detailIdx !== -1 && handleIdx !== -1 && detailIdx > handleIdx) {
      fail(
        `vercel.json: /@:handle/d/:messageId rewrite(${detailIdx}번째)가 /@:handle(${handleIdx}번째)보다 뒤에 있습니다 — 구체적인 것을 먼저 두세요`
      );
    }
  }

  // functions["api/channel-page.ts"].includeFiles 에 public/channel.html 포함
  const fn = json.functions && json.functions["api/channel-page.ts"];
  if (!fn) {
    fail('vercel.json: functions["api/channel-page.ts"] 항목이 없습니다');
  } else {
    const inc = fn.includeFiles;
    const includesTemplate =
      inc === "public/channel.html" ||
      (typeof inc === "string" &&
        inc.split(",").map((s) => s.trim()).includes("public/channel.html")) ||
      (Array.isArray(inc) && inc.includes("public/channel.html"));
    if (!includesTemplate) {
      fail(
        `vercel.json: functions["api/channel-page.ts"].includeFiles에 public/channel.html이 없습니다 (현재: ${JSON.stringify(inc)})`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 2. 필수 api 파일 존재
// ---------------------------------------------------------------------------

function checkRequiredApiFiles() {
  for (const rel of ["api/channel-page.ts", "api/_webServer.ts"]) {
    if (!fs.existsSync(path.join(ROOT, rel))) {
      fail(`${rel}: 필수 파일이 없습니다`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. public/ 페이지 계약
// ---------------------------------------------------------------------------

const REQUIRED_PAGES = [
  "index.html",
  "login.html",
  "signup.html",
  "channel.html",
  "channels.html",
  "me.html",
  "studio.html",
  "terms.html",
  "privacy.html"
];

function checkPage(pageName) {
  const rel = `public/${pageName}`;
  const html = readTextIfExists(rel);
  if (html === null) {
    fail(`${rel}: 파일이 없습니다 (최종 상태 필수 페이지)`);
    return;
  }

  if (!/<meta\s[^>]*name="viewport"/i.test(html)) {
    fail(`${rel}: <meta name="viewport"> 가 없습니다`);
  }

  if (!/<link\s[^>]*rel="icon"/i.test(html)) {
    fail(`${rel}: <link rel="icon"> 파비콘이 없습니다`);
  }

  // v2.css가 디자인 베이스 — 모든 필수 페이지가 링크해야 하고, 페이지 전용
  // web-*.css보다 먼저 와야 한다. (web-tokens.css·site.css는 이 저장소에
  // 없으므로 요구하지 않는다.)
  // 예외: index.html은 자체 완결 v5 랜딩(d-playful 정본, 인라인 토큰) —
  // v2.css를 강제로 링크하면 전역 태그 스타일이 랜딩을 덮어써 정본이 깨진다.
  const v2Exempt = rel === "public/index.html";
  const v2Idx = html.indexOf("/assets/v2.css");
  if (v2Idx === -1 && !v2Exempt) {
    fail(`${rel}: /assets/v2.css 링크가 없습니다 (v2.css가 디자인 베이스)`);
  }
  const webCssMatch = /\/assets\/web-[a-z0-9-]+\.css/i.exec(html);
  if (v2Idx !== -1 && webCssMatch !== null && webCssMatch.index < v2Idx) {
    fail(
      `${rel}: /assets/v2.css는 ${webCssMatch[0]}보다 먼저 링크해야 합니다 (베이스 → 페이지 전용 순서)`
    );
  }

  if (html.includes("/assets/site.js")) {
    fail(`${rel}: 구 프로그램 사이트 /assets/site.js 를 참조합니다`);
  }

  // 사이트 admin 화면 참조 금지 — 링크 표면(href/src/action)과 admin.html,
  // /api/admin 만 검사한다. 본문 카피의 "프로그램 관리 화면(/admin)"은
  // 데스크톱 프로그램 로컬 화면 안내라서 위반이 아니다(파일 상단 주석 참조).
  const attrRe = /(?:href|src|action)\s*=\s*"([^"]*)"/gi;
  let attrMatch;
  while ((attrMatch = attrRe.exec(html)) !== null) {
    if (/admin/i.test(attrMatch[1])) {
      fail(`${rel}: admin을 가리키는 링크/리소스 참조 — ${attrMatch[0]}`);
    }
  }
  if (/admin\.html/i.test(html)) {
    fail(`${rel}: 존재하지 않는 admin.html 을 참조합니다`);
  }
  if (/\/api\/admin/i.test(html)) {
    fail(`${rel}: 존재하지 않는 /api/admin* 엔드포인트를 참조합니다`);
  }
}

// ---------------------------------------------------------------------------
// 4. api/ 임포트 스캔 — 이 저장소에 없는 모듈 참조 금지
// ---------------------------------------------------------------------------

function walkTsFiles(dirAbs, acc) {
  for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    const abs = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(abs, acc);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      acc.push(abs);
    }
  }
  return acc;
}

function extractImportSpecifiers(source) {
  const specs = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g, // import ... from / export ... from
    /\bimport\s+["']([^"']+)["']/g, // side-effect import
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) specs.push(m[1]);
  }
  return specs;
}

// 프로그램 사이트 전용 모듈(이 저장소에 존재하지 않음) — 세그먼트 단위 매치
// (확장자 제거 후 비교)
const MISSING_SEGMENTS = new Set(["shared-code", "shared-profile", "account", "releases"]);

function isMissingModule(spec) {
  const segments = spec
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== "." && s !== "..")
    .map((s) => s.replace(/\.(?:js|mjs|cjs|ts)$/i, ""));
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (MISSING_SEGMENTS.has(seg)) return true;
    if (/^_?admin/i.test(seg)) return true; // admin, admin-*, _admin* 전부
    if (seg === "devices" && i + 1 < segments.length && /^register/i.test(segments[i + 1])) {
      return true; // devices/register
    }
  }
  return false;
}

function checkApiImports() {
  const apiDir = path.join(ROOT, "api");
  if (!fs.existsSync(apiDir)) {
    fail("api/: 디렉터리가 없습니다");
    return [];
  }
  const files = walkTsFiles(apiDir, []);
  for (const abs of files) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
    const source = fs.readFileSync(abs, "utf8");
    for (const spec of extractImportSpecifiers(source)) {
      if (isMissingModule(spec)) {
        fail(`${rel}: 이 저장소에 없는 모듈을 import합니다 — "${spec}"`);
      }
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// 5. (정보성) BBBB_SHARED_ADMIN_TOKEN 사용처 스캔
// ---------------------------------------------------------------------------

function checkSharedAdminToken(apiFiles) {
  const usages = [];
  for (const abs of apiFiles) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
    const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (line.includes("BBBB_SHARED_ADMIN_TOKEN")) {
        usages.push(`${rel}:${idx + 1}`);
      }
    });
  }
  if (usages.length === 0) {
    info("BBBB_SHARED_ADMIN_TOKEN: api/ 사용처 없음 — 새 Vercel 프로젝트에 이 env 변수는 불필요");
  } else {
    info(`BBBB_SHARED_ADMIN_TOKEN: 사용처 발견 — ${usages.join(", ")} (env 유지 필요)`);
  }
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------

checkVercelJson();
checkRequiredApiFiles();
for (const page of REQUIRED_PAGES) checkPage(page);
const apiFiles = checkApiImports();
checkSharedAdminToken(apiFiles);

for (const line of infos) console.log(`INFO: ${line}`);

if (failures.length > 0) {
  for (const line of failures) console.error(`FAIL: ${line}`);
  console.error(`\ncheck-web-static: ${failures.length}건 위반 — 위 FAIL 항목을 수정하세요.`);
  process.exit(1);
}

console.log(
  `check-web-static: OK — vercel.json rewrites, 페이지 ${REQUIRED_PAGES.length}종 계약, api 임포트(${apiFiles.length}파일) 모두 통과`
);
