-- ---- Studio: plan one video per project, up to a reviewed storyboard ----------
create table if not exists studio_projects (
  id         uuid primary key default gen_random_uuid(),
  creator_id uuid not null references creators(id) on delete cascade,
  name       text not null,
  format     text not null default 'auto',   -- auto | long | short
  twist      text not null default '',       -- what the creator will do differently
  research   text not null default '',       -- topics or links for web research
  research_notes text,                       -- what Claude found on the web
  stage      text not null default 'inspire', -- inspire | questions | storyboard | approved
  understanding text,                        -- Claude's one-paragraph read of the brief
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists studio_projects_creator_idx on studio_projects (creator_id, updated_at desc);

create table if not exists studio_inspirations (
  id           bigserial primary key,
  project_id   uuid not null references studio_projects(id) on delete cascade,
  position     integer not null,              -- 1..4
  video_id     text not null,
  title        text,
  channel      text,
  thumb        text,
  duration_sec integer,
  notes        text not null default '',
  transcript   text,
  transcript_source text,                     -- mac | paste
  transcript_error  text,
  unique (project_id, position)
);

-- One row per round of clarifying questions (at most 2).
create table if not exists studio_rounds (
  id          bigserial primary key,
  project_id  uuid not null references studio_projects(id) on delete cascade,
  round       integer not null,
  questions   jsonb not null,
  answers     jsonb,
  created_at  timestamptz not null default now(),
  answered_at timestamptz,
  unique (project_id, round)
);

-- Latest storyboard per project; beats live in data.beats.
create table if not exists studio_storyboards (
  project_id uuid primary key references studio_projects(id) on delete cascade,
  data       jsonb not null,
  model      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table studio_projects     enable row level security;
alter table studio_inspirations enable row level security;
alter table studio_rounds       enable row level security;
alter table studio_storyboards  enable row level security;
