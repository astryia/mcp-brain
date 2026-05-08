import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { supabase } from '../lib/supabase.ts'
import { embed } from '../lib/embed.ts'
import { safeError } from '../lib/errors.ts'
import { jsonResponse } from '../lib/response.ts'
import {
  categoryPathSchema,
  isoDate,
  MAX_CONTENT_LEN,
  memoryType,
} from '../lib/schemas.ts'

export function register(server: McpServer) {
  server.registerTool(
    'update_memory',
    {
      title: 'Update Memory',
      description:
        'Update content, type, category, due date, or completion status of an existing memory. ' +
        'Set completed=true to mark a task done (records completed_at).',
      inputSchema: {
        id: z.string().uuid(),
        content: z.string().trim().min(1).max(MAX_CONTENT_LEN).optional(),
        type: memoryType.optional(),
        category_path: categoryPathSchema.optional(),
        due_date: isoDate.nullable().optional().describe('ISO 8601 or null to clear'),
        completed: z.boolean().optional().describe('true marks a task done; false unmarks'),
      },
    },
    async ({ id, content, type, category_path, due_date, completed }) => {
      // updated_at is set by a DB trigger.
      const updates: Record<string, unknown> = {}

      if (content !== undefined) {
        updates.content = content
        updates.embedding = await embed(content)
      }
      if (type !== undefined) updates.type = type
      if (due_date !== undefined) updates.due_date = due_date
      if (completed !== undefined) {
        updates.completed_at = completed ? new Date().toISOString() : null
      }
      if (category_path !== undefined) {
        const { data, error } = await supabase.rpc('resolve_category_path', {
          path: category_path,
        })
        if (error) safeError('update_memory.category', error.message)
        updates.category_id = data
      }

      if (Object.keys(updates).length === 0) {
        throw new Error('update_memory requires at least one field to change')
      }

      const { data, error } = await supabase
        .from('memories')
        .update(updates)
        .eq('id', id)
        .is('deleted_at', null)
        .select('id')
        .maybeSingle()

      if (error) safeError('update_memory', error.message)
      if (!data) throw new Error('memory not found')

      return jsonResponse({ id, message: 'Memory updated.' })
    },
  )
}
