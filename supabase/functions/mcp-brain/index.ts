// @ts-ignore Supabase Edge Runtime type definitions
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPTransport } from '@hono/mcp'
import { Hono } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'zod'

// ─────────────────────────────────────────────────────────────────────────────
// Environment — fail fast on misconfiguration
// ─────────────────────────────────────────────────────────────────────────────
function requireEnv(name: string, minLength = 1): string {
  const value = Deno.env.get(name)
  if (!value || value.length < minLength) {
    throw new Error(`env ${name} is missing or too short (min ${minLength} chars)`)
  }
  return value
}

const SUPABASE_URL = requireEnv('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY', 32)
const BRAIN_SECRET = requireEnv('BRAIN_SECRET', 32)

// ─────────────────────────────────────────────────────────────────────────────
// Supabase client (service role — bypasses RLS for personal brain)
// ─────────────────────────────────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

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
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Reusable input limits.
const MAX_CONTENT_LEN = 10_000
const MAX_NAME_LEN = 200
const MAX_SUBTYPE_LEN = 100
const MAX_RELATION_LEN = 100
const MAX_PROPERTIES_BYTES = 8_192
const MAX_ENTITIES_PER_MEMORY = 25
const MAX_CATEGORY_SEGMENT_LEN = 100

const propertiesSchema = z
  .record(z.unknown())
  .refine(
    (v) => new TextEncoder().encode(JSON.stringify(v)).byteLength <= MAX_PROPERTIES_BYTES,
    { message: `properties exceeds ${MAX_PROPERTIES_BYTES} bytes` },
  )

const categoryPathSchema = z
  .array(z.string().trim().min(1).max(MAX_CATEGORY_SEGMENT_LEN))
  .min(1)
  .max(3)

// Map a thrown value to a generic error for the client. Logs the original.
function safeError(scope: string, err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`[mcp-brain:${scope}]`, msg)
  // Surface a short, non-leaky message to the caller.
  throw new Error(`${scope} failed`)
}

function check<T>(scope: string, error: { message: string } | null, data: T): T {
  if (error) safeError(scope, error.message)
  return data
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
      query: z.string().trim().min(1).max(MAX_NAME_LEN).describe('Name or description to search for'),
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

    if (error) safeError('search_entities', error.message)

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
      content: z.string().trim().min(1).max(MAX_CONTENT_LEN).describe('The memory content'),
      type: z.enum(['memory', 'reminder', 'note', 'idea']),
      category_path: categoryPathSchema.describe(
        'Category path from root, e.g. ["Work & Career", "projects"]',
      ),
      due_date: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe('ISO 8601 due date/time for reminders'),
      entities: z
        .array(
          z.union([
            z.object({ id: z.string().uuid() }).describe('Resolved entity — pass only id'),
            z
              .object({
                name: z.string().trim().min(1).max(MAX_NAME_LEN),
                type: z.enum(['person', 'place', 'object', 'event', 'concept']),
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

    // Embed the memory content
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

    if (memError) safeError('add_memory.insert', memError.message)
    const memoryId = memory!.id as string

    // Resolve + link entities. On any failure, compensate by deleting the
    // freshly-inserted memory so we don't leak orphan rows.
    try {
      if (entities && entities.length > 0) {
        // Embed all new entities in parallel.
        const newEntities = entities.filter((e) => !('id' in e)) as Array<{
          name: string
          type: string
          subtype?: string
          properties?: Record<string, unknown>
        }>

        const newEntityEmbeddings = await Promise.all(
          newEntities.map((e) => embed(e.subtype ? `${e.name} ${e.subtype}` : e.name)),
        )

        // Insert new entities (one round-trip).
        const newEntityIds: string[] = []
        if (newEntities.length > 0) {
          const rows = newEntities.map((e, i) => ({
            name: e.name,
            type: e.type,
            subtype: e.subtype ?? null,
            properties: e.properties ?? null,
            embedding: newEntityEmbeddings[i],
          }))
          const { data: inserted, error: entError } = await supabase
            .from('entities')
            .insert(rows)
            .select('id')
          if (entError) safeError('add_memory.entity_insert', entError.message)
          for (const row of inserted ?? []) newEntityIds.push((row as { id: string }).id)
        }

        // Build full ID list preserving order is unimportant here.
        const entityIds: string[] = []
        let newIx = 0
        for (const e of entities) {
          if ('id' in e) entityIds.push(e.id)
          else entityIds.push(newEntityIds[newIx++])
        }

        // Upsert memory_entities links
        if (entityIds.length > 0) {
          const { error: linkError } = await supabase.from('memory_entities').upsert(
            entityIds.map((eid) => ({ memory_id: memoryId, entity_id: eid })),
            { onConflict: 'memory_id,entity_id' },
          )
          if (linkError) safeError('add_memory.link', linkError.message)
        }
      }
    } catch (err) {
      // Compensating delete — best-effort. Logs but does not mask the original.
      const { error: cleanupErr } = await supabase
        .from('memories')
        .delete()
        .eq('id', memoryId)
      if (cleanupErr) {
        console.error('[mcp-brain:add_memory.cleanup]', cleanupErr.message)
      }
      throw err
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ id: memoryId, message: 'Memory saved.' }),
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
      query: z.string().trim().min(1).max(MAX_CONTENT_LEN).describe('What to search for'),
      category_path: categoryPathSchema
        .optional()
        .describe('Filter to a category path, e.g. ["Work & Career"] or ["Work & Career", "projects"]'),
      type: z.enum(['memory', 'reminder', 'note', 'idea']).optional(),
      date_from: z.string().datetime({ offset: true }).optional().describe('ISO 8601 — filter memories created after this date'),
      date_to: z.string().datetime({ offset: true }).optional().describe('ISO 8601 — filter memories created before this date'),
      due_date_from: z.string().datetime({ offset: true }).optional().describe('ISO 8601 — filter reminders with due date after this'),
      due_date_to: z.string().datetime({ offset: true }).optional().describe('ISO 8601 — filter reminders with due date before this'),
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
      content: z.string().trim().min(1).max(MAX_CONTENT_LEN).optional(),
      type: z.enum(['memory', 'reminder', 'note', 'idea']).optional(),
      category_path: categoryPathSchema.optional(),
      due_date: z
        .string()
        .datetime({ offset: true })
        .nullable()
        .optional()
        .describe('ISO 8601 or null to clear'),
      completed: z.boolean().optional().describe('true to mark done, false to unmark'),
    },
  },
  async ({ id, content, type, category_path, due_date, completed }) => {
    // Build update payload (updated_at is set by a DB trigger now)
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

    return {
      content: [{ type: 'text', text: JSON.stringify({ id, message: 'Memory updated.' }) }],
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
    const { data, error } = await supabase
      .from('memories')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle()

    if (error) safeError('delete_memory', error.message)
    if (!data) throw new Error('memory not found or already deleted')

    return {
      content: [{ type: 'text', text: JSON.stringify({ id, message: 'Memory deleted.' }) }],
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
      supabase.from('entities').select('id, name, type, subtype, properties, created_at, updated_at').eq('id', id).maybeSingle(),
      // Relationships where this entity is the subject (this → relation → B).
      // Hint by FK column to disambiguate the two FKs to entities.
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

    if (entityResult.error) safeError('get_entity', entityResult.error.message)
    if (!entityResult.data) throw new Error('entity not found')
    if (relAResult.error) safeError('get_entity.outgoing', relAResult.error.message)
    if (relBResult.error) safeError('get_entity.incoming', relBResult.error.message)
    if (memCountResult.error) safeError('get_entity.count', memCountResult.error.message)

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
      name: z.string().trim().min(1).max(MAX_NAME_LEN),
      type: z.enum(['person', 'place', 'object', 'event', 'concept']),
      subtype: z.string().trim().min(1).max(MAX_SUBTYPE_LEN).optional().describe('e.g. "teacher", "life coach", "car"'),
      properties: propertiesSchema.optional().describe('Any additional structured attributes as key-value pairs'),
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

    if (error) {
      // Surface the unique-violation case as a helpful message.
      if ((error as { code?: string }).code === '23505') {
        throw new Error('entity with this name/type/subtype already exists')
      }
      safeError('add_entity', error.message)
    }

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
      relation: z.string().trim().min(1).max(MAX_RELATION_LEN).describe('Verb phrase describing the relationship'),
      entity_b_id: z.string().uuid().describe('Object entity ID'),
    },
  },
  async ({ entity_a_id, relation, entity_b_id }) => {
    if (entity_a_id === entity_b_id) {
      throw new Error('cannot link an entity to itself')
    }
    const { data, error } = await supabase
      .from('entity_relationships')
      .upsert({ entity_a_id, relation, entity_b_id }, { onConflict: 'entity_a_id,relation,entity_b_id' })
      .select('id')
      .single()

    if (error) safeError('link_entities', error.message)

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ id: data!.id, message: 'Relationship created.' }),
        },
      ],
    }
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// Hono app with Bearer auth + simple per-IP rate limiting
// ─────────────────────────────────────────────────────────────────────────────
const app = new Hono()

// Lightweight in-memory token-bucket rate limiter (per-IP). The Edge Function
// is single-instance for short bursts; this isn't perfect but it stops easy
// brute-forcing of BRAIN_SECRET and accidental floods.
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 120
const buckets = new Map<string, { count: number; resetAt: number }>()

app.use('*', async (c, next) => {
  const ip =
    c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
    c.req.header('x-real-ip') ||
    'unknown'
  const now = Date.now()
  const bucket = buckets.get(ip)
  if (!bucket || bucket.resetAt < now) {
    buckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
  } else {
    bucket.count++
    if (bucket.count > RATE_LIMIT_MAX) {
      return c.text('rate limit exceeded', 429)
    }
  }
  // Opportunistic cleanup to bound memory.
  if (buckets.size > 1024) {
    for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k)
  }
  await next()
})

app.use('*', bearerAuth({ token: BRAIN_SECRET }))

app.all('/', async (c) => {
  const transport = new StreamableHTTPTransport()
  await server.connect(transport)
  return transport.handleRequest(c)
})

// @ts-ignore Deno global
Deno.serve(app.fetch)
