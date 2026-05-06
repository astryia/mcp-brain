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

const app = new Hono()
app.use('*', rateLimit)
app.use('*', bearerAuth({ token: BRAIN_SECRET }))

app.all('/', async (c) => {
  const transport = new StreamableHTTPTransport()
  await server.connect(transport)
  return transport.handleRequest(c)
})

// @ts-ignore Deno global
Deno.serve(app.fetch)
