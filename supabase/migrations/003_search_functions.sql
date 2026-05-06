-- Hybrid search using Reciprocal Rank Fusion (RRF)
-- Combines pgvector cosine similarity with PostgreSQL full-text search

-- ─────────────────────────────────────────────────────────────────────────────
-- hybrid_search_memories
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.hybrid_search_memories(
  query_text        text,
  query_embedding   extensions.vector(384),
  match_count       int default 10,
  filter_category_id uuid default null,
  filter_type       text default null,
  filter_date_from  timestamptz default null,
  filter_date_to    timestamptz default null,
  filter_due_from   timestamptz default null,
  filter_due_to     timestamptz default null,
  include_completed boolean default false,
  full_text_weight  float default 1.0,
  semantic_weight   float default 1.0,
  rrf_k             int default 50
)
returns table (
  id           uuid,
  content      text,
  type         text,
  category_id  uuid,
  due_date     timestamptz,
  completed_at timestamptz,
  created_at   timestamptz,
  updated_at   timestamptz,
  rrf_score    float
)
language sql
stable
as $$
  with candidates as (
    select m.id
    from public.memories m
    where m.deleted_at is null
      and (filter_category_id is null or m.category_id = filter_category_id)
      and (filter_type is null or m.type = filter_type)
      and (filter_date_from is null or m.created_at >= filter_date_from)
      and (filter_date_to is null or m.created_at <= filter_date_to)
      and (filter_due_from is null or m.due_date >= filter_due_from)
      and (filter_due_to is null or m.due_date <= filter_due_to)
      and (include_completed or m.completed_at is null)
  ),
  full_text as (
    select
      c.id,
      row_number() over (
        order by ts_rank_cd(m.fts, websearch_to_tsquery('english', query_text)) desc
      ) as rank_ix
    from candidates c
    join public.memories m on m.id = c.id
    where m.fts @@ websearch_to_tsquery('english', query_text)
    limit least(match_count, 30) * 2
  ),
  semantic as (
    select
      c.id,
      row_number() over (
        order by m.embedding <=> query_embedding
      ) as rank_ix
    from candidates c
    join public.memories m on m.id = c.id
    where m.embedding is not null
    order by m.embedding <=> query_embedding
    limit least(match_count, 30) * 2
  ),
  combined as (
    select
      coalesce(ft.id, sem.id) as id,
      coalesce(1.0 / (rrf_k + ft.rank_ix),  0.0) * full_text_weight +
      coalesce(1.0 / (rrf_k + sem.rank_ix), 0.0) * semantic_weight  as score
    from full_text ft
    full outer join semantic sem on ft.id = sem.id
  )
  select
    m.id,
    m.content,
    m.type,
    m.category_id,
    m.due_date,
    m.completed_at,
    m.created_at,
    m.updated_at,
    c.score as rrf_score
  from combined c
  join public.memories m on m.id = c.id
  order by c.score desc
  limit match_count;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- hybrid_search_entities
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.hybrid_search_entities(
  query_text       text,
  query_embedding  extensions.vector(384),
  match_count      int default 5,
  filter_type      text default null,
  full_text_weight float default 1.0,
  semantic_weight  float default 1.0,
  rrf_k            int default 50
)
returns table (
  id         uuid,
  name       text,
  type       text,
  subtype    text,
  properties jsonb,
  created_at timestamptz,
  rrf_score  float
)
language sql
stable
as $$
  with full_text as (
    select
      e.id,
      row_number() over (
        order by ts_rank_cd(e.fts, websearch_to_tsquery('english', query_text)) desc
      ) as rank_ix
    from public.entities e
    where e.fts @@ websearch_to_tsquery('english', query_text)
      and (filter_type is null or e.type = filter_type)
    limit least(match_count, 20) * 2
  ),
  semantic as (
    select
      e.id,
      row_number() over (
        order by e.embedding <=> query_embedding
      ) as rank_ix
    from public.entities e
    where e.embedding is not null
      and (filter_type is null or e.type = filter_type)
    order by e.embedding <=> query_embedding
    limit least(match_count, 20) * 2
  ),
  combined as (
    select
      coalesce(ft.id, sem.id) as id,
      coalesce(1.0 / (rrf_k + ft.rank_ix),  0.0) * full_text_weight +
      coalesce(1.0 / (rrf_k + sem.rank_ix), 0.0) * semantic_weight  as score
    from full_text ft
    full outer join semantic sem on ft.id = sem.id
  )
  select
    e.id,
    e.name,
    e.type,
    e.subtype,
    e.properties,
    e.created_at,
    c.score as rrf_score
  from combined c
  join public.entities e on e.id = c.id
  order by c.score desc
  limit match_count;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- resolve_category_path
-- Given an array like ['Work & Career', 'projects', 'backend']
-- returns the category_id for the deepest match, creating missing levels.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.resolve_category_path(
  path text[]
)
returns uuid
language plpgsql
as $$
declare
  current_id   uuid := null;
  current_level int;
  seg           text;
  found_id      uuid;
begin
  foreach seg in array path loop
    current_level := coalesce(array_position(path, seg), 1);

    -- Try to find existing category
    select id into found_id
    from public.categories
    where name = seg
      and (current_id is null and parent_id is null
           or parent_id = current_id)
    limit 1;

    if found_id is null then
      -- Create the missing category
      insert into public.categories (name, parent_id, level)
      values (seg, current_id, current_level)
      returning id into found_id;
    end if;

    current_id := found_id;
  end loop;

  return current_id;
end;
$$;
