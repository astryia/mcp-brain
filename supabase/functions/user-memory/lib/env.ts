// Centralised env loader. Fails fast on misconfiguration so a missing var
// can never silently disable auth or reach Supabase as undefined.

export function requireEnv(name: string, minLength = 1): string {
  const value = Deno.env.get(name)
  if (!value || value.length < minLength) {
    throw new Error(`env ${name} is missing or too short (min ${minLength} chars)`)
  }
  return value
}

export const SUPABASE_URL = requireEnv('SUPABASE_URL')
export const SUPABASE_SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY', 32)
export const BRAIN_SECRET = requireEnv('BRAIN_SECRET', 32)
