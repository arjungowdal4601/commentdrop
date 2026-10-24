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
create table if not exists deliveries (
  comment_id        text primary key,
  campaign_id       bigint not null references campaigns(id) on delete cascade,
  creator_id        uuid not null references creators(id) on delete cascade,
  author_channel_id text,
  author_name       text,
  author_avatar     text,
  comment_text      text,
  commented_at      timestamptz,
  status            text not null default 'waiting', -- waiting | sent | failed
  viewer_id         bigint references viewers(id) on delete set null,
  error             text,
  delivered_via     text,
  delivered_at      timestamptz,
  detected_at       timestamptz not null default now()
);
create index if not exists deliveries_creator_idx on deliveries (creator_id, detected_at desc);
create index if not exists deliveries_author_idx on deliveries (author_channel_id) where status <> 'sent';

-- Latest Claude analysis per creator + video.
create table if not exists analyses (
  creator_id  uuid not null references creators(id) on delete cascade,
  video_id    text not null,
  video_title text,
  video_thumb text,
  data        jsonb not null,
  created_at  timestamptz not null default now(),
  primary key (creator_id, video_id)
);

-- Replies posted from the Comments page, so a comment is never answered twice.
create table if not exists comment_replies (
  comment_id text primary key,
  creator_id uuid not null references creators(id) on delete cascade,
  video_id   text not null,
  text       text not null,
  status     text not null, -- sent | failed
  reply_id   text,
  error      text,
  replied_at timestamptz not null default now()
);

-- Comments hidden (rejected) or hidden + author banned from the Comments page.
-- YouTube can't restore a rejected comment to published via the API, so this is one-way.
create table if not exists comment_moderation (
  comment_id   text primary key,
  creator_id   uuid not null references creators(id) on delete cascade,
  video_id     text not null,
  action       text not null, -- hide | ban
  status       text not null, -- done | failed
  error        text,
  moderated_at timestamptz not null default now()
);

-- Supabase exposes the public schema over its REST API; RLS with no policies
-- keeps these tables closed to anon/authenticated keys. The app connects as its own role.
alter table creators           enable row level security;
alter table materials          enable row level security;
alter table campaigns          enable row level security;
alter table viewers            enable row level security;
alter table deliveries         enable row level security;
alter table analyses           enable row level security;
alter table comment_replies    enable row level security;
alter table comment_moderation enable row level security;
