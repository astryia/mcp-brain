import { z } from 'zod'
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
        'Returns categories one level at a time (progressive disclosure). ' +
        'Call with no args to get 1st-level categories. ' +
        'Pass a 1st-level id to get its 2nd-level children. ' +
        'Pass a 2nd-level id to get its 3rd-level children. ' +
        'Always call this progressively before add_memory to pick the closest existing path and avoid creating duplicate categories.',
      inputSchema: {
        parent_id: z.string().uuid().optional().describe('ID of parent category. Omit for top-level.'),
      },
    },
    async ({ parent_id }) => {
      let q = supabase
        .from('categories')
        .select('id, name, level')
        .order('name')
      q = parent_id ? q.eq('parent_id', parent_id) : q.is('parent_id', null)

      const { data, error } = await q
      if (error) safeError('list_categories', error.message)

      const rows = (data ?? []) as { id: string; name: string; level: number }[]
      const ids = rows.map((c) => c.id)

      let childSet = new Set<string>()
      if (ids.length > 0) {
        const { data: children, error: childErr } = await supabase
          .from('categories')
          .select('parent_id')
          .in('parent_id', ids)
        if (childErr) safeError('list_categories', childErr.message)
        childSet = new Set(
          ((children ?? []) as { parent_id: string }[]).map((c) => c.parent_id),
        )
      }

      const categories = rows.map((c) => ({
        id: c.id,
        name: c.name,
        level: c.level,
        has_children: childSet.has(c.id),
      }))

      return jsonResponse(categories, true)
    },
  )
}
