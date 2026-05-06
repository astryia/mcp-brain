-- Hybrid search using Reciprocal Rank Fusion (RRF)
-- Combines pgvector cosine similarity with PostgreSQL full-text search.
--
-- All functions explicitly set search_path so the pgvector operators
-- (`<=>`, `<->`, `<#>`) defined in the `extensions` schema resolve
-- regardless of the caller's session search_path.

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
  rrf_k             int default 50,
  semantic_threshold float default 0.7
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
set search_path = public, extensions, pg_temp
as $$
  with recursive
  -- Expand filter_category_id to include all descendant categories.
  -- When filter_category_id is null the anchor returns 0 rows and the
  -- outer (filter_category_id is null or ...) short-circuits to true.
  cat_subtree as (
    select id from public.categories where id = filter_category_id
    union all
    select c.id from public.categories c join cat_subtree t on c.parent_id = t.id
  ),
  candidates as (
    select m.id, m.embedding, m.fts
    from public.memories m
    where m.deleted_at is null
      and (filter_category_id is null or m.category_id in (select id from cat_subtree))
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
        order by ts_rank_cd(c.fts, websearch_to_tsquery('english', query_text)) desc
      ) as rank_ix
    from candidates c
    where c.fts @@ websearch_to_tsquery('english', query_text)
    limit least(match_count, 30) * 2
  ),
  semantic as (
    select
      c.id,
      row_number() over (
        order by c.embedding <=> query_embedding
      ) as rank_ix
    from candidates c
    where c.embedding is not null
      and (c.embedding <=> query_embedding) < semantic_threshold
    order by c.embedding <=> query_embedding
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
  rrf_k            int default 50,
  semantic_threshold float default 0.7
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
set search_path = public, extensions, pg_temp
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
      and (e.embedding <=> query_embedding) < semantic_threshold
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
-- Race-safe (ON CONFLICT) and idempotent. Validates depth and segments.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.resolve_category_path(
  path text[]
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  current_id    uuid := null;
  current_level int  := 0;
  seg           text;
  found_id      uuid;
begin
  if path is null or array_length(path, 1) is null then
    raise exception 'category path must contain at least one segment';
  end if;
  if array_length(path, 1) > 3 then
    raise exception 'category path supports at most 3 levels (got %)', array_length(path, 1);
  end if;

  foreach seg in array path loop
    current_level := current_level + 1;
    seg := nullif(btrim(seg), '');
    if seg is null then
      raise exception 'category path contains an empty segment at level %', current_level;
    end if;

    -- Look up by exact (parent_id, name). Two queries because
    -- `parent_id = NULL` is always unknown.
    if current_id is null then
      select id into found_id
      from public.categories
      where parent_id is null and name = seg
      limit 1;
    else
      select id into found_id
      from public.categories
      where parent_id = current_id and name = seg
      limit 1;
    end if;

    -- Race-safe upsert using partial index syntax to match the two partial
    -- unique indexes on categories (NULL parent vs non-NULL parent).
    if found_id is null then
      if current_id is null then
        insert into public.categories (name, parent_id, level)
        values (seg, null, current_level)
        on conflict (name) where parent_id is null do update set name = excluded.name
        returning id into found_id;
      else
        insert into public.categories (name, parent_id, level)
        values (seg, current_id, current_level)
        on conflict (name, parent_id) where parent_id is not null do update set name = excluded.name
        returning id into found_id;
      end if;
    end if;

    current_id := found_id;
  end loop;

  return current_id;
end;
$$;
