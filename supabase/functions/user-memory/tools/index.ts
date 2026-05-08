import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { register as listCategories } from './list-categories.ts'
import { register as addMemory } from './add-memory.ts'
import { register as searchMemories } from './search-memories.ts'
import { register as updateMemory } from './update-memory.ts'
import { register as deleteMemory } from './delete-memory.ts'

export function registerAllTools(server: McpServer) {
  listCategories(server)
  addMemory(server)
  searchMemories(server)
  updateMemory(server)
  deleteMemory(server)
}
