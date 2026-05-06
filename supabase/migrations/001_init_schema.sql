-- Enable pgvector extension
create extension if not exists vector with schema extensions;

-- ─────────────────────────────────────────────
-- categories (hierarchical, 3 levels)
-- ─────────────────────────────────────────────
create table public.categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  parent_id  uuid references public.categories(id) on delete cascade,
  level      int not null check (level between 1 and 3),
  created_at timestamptz not null default now()
);

-- Standard UNIQUE doesn't protect against duplicate top-level categories because
-- NULL != NULL in SQL. Use two partial indexes instead.
create unique index on public.categories (name) where parent_id is null;
create unique index on public.categories (name, parent_id) where parent_id is not null;

create index on public.categories (parent_id);

-- ─────────────────────────────────────────────
-- memories
-- ─────────────────────────────────────────────
create table public.memories (
  id           uuid primary key default gen_random_uuid(),
  content      text not null,
  type         text not null check (type in ('memory', 'reminder', 'note', 'idea')),
  category_id  uuid references public.categories(id),
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
create index on public.memories (due_date) where due_date is not null;
create index on public.memories (deleted_at) where deleted_at is null;

-- ─────────────────────────────────────────────
-- entities (graph nodes)
-- ─────────────────────────────────────────────
create table public.entities (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  type       text not null check (type in ('person', 'place', 'object', 'event', 'concept')),
  subtype    text,
  properties jsonb,
  embedding  extensions.vector(384),
  fts        tsvector generated always as (to_tsvector('english', name)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index on public.entities using hnsw (embedding extensions.vector_cosine_ops);
create index on public.entities using gin (fts);

-- ─────────────────────────────────────────────
-- entity_relationships (graph edges)
-- ─────────────────────────────────────────────
create table public.entity_relationships (
  id           uuid primary key default gen_random_uuid(),
  entity_a_id  uuid not null references public.entities(id) on delete cascade,
  relation     text not null,
  entity_b_id  uuid not null references public.entities(id) on delete cascade,
  created_at   timestamptz not null default now(),
  unique (entity_a_id, relation, entity_b_id)
);

create index on public.entity_relationships (entity_a_id);
create index on public.entity_relationships (entity_b_id);

-- ─────────────────────────────────────────────
-- memory_entities (junction)
-- ─────────────────────────────────────────────
create table public.memory_entities (
  memory_id  uuid not null references public.memories(id) on delete cascade,
  entity_id  uuid not null references public.entities(id) on delete cascade,
  primary key (memory_id, entity_id)
);

create index on public.memory_entities (entity_id);
