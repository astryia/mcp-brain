import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { supabase } from '../lib/supabase.ts'
import { safeError } from '../lib/errors.ts'
import { jsonResponse } from '../lib/response.ts'

export function register(server: McpServer) {
  server.registerTool(
    'get_entity',
    {
      title: 'Get Entity',
      description: 'Retrieve a specific entity by ID including all its relationships and linked memory count.',
      inputSchema: {
        id: z.string().uuid(),
      },
    },
    async ({ id }) => {
      const [entityResult, relAResult, relBResult, memCountResult] = await Promise.all([
        supabase
          .from('entities')
          .select('id, name, type, subtype, properties, created_at, updated_at')
          .eq('id', id)
          .maybeSingle(),
        // Subject side: this → relation → B. Hint by FK column name.
        supabase
          .from('entity_relationships')
          .select('id, relation, entity_b_id, entities!entity_b_id(name, type, subtype)')
          .eq('entity_a_id', id),
        // Object side: A → relation → this.
        supabase
          .from('entity_relationships')
          .select('id, relation, entity_a_id, entities!entity_a_id(name, type, subtype)')
          .eq('entity_b_id', id),
        supabase
          .from('memory_entities')
          .select('memory_id', { count: 'exact', head: true })
          .eq('entity_id', id),
      ])

      if (entityResult.error) safeError('get_entity', entityResult.error.message)
      if (!entityResult.data) throw new Error('entity not found')
      if (relAResult.error) safeError('get_entity.outgoing', relAResult.error.message)
      if (relBResult.error) safeError('get_entity.incoming', relBResult.error.message)
      if (memCountResult.error) safeError('get_entity.count', memCountResult.error.message)

      return jsonResponse(
        {
          ...entityResult.data,
          outgoing_relationships: relAResult.data ?? [],
          incoming_relationships: relBResult.data ?? [],
          linked_memory_count: memCountResult.count ?? 0,
        },
        true,
      )
    },
  )
}
