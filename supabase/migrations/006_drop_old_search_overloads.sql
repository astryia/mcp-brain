-- Migration 005 added a new parameter (semantic_threshold) to both hybrid
-- search functions via CREATE OR REPLACE. In PostgreSQL, changing the
-- parameter list creates a NEW overload instead of replacing the old one.
-- This leaves two versions of each function, causing PostgREST to throw
-- "Could not choose the best candidate function" (ambiguous function error).
--
-- This migration drops the old 13-param / 7-param signatures so only the
-- new 14-param / 8-param versions (with semantic_threshold) remain.

drop function if exists public.hybrid_search_memories(
  text, extensions.vector(384), int, uuid, text,
  timestamptz, timestamptz, timestamptz, timestamptz,
  boolean, float, float, int
);

drop function if exists public.hybrid_search_entities(
  text, extensions.vector(384), int, text, float, float, int
);
