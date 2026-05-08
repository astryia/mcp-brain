import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { supabase } from '../lib/supabase.ts'
import { safeError } from '../lib/errors.ts'
import { jsonResponse } from '../lib/response.ts'

export function register(server: McpServer) {
  server.registerTool(
    'list_categories',
    {
      title: 'List Categories',
      description:
        'Returns the full 2-level category tree in one call. ' +
        'The vocabulary is fixed — use the closest existing path; do not invent categories. ' +
        'Each row is { id, name, level, parent_id }; level 1 rows have parent_id = null.',
      inputSchema: {},
    },
    async () => {
      const { data, error } = await supabase
        .from('categories')
        .select('id, name, level, parent_id')
        .order('level')
        .order('name')

      if (error) safeError('list_categories', error.message)

      return jsonResponse(data ?? [], true)
    },
  )
}
