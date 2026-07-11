-- =============================================================================
-- 계이득 웹 후원 플랫폼 — ideukgae(feat/relay-p1 → main) 통합 마이그레이션
-- (단일 idempotent 스크립트)
--
-- 적용 대상 : 이 사이트(ideukgae)가 바라보는 프로덕션 Supabase 프로젝트
--             (라이선스·계정 스키마가 이미 적용된 프로젝트 — 해당 스키마 정본은
--              relay-site 저장소의 supabase/schema.sql, 이 저장소에는 없다)
-- 실행 방법 : Supabase 대시보드 → SQL Editor 에 이 파일 전체를 붙여넣고 1회 실행.
--             서비스 키 불필요(대시보드 세션 권한으로 충분). 재실행해도 안전하다 —
--             모든 문장이 create ... if not exists / on conflict do nothing 이다.
-- 실행 순서 : ① 라이선스·계정 스키마(기적용 확인만) → ② 이 파일. 이 파일 내부는 위→아래 순서 그대로.
-- 포함 내용 : web-platform.sql 전체(WS0 스키마) + 핸들 이력·예약어 테이블(P1 바로가기).
--
-- 롤백 노트 : 이 스크립트는 신규 테이블·인덱스·버킷 생성뿐이며 기존 테이블을 변경하지
--             않는다(bbbb_donation_messages.ip_hash 컬럼 추가 1건 제외 — add column if not
--             exists, 데이터 무손실). 전체 롤백이 필요하면 아래를 역순으로 실행:
--               drop table if exists public.bbbb_handle_history;
--               drop table if exists public.bbbb_reserved_handles;
--               drop table if exists public.bbbb_payment_intents;
--               drop table if exists public.bbbb_ledger_entries;
--               drop table if exists public.bbbb_wallets;
--               drop table if exists public.bbbb_web_reports;
--               drop table if exists public.bbbb_relay_devices;
--               drop table if exists public.bbbb_page_blocks;
--               drop table if exists public.bbbb_donation_matches;
--               drop table if exists public.bbbb_donation_messages;
--               drop table if exists public.bbbb_page_signatures;
--               drop table if exists public.bbbb_page_follows;
--               drop table if exists public.bbbb_streamer_pages;
--               drop table if exists public.bbbb_web_profiles;
--               delete from storage.buckets where id = 'bbbb-web-thumbs';
--             (스토리지 버킷은 내부 객체가 있으면 먼저 storage.objects 에서 해당 bucket_id
--              행을 지워야 삭제된다.)
-- =============================================================================

-- =============================================================================
-- PART 1. 웹 후원 플랫폼 스키마 (WS0) — supabase/web-platform.sql 전문 복사
-- 계약 문서: donation-system/docs/WEB_TECH_SPEC.md §1
-- 모든 테이블은 RLS 활성 + 정책 없음 = service role(Vercel Functions) 전용.
-- 클라이언트(anon) 직접 쿼리 금지 — 공개 API는 Functions를 경유한다.
-- =============================================================================

-- 1.1 계정·채널 ---------------------------------------------------------------

create table if not exists public.bbbb_web_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null check (char_length(nickname) between 1 and 20),
  avatar_url text,
  roles text[] not null default '{viewer}',
  default_message text check (default_message is null or char_length(default_message) <= 200),
  notify_email boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bbbb_streamer_pages (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null unique references auth.users(id) on delete cascade,
  handle text not null check (handle ~ '^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$'),
  banner_url text,
  avatar_url text,
  bio text check (bio is null or char_length(bio) <= 500),
  broadcast_links jsonb not null default '[]'::jsonb,
  preset_amounts integer[] not null default '{1000,5000,10000,50000}',
  min_amount integer not null default 1000 check (min_amount >= 100),
  ticker_public boolean not null default false,
  directory_optin boolean not null default false,
  account_display text not null default 'link_only' check (account_display in ('link_only', 'full')),
  account_info jsonb,
  transfer_links jsonb not null default '[]'::jsonb,
  status text not null default 'active' check (status in ('active', 'hidden', 'suspended')),
  handle_changed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists bbbb_streamer_pages_handle_idx
  on public.bbbb_streamer_pages (lower(handle));

create table if not exists public.bbbb_page_follows (
  viewer_user_id uuid not null references auth.users(id) on delete cascade,
  page_id uuid not null references public.bbbb_streamer_pages(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (viewer_user_id, page_id)
);

-- 1.2 시그니처 메뉴판 (로컬 → 클라우드 단방향 캐시, 진실은 로컬) -------------------

create table if not exists public.bbbb_page_signatures (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references public.bbbb_streamer_pages(id) on delete cascade,
  local_signature_id text not null,
  title text not null default '',
  web_title text check (web_title is null or char_length(web_title) <= 60),
  amount integer not null check (amount > 0),
  media_type text not null check (media_type in ('image', 'gif', 'video', 'audio')),
  thumb_url text,
  published boolean not null default false,
  pinned boolean not null default false,
  sort integer not null default 0,
  synced_at timestamptz not null default now(),
  unique (page_id, local_signature_id)
);

create index if not exists bbbb_page_signatures_page_pub_idx
  on public.bbbb_page_signatures (page_id, published, amount);

-- 1.3 후원 메시지·매칭 (계좌 레일) ----------------------------------------------

create table if not exists public.bbbb_donation_messages (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references public.bbbb_streamer_pages(id) on delete cascade,
  viewer_user_id uuid references auth.users(id) on delete set null,
  nickname text not null check (char_length(nickname) between 1 and 20),
  message text not null default '' check (char_length(message) <= 200),
  amount integer not null check (amount > 0),
  deposit_code text not null,
  code_norm text not null,
  status text not null default 'pending' check (status in ('pending', 'matched', 'expired', 'blocked')),
  expires_at timestamptz not null,
  grace_until timestamptz not null,
  created_at timestamptz not null default now(),
  matched_at timestamptz
);

create index if not exists bbbb_donation_messages_page_status_idx
  on public.bbbb_donation_messages (page_id, status, expires_at);

-- IP 단위 레이트리밋용 (기존 적용분에도 안전하게 추가되도록 alter 사용)
alter table public.bbbb_donation_messages add column if not exists ip_hash text;

-- 활성 pending 내 입금코드 유일 (만료·매칭된 코드는 재사용 가능)
create unique index if not exists bbbb_donation_messages_pending_code_idx
  on public.bbbb_donation_messages (page_id, code_norm)
  where status = 'pending';

-- 감사 로그(불변, update/delete 없음)
create table if not exists public.bbbb_donation_matches (
  id uuid primary key default gen_random_uuid(),
  message_id uuid references public.bbbb_donation_messages(id) on delete set null,
  page_id uuid not null references public.bbbb_streamer_pages(id) on delete cascade,
  matched_by text check (matched_by in ('auto', 'manual')),
  local_donation_id text not null,
  sender_raw text,
  amount integer,
  reported_at timestamptz not null default now(),
  -- 릴레이 match-report 멱등 키
  unique (page_id, local_donation_id)
);

create table if not exists public.bbbb_page_blocks (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references public.bbbb_streamer_pages(id) on delete cascade,
  blocked_value text not null,
  reason text,
  created_at timestamptz not null default now(),
  unique (page_id, blocked_value)
);

-- 릴레이 디바이스 연결 (스트리머 페이지당 1활성 — 새 등록 시 구 키 폐기)
create table if not exists public.bbbb_relay_devices (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references public.bbbb_streamer_pages(id) on delete cascade,
  device_key_hash text not null unique,
  connect_code text,
  connect_code_expires_at timestamptz,
  active boolean not null default false,
  last_heartbeat_at timestamptz,
  signatures_dirty boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists bbbb_relay_devices_page_active_idx
  on public.bbbb_relay_devices (page_id, active);

-- 신고 큐 (/ops)
create table if not exists public.bbbb_web_reports (
  id uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('page', 'signature', 'message')),
  target_id text not null,
  reason text not null check (char_length(reason) <= 500),
  reporter_ip_hash text,
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  created_at timestamptz not null default now()
);

-- 1.4 [예약] 결제 — ★ 결제 스프린트(WSG~WSI) 전 활성화(사용) 금지 ★ ---------------
-- 테이블만 생성해 둔다. 어떤 API도 이 테이블을 읽거나 쓰면 안 된다.
-- 활성화 조건: PG 테스트 키 + 법률 자문 1차 의견 (docs/WEB_ROADMAP.md §2)

create table if not exists public.bbbb_wallets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance_cached bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- append-only 복식부기 원장: update/delete 금지, 잔액 = 원장 합계
create table if not exists public.bbbb_ledger_entries (
  id bigint generated always as identity primary key,
  entry_group uuid not null,
  account text not null,
  user_ref uuid,
  delta bigint not null,
  ref jsonb,
  created_at timestamptz not null default now()
);

create index if not exists bbbb_ledger_entries_group_idx on public.bbbb_ledger_entries (entry_group);
create index if not exists bbbb_ledger_entries_account_idx on public.bbbb_ledger_entries (account, user_ref);

create table if not exists public.bbbb_payment_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  provider_intent_id text unique,
  amount bigint not null check (amount > 0),
  status text not null default 'requested'
    check (status in ('requested', 'authorized', 'captured', 'partially_refunded', 'refunded', 'chargeback')),
  payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS: 전 테이블 활성, 정책 없음 = service role 전용 --------------------------------

alter table public.bbbb_web_profiles enable row level security;
alter table public.bbbb_streamer_pages enable row level security;
alter table public.bbbb_page_follows enable row level security;
alter table public.bbbb_page_signatures enable row level security;
alter table public.bbbb_donation_messages enable row level security;
alter table public.bbbb_donation_matches enable row level security;
alter table public.bbbb_page_blocks enable row level security;
alter table public.bbbb_relay_devices enable row level security;
alter table public.bbbb_web_reports enable row level security;
alter table public.bbbb_wallets enable row level security;
alter table public.bbbb_ledger_entries enable row level security;
alter table public.bbbb_payment_intents enable row level security;

-- 썸네일 스토리지 버킷 (공개 읽기 — 시그니처 썸네일 ≤200KB만 업로드)
insert into storage.buckets (id, name, public)
values ('bbbb-web-thumbs', 'bbbb-web-thumbs', true)
on conflict (id) do nothing;

-- =============================================================================
-- PART 2. 핸들 이력·예약어 (P1 바로가기 — VIEWER_MESSAGE_RELAY_PLAN §6.2, 부록 A 2단계)
-- 핸들 변경 30일 1회 + 구 핸들 90일 301 리다이렉트 + 그 기간 재사용 잠금.
-- =============================================================================

-- supabase/web-platform.sql §1.5 전문 복사 — 두 파일은 항상 동일해야 한다.
-- old_handle이 PK: 구 핸들 하나는 정확히 하나의 현재 목적지만 가진다
-- (a→b→c 체인은 변경 시 API가 내 이력 전체를 새 핸들로 재조준해 1홉을 보장).
-- API 계약: api/studio/page.ts upsert onConflict:'old_handle',
--           api/channel-page.ts .maybeSingle() — old_handle 유니크 전제.
-- RLS 활성 + 정책 없음 = service role 전용. SSR 301 조회(api/channel-page.ts)도
-- service key 경유라 anon 정책은 두지 않는다.

create table if not exists public.bbbb_handle_history (
  old_handle text primary key,
  page_id uuid not null references public.bbbb_streamer_pages(id) on delete cascade,
  new_handle text not null,
  changed_at timestamptz not null default now()
);

-- 핸들 변경·페이지 삭제 시 내 이력 일괄 재조준/정리용
create index if not exists bbbb_handle_history_page_idx
  on public.bbbb_handle_history (page_id);

alter table public.bbbb_handle_history enable row level security;

-- 예약어 핸들 (api/_webShared.ts RESERVED_HANDLES와 동기 유지 — 코드가 1차 게이트,
-- 이 테이블은 DB 레벨 참조·운영 중 추가 차단용)
create table if not exists public.bbbb_reserved_handles (
  handle text primary key
);

alter table public.bbbb_reserved_handles enable row level security;

insert into public.bbbb_reserved_handles (handle) values
  ('admin'), ('api'), ('app'), ('assets'), ('auth'), ('about'), ('account'),
  ('ads'), ('bbbb'), ('blog'), ('channel'), ('channels'), ('dev'), ('docs'),
  ('download'), ('downloads'), ('gaeideuk'), ('gyeideuk'), ('help'), ('home'),
  ('login'), ('logout'), ('m'), ('me'), ('news'), ('ops'), ('overlay'),
  ('privacy'), ('relay'), ('releases'), ('root'), ('settings'), ('signup'),
  ('site'), ('static'), ('studio'), ('support'), ('terms'), ('test'),
  ('wallet'), ('ws'), ('www')
on conflict (handle) do nothing;

-- =============================================================================
-- 끝. 재실행 안전(idempotent). 기존 데이터 변경 문장 없음.
-- =============================================================================
