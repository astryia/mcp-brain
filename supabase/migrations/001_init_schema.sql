-- user-memory — fresh schema (v2).
--
-- Two tables: categories (fixed 2-level tree) and memories.
-- Entities, relationships, and the memory_entities junction were removed
-- in this redesign — categories + types + temporal filters carry the load.

create extension if not exists vector with schema extensions;

-- ─────────────────────────────────────────────
-- categories — fixed 2-level tree
-- The vocabulary is curated in 002_seed_categories.sql.
-- resolve_category_path is lookup-only (no auto-create).
-- ─────────────────────────────────────────────
create table public.categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  parent_id  uuid references public.categories(id) on delete cascade,
  level      int not null check (level between 1 and 2),
  created_at timestamptz not null default now()
);

-- NULL != NULL means a plain UNIQUE doesn't catch duplicate top-level names;
-- two partial indexes do.
create unique index on public.categories (name) where parent_id is null;
create unique index on public.categories (name, parent_id) where parent_id is not null;
create index on public.categories (parent_id);

-- ─────────────────────────────────────────────
-- memories
-- types: fact · preference · memory · task · note
-- ─────────────────────────────────────────────
create table public.memories (
  id           uuid primary key default gen_random_uuid(),
  content      text not null,
  type         text not null check (type in ('fact', 'preference', 'memory', 'task', 'note')),
  category_id  uuid not null references public.categories(id),
  due_date     timestamptz,
  completed_at timestamptz,
  deleted_at   timestamptz,
  embedding    extensions.vector(384),
  fts          tsvector generated always as (to_tsvector('english', content)) stored,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index on public.memories using hnsw (embedding extensions.vector_cosine_ops);
create index on public.memories using gin (fts);
create index on public.memories (category_id);
create index on public.memories (type);
create index on public.memories (created_at);
create index on public.memories (due_date) where due_date is not null;
create index on public.memories (deleted_at) where deleted_at is null;

-- ─────────────────────────────────────────────
-- updated_at trigger
-- ─────────────────────────────────────────────
create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
set search_path = pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger set_updated_at
  before update on public.memories
  for each row execute function public.tg_set_updated_at();

-- ─────────────────────────────────────────────
-- RLS — strict deny-all defense in depth.
--
-- The Edge Function uses the service_role key, which has BYPASSRLS — so
-- application behaviour is unchanged. Every other role (anon, authenticated,
-- authenticator, public, custom) is denied at multiple layers:
--   1. RLS enabled + FORCE on every table, with zero policies → default deny.
--   2. All privileges revoked on existing tables / sequences / functions.
--   3. Default privileges for future objects also revoked, so a forgotten
--      `grant` on a new table never leaks access.
--   4. USAGE on schema public revoked from anon / authenticated.
--   5. PUBLIC role stripped of its implicit grants.
--
-- If anything is ever queried by a non-bypass role it will see an empty
-- result set or an outright permission error — never real rows.
-- ─────────────────────────────────────────────
alter table public.categories enable row level security;
alter table public.memories   enable row level security;
alter table public.categories force row level security;
alter table public.memories   force row level security;

-- (1) Strip PUBLIC — the implicit "everyone" grant.
revoke all on schema public                  from public;
revoke all on all tables    in schema public from public;
revoke all on all sequences in schema public from public;
revoke all on all functions in schema public from public;
revoke all on all routines  in schema public from public;

-- Default privileges for future objects created by the current role.
alter default privileges in schema public revoke all on tables    from public;
alter default privileges in schema public revoke all on sequences from public;
alter default privileges in schema public revoke all on functions from public;
alter default privileges in schema public revoke all on routines  from public;

-- (2) Revoke from Supabase-managed roles if they exist in this DB.
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'authenticator'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema public                  from %I', r);
      execute format('revoke all on all tables    in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
      execute format('revoke all on all routines  in schema public from %I', r);
      execute format('alter default privileges in schema public revoke all on tables    from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);
      execute format('alter default privileges in schema public revoke all on routines  from %I', r);
    end if;
  end loop;
end $$;

-- (3) Lock down the extensions schema too — pgvector lives there. Without
-- USAGE the operators (<=>, <->, <#>) are unreachable to non-bypass roles,
-- which is what we want.
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'authenticator', 'public'] loop
    if r = 'public' or exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema extensions from %I', r);
    end if;
  end loop;
end $$;

-- ─────────────────────────────────────────────
-- Manual purge helper for soft-deleted memories.
-- Call e.g. select public.purge_deleted_memories('30 days'::interval);
-- ─────────────────────────────────────────────
create or replace function public.purge_deleted_memories(older_than interval default '30 days')
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare
  removed int;
begin
  delete from public.memories
  where deleted_at is not null
    and deleted_at < now() - older_than;
  get diagnostics removed = row_count;
  return removed;
end;
$$;
