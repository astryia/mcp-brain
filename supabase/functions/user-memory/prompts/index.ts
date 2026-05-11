import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/**
 * Slash-command prompts. Each prompt expands into a user-style message that
 * tells the LLM exactly which tool to call and how to interpret the args.
 * The LLM still picks the category and type — keeping prompts free of
 * business logic and reusing the validation already in the tools.
 */

const userMessage = (text: string) => ({
  messages: [
    {
      role: 'user' as const,
      content: { type: 'text' as const, text },
    },
  ],
})

const contentArg = {
  content: z.string().min(1).describe('What to remember (free text)'),
}

const queryArg = {
  query: z.string().min(1).describe('What to search for'),
}

/**
 * Shared enrichment block. Raw user input is usually terse and pronoun-heavy;
 * stored as-is it loses meaning in weeks. Enrichment turns it into a
 * self-contained sentence that resolves cleanly out of context.
 *
 * Kept in a single string so all storage prompts give consistent guidance.
 */
const ENRICHMENT_GUIDANCE = [
  `**Decompose, then enrich before storing.** Raw input is usually terse and may bundle several independent facts. Stored as-is it will be unreadable and unsearchable in 6 months. Before calling \`add_memory\`:`,
  ``,
  `1. **Decompose.** If the input contains multiple independent facts/events/items (often signalled by "and", "also", numbered lists, "1.", "2.", or "I'm doing X and Y"), split it into separate memories and call \`add_memory\` once per item. Each memory must stand on its own. Only keep things together if they truly describe a single event.`,
  `2. **Enrich each piece.** Rewrite into a **self-contained sentence**:`,
  `   - Resolve pronouns and vague references ("it", "the new one", "that thing") to concrete names.`,
  `   - Add the **project / product / person / place** it relates to if you can infer it from recent conversation, open files, or other recent memories.`,
  `   - Add the **why / what changed** if the raw text only says the *what*.`,
  `   - Preserve the user's original wording where it carries meaning. **Do not fabricate facts** — only add context you can actually source.`,
  `3. If you don't have enough context to enrich confidently, first call \`search_memories\` (scoped by likely \`type\` and \`category_path\`) to pull related memories.`,
  `4. If still ambiguous, ask the user **one** clarifying question instead of guessing.`,
  ``,
  `Examples (illustrative, not real):`,
  `  Raw:      "at Acme I'm on two projects: Atlas and Borealis"`,
  `  Action:   TWO add_memory calls (type="fact"):`,
  `            1) "At Acme, assigned to the Atlas project."`,
  `            2) "At Acme, assigned to the Borealis project."`,
  ``,
  `  Raw:      "shipped the new ranker"`,
  `  Enriched: "Shipped v2 of the search ranker on Project Atlas — replaces the BM25 baseline with a learned cross-encoder."`,
  ``,
  `  Raw:      "talked to Sam about the budget"`,
  `  Enriched: "Reviewed the Q3 marketing budget with Sam Patel; agreed to cut paid search by 20% and reinvest in content."`,
  ``,
  `  Raw:      "fixed the bug"`,
  `  Enriched: "Fixed the off-by-one in PaginationHelper that was dropping the last result on every page in the admin dashboard on the System Health project."`,
].join('\n')

function registerStorage(
  server: McpServer,
  name: string,
  type: 'memory' | 'note' | 'task' | 'fact' | 'preference',
  title: string,
  description: string,
  extraGuidance = '',
) {
  server.registerPrompt(
    name,
    { title, description, argsSchema: contentArg },
    ({ content }) =>
      userMessage(
        [
          `Save the following as a **${type}** using the \`add_memory\` tool.`,
          `If you do not already know the category vocabulary, call \`list_categories\` first, then pick the closest 1–2 level path.`,
          ``,
          ENRICHMENT_GUIDANCE,
          extraGuidance,
          ``,
          `Raw input:`,
          content,
        ]
          .filter(Boolean)
          .join('\n'),
      ),
  )
}

export function registerAllPrompts(server: McpServer) {
  // ---------- storage ----------
  registerStorage(
    server,
    'remember',
    'memory',
    'Remember',
    'Store something that happened as a memory.',
    'Use `created_at` to backfill if the user mentions a past time (e.g. "yesterday", "last week").',
  )

  registerStorage(
    server,
    'note',
    'note',
    'Note',
    'Save reference material or an idea as a note.',
  )

  registerStorage(
    server,
    'fact',
    'fact',
    'Fact',
    'Record a durable factual statement about the user or their world.',
  )

  registerStorage(
    server,
    'prefer',
    'preference',
    'Preference',
    'Record a taste, opinion, or standing preference.',
  )

  server.registerPrompt(
    'task',
    {
      title: 'Task',
      description: 'Create a to-do item, optionally with a deadline.',
      argsSchema: {
        content: z.string().min(1).describe('What needs to be done'),
        due: z
          .string()
          .optional()
          .describe('Optional natural-language deadline, e.g. "tomorrow 5pm", "next Friday"'),
      },
    },
    ({ content, due }) =>
      userMessage(
        [
          `Create a **task** using the \`add_memory\` tool with type="task".`,
          due
            ? `Parse this deadline into ISO 8601 (with timezone offset) and pass it as \`due_date\`: "${due}".`
            : `No deadline was given — omit \`due_date\`.`,
          `If you do not already know the category vocabulary, call \`list_categories\` first.`,
          ``,
          ENRICHMENT_GUIDANCE,
          ``,
          `Raw input:`,
          content,
        ].join('\n'),
      ),
  )

  server.registerPrompt(
    'remind',
    {
      title: 'Remind',
      description: 'Create a time-bound task (alias for /task with a required deadline).',
      argsSchema: {
        content: z.string().min(1).describe('What to be reminded about'),
        when: z.string().min(1).describe('When — natural language, e.g. "tomorrow 9am", "in 2 hours"'),
      },
    },
    ({ content, when }) =>
      userMessage(
        [
          `Create a **task** using \`add_memory\` with type="task".`,
          `Parse "${when}" into ISO 8601 (with timezone offset) and pass it as \`due_date\`. This field is required for this command.`,
          `If you do not already know the category vocabulary, call \`list_categories\` first.`,
          ``,
          ENRICHMENT_GUIDANCE,
          ``,
          `Raw input:`,
          content,
        ].join('\n'),
      ),
  )

  // ---------- retrieval ----------
  server.registerPrompt(
    'recall',
    {
      title: 'Recall',
      description: 'Search memories by topic, scoped by type or category.',
      argsSchema: queryArg,
    },
    ({ query }) =>
      userMessage(
        [
          `Search memories using \`search_memories\` for: "${query}".`,
          `Pass at least one of \`type\` or \`category_path\` to scope the search — pure semantic queries collide.`,
          `If the user's intent is ambiguous, run a couple of scoped searches and combine the results.`,
          `Format the results as a concise bulleted list with type, category, and date.`,
        ].join('\n'),
      ),
  )

  server.registerPrompt(
    'due',
    {
      title: 'Due',
      description: 'List pending tasks, optionally filtered by a window.',
      argsSchema: {
        within: z
          .string()
          .optional()
          .describe('Optional window, e.g. "today", "this week", "next 3 days"'),
      },
    },
    ({ within }) =>
      userMessage(
        [
          `Use \`search_memories\` with \`type="task"\` and \`include_completed=false\` to list pending tasks.`,
          within
            ? `Compute ISO 8601 bounds for "${within}" and pass them as \`due_date_from\` / \`due_date_to\`.`
            : `No window given — return everything pending, sorted by due date.`,
          `Display as a checklist grouped by due date (overdue first, then today, then upcoming).`,
        ].join('\n'),
      ),
  )

  // ---------- mutation by query ----------
  server.registerPrompt(
    'done',
    {
      title: 'Done',
      description: 'Mark a task as completed by describing it.',
      argsSchema: queryArg,
    },
    ({ query }) =>
      userMessage(
        [
          `The user finished a task. Find it and mark it complete:`,
          `1. Call \`search_memories\` with \`type="task"\` and \`query="${query}"\`.`,
          `2. If exactly one match, call \`update_memory\` to set its completed flag (or delete it if no completion field exists — confirm with the user first if ambiguous).`,
          `3. If multiple match, list candidates and ask which one.`,
          `4. If none match, say so.`,
        ].join('\n'),
      ),
  )

  server.registerPrompt(
    'forget',
    {
      title: 'Forget',
      description: 'Delete a memory by describing it.',
      argsSchema: queryArg,
    },
    ({ query }) =>
      userMessage(
        [
          `The user wants to forget something. Be careful — deletion is permanent.`,
          `1. Call \`search_memories\` with \`query="${query}"\` (and a scoping \`type\` or \`category_path\` if you can infer one).`,
          `2. Show the top matches and ask the user to confirm which to delete.`,
          `3. Only call \`delete_memory\` after explicit confirmation.`,
        ].join('\n'),
      ),
  )

  // ---------- meta ----------
  server.registerPrompt(
    'categories',
    {
      title: 'Categories',
      description: 'Show the full category vocabulary.',
      argsSchema: {},
    },
    () =>
      userMessage(
        `Call \`list_categories\` and present the full 2-level vocabulary as a tree.`,
      ),
  )

  server.registerPrompt(
    'memory',
    {
      title: 'Memory Help',
      description: 'Show available memory commands.',
      argsSchema: {},
    },
    () =>
      userMessage(
        [
          `Show the user the available memory slash-commands and what each one does:`,
          `- /remember <content> — store something that happened`,
          `- /note <content> — save a reference or idea`,
          `- /fact <content> — record a durable fact`,
          `- /prefer <content> — record a preference`,
          `- /task <content> [due] — create a to-do`,
          `- /remind <content> <when> — time-bound task`,
          `- /recall <query> — search memories`,
          `- /due [within] — list pending tasks`,
          `- /done <query> — complete a task`,
          `- /forget <query> — delete a memory (with confirmation)`,
          `- /categories — show the category tree`,
        ].join('\n'),
      ),
  )
}
