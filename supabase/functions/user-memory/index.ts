// @ts-ignore Supabase Edge Runtime type definitions
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPTransport } from '@hono/mcp'
import { Hono } from 'hono'

import { auth } from './lib/auth.ts'
import { rateLimit } from './lib/rate-limit.ts'
import { registerAllTools } from './tools/index.ts'

const server = new McpServer({ name: 'user-memory', version: '2.0.0' }, {
  instructions: `
Personal second brain. One concept: **Memory** — anything the user wants stored.

Each memory has a **type** (what it is) and a **category** (where it lives).
These two filters are the primary "context walls" — use them aggressively
on every search to avoid topic collisions.

## Memory types (pick one)
- **fact** — durable truth about the world ("daughter's pediatrician is Dr. Lee")
- **preference** — taste / opinion ("daughter loves Dr. Seuss")
- **memory** — something that happened ("worked on Delta Lake today")
- **task** — to-do; set due_date for time-bound items; mark completed via update_memory
- **note** — reference material, recipes, addresses, snippets, ideas

## Categories
Fixed 2-level vocabulary. Call **list_categories** once per session to learn
the tree, then pick the closest existing path. Never invent categories — the
DB will reject unknown segments.

## Storing — policy
- Store only when the user asks or the info is clearly worth recalling.
- Prefer **update_memory** over a near-duplicate.
- **delete_memory** only to correct mistakes or on explicit request (soft-delete).
- Use **created_at** to backfill past events ("sprint started 5 days ago"),
  so temporal queries work correctly.

## Retrieving — REQUIRED patterns

**Always pass category_path or type as a filter.** Pure semantic search
collides easily (a doctor's appointment will pull in a "favorite Dr. Seuss
book" preference). Filter first, search within scope.

**Two-step temporal retrieval** for "what did I do during X?" questions:
1. Find the temporal anchor — e.g. search_memories(query: "sprint 6.59 started").
   Read its created_at and (if present) due_date to bound the window.
2. Fetch the window — search_memories(date_from, date_to, category_path: ["Work & Career"]).

**Scoping examples**:
- "Schedule daughter's checkup" → search type=task, category_path=["Health & Wellness", "medical"].
- "What does daughter like to read?" → search type=preference, category_path=["Lifestyle & Leisure"].
- "Open work tasks" → search type=task, category_path=["Work & Career"], include_completed=false.
`.trim(),
})
registerAllTools(server)

// Single transport — connect once, reuse for all requests.
const transport = new StreamableHTTPTransport()
await server.connect(transport)

const app = new Hono()
app.use('*', rateLimit)
app.use('*', auth)

// Health-check — GET with no body, skips MCP handling.
app.get('*', (c) => c.json({ status: 'ok', service: 'user-memory', version: '2.0.0' }))

// MCP — match any path because Supabase forwards the full URL path
// (e.g. /functions/v1/user-memory), not just "/".
app.post('*', async (c) => {
  // Cursor and Claude Desktop don't always send the Accept header that
  // StreamableHTTPTransport requires. Patch it in if missing.
  if (!c.req.header('accept')?.includes('text/event-stream')) {
    const headers = new Headers(c.req.raw.headers)
    headers.set('Accept', 'application/json, text/event-stream')
    const patched = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
      // @ts-ignore duplex required for streaming body in Deno
      duplex: 'half',
    })
    Object.defineProperty(c.req, 'raw', { value: patched, writable: true })
  }

  return transport.handleRequest(c)
})

// @ts-ignore Deno global
Deno.serve(app.fetch)
