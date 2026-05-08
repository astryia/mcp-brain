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
    'add_memory',
    {
      title: 'Add Memory',
      description:
        'Store a fact, preference, memory, task, or note. ' +
        'Before calling: call list_categories once to see the (fixed) vocabulary, then pick the closest path. ' +
        'Type guidance: ' +
        'fact = durable truth, preference = taste/opinion, memory = something that happened, ' +
        'task = to-do (set due_date for time-bound items), note = reference material / ideas. ' +
        'Use created_at to backfill items that happened in the past (e.g. "sprint started 5 days ago"). ' +
        'Defaults to now() when omitted.',
      inputSchema: {
        content: z.string().trim().min(1).max(MAX_CONTENT_LEN).describe('The memory content'),
        type: memoryType,
        category_path: categoryPathSchema.describe(
          'Category path from root, e.g. ["Work & Career", "projects"]. Max 2 levels. Vocabulary is fixed.',
        ),
        due_date: isoDate.optional().describe('ISO 8601 due date/time (typically with type=task)'),
        created_at: isoDate
          .optional()
          .describe('ISO 8601 — override the creation timestamp to backfill past events. Must be <= now().'),
      },
    },
    async ({ content, type, category_path, due_date, created_at }) => {
      if (created_at && new Date(created_at).getTime() > Date.now()) {
        throw new Error('created_at cannot be in the future')
      }

      const { data: categoryId, error: catError } = await supabase.rpc(
        'resolve_category_path',
        { path: category_path },
      )
      if (catError) safeError('add_memory.category', catError.message)

      const embedding = await embed(content)

      const row: Record<string, unknown> = {
        content,
        type,
        category_id: categoryId,
        due_date: due_date ?? null,
        embedding,
      }
      if (created_at) row.created_at = created_at

      const { data: memory, error: memError } = await supabase
        .from('memories')
        .insert(row)
        .select('id')
        .single()

      if (memError) safeError('add_memory.insert', memError.message)

      return jsonResponse({ id: memory!.id, message: 'Memory saved.' })
    },
  )
}
