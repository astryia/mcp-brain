---
name: user-memory
description: Personal second brain backed by the user-memory MCP server. USE WHENEVER the user asks recall questions ("what did I…", "when did I…", "do I have…", "remind me…", "what's the status of…", "last time I…"), states a fact / preference / decision / deadline worth remembering, mentions a project or topic that may already have history, or asks anything that could be answered by stored context. Covers storing facts, preferences, memories, tasks, and notes; retrieving them via hybrid semantic + full-text search with mandatory category/type scoping.
---

# user-memory — when and how to use it

This MCP is the user's persistent personal memory. It is **not** general
knowledge and **not** workspace-scoped — it is everything *this user* has
chosen to remember about their own life, work, people, and ideas.

One concept: **Memory** — a single piece of content with a `type` (what it
is) and a `category` (where it lives). These two filters are the primary
"context walls" — apply them aggressively on every search to avoid topic
collisions.

---

## Memory types (pick one)

- **fact** — durable truth about the world ("daughter's pediatrician is Dr. Lee").
- **preference** — taste / opinion ("daughter loves Dr. Seuss").
- **memory** — something that happened ("worked on Delta Lake today", "met Maya for coffee").
- **task** — to-do; set `due_date` for time-bound items; mark done via `update_memory(completed:true)`.
- **note** — reference material, recipes, addresses, snippets, ideas.

## Categories

Fixed 2-level vocabulary. **Never invent categories** — the DB rejects unknown
segments. Top-level (seeded): `Health & Wellness`, `Relationships`,
`Work & Career`, `Learning & Growth`, `Finances & Assets`, `Lifestyle & Leisure`.
Call `list_categories` once per session to learn the full tree.

---

## Explicit trigger commands

| Command | Action |
|---|---|
| `/remember <text>` | Store as `memory` (or `fact` if it's a durable truth). Pick category. |
| `/note <text>` | Store as `note`. |
| `/remind <text> @ <when>` | Store as `task` with parsed `due_date`. |
| `/idea <text>` | Store as `note`. |
| `/fact <text>` | Store as `fact`. |
| `/prefer <text>` | Store as `preference`. |
| `/recall <query>` | `search_memories(query, …)` — always pass `category_path` or `type`. |
| `/due [today\|week\|<range>]` | `search_memories(type:"task", due_date_from, due_date_to, include_completed:false)`. |
| `/done <id\|description>` | Resolve to memory id, then `update_memory(id, completed:true)`. |
| `/forget <id\|description>` | Resolve to memory id, then `delete_memory(id)`. |
| `/categories` | `list_categories()`. |
| `/memory` | Acknowledge user-memory mode; ask what to store or recall. |

---

## When to RETRIEVE (the part agents miss)

Treat retrieval as cheap and the default. Search **before** answering or
acting whenever any of these triggers fire.

### Trigger 1 — recall language
"What did I…", "when did I…", "do I have…", "remind me about…",
"what's the status of…", "did I ever…", "last time I…", "what's my…".
→ `search_memories(query, category_path?, type?)`.

### Trigger 2 — topical question that might have stored context
The user asks about a topic they may have written about before — their
preferences, decisions, opinions, prior research, contacts.
→ `search_memories` first; only answer from general knowledge if no hits.

### Trigger 3 — due / time-scoped questions
"What's due this week?", "anything tomorrow?", "open tasks for the project?"
→ `search_memories(query, type:"task", due_date_from, due_date_to, include_completed:false)`.

### Trigger 4 — "what did I do during X?" (two-step temporal pattern)
1. **Find the anchor**: `search_memories("X started", type:"memory")` — read its
   `created_at` and (if present) `due_date` to bound the window.
2. **Fetch the window**: `search_memories(query, date_from, date_to, category_path)`.

> Example — "what did I work on this sprint?":
> 1. `search_memories("sprint 6.59 started", type:"memory", category_path:["Work & Career"])` →
>    anchor.created_at = `2026-05-06`, anchor.due_date = `2026-05-20`.
> 2. `search_memories(query:"work done", date_from:"2026-05-06", date_to:"2026-05-20", category_path:["Work & Career"])`.

If in doubt, **search**. A wasted query is cheap; a missed memory is the bug
the user is complaining about.

---

## REQUIRED scoping rule

**Always pass at least one of `category_path` or `type` to `search_memories`.**

Pure semantic search collides easily. Without scope, "schedule daughter's
checkup" can pull in "daughter loves Dr. Seuss". Filter first, search within
scope:

- "Schedule daughter's checkup" → `type:"task", category_path:["Health & Wellness", "medical"]`.
- "What does daughter like to read?" → `type:"preference", category_path:["Lifestyle & Leisure"]`.
- "Open work tasks" → `type:"task", category_path:["Work & Career"], include_completed:false`.
- "Doctor's phone number" → `type:"fact", category_path:["Health & Wellness", "medical"]`.

---

## When to STORE

Store only when one of:

- The user explicitly asks ("remember that…", "save this", "add a reminder", "note that…").
- The user states a durable fact about themselves, their preferences, their
  people, or their commitments that is clearly worth recalling later.
- The user has a deadline, appointment, or follow-up → store as `task` with `due_date`.

**Do not** store: trivia from the conversation, things the user can re-derive,
anything the user did not endorse.

Prefer **`update_memory`** over creating a near-duplicate. Use **`delete_memory`**
only to correct mistakes or on explicit request (it is a soft delete).

### Backfilling past events

Use `created_at` to record events that happened earlier:

> "Sprint 6.59 started 5 days ago" →
> `add_memory(content:"Sprint 6.59 started.", type:"memory", category_path:["Work & Career", "projects"], created_at:"2026-05-03T09:00:00-04:00")`.

This is essential for the two-step temporal pattern above to work correctly.

---

## Canonical workflows

### Recall: "What was I working on for the InfoNgen release?"
1. `search_memories("InfoNgen sprint started", type:"memory", category_path:["Work & Career"])` → anchor with date range.
2. `search_memories("release work", date_from, date_to, category_path:["Work & Career"])`.
3. Answer from returned content.

### Store: "Remind me to call Dr Patel about lab results next Tuesday at 3pm"
1. `list_categories()` (if not already known) → confirm `["Health & Wellness", "medical"]` exists.
2. `add_memory({ content:"Call Dr Patel about lab results.", type:"task", category_path:["Health & Wellness", "medical"], due_date:"2026-05-12T15:00:00-04:00" })`.

### Store a fact
> "My pediatrician is Dr. Lee at Main St Clinic" →
> `add_memory({ content:"Daughter's pediatrician is Dr. Lee at Main St Clinic.", type:"fact", category_path:["Health & Wellness", "medical"] })`.

### Mark a task done
1. Find it: `search_memories("call Dr Patel", type:"task", include_completed:false)`.
2. `update_memory(id, completed:true)`.

---

## Hard rules

- **Never invent UUIDs.** Obtain `id` from a search/list call.
- **Never invent category names.** The vocabulary is fixed; if nothing fits, file under the closest level-1 parent.
- **Always scope `search_memories`** with `category_path` or `type` — never run it with `query` alone.
- **Tasks with deadlines need `due_date`** in ISO 8601 with offset.
- **For "what did I do during X?" questions, do the two-step temporal retrieval** — don't keyword-grep your way to an answer.
- **Search before answering** any question that could have stored context.
