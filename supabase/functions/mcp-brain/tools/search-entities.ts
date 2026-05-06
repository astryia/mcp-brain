import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { supabase } from '../lib/supabase.ts'
import { embed } from '../lib/embed.ts'
import { safeError } from '../lib/errors.ts'
import { jsonResponse } from '../lib/response.ts'
import { entityType, MAX_NAME_LEN } from '../lib/schemas.ts'

export function register(server: McpServer) {
  server.registerTool(
    'search_entities',
    {
      title: 'Search Entities',
      description:
        'Hybrid semantic + full-text search for entities (people, places, objects, events, concepts). ' +
        'ALWAYS call this before add_memory when the memory mentions specific people, places, or things. ' +
        'Use the returned entity IDs in add_memory to avoid creating duplicates. ' +
        'If multiple entities match (e.g. two people named "Mr Smith"), inspect subtype and properties to pick the right one.',
      inputSchema: {
        query: z.string().trim().min(1).max(MAX_NAME_LEN).describe('Name or description to search for'),
        type: entityType.optional().describe('Filter by entity type'),
        limit: z.number().int().min(1).max(20).optional().default(5),
      },
    },
    async ({ query, type, limit }) => {
      const queryEmbedding = await embed(query)

      const { data, error } = await supabase.rpc('hybrid_search_entities', {
        query_text: query,
        query_embedding: queryEmbedding,
        match_count: limit,
        filter_type: type ?? null,
      })

      if (error) safeError('search_entities', error.message)

      return jsonResponse(data ?? [], true)
    },
  )
}
