// Helpers to build MCP tool responses consistently.
export function jsonResponse(value: unknown, pretty = false) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(value, null, pretty ? 2 : 0) },
    ],
  }
}
