// @ts-ignore Supabase Edge Runtime type definitions
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPTransport } from '@hono/mcp'
import { Hono } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'

import { BRAIN_SECRET } from './lib/env.ts'
import { rateLimit } from './lib/rate-limit.ts'
import { registerAllTools } from './tools/index.ts'

const server = new McpServer({ name: 'mcp-brain', version: '1.0.0' })
registerAllTools(server)

// Single transport — connect once, reuse for all requests.
const transport = new StreamableHTTPTransport()
await server.connect(transport)

const app = new Hono()
app.use('*', rateLimit)
app.use('*', bearerAuth({ token: BRAIN_SECRET }))

// Health-check — GET with no body, skips MCP handling.
app.get('*', (c) => c.json({ status: 'ok', service: 'mcp-brain', version: '1.0.0' }))

// MCP — match any path because Supabase forwards the full URL path
// (e.g. /functions/v1/mcp-brain), not just "/".
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
