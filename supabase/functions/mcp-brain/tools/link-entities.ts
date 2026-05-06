import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { supabase } from '../lib/supabase.ts'
import { safeError } from '../lib/errors.ts'
import { jsonResponse } from '../lib/response.ts'
import { MAX_RELATION_LEN } from '../lib/schemas.ts'

export function register(server: McpServer) {
  server.registerTool(
    'link_entities',
    {
      title: 'Link Entities',
      description:
        'Create a directional relationship between two entities. ' +
        'Use a verb phrase for relation, e.g. "teaches", "is parent of", "owns", "works at".',
      inputSchema: {
        entity_a_id: z.string().uuid().describe('Subject entity ID'),
        relation: z
          .string()
          .trim()
          .min(1)
          .max(MAX_RELATION_LEN)
          .describe('Verb phrase describing the relationship'),
        entity_b_id: z.string().uuid().describe('Object entity ID'),
      },
    },
    async ({ entity_a_id, relation, entity_b_id }) => {
      if (entity_a_id === entity_b_id) {
        throw new Error('cannot link an entity to itself')
      }
      const { data, error } = await supabase
        .from('entity_relationships')
        .upsert(
          { entity_a_id, relation, entity_b_id },
          { onConflict: 'entity_a_id,relation,entity_b_id' },
        )
        .select('id')
        .single()

      if (error) safeError('link_entities', error.message)

      return jsonResponse({ id: data!.id, message: 'Relationship created.' })
    },
  )
}
