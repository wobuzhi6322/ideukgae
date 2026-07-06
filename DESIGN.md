---
version: v3
name: 계이득 ON AIR
description: Broadcast control-room design system for the gyeideuk streamer donation platform
defaultMode: dark
colors:
  primary: "#EDF1F7"
  secondary: "#9AA7B8"
  muted: "#5E6B7E"
  page: "#0A0C10"
  surface: "#10131A"
  surface-2: "#161B24"
  surface-3: "#232B38"
  border: "#232B38"
  line: "#1A202B"
  blue: "#38A4FF"
  blue-2: "#0E2338"
  green: "#24D57F"
  green-2: "#0E271B"
  yellow: "#FFC24D"
  yellow-2: "#2B2210"
  danger: "#FF3B4E"
  danger-2: "#2E1216"
  magenta: "#8F79FF"
typography:
  display:
    fontFamily: Pretendard Variable
    fontWeight: 800
    letterSpacing: "-0.03em"
    lineHeight: 1.15
  body:
    fontFamily: Pretendard Variable
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "-0.01em"
  signal:
    fontFamily: IBM Plex Mono
    usage: 금액, 입금코드, 타임코드, 뱃지 레이블, 스텝 번호 — 기계가 말하는 자리
rounded:
  control: 6px
  panel: 10px
  badge: 4px
spacing:
  section: 88px
  panel: 20px
components:
  header:
    height: 60px
    layout: logo / nav / theme-toggle
    border: bottom 1px line
  badge:
    shape: square 4px, mono uppercase 11.5px, letter-spacing 0.08em
    variants: neutral / blue / green(signal) / danger(on-air)
  button:
    height: 44px
    radius: 6px
    primary: blue solid + faint blue glow, one per view
  panel:
    radius: 10px
    border: 1px line
    bracket-corners: emphasis panels only (.frame)
  stream-frame:
    scanlines: true
    timecode: mono, ticking
    on-air: danger badge with pulsing dot
---

## Overview

계이득은 계좌이체를 방송 리액션으로 바꾸는 스트리머 후원 플랫폼이다. v3의 정체성은 **방송 컨트롤룸** —
OBS, 오디오 믹서, 송출 장비가 공유하는 시각 언어(모노스페이스 계기판, 타임코드, 시그널 레벨, ON AIR 램프)를
UI 전체의 디테일로 쓴다. 대중적인 SaaS 미니멀(v2)에서 의도적으로 이탈하되, 위계는 여전히 여백과
그레이스케일로 만든다. 장식이 아니라 **계기(instrument)** 처럼 보이는 것이 목표다.

## Colors

베이스는 스튜디오 블랙(`{colors.page}` — 장비 새시의 깊은 검정). 면은 `{colors.surface}`~`{colors.surface-3}`로
한 단계씩만 밝아진다. 액센트는 **전기 블루** `{colors.blue}` 하나 — 로고의 블루를 모니터 발광색으로 승압한 값이며,
상호작용(버튼·선택·포커스·금액)의 유일한 드라이버다. `{colors.danger}`는 **ON AIR 램프** — 라이브 상태와
파괴 동작에만. `{colors.green}`은 **시그널** — 연결됨·전달됨·레벨미터에만. 라이트 모드는 도면 종이
(#F4F6F8 계열)를 베이스로 동일 위계를 유지한다(토글 존치). 그라데이션·블롭 금지는 v1부터의 헌법.

## Typography

한글 본문은 Pretendard가 말하고, **기계가 말하는 자리는 IBM Plex Mono가 말한다** — 금액(5,000원의 숫자),
입금코드(민수K3), 타임코드, 뱃지 레이블, 스텝 번호, 시청자 수. 이 이중 음성이 v3의 캐릭터다.
디스플레이(h1~h2)는 Pretendard 800/-0.03em으로 단단하게. 모노에 한글이 섞이면 Pretendard로 폴백되므로
모노 요소에는 가급적 숫자·라틴만 넣는다.

## Layout

컨테이너 1080px, 섹션 간 `{spacing.section}`. 밀도는 v2보다 반 단계 높인다 — 계기판은 여백이 아니라
정렬로 숨 쉰다. 라벨은 12px 안팎의 모노 대문자로 패널 상단 좌측에 고정한다.

## Elevation & Depth

그림자는 거의 쓰지 않는다. 깊이는 ① 면의 단계(`surface` 스텝) ② 1px 라인 ③ 발광(전기 블루 글로우)으로 만든다.
글로우는 스트림 프레임·primary 버튼·활성 알림에만 — 컨트롤룸에서 빛나는 것은 신호뿐이다.

## Shapes

**각(角)이 기본.** 컨트롤은 `{rounded.control}`, 패널은 `{rounded.panel}`, 뱃지는 `{rounded.badge}` — pill 금지.
강조 패널은 `.frame` 클래스로 네 모서리에 브래킷(┌ ┐ └ ┘)을 단다(뷰파인더 모티프, 강조 1~2곳 한정).
스트림 프레임에는 스캔라인 오버레이를 허용한다.

## Components

- **header**: 로고(다크에서 반전 필터) + 우측 내비 + 테마 토글. 높이 60px, 하단 1px.
- **badge**: 사각 4px·모노 11.5px·자간 0.08em. neutral(회색 필) / blue(선택·정보) / green(시그널) /
  danger(ON AIR·차단). LIVE 뱃지는 `● ON AIR` 점 펄스.
- **button**: 6px 각. primary(전기 블루+은은한 글로우)는 화면당 하나, 기본은 surface 필, outline은 1px.
- **input**: filled(surface-2) 6px 각, 포커스 시 블루 1.5px 라인+글로우 링. 코드·금액 입력은 모노.
- **panel/card**: surface + 1px line + 10px. 카드 안 카드 금지.
- **stream-frame**(랜딩·데모): 그리드+스캔라인 배경, 좌상단 `● ON AIR`, 우측 모노 타임코드 틱,
  블루 글로우 테두리. 오버레이 알림은 실제 OBS 연출의 축소판(등장 오버슈트+진행바+스파크).
- **level-meter**(장식 모티프): 3~5개의 가는 세로 바, green→yellow 스텝. 연결 상태·데모 프레임에만.

## Do's and Don'ts

**Do**
- 숫자가 나오는 모든 곳(금액·코드·카운트)에 `{typography.signal}`을 적용한다.
- 상태는 뱃지로 말한다 — ON AIR(danger), 시그널(green), 정보(blue).
- 다크가 기본, 라이트 토글 유지(`assets/theme.js`, 저장 키 `bbbb-site-theme`).
- 페이지 CSS는 토큰 변수만 사용(하드코딩 색 0 원칙 유지).

**Don't**
- pill 라운드, 그라데이션 배경, 장식용 blob·오브 금지.
- 글로우 남용 금지 — 신호(파랑·빨강)가 아닌 것은 빛나지 않는다.
- 브래킷 프레임을 페이지당 2곳 초과 사용 금지.
- 한글 문장을 모노로 조판하지 않는다.
