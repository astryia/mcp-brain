import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { register as listCategories } from './list-categories.ts'
import { register as searchEntities } from './search-entities.ts'
import { register as addMemory } from './add-memory.ts'
import { register as searchMemories } from './search-memories.ts'
import { register as updateMemory } from './update-memory.ts'
import { register as deleteMemory } from './delete-memory.ts'
import { register as getEntity } from './get-entity.ts'
import { register as addEntity } from './add-entity.ts'
import { register as linkEntities } from './link-entities.ts'

export function registerAllTools(server: McpServer) {
  listCategories(server)
  searchEntities(server)
  addMemory(server)
  searchMemories(server)
  updateMemory(server)
  deleteMemory(server)
  getEntity(server)
  addEntity(server)
  linkEntities(server)
}
