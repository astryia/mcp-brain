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
    'search_memories',
    {
      title: 'Search Memories',
      description:
        'Hybrid semantic + full-text search across all memories. ' +
        'ALWAYS pass at least one of category_path or type to scope the query — ' +
        'this prevents collisions between unrelated topics (e.g. medical scheduling vs. literary preferences). ' +
        'For "what did I work on between dates X and Y?" patterns, use date_from/date_to with category_path; ' +
        'find a temporal anchor first (e.g. "sprint 6.59 started") to determine the date range.',
      inputSchema: {
        query: z.string().trim().min(1).max(MAX_CONTENT_LEN).describe('What to search for'),
        category_path: categoryPathSchema
          .optional()
          .describe('Filter to a category path, e.g. ["Work & Career"] or ["Work & Career", "projects"]'),
        type: memoryType.optional().describe('Filter by memory type (fact, preference, memory, task, note)'),
        date_from: isoDate.optional().describe('ISO 8601 — memories created on/after this date'),
        date_to: isoDate.optional().describe('ISO 8601 — memories created on/before this date'),
        due_date_from: isoDate.optional().describe('ISO 8601 — tasks with due date on/after this'),
        due_date_to: isoDate.optional().describe('ISO 8601 — tasks with due date on/before this'),
        include_completed: z
          .boolean()
          .optional()
          .default(false)
          .describe('Include completed tasks (default: false)'),
        limit: z.number().int().min(1).max(50).optional().default(10),
      },
    },
    async ({
      query,
      category_path,
      type,
      date_from,
      date_to,
      due_date_from,
      due_date_to,
      include_completed,
      limit,
    }) => {
      let categoryId: string | null = null
      if (category_path && category_path.length > 0) {
        const { data, error } = await supabase.rpc('resolve_category_path', {
          path: category_path,
        })
        if (error) safeError('search_memories.category', error.message)
        categoryId = data
      }

      const queryEmbedding = await embed(query)

      const { data, error } = await supabase.rpc('hybrid_search_memories', {
        query_text: query,
        query_embedding: queryEmbedding,
        match_count: limit,
        filter_category_id: categoryId,
        filter_type: type ?? null,
        filter_date_from: date_from ?? null,
        filter_date_to: date_to ?? null,
        filter_due_from: due_date_from ?? null,
        filter_due_to: due_date_to ?? null,
        include_completed: include_completed ?? false,
      })

      if (error) safeError('search_memories', error.message)

      return jsonResponse(data ?? [], true)
    },
  )
}
