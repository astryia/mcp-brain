import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { supabase } from '../lib/supabase.ts'
import { embed } from '../lib/embed.ts'
import { safeError } from '../lib/errors.ts'
import { jsonResponse } from '../lib/response.ts'
import {
  entityType,
  MAX_NAME_LEN,
  MAX_SUBTYPE_LEN,
  propertiesSchema,
} from '../lib/schemas.ts'

export function register(server: McpServer) {
  server.registerTool(
    'add_entity',
    {
      title: 'Add Entity',
      description:
        'Explicitly create a new entity. Use search_entities first to confirm it does not already exist.',
      inputSchema: {
        name: z.string().trim().min(1).max(MAX_NAME_LEN),
        type: entityType,
        subtype: z
          .string()
          .trim()
          .min(1)
          .max(MAX_SUBTYPE_LEN)
          .optional()
          .describe('e.g. "teacher", "life coach", "car"'),
        properties: propertiesSchema
          .optional()
          .describe('Any additional structured attributes as key-value pairs'),
      },
    },
    async ({ name, type, subtype, properties }) => {
      const entityText = subtype ? `${name} ${subtype}` : name
      const embedding = await embed(entityText)

      const { data, error } = await supabase
        .from('entities')
        .insert({
          name,
          type,
          subtype: subtype ?? null,
          properties: properties ?? null,
          embedding,
        })
        .select('id, name, type, subtype')
        .single()

      if (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new Error('entity with this name/type/subtype already exists')
        }
        safeError('add_entity', error.message)
      }

      return jsonResponse(data)
    },
  )
}
