-- Hardening migration: triggers, constraints, RLS, and a manual purge helper.
-- Safe to apply on top of the initial schema; uses IF NOT EXISTS / DO blocks
-- so it can be re-run without erroring.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. updated_at trigger
-- ─────────────────────────────────────────────────────────────────────────────
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

drop trigger if exists set_updated_at on public.memories;
create trigger set_updated_at
  before update on public.memories
  for each row execute function public.tg_set_updated_at();

drop trigger if exists set_updated_at on public.entities;
create trigger set_updated_at
  before update on public.entities
  for each row execute function public.tg_set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Self-loop guard on entity_relationships
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'entity_relationships_no_self_loop'
  ) then
    alter table public.entity_relationships
      add constraint entity_relationships_no_self_loop
      check (entity_a_id <> entity_b_id);
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Case-insensitive uniqueness on entities (name, type, subtype)
--    Prevents duplicate "Mr Smith" / "mr smith" rows.
-- ─────────────────────────────────────────────────────────────────────────────
create unique index if not exists entities_unique_ci
  on public.entities (lower(name), type, lower(coalesce(subtype, '')));

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Row Level Security — defense in depth.
--    The Edge Function uses the service role and bypasses RLS, so app
--    behaviour is unchanged. Anon / authenticated roles get nothing.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.categories           enable row level security;
alter table public.memories             enable row level security;
alter table public.entities             enable row level security;
alter table public.entity_relationships enable row level security;
alter table public.memory_entities      enable row level security;

-- Force RLS even for table owners (extra safety against psql sessions).
alter table public.categories           force row level security;
alter table public.memories             force row level security;
alter table public.entities             force row level security;
alter table public.entity_relationships force row level security;
alter table public.memory_entities      force row level security;

-- No policies => deny by default for every non-superuser, non-bypassrls role.

-- Revoke default grants from anon / authenticated, just in case.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables    in schema public from anon';
    execute 'revoke all on all sequences in schema public from anon';
    execute 'revoke all on all functions in schema public from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on all tables    in schema public from authenticated';
    execute 'revoke all on all sequences in schema public from authenticated';
    execute 'revoke all on all functions in schema public from authenticated';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Partial index on memories.embedding to keep HNSW lean
-- ─────────────────────────────────────────────────────────────────────────────
-- (kept as-is from migration 001 — HNSW indexes do not support WHERE clauses
-- in current pgvector releases, so no change.)

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Manual purge helper for soft-deleted memories
--    Call periodically (cron / scheduled function) e.g.
--      select public.purge_deleted_memories('30 days'::interval);
-- ─────────────────────────────────────────────────────────────────────────────
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
