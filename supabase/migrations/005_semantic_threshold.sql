-- Add cosine distance threshold to semantic legs of hybrid search functions.
-- Prevents unrelated memories/entities from ranking via the semantic leg alone.
-- Threshold 0.7 means cosine similarity must be >= 0.3 to be considered.
--
-- NOTE: Adding a parameter changes the function signature, so PostgreSQL treats
-- it as a new overload rather than replacing the old one. We must DROP the old
-- signatures first to avoid PostgREST "ambiguous function" errors.

drop function if exists public.hybrid_search_memories(
  text, extensions.vector(384), int, uuid, text,
  timestamptz, timestamptz, timestamptz, timestamptz,
  boolean, float, float, int
);

drop function if exists public.hybrid_search_entities(
  text, extensions.vector(384), int, text, float, float, int
);

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
