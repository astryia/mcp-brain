<p align="center">
  <img src="https://edrprqdadxspquiuobyj.supabase.co/storage/v1/object/sign/raw/logo.png?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV8xYTAzYjMxNi0wMzhjLTQ4MjgtOWQzYy0zYmVmMjg0OTllZjEiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJyYXcvbG9nby5wbmciLCJpYXQiOjE3NzgyNzUzNzYsImV4cCI6MjA5MzYzNTM3Nn0.8xQyRvEkMohsRYFbFfc1bAVr-tqvbe3Ont1up5kfAgY" alt="user-memory" width="900" />
</p>

# user-memory

[![Deploy to Supabase](https://github.com/astryia/user-memory/actions/workflows/deploy.yml/badge.svg)](https://github.com/astryia/user-memory/actions/workflows/deploy.yml)

A personal **MCP server** that gives an AI assistant long-term memory — facts, preferences, past events, tasks, and notes — backed by Supabase (Postgres + pgvector) with hybrid semantic + full-text search.

## Concept

A single `Memory` with:

- **type** — `fact`, `preference`, `memory`, `task`, `note`
- **category** — fixed 2-level vocabulary (e.g. `Work & Career > projects`)
- **content** — free text, embedded for semantic search
- optional **due_date** (tasks) and **created_at** override (backfill)

Strict per-user RLS. Searches require `type` or `category_path` to avoid semantic collisions.

## Stack

- Supabase Edge Functions (Deno)
- `@modelcontextprotocol/sdk` over Streamable HTTP (Hono)
- Postgres + pgvector, OpenAI embeddings

## Tools

`add_memory`, `update_memory`, `delete_memory`, `search_memories`, `list_categories`.
