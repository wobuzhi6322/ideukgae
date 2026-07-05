# ideukgae — 스트리머 후원 플랫폼 (웹)

계좌이체 기반(수수료 0%) 후원 페이지 + 스트리머 스튜디오. 로컬 프로그램(계이득)이 입금을 감지해
방송 오버레이로 재생하고, 이 사이트가 시청자 메시지를 입금코드로 매칭한다.
결제(캐시 충전) 레일은 예약 상태(스키마만 존재, 미사용).

## 구조

- `public/` — 정적 페이지: `/`(임시 랜딩) `/@핸들`(후원 페이지) `/signup` `/login` `/me` `/channels` `/studio`
- `api/` — Vercel Functions. `_webShared.ts`가 계약 모듈(타입·입금코드 규칙), `_webServer.ts`가 서버 헬퍼
- `supabase/web-platform.sql` — 스키마(기존 계이득 Supabase 프로젝트에 적용, `bbbb_` 접두)
- 기획·계약 문서: donation-system 저장소 `docs/WEB_*.md` 5종

## 배포 (Vercel)

1. Supabase SQL Editor에서 `supabase/web-platform.sql` 실행 (기존 프로젝트, 멱등)
2. Vercel 새 프로젝트 → 이 저장소 연결 → 환경변수: `SUPABASE_URL` `SUPABASE_SERVICE_ROLE_KEY` `SUPABASE_ANON_KEY`
3. push = 자동 배포

## 개발

```bash
npm install
npm run check   # tsc --noEmit
npm test        # vitest (계약·서버 로직 단위 테스트)
```

페이지는 `?mock=1`로 백엔드 없이 화면 확인 가능.

## 유의

- 디자인은 자리표시(구 사이트 토큰) — DESIGN v2로 전면 교체 예정
- `terms.html`/`privacy.html`은 구 사이트 문서를 임시 게재 — 신규 서비스용 재작성 필요(법무 검토)
- 결제·정산·KYC 화면은 [예약] 잠금 상태
