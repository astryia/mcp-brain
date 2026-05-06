// @ts-ignore Supabase Edge Runtime type definitions
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPTransport } from '@hono/mcp'
import { Hono } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'zod'

// ─────────────────────────────────────────────────────────────────────────────
// Supabase client (service role — bypasses RLS for personal brain)
// ─────────────────────────────────────────────────────────────────────────────
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

// ─────────────────────────────────────────────────────────────────────────────
// Embedding model (gte-small, 384 dims)
// ─────────────────────────────────────────────────────────────────────────────
// @ts-ignore Supabase Edge Runtime global
const embeddingModel = new Supabase.ai.Session('gte-small')

async function embed(text: string): Promise<number[]> {
  const result = await embeddingModel.run(text, {
    mean_pool: true,
    normalize: true,
  })
  return Array.from(result as Float32Array | number[])
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP Server
// ─────────────────────────────────────────────────────────────────────────────
const server = new McpServer({
  name: 'mcp-brain',
  version: '1.0.0',
})

// ── Tool: list_categories ──────────────────────────────────────────────────
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
    const query = supabase
      .from('categories')
      .select('id, name, level')
      .order('name')

    if (parent_id) {
      query.eq('parent_id', parent_id)
    } else {
      query.is('parent_id', null)
    }

    const { data, error } = await query
    if (error) throw new Error(error.message)

    // Check which categories have children
    const ids = (data ?? []).map((c: { id: string }) => c.id)
    let childSet = new Set<string>()
    if (ids.length > 0) {
      const { data: children } = await supabase
        .from('categories')
        .select('parent_id')
        .in('parent_id', ids)
      childSet = new Set((children ?? []).map((c: { parent_id: string }) => c.parent_id))
    }

    const categories = (data ?? []).map((c: { id: string; name: string; level: number }) => ({
      id: c.id,
      name: c.name,
      level: c.level,
      has_children: childSet.has(c.id),
    }))

    return {
      content: [{ type: 'text', text: JSON.stringify(categories, null, 2) }],
    }
  },
)

// ── Tool: search_entities ─────────────────────────────────────────────────
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
      query: z.string().describe('Name or description to search for'),
      type: z
        .enum(['person', 'place', 'object', 'event', 'concept'])
        .optional()
        .describe('Filter by entity type'),
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

    if (error) throw new Error(error.message)

    return {
      content: [{ type: 'text', text: JSON.stringify(data ?? [], null, 2) }],
    }
  },
)

// ── Tool: add_memory ──────────────────────────────────────────────────────
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
      content: z.string().describe('The memory content'),
      type: z.enum(['memory', 'reminder', 'note', 'idea']),
      category_path: z
        .array(z.string())
        .min(1)
        .describe('Category path from root, e.g. ["Work & Career", "projects"]'),
      due_date: z
        .string()
        .optional()
        .describe('ISO 8601 due date/time for reminders'),
      entities: z
        .array(
          z.union([
            z.object({ id: z.string().uuid() }).describe('Resolved entity — pass only id'),
            z
              .object({
                name: z.string(),
                type: z.enum(['person', 'place', 'object', 'event', 'concept']),
                subtype: z.string().optional(),
                properties: z.record(z.unknown()).optional(),
              })
              .describe('New entity to create — only when search_entities found no match'),
          ]),
        )
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
    if (catError) throw new Error(catError.message)

    // Generate embedding
    const embedding = await embed(content)

    // Insert memory
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

    if (memError) throw new Error(memError.message)

    // Resolve + link entities
    if (entities && entities.length > 0) {
      const entityIds: string[] = []

      for (const e of entities) {
        if ('id' in e) {
          entityIds.push(e.id)
        } else {
          // Create new entity with embedding
          const entityText = e.subtype ? `${e.name} ${e.subtype}` : e.name
          const entityEmbedding = await embed(entityText)

          const { data: newEntity, error: entError } = await supabase
            .from('entities')
            .insert({
              name: e.name,
              type: e.type,
              subtype: e.subtype ?? null,
              properties: e.properties ?? null,
              embedding: entityEmbedding,
            })
            .select('id')
            .single()

          if (entError) throw new Error(entError.message)
          entityIds.push(newEntity.id)
        }
      }

      // Upsert memory_entities links
      if (entityIds.length > 0) {
        const { error: linkError } = await supabase.from('memory_entities').upsert(
          entityIds.map((eid) => ({ memory_id: memory.id, entity_id: eid })),
          { onConflict: 'memory_id,entity_id' },
        )
        if (linkError) throw new Error(linkError.message)
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ id: memory.id, message: 'Memory saved.' }),
        },
      ],
    }
  },
)

// ── Tool: search_memories ─────────────────────────────────────────────────
server.registerTool(
  'search_memories',
  {
    title: 'Search Memories',
    description:
      'Hybrid semantic + full-text search across memories, notes, reminders, and ideas. ' +
      'Filter by category path (partial is fine), type, date ranges, or due date ranges.',
    inputSchema: {
      query: z.string().describe('What to search for'),
      category_path: z
        .array(z.string())
        .optional()
        .describe('Filter to a category path, e.g. ["Work & Career"] or ["Work & Career", "projects"]'),
      type: z.enum(['memory', 'reminder', 'note', 'idea']).optional(),
      date_from: z.string().optional().describe('ISO 8601 — filter memories created after this date'),
      date_to: z.string().optional().describe('ISO 8601 — filter memories created before this date'),
      due_date_from: z.string().optional().describe('ISO 8601 — filter reminders with due date after this'),
      due_date_to: z.string().optional().describe('ISO 8601 — filter reminders with due date before this'),
      include_completed: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include completed reminders (default: false)'),
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
    // Resolve category filter if provided
    let categoryId: string | null = null
    if (category_path && category_path.length > 0) {
      const { data, error } = await supabase.rpc('resolve_category_path', {
        path: category_path,
      })
      if (error) throw new Error(error.message)
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

    if (error) throw new Error(error.message)

    return {
      content: [{ type: 'text', text: JSON.stringify(data ?? [], null, 2) }],
    }
  },
)

// ── Tool: update_memory ───────────────────────────────────────────────────
server.registerTool(
  'update_memory',
  {
    title: 'Update Memory',
    description: 'Update content, type, category, due date, or completion status of an existing memory.',
    inputSchema: {
      id: z.string().uuid(),
      content: z.string().optional(),
      type: z.enum(['memory', 'reminder', 'note', 'idea']).optional(),
      category_path: z.array(z.string()).optional(),
      due_date: z.string().nullable().optional().describe('ISO 8601 or null to clear'),
      completed: z.boolean().optional().describe('true to mark done, false to unmark'),
    },
  },
  async ({ id, content, type, category_path, due_date, completed }) => {
    // Build update payload
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }

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
      if (error) throw new Error(error.message)
      updates.category_id = data
    }

    const { error } = await supabase.from('memories').update(updates).eq('id', id)
    if (error) throw new Error(error.message)

    return {
      content: [{ type: 'text', text: JSON.stringify({ message: 'Memory updated.' }) }],
    }
  },
)

// ── Tool: delete_memory ───────────────────────────────────────────────────
server.registerTool(
  'delete_memory',
  {
    title: 'Delete Memory',
    description: 'Soft-delete a memory (sets deleted_at). It will no longer appear in search results.',
    inputSchema: {
      id: z.string().uuid(),
    },
  },
  async ({ id }) => {
    const { error } = await supabase
      .from('memories')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)

    if (error) throw new Error(error.message)

    return {
      content: [{ type: 'text', text: JSON.stringify({ message: 'Memory deleted.' }) }],
    }
  },
)

// ── Tool: get_entity ──────────────────────────────────────────────────────
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
      supabase.from('entities').select('*').eq('id', id).single(),
      // Relationships where this entity is the subject (A → relation → B)
      supabase
        .from('entity_relationships')
        .select('id, relation, entity_b_id, entities!entity_b_id(name, type, subtype)')
        .eq('entity_a_id', id),
      // Relationships where this entity is the object (A → relation → this)
      supabase
        .from('entity_relationships')
        .select('id, relation, entity_a_id, entities!entity_a_id(name, type, subtype)')
        .eq('entity_b_id', id),
      supabase
        .from('memory_entities')
        .select('memory_id', { count: 'exact', head: true })
        .eq('entity_id', id),
    ])

    if (entityResult.error) throw new Error(entityResult.error.message)

    const result = {
      ...entityResult.data,
      outgoing_relationships: relAResult.data ?? [],
      incoming_relationships: relBResult.data ?? [],
      linked_memory_count: memCountResult.count ?? 0,
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    }
  },
)

// ── Tool: add_entity ──────────────────────────────────────────────────────
server.registerTool(
  'add_entity',
  {
    title: 'Add Entity',
    description:
      'Explicitly create a new entity. Use search_entities first to confirm it does not already exist.',
    inputSchema: {
      name: z.string(),
      type: z.enum(['person', 'place', 'object', 'event', 'concept']),
      subtype: z.string().optional().describe('e.g. "teacher", "life coach", "car"'),
      properties: z
        .record(z.unknown())
        .optional()
        .describe('Any additional structured attributes as key-value pairs'),
    },
  },
  async ({ name, type, subtype, properties }) => {
    const entityText = subtype ? `${name} ${subtype}` : name
    const embedding = await embed(entityText)

    const { data, error } = await supabase
      .from('entities')
      .insert({ name, type, subtype: subtype ?? null, properties: properties ?? null, embedding })
      .select('id, name, type, subtype')
      .single()

    if (error) throw new Error(error.message)

    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
    }
  },
)

// ── Tool: link_entities ───────────────────────────────────────────────────
server.registerTool(
  'link_entities',
  {
    title: 'Link Entities',
    description:
      'Create a directional relationship between two entities. ' +
      'Use a verb phrase for relation, e.g. "teaches", "is parent of", "owns", "works at".',
    inputSchema: {
      entity_a_id: z.string().uuid().describe('Subject entity ID'),
      relation: z.string().describe('Verb phrase describing the relationship'),
      entity_b_id: z.string().uuid().describe('Object entity ID'),
    },
  },
  async ({ entity_a_id, relation, entity_b_id }) => {
    const { data, error } = await supabase
      .from('entity_relationships')
      .upsert({ entity_a_id, relation, entity_b_id }, { onConflict: 'entity_a_id,relation,entity_b_id' })
      .select('id')
      .single()

    if (error) throw new Error(error.message)

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ id: data.id, message: 'Relationship created.' }),
        },
      ],
    }
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// Hono app with Bearer auth
// ─────────────────────────────────────────────────────────────────────────────
const app = new Hono()

app.use('*', bearerAuth({ token: Deno.env.get('BRAIN_SECRET')! }))

app.all('/', async (c) => {
  const transport = new StreamableHTTPTransport()
  await server.connect(transport)
  return transport.handleRequest(c)
})

// @ts-ignore Deno global
Deno.serve(app.fetch)
