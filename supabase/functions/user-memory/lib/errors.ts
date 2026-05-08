// Map a thrown value (or PostgREST error) to a generic, non-leaky message
// for the client. Original is logged server-side with a scope tag.

export function safeError(scope: string, err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`[user-memory:${scope}]`, msg)
  throw new Error(`${scope} failed`)
}
