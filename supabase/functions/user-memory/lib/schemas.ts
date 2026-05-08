// Shared input limits and reusable Zod schemas.
import { z } from 'zod'

export const MAX_CONTENT_LEN = 10_000
export const MAX_CATEGORY_SEGMENT_LEN = 100

// Memory types — see server `instructions` for guidance on which to pick.
//   fact       — durable truth ("daughter's pediatrician is Dr. Lee")
//   preference — taste/opinion ("daughter loves Dr. Seuss")
//   memory     — something that happened ("worked on Delta Lake today")
//   task       — to-do, optional due_date / completed_at
//   note       — reference material (recipes, addresses, snippets, ideas)
export const memoryType = z.enum(['fact', 'preference', 'memory', 'task', 'note'])

// Category vocabulary is fixed (see 002_seed_categories.sql).
// Max 2 levels — resolve_category_path errors on unknown segments.
export const categoryPathSchema = z
  .array(z.string().trim().min(1).max(MAX_CATEGORY_SEGMENT_LEN))
  .min(1)
  .max(2)

export const isoDate = z.string().datetime({ offset: true })
