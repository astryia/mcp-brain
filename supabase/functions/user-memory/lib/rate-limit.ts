// Lightweight in-memory token-bucket rate limiter (per-IP).
// The Edge Function may run as multiple isolates so this isn't perfect,
// but it stops easy brute-forcing of BRAIN_SECRET and accidental floods.

import type { Context, Next } from 'hono'

const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 120
const MAX_TRACKED_IPS = 1024

const buckets = new Map<string, { count: number; resetAt: number }>()

function clientIp(c: Context): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
    c.req.header('x-real-ip') ||
    'unknown'
  )
}

export async function rateLimit(c: Context, next: Next) {
  const ip = clientIp(c)
  const now = Date.now()
  const bucket = buckets.get(ip)
  if (!bucket || bucket.resetAt < now) {
    buckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
  } else {
    bucket.count++
    if (bucket.count > RATE_LIMIT_MAX) {
      return c.text('rate limit exceeded', 429)
    }
  }
  if (buckets.size > MAX_TRACKED_IPS) {
    for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k)
  }
  await next()
}
