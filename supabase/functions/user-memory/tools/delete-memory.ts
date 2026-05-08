import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { supabase } from '../lib/supabase.ts'
import { safeError } from '../lib/errors.ts'
import { jsonResponse } from '../lib/response.ts'

export function register(server: McpServer) {
  server.registerTool(
    'delete_memory',
    {
      title: 'Delete Memory',
      description: 'Soft-delete a memory (sets deleted_at). It will no longer appear in search results.',
      inputSchema: {
        id: z.string().uuid(),
      },
    },
    async ({ id }) => {
      const { data, error } = await supabase
        .from('memories')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id)
        .is('deleted_at', null)
        .select('id')
        .maybeSingle()

      if (error) safeError('delete_memory', error.message)
      if (!data) throw new Error('memory not found or already deleted')

      return jsonResponse({ id, message: 'Memory deleted.' })
    },
  )
}
