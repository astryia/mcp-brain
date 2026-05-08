---
name: user-memory
description: Always-on personal memory for this user — stores and retrieves facts, preferences, past events, tasks, and notes; loads the user's writing/code/communication style preferences at session start so all assistant output matches their voice. Activate at the beginning of every conversation; consult on every recall question, every storage intent, every slash command (/remember, /note, /remind, /fact, /prefer, /recall, /due, /done, /forget, /categories, /memory), and before producing any text on the user's behalf (emails, Jira, PR descriptions, support replies, technical writing).
---

# user-memory

The user's persistent personal memory. Not workspace knowledge, not general
knowledge — only what the user has chosen to store.

## SESSION BOOTSTRAP — do this BEFORE generating any text on the user's behalf

Run **once per session**, before the first user-facing reply:

```
search_memories(
  query: "style",
  type: "preference",
  category_path: ["Assistant Preferences"],
  limit: 50
)
```

Treat the returned content as **standing instructions** for tone, voice,
formatting, and code style for the entire conversation. Apply them to every
email draft, Jira comment, PR description, code change, and reply.

These meta-preferences live in their own category tree (`Assistant Preferences > {writing, code, communication}`) and are never mixed with personal preferences (food, books, music) which live elsewhere.

---

## Model

A `memory` has a `type` (what it is) and a `category` (where it lives). Both fields are **context walls** — every search must filter on at least one or unrelated topics collide.

### Types
| Type | Use for | Example |
|---|---|---|
| `fact` | durable truth | "daughter's pediatrician is Dr. Lee" |
| `preference` | taste / opinion / style | "prefer concise, technical wording for Jira" |
| `memory` | something that happened | "worked on Delta Lake today" |
| `task` | to-do (set `due_date` if time-bound) | "call Dr Patel re: lab results" |
| `note` | reference material, recipes, addresses, ideas | recipe, phone number, snippet |

### Categories
Fixed 2-level vocabulary. **Never invent.** Top-level: `Health & Wellness`, `Relationships`, `Work & Career`, `Learning & Growth`, `Finances & Assets`, `Lifestyle & Leisure`, `Assistant Preferences`. Call `list_categories` once to learn the full tree.

---

## When to USE this skill

Search/store on any of:
- **Recall language** — "what did I…", "when did I…", "do I have…", "remind me…", "what's my…", "did I ever…", "last time I…", "what's the status of…", "open tasks", "anything due…".
- **Storage intent** — "remember…", "save this", "note that…", "remind me to…", "I prefer…", "from now on…".
- **Slash command** — `/remember`, `/note`, `/remind`, `/fact`, `/prefer`, `/idea`, `/recall`, `/due`, `/done`, `/forget`, `/categories`, `/memory`.
- **Producing text on the user's behalf** — emails, Jira/PR/issue comments, support replies, technical writing. Bootstrap-loaded preferences must apply.
- **Topic that may have stored history** — project, person, decision, recurring theme. Search first; fall back to general knowledge only if no hits.

When in doubt: a wasted `search_memories` call is cheap; a missed memory is the bug.

---

## Slash commands

| Command | Maps to |
|---|---|
| `/remember <text>` | `add_memory(type:"memory")` |
| `/fact <text>` | `add_memory(type:"fact")` |
| `/prefer <text>` | `add_memory(type:"preference")` — file under `Assistant Preferences > {writing\|code\|communication}` if it governs assistant behavior; otherwise pick the personal-life category. |
| `/note <text>` / `/idea <text>` | `add_memory(type:"note")` |
| `/remind <text> @ <when>` | `add_memory(type:"task", due_date)` |
| `/recall <query>` | `search_memories(query, …)` — pass scope |
| `/due [today\|week\|<range>]` | `search_memories(type:"task", due_date_from, due_date_to, include_completed:false)` |
| `/done <id\|description>` | `update_memory(id, completed:true)` |
| `/forget <id\|description>` | `delete_memory(id)` (soft delete) |
| `/categories` | `list_categories()` |
| `/memory` | acknowledge mode; ask what to store or recall |

---

## REQUIRED rules

1. **Run the session bootstrap** before any user-facing output.
2. **Always scope `search_memories`** with `category_path` or `type` — never query alone.
3. **Never invent UUIDs or category names.** Get IDs from a search/list; if no category fits, file under the closest level-1 parent.
4. **Tasks with deadlines need `due_date`** in ISO 8601 with offset.
5. **Search before storing** if a near-duplicate might exist; prefer `update_memory` over duplicates.
6. **`delete_memory` only on explicit user request** or to correct a mistake (it's a soft delete).
7. **Style/tone/code preferences belong under `Assistant Preferences`**, not under personal-life categories — otherwise the bootstrap won't find them.

---

## Pattern: "what did I do during X?" — two-step temporal retrieval

Never keyword-grep across time. Always:

1. **Find the anchor**: `search_memories("X started", type:"memory")` → read `created_at` and (if present) `due_date` to bound the window.
2. **Fetch the window**: `search_memories(query, date_from, date_to, category_path)`.

> Example — "what did I work on this sprint?"
> 1. `search_memories("sprint 6.59 started", type:"memory", category_path:["Work & Career"])` → anchor.created_at = `2026-05-06`, anchor.due_date = `2026-05-20`.
> 2. `search_memories("work done", date_from:"2026-05-06", date_to:"2026-05-20", category_path:["Work & Career"])`.

---

## Pattern: backfilling past events

When the user reports something that happened earlier, set `created_at` so temporal retrieval finds it.

> "Sprint 6.59 started 5 days ago" → `add_memory(content:"Sprint 6.59 started.", type:"memory", category_path:["Work & Career","projects"], created_at:"2026-05-03T09:00:00-04:00")`.

---

## Scoping examples (the anti-collision rule)

| User intent | Correct scope |
|---|---|
| "Schedule daughter's checkup" | `type:"task", category_path:["Health & Wellness","medical"]` |
| "What does daughter like to read?" | `type:"preference", category_path:["Lifestyle & Leisure"]` |
| "Open work tasks" | `type:"task", category_path:["Work & Career"], include_completed:false` |
| "Doctor's phone number" | `type:"fact", category_path:["Health & Wellness","medical"]` |
| "Draft a Jira comment about X" | bootstrap-loaded `Assistant Preferences > writing` + `communication` apply automatically; then proceed |
