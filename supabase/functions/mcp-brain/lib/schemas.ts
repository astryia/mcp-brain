// Shared input limits and reusable Zod schemas.
import { z } from 'zod'

export const MAX_CONTENT_LEN = 10_000
export const MAX_NAME_LEN = 200
export const MAX_SUBTYPE_LEN = 100
export const MAX_RELATION_LEN = 100
export const MAX_PROPERTIES_BYTES = 8_192
export const MAX_ENTITIES_PER_MEMORY = 25
export const MAX_CATEGORY_SEGMENT_LEN = 100

export const entityType = z.enum(['person', 'place', 'object', 'event', 'concept'])
export const memoryType = z.enum(['memory', 'reminder', 'note', 'idea'])

export const propertiesSchema = z
  .record(z.unknown())
  .refine(
    (v) => new TextEncoder().encode(JSON.stringify(v)).byteLength <= MAX_PROPERTIES_BYTES,
    { message: `properties exceeds ${MAX_PROPERTIES_BYTES} bytes` },
  )

export const categoryPathSchema = z
  .array(z.string().trim().min(1).max(MAX_CATEGORY_SEGMENT_LEN))
  .min(1)
  .max(3)

export const isoDate = z.string().datetime({ offset: true })
