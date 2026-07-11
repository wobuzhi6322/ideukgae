# DEPLOY-RELAY-P0 — 계이득(ideukgae) 독립 릴레이 사이트 배포 런북

대상: GitHub 저장소 `wobuzhi6322/ideukgae` — **시청자 후원 메시지 릴레이 독립 사이트**
(Vercel + Supabase, v5 스티커/쿠폰 디자인). 작업은 `feat/relay-p1` 브랜치에서 진행되며
`main` 병합으로 배포에 반영된다. **새 Vercel 프로젝트**에 배포하며, 기존
gaeideuk.com 프로그램 사이트 프로젝트와는 완전히 분리된다. `.vercel/` 링크
디렉터리는 `.gitignore`로 차단돼 있다 — 기존 프로젝트로 잘못 배포되는 것을
막기 위함이니 커밋하지 말 것.

원칙: DB 마이그레이션 → 새 프로젝트 생성 → env 설정 → 스모크 → 도메인 바인딩 → 문제 시 롤백.
service key 등 비밀 값은 어디에도 붙여넣거나 출력하지 않는다 — 이 문서는 **이름만** 다룬다.

배포 전 게이트: `npm run check`(tsc + `scripts/check-web-static.cjs`) 0 실패,
`npm test`(vitest) 0 실패.

---

## 1. Supabase 마이그레이션 적용

Supabase는 **프로그램 사이트와 같은 기존 프로젝트를 공유**한다(라이선스·계정
스키마는 이미 그 프로젝트에 적용돼 있음). 새 Supabase 프로젝트를 만들지 않는다.

1. Supabase 대시보드 로그인 → 기존 프로덕션 프로젝트 선택 → **SQL Editor**.
2. `supabase/migrations-relay-p0.sql` 파일 전체를 붙여넣고 **1회 실행**.
   - 서비스 키 불필요 — 대시보드 세션 권한으로 충분하다.
   - 재실행해도 안전(모든 문장이 `create ... if not exists` / `on conflict do nothing`).
3. 확인: Table Editor에서 `bbbb_streamer_pages`, `bbbb_donation_messages`,
   `bbbb_relay_devices`, `bbbb_handle_history`, `bbbb_reserved_handles` 존재 +
   각 테이블 RLS enabled 표시 확인. Storage에 `bbbb-web-thumbs` 버킷(공개) 확인.

## 2. Vercel — 새 프로젝트 생성

⚠️ **기존 gaeideuk.com 프로그램 사이트 프로젝트에 이 저장소를 연결하지 않는다. 절대 금지.**

1. Vercel 대시보드 → **Add New → Project** → GitHub 저장소 `wobuzhi6322/ideukgae` import.
2. 프로젝트 설정:
   - **Production Branch**: `main` (작업 브랜치 `feat/relay-p1`은 병합으로만 반영)
   - **Framework Preset**: `Other`
   - **Build Command**: 없음(비워 둠)
   - **Root Directory**: 저장소 루트(변경하지 않음)
3. Deploy 전에 §3의 환경변수를 먼저 넣는다(안 넣고 배포하면 API가 500/빈 설정으로 뜬다).
4. 배포 후 발급되는 `*.vercel.app` URL로 §6 스모크를 먼저 돌린다(도메인은 §4에서 나중에).

## 3. 환경변수 (이름만 — 값 기재·출력 금지)

새 프로젝트 → Settings → Environment Variables, Production 대상. 이름 목록의
정본은 `.env.example`이며, 전부 현재 `api/` 코드의 `process.env` 사용처에서
수확한 것이다.

**필수**

- [ ] `SUPABASE_URL` — 모든 서버 함수가 사용
- [ ] `SUPABASE_SERVICE_ROLE_KEY` — 서버 함수 전용. 절대 클라이언트/로그 노출 금지
- [ ] `SUPABASE_ANON_KEY` — 브라우저용 공개 키(`api/site-config.ts`가 클라이언트에
      전달). 코드가 인식하는 폴백 이름: `SUPABASE_PUBLISHABLE_KEY`,
      `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `VITE_SUPABASE_ANON_KEY`,
      `PUBLIC_SUPABASE_ANON_KEY` — 새 프로젝트에는 정본 이름
      `SUPABASE_ANON_KEY` 하나만 설정한다
- [ ] `BBBB_PASSWORD_RESET_REDIRECT_URL` — **`https://<사이트>/login` 으로 설정**
      (도메인 확정 전에는 `https://<프로젝트>.vercel.app/login`). 재설정 메일 링크가
      로그인 페이지의 recovery 처리기로 착지해야 한다. ⚠️ 미설정 시 코드 기본값이
      구 사이트(`https://www.gaeideuk.com/`)라서 메일이 프로그램 사이트로 간다 —
      새 프로젝트에서는 사실상 필수. (`api/auth-password-reset.ts`가 읽는다)

**도메인 확정 후 (§4)**

- [ ] `SITE_ORIGIN` — 정본 오리진(예: `https://<최종도메인>`). OG 태그의 절대 URL에
      쓰인다. **설정 전까지는 SSR(`api/channel-page.ts`)이 요청 호스트
      (x-forwarded-host)에서 오리진을 유도**하므로 `*.vercel.app` 스모크 단계에서는
      비워 둬도 된다.

**선택**

- [ ] `GITHUB_REPO` — `api/site-config.ts`가 읽지만 기본값(`wobuzhi6322/BBBB`)이
      있고, 응답의 releasesUrl은 릴레이 페이지들이 사용하지 않는다. 설정 불필요.

**이 프로젝트에 넣지 않는 것** (구 프로그램 사이트 API 전용 — 이 저장소 `api/`에
사용처가 없음, `npm run check`가 사용처 0건을 확인):

- `BBBB_SHARED_ADMIN_TOKEN` — admin·shared-code API가 이 저장소에 없음
- `BBBB_OWNER_EMAILS` — 오너 예외 게이트(`_owner.ts`)가 이 저장소에 없음.
  포팅되면 `.env.example`에 추가하고 이 목록에서 필수로 승격할 것
- `SUPABASE_STORAGE_BUCKET` — 썸네일 버킷 `bbbb-web-thumbs`는 코드에 하드코딩
- `GITHUB_TOKEN` — 릴리스 다운로드 프록시 없음

## 4. 도메인 — 미확정 (스모크 후 바인딩)

도메인은 아직 결정되지 않았다. 순서:

1. **먼저 `*.vercel.app` URL로 §6 스모크 전체를 통과**시킨다.
2. 도메인 확정 시: Vercel 프로젝트 → Settings → Domains → 도메인 추가 →
   안내대로 DNS(A/CNAME) 설정 → 발급 확인.
3. 도메인 바인딩 직후 env 갱신 (둘 다):
   - `SITE_ORIGIN` = `https://<최종도메인>`
   - `BBBB_PASSWORD_RESET_REDIRECT_URL` = `https://<최종도메인>/login`
4. env 변경은 재배포해야 반영된다(Deployments → 최신 배포 → Redeploy).
5. 갱신 후 `/@handle`을 curl로 열어 OG `og:url`/`og:image`가 최종 도메인으로
   나오는지, 비밀번호 재설정 메일 링크가 최종 도메인 `/login`으로 오는지 재확인.

## 5. 프로그램 페어링 (프로그램 코드 변경 없음)

데스크톱 프로그램은 **페어링 시점에 릴레이 baseUrl을 저장**한다 — 프로그램 쪽 코드
수정이나 재배포가 필요 없다.

1. 새 사이트 `/studio` → 릴레이 연결 카드에서 연결 코드 발급.
2. 데스크톱 프로그램 관리 화면 → **관리자 릴레이 카드**에서
   **연결 코드와 함께 새 사이트 URL(baseUrl)** 을 입력한다.
3. 이후 프로그램의 pending 폴링·매칭 보고가 새 사이트로 향한다.

## 6. 배포 후 스모크

기획서 `docs/VIEWER_MESSAGE_RELAY_PLAN.md`(donation-system 저장소) §11 그대로 +
독립 사이트 선행 3항.

**선행 (독립 사이트 셸)**

- [ ] `/` 랜딩이 렌더링된다 (v5 스티커/쿠폰 디자인, 모바일 360px 가로 스크롤 없음)
- [ ] `/login` 비밀번호 재설정 메일 흐름 — 메일 발송 → 링크가 이 사이트 `/login`
      recovery 처리기로 착지 → 새 비밀번호 설정 성공
- [ ] `/@handle`을 curl로 열면 OG 태그(og:title/og:image/og:url)가 보인다

**§11 스모크 (기획서 그대로)**

- [ ] 시청자: 바로가기 접속 → 등록 → 안내 화면에 계좌·닉네임·금액·시한 표시
- [ ] 이체 후 1분 내(폴링 30초 주기) 방송 오버레이에 메시지 출력, 상태 페이지 "출력됨"
- [ ] 닉네임/금액 불일치 이체 → 일반 알림만 출력(메시지 없음), pending 유지
- [ ] 24시간 경과 → 상태 "만료", 이후 동일 입금에 미부착
- [ ] 릴레이 끊김(웹 장애) 상태에서 입금 → 방송 알림 정상(불변식)
- [ ] 라이선스 비활성 계정 → 디렉터리 미노출 + 등록 API 403
- [ ] 엔터 페이지 → 멤버 그리드 → 멤버 바로가기 직행
- [ ] 핸들 변경 → 구 주소 301 리다이렉트

## 7. 롤백

**웹(Vercel)**: 이 사이트는 독립 프로젝트라서 롤백이 단순하다 —
직전 배포로 되돌리려면 Deployments → 직전 배포 → Promote(또는 `vercel rollback`).
사이트 자체를 내려야 하면 **새 Vercel 프로젝트를 삭제**하면 끝이다. 기존
gaeideuk.com 프로그램 사이트에는 아무 영향이 없다(프로젝트가 분리돼 있으므로).

**DB(Supabase)**: PART 1(웹 플랫폼 스키마)은 프로그램 사이트와 공유되는
테이블이라 건드리지 않는다 — pending·매칭 감사 데이터가 들어 있으면 특히 금지.
이번 배포에서 새로 의미를 갖는 PART 2(핸들 이력·예약어)만 되돌리려면 SQL Editor에서:

```sql
drop table if exists public.bbbb_handle_history;
drop table if exists public.bbbb_reserved_handles;
```

⚠️ PART 2 drop은 핸들 변경 301 리다이렉트 이력을 지운다 — 운영 개시 후에는
drop 대신 웹 롤백(프로젝트 삭제/직전 배포 promote)만. 전체 드롭 목록은
`supabase/migrations-relay-p0.sql` 상단 롤백 노트 참조(운영 데이터가 없는
초기 상태에서만 사용).
