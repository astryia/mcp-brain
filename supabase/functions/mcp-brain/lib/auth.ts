// Accepts the secret from either:
//   Authorization: Bearer <token>   (Cursor, Claude Desktop, SDK)
//   ?key=<token>                    (claude.ai — no custom headers support)

import type { Context, Next } from 'hono'
import { BRAIN_SECRET } from './env.ts'

export async function auth(c: Context, next: Next) {
  const authHeader = c.req.header('authorization') ?? ''
  const fromHeader = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  const fromQuery = c.req.query('key') ?? null
  const token = fromHeader ?? fromQuery

  if (!token || token !== BRAIN_SECRET) {
    return c.text('Unauthorized', 401)
  }
  await next()
}
