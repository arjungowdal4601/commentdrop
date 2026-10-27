-- CommentDrop (multi-creator) on Supabase Postgres.
-- Every creator-owned row carries creator_id; the API always filters by it.

create table if not exists creators (
  id             uuid primary key default gen_random_uuid(),
  google_sub     text not null unique,
  email          text not null,
  name           text,
  channel_id     text,
  channel_title  text,
  channel_handle text,
  channel_avatar text,
  refresh_token  text,
  scope          text,
  created_at     timestamptz not null default now()
);

-- Files a creator sends (PDFs etc.), stored in the database for simplicity.
create table if not exists materials (
  id         uuid primary key default gen_random_uuid(),
  creator_id uuid not null references creators(id) on delete cascade,
  filename   text not null,
  mime       text not null,
  size       integer not null,
  data       bytea not null,
  created_at timestamptz not null default now()
);

create table if not exists campaigns (
  id            bigserial primary key,
  creator_id    uuid not null references creators(id) on delete cascade,
  video_id      text not null,
  video_title   text,
  video_thumb   text,
  keyword       text not null,
  material_id   uuid not null references materials(id) on delete restrict,
  material_name text not null,
  subject       text not null,
  message       text not null,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists campaigns_active_idx on campaigns (active) where active;

-- Viewers are shared across creators: link once, get material from anyone.
create table if not exists viewers (
  id                 bigserial primary key,
  email              text not null,
  youtube_channel_id text not null unique,
  youtube_handle     text,
  youtube_name       text,
  youtube_avatar     text,
  created_at         timestamptz not null default now()
);

-- One row per keyword comment; the comment id is the key, so it is delivered once.
-- Only who asked and what happened is kept, never the comment text.
-- author_channel_id is the YouTube channel id, or the Instagram user id on Instagram.
create table if not exists deliveries (
  comment_id        text primary key,
  campaign_id       bigint not null references campaigns(id) on delete cascade,
  creator_id        uuid not null references creators(id) on delete cascade,
  author_channel_id text,
  author_name       text,
  commented_at      timestamptz,
  status            text not null default 'waiting', -- waiting | dm_sent | sent | failed
  viewer_id         bigint references viewers(id) on delete set null,
  error             text,
  delivered_via     text,
  delivered_at      timestamptz,
  detected_at       timestamptz not null default now()
);
create index if not exists deliveries_creator_idx on deliveries (creator_id, detected_at desc);
create index if not exists deliveries_author_idx on deliveries (author_channel_id) where status <> 'sent';

-- Instagram: one-time sign-in links sent by DM to a first-time commenter.
create table if not exists ig_links (
  token       text primary key,
  creator_id  uuid not null references creators(id) on delete cascade,
  ig_user_id  text not null,
  ig_username text,
  comment_id  text not null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

-- Small app-wide switches, e.g. live_paused = 'true' stops every YouTube check.
create table if not exists app_config (
  k text primary key,
  v text
);

-- Changes for databases created before Instagram support (safe to run again).
alter table creators   add column if not exists yt_checked_at timestamptz; -- newest comment time seen by the channel check
alter table creators   add column if not exists ig_user_id text;
alter table creators   add column if not exists ig_username text;
alter table creators   add column if not exists ig_avatar text;
alter table creators   add column if not exists ig_token text;
alter table creators   add column if not exists ig_token_expires timestamptz;
create unique index if not exists creators_ig_user_idx on creators (ig_user_id);
alter table campaigns  add column if not exists platform text not null default 'youtube'; -- youtube | instagram
alter table campaigns  add column if not exists permalink text;
alter table viewers    alter column youtube_channel_id drop not null;
alter table viewers    add column if not exists instagram_user_id text unique;
alter table viewers    add column if not exists instagram_username text;
alter table deliveries add column if not exists platform text not null default 'youtube';
alter table deliveries drop column if exists comment_text;
alter table deliveries drop column if exists author_avatar;
drop table if exists analyses;
drop table if exists comment_replies;
drop table if exists comment_moderation;

-- Supabase exposes the public schema over its REST API; RLS with no policies
-- keeps these tables closed to anon/authenticated keys. The app connects as its own role.
alter table creators           enable row level security;
alter table materials          enable row level security;
alter table campaigns          enable row level security;
alter table viewers            enable row level security;
alter table deliveries         enable row level security;
alter table ig_links           enable row level security;
alter table app_config         enable row level security;
