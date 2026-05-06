import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { supabase } from '../lib/supabase.ts'
import { embed } from '../lib/embed.ts'
import { safeError } from '../lib/errors.ts'
import { jsonResponse } from '../lib/response.ts'
import {
  categoryPathSchema,
  entityType,
  isoDate,
  MAX_CONTENT_LEN,
  MAX_ENTITIES_PER_MEMORY,
  MAX_NAME_LEN,
  MAX_SUBTYPE_LEN,
  memoryType,
  propertiesSchema,
} from '../lib/schemas.ts'

type NewEntity = {
  name: string
  type: string
  subtype?: string
  properties?: Record<string, unknown>
}

export function register(server: McpServer) {
  server.registerTool(
    'add_memory',
    {
      title: 'Add Memory',
      description:
        'Store a memory, note, reminder, or idea. ' +
        'Before calling: (1) Use list_categories to navigate the category tree and find the right path. ' +
        '(2) Use search_entities for every person, place, or thing mentioned — pass their IDs to avoid duplicates. ' +
        'Only set create:true on an entity object when search_entities returned no good match.',
      inputSchema: {
        content: z.string().trim().min(1).max(MAX_CONTENT_LEN).describe('The memory content'),
        type: memoryType,
        category_path: categoryPathSchema.describe(
          'Category path from root, e.g. ["Work & Career", "projects"]',
        ),
        due_date: isoDate.optional().describe('ISO 8601 due date/time for reminders'),
        entities: z
          .array(
            z.union([
              z.object({ id: z.string().uuid() }).describe('Resolved entity — pass only id'),
              z
                .object({
                  name: z.string().trim().min(1).max(MAX_NAME_LEN),
                  type: entityType,
                  subtype: z.string().trim().min(1).max(MAX_SUBTYPE_LEN).optional(),
                  properties: propertiesSchema.optional(),
                })
                .describe('New entity to create — only when search_entities found no match'),
            ]),
          )
          .max(MAX_ENTITIES_PER_MEMORY)
          .optional()
          .describe('Entities mentioned in this memory'),
      },
    },
    async ({ content, type, category_path, due_date, entities }) => {
      // Resolve category path → category_id
      const { data: categoryId, error: catError } = await supabase.rpc(
        'resolve_category_path',
        { path: category_path },
      )
      if (catError) safeError('add_memory.category', catError.message)

      const embedding = await embed(content)

      const { data: memory, error: memError } = await supabase
        .from('memories')
        .insert({
          content,
          type,
          category_id: categoryId,
          due_date: due_date ?? null,
          embedding,
        })
        .select('id')
        .single()

      if (memError) safeError('add_memory.insert', memError.message)
      const memoryId = memory!.id as string

      try {
        if (entities && entities.length > 0) {
          await linkEntities(memoryId, entities)
        }
      } catch (err) {
        // Compensating delete — best-effort. Logs but does not mask original.
        const { error: cleanupErr } = await supabase
          .from('memories')
          .delete()
          .eq('id', memoryId)
        if (cleanupErr) console.error('[mcp-brain:add_memory.cleanup]', cleanupErr.message)
        throw err
      }

      return jsonResponse({ id: memoryId, message: 'Memory saved.' })
    },
  )
}

async function linkEntities(
  memoryId: string,
  entities: ReadonlyArray<{ id: string } | NewEntity>,
) {
  const newEntities = entities.filter((e) => !('id' in e)) as NewEntity[]

  // Embed all new entities in parallel.
  const newEmbeddings = await Promise.all(
    newEntities.map((e) => embed(e.subtype ? `${e.name} ${e.subtype}` : e.name)),
  )

  const newEntityIds: string[] = []
  if (newEntities.length > 0) {
    const rows = newEntities.map((e, i) => ({
      name: e.name,
      type: e.type,
      subtype: e.subtype ?? null,
      properties: e.properties ?? null,
      embedding: newEmbeddings[i],
    }))
    const { data: inserted, error: entError } = await supabase
      .from('entities')
      .insert(rows)
      .select('id')
    if (entError) safeError('add_memory.entity_insert', entError.message)
    for (const row of inserted ?? []) newEntityIds.push((row as { id: string }).id)
  }

  // Reassemble in original order (cheap, but keeps debug logs sensible).
  const entityIds: string[] = []
  let newIx = 0
  for (const e of entities) {
    if ('id' in e) entityIds.push(e.id)
    else entityIds.push(newEntityIds[newIx++])
  }

  if (entityIds.length === 0) return

  const { error: linkError } = await supabase.from('memory_entities').upsert(
    entityIds.map((eid) => ({ memory_id: memoryId, entity_id: eid })),
    { onConflict: 'memory_id,entity_id' },
  )
  if (linkError) safeError('add_memory.link', linkError.message)
}
