import { createClient } from 'jsr:@supabase/supabase-js@2'
import { SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from './env.ts'

// Service role client — bypasses RLS. RLS is still enabled on every table
// as defense-in-depth (see migration 004).
export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
