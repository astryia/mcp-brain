// @ts-ignore Supabase Edge Runtime type definitions
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPTransport } from '@hono/mcp'
import { Hono } from 'hono'

import { auth } from './lib/auth.ts'
import { rateLimit } from './lib/rate-limit.ts'
import { registerAllTools } from './tools/index.ts'

const server = new McpServer({ name: 'user-memory', version: '2.1.0' }, {
  instructions: `
The user's persistent personal memory. Each memory has a **type** (fact,
preference, memory, task, note) and a **category** (fixed 2-level vocabulary).

## SESSION BOOTSTRAP — do this BEFORE generating any text on the user's behalf
Call once per session:
  search_memories(query:"style", type:"preference", category_path:["Assistant Preferences"], limit:50)
Treat results as standing instructions for tone, voice, formatting, and code style
for the entire conversation.

## Required rules
- Always pass category_path or type to search_memories — never query alone.
  Pure semantic search collides (e.g. "schedule daughter's checkup" pulls in
  "daughter loves Dr. Seuss").
- Categories are fixed: list_categories returns the full tree in one call.
  Never invent segments — the DB rejects unknown ones.
- Tasks with deadlines need due_date (ISO 8601 with offset).
- Use add_memory's created_at to backfill past events ("X started 5 days ago").

## "What did I do during X?" — two-step temporal pattern
1. Find the anchor: search_memories("X started", type:"memory") → read created_at + due_date.
2. Fetch the window: search_memories(date_from, date_to, category_path).
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
app.get('*', (c) => c.json({ status: 'ok', service: 'user-memory', version: '2.1.0' }))

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
