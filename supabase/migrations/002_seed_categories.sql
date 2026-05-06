-- Seed 1st-level (fixed) and 2nd-level (pre-populated, extensible) categories

do $$
declare
  hw_id  uuid;
  rel_id uuid;
  wc_id  uuid;
  lg_id  uuid;
  fa_id  uuid;
  ll_id  uuid;
begin

  -- ── 1st level ─────────────────────────────────────────────────────────
  insert into public.categories (name, parent_id, level) values ('Health & Wellness', null, 1) returning id into hw_id;
  insert into public.categories (name, parent_id, level) values ('Relationships',     null, 1) returning id into rel_id;
  insert into public.categories (name, parent_id, level) values ('Work & Career',     null, 1) returning id into wc_id;
  insert into public.categories (name, parent_id, level) values ('Learning & Growth', null, 1) returning id into lg_id;
  insert into public.categories (name, parent_id, level) values ('Finances & Assets', null, 1) returning id into fa_id;
  insert into public.categories (name, parent_id, level) values ('Lifestyle & Leisure', null, 1) returning id into ll_id;

  -- ── 2nd level: Health & Wellness ──────────────────────────────────────
  insert into public.categories (name, parent_id, level) values
    ('fitness',       hw_id, 2),
    ('medical',       hw_id, 2),
    ('nutrition',     hw_id, 2),
    ('sleep',         hw_id, 2),
    ('mental health', hw_id, 2);

  -- ── 2nd level: Relationships ───────────────────────────────────────────
  insert into public.categories (name, parent_id, level) values
    ('family',        rel_id, 2),
    ('friends',       rel_id, 2),
    ('social events', rel_id, 2),
    ('contacts',      rel_id, 2);

  -- ── 2nd level: Work & Career ───────────────────────────────────────────
  insert into public.categories (name, parent_id, level) values
    ('projects',                wc_id, 2),
    ('meetings',                wc_id, 2),
    ('ideas',                   wc_id, 2),
    ('professional development', wc_id, 2);

  -- ── 2nd level: Learning & Growth ──────────────────────────────────────
  insert into public.categories (name, parent_id, level) values
    ('books',      lg_id, 2),
    ('courses',    lg_id, 2),
    ('skills',     lg_id, 2),
    ('research',   lg_id, 2),
    ('journaling', lg_id, 2);

  -- ── 2nd level: Finances & Assets ──────────────────────────────────────
  insert into public.categories (name, parent_id, level) values
    ('budget',      fa_id, 2),
    ('investments', fa_id, 2),
    ('possessions', fa_id, 2),
    ('bills',       fa_id, 2);

  -- ── 2nd level: Lifestyle & Leisure ────────────────────────────────────
  insert into public.categories (name, parent_id, level) values
    ('hobbies',       ll_id, 2),
    ('travel',        ll_id, 2),
    ('food',          ll_id, 2),
    ('entertainment', ll_id, 2),
    ('home',          ll_id, 2);

end $$;
