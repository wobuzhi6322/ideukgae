---
version: v5
name: 계이득 후원 사이트 — D 스티커
description: Playful sticker/coupon design system for the ideukgae donation platform (matches gaeideuk.com)
defaultMode: light
colors:
  primary: "#1D2B57"
  secondary: "#4A5680"
  muted: "#8B91A8"
  ink: "#17265C"
  page: "#FFF7EA"
  surface: "#FFFDF6"
  surface-2: "#F6EFDD"
  surface-3: "#EADFC4"
  border: "#E3D9C2"
  line: "#EFE7D2"
  blue: "#2E53FF"
  blue-2: "#E5EBFF"
  yellow: "#FFCE31"
  yellow-2: "#FFF3CC"
  green: "#14B871"
  danger: "#F0435C"
typography:
  display:
    fontFamily: Jua
    usage: h1·h2, 큰 숫자, 도장 문구 — 놀이의 목소리
  body:
    fontFamily: Pretendard Variable
    fontSize: 16px
    lineHeight: 1.6
    letterSpacing: "-0.01em"
rounded:
  control: 12px
  panel: 20px
  badge: 9px
spacing:
  section: 88px
components:
  button:
    border: 2px solid ink
    shadow: "3px 3px 0 ink (hover: -2px 리프트 + 5px 5px 0)"
    primary: 전기 블루, 화면당 1~2개
  card:
    border: 2px solid ink
    shadow: "5px 5px 0 rgba(ink, .22)"
  badge:
    shape: 스티커(9px 라운드 + 1.5px 잉크 보더 + 틴트 배경)
  coupon:
    usage: 요금·다운로드·시그니처 카드 — 절취선(dashed)·펀치홀·도장 스탬프 허용
  theme:
    default: 크림 라이트
    dark: 딥네이비 나이트(#0B1130) — assets/theme.js 토글, 키 bbbb-site-theme
---

## Overview

후원을 "분식집 메뉴판에서 쿠폰 뽑기"로 만드는 밝고 위트 있는 세계 — gaeideuk.com(프로그램 사이트)과
동일한 D 디자인 언어를 후원 플랫폼에 적용한다. 정체성은 세 가지: **크림 종이 위의 스티커**(두꺼운 잉크
보더+하드섀도), **말맛 있는 직설 카피**("내 후원인데, 왜 남이 떼 가요?"), **살아있는 데모**. 랜딩(index.html)은
d-playful 원본이 정본이며 자체완결이다.

## Colors

크림(`{colors.page}`)이 종이, 네이비 잉크(`{colors.ink}`)가 펜. 전기 블루(`{colors.blue}`)는 행동(버튼·선택·링크),
햇살 옐로(`{colors.yellow}`)는 강조 스티커와 하이라이트. 그린=성공/전달됨, 레드=라이브·위험·차단.
다크는 밤의 분식집 — 딥네이비 바탕에 크림 잉크, 문법은 동일. 그라데이션·블롭 금지(전통 유지).

## Typography

Jua가 제목과 큰 숫자에서 놀이의 목소리를 내고, Pretendard가 본문을 든든하게 받친다.
모노스페이스는 쓰지 않는다(v3 폐기) — 금액·코드는 Pretendard 800으로 굵게.

## Layout

컨테이너 1080px, 섹션 88px. 요소를 ±1~2.5° 살짝 기울이는 것 허용(스티커 감성) — 페이지당 2~3곳,
본문 텍스트는 기울이지 않는다.

## Elevation & Depth

그림자는 전부 **블러 0 오프셋 하드섀도**다. 컨트롤 3px, 패널 5px. 호버는 -2px 리프트+그림자 확대,
액티브는 +1px 눌림. 부드러운 블러 그림자 금지.

## Shapes

큰 라운드(12/20px) + 두꺼운 잉크 보더(2px)가 기본. 쿠폰(절취선 dashed·펀치홀), 도장 스탬프(이중 링+
mix-blend multiply), 별/코인 CSS 도형 장식 허용 — 페이지당 절제. pill은 뱃지 한정 9px 라운드로 대체.

## Components

- **버튼**: `{components.button}` — 기본은 크림 surface, primary만 블루.
- **카드/패널**: 잉크 보더+하드섀도. 카드 안 카드 금지.
- **뱃지**: 스티커형. 전달됨=green 틴트, 확인 중=blue 틴트, LIVE·차단=danger 틴트.
- **인풋**: 2px 잉크 보더 + 12px 라운드, 포커스 시 블루 보더+링.
- **쿠폰**: 시그니처 메뉴판 카드·요금 카드의 정본 형태 — 금액은 크게(Jua), 절취선으로 본문과 분리.
- **테마 토글**: `.theme-toggle`(class) — theme.js가 관리, 크림 기본.

## Do's and Don'ts

**Do**: 토큰만 사용(하드코딩 0 원칙 유지) · 카피에 위트(단 기능 안내는 명료하게) · 모바일 360px 우선 ·
`prefers-reduced-motion` 존중 · DOM id/클래스/JS 계약 보존(리스킨은 스타일 층만).
**Don't**: 그라데이션·블롭·블러 그림자 · 모노스페이스 · 본문 기울임 · 도장/기울임 남발(페이지당 2~3곳) ·
관리자·정산 등 기능 화면에서 장식 과다(스티커는 마케팅 표면에 집중).
