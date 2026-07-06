# ideukgae DESIGN v2 — 클린 라이트

2026-07-06 전면 리뉴얼(사용자 지시: 로고만 유지, 전체 리뉴얼, 깔끔하게). 베이스: `public/assets/v2.css`.
구 site.css는 토큰 호환용으로만 남아 있으며 신규 페이지는 전부 v2.css를 로드한다.

## 컨셉

**"배경 위의 위계"** — 색으로 구분하지 않고 여백·굵기·그레이스케일로 구분한다.
액센트는 로고에서 온 블루 단 하나. 상태색(green/danger/yellow)은 뱃지·알림에만.
그라데이션, 블롭, 장식용 배경 금지(v1 Don'ts 승계).

**테마: 다크 기본 + 라이트 토글** (2026-07-06 사용자 확정). `:root` = 다크 토큰, `[data-theme="light"]` = 라이트 오버라이드.
전환은 `assets/theme.js`(head에서 v2.css 다음 동기 로드 — FOUC 방지)가 담당하며 저장 키는 구 사이트와 공유(`bbbb-site-theme`).
토글 버튼은 `button.theme-toggle`(class, id 없이 — id="theme-toggle"은 terms/privacy의 site.js 구형 버튼 전용). 다크에서 네이비 로고는 CSS 반전 필터로 처리.

## 토큰 (변수명은 구버전 호환 — 값만 v2. 아래는 라이트 값, 다크 기본값은 v2.css `:root` 참조)

| 용도 | 변수 | 값 |
|---|---|---|
| 본문 텍스트 | `--primary` | #191F28 |
| 보조 텍스트 | `--secondary` | #4E5968 |
| 흐린 텍스트 | `--muted` | #8B95A1 |
| 페이지 배경 | `--page` | #FFFFFF |
| 면 1/2/3 | `--surface(-2,-3)` | #F9FAFB / #F2F4F6 / #E5E8EB |
| 보더/라인 | `--border` / `--line` | #E5E8EB / #F2F4F6 |
| 액센트 | `--blue` / `--blue-2`(틴트) | #0F6BFF / #EBF2FF |
| 상태 | `--green` `--yellow` `--danger` | #12B76A / #F79009 / #F04452 |
| 라운드 | `--radius` / `--radius-lg` | 12px / 16px |

타이포: Pretendard Variable(jsdelivr), 본문 16px/1.6/-0.01em, 제목 700/-0.02em.

## 컴포넌트 규칙

- **헤더** `.site-header`: 스티키, 흰 배경 블러, 하단 1px `--line`, 좌측 로고(`gyeideuk-logo.png`, 높이 24px)만. 내비 `.site-nav`는 우측, 텍스트 링크(호버 시 surface-2 필).
- **버튼** `.btn`: 기본 44px/라운드 10px/600. `.btn-primary`(블루 솔리드) 페이지당 1~2개, 나머지는 기본(회색 필) 또는 `.btn-outline`. 파괴 동작은 `.btn-danger`(레드 틴트).
- **인풋**: filled 스타일 — surface-2 배경·투명 보더, 포커스 시 흰 배경+블루 보더+포커스 링.
- **카드** `.card`: 흰 배경 + 1px `--line` + 은은한 그림자. 카드 안에 카드 금지(승계).
- **뱃지** `.badge(-blue/-green/-danger)`: 틴트 배경 필. LIVE 뱃지는 badge-danger.
- **스켈레톤** `.skeleton`: shimmer 제공.

## 페이지 적용 원칙

1. 스타일시트 링크를 `assets/site.css` → `assets/v2.css`로 교체(그 외 페이지 자체 CSS 유지).
2. `<html data-theme="dark">` 속성·테마 토글 마크업 제거(남아 있어도 v2가 무력화하지만 정리).
3. 페이지 CSS의 하드코딩 색·다크 전제(밝은 글자색, 어두운 오버레이용 알파 흰색 등)를 토큰으로 교체.
4. DOM id·클래스·JS 계약은 유지 — 이 리뉴얼은 스타일 층만 바꾼다.
5. 모바일 360px 우선, 한국어 클리핑·가로 오버플로 금지(승계).
