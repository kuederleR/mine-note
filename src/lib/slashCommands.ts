import type { BlockEdit } from './listEdit'
import { DEFAULT_TABLE, serializeMdTable } from './mdTable'
import type { MineObjectType } from './mineObjects'

export type SlashCommand = {
  id: string
  title: string
  hint: string
  keywords: string[]
  markdown: string
  caret: number
  special?: 'ai' | 'reminder'
}

export type SlashTrigger = {
  from: number
  to: number
  query: string
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: 'h1',
    title: 'Heading 1',
    hint: 'Big section title',
    keywords: ['h1', 'heading', 'title', 'header'],
    markdown: '# ',
    caret: 2,
  },
  {
    id: 'h2',
    title: 'Heading 2',
    hint: 'Subsection',
    keywords: ['h2', 'heading', 'subtitle'],
    markdown: '## ',
    caret: 3,
  },
  {
    id: 'h3',
    title: 'Heading 3',
    hint: 'Small heading',
    keywords: ['h3', 'heading'],
    markdown: '### ',
    caret: 4,
  },
  {
    id: 'h4',
    title: 'Heading 4',
    hint: 'Label',
    keywords: ['h4', 'heading'],
    markdown: '#### ',
    caret: 5,
  },
  {
    id: 'ul',
    title: 'Bulleted list',
    hint: 'Dash list',
    keywords: ['bullet', 'list', 'ul', 'unordered', 'items'],
    markdown: '- ',
    caret: 2,
  },
  {
    id: 'ol',
    title: 'Numbered list',
    hint: '1. 2. 3.',
    keywords: ['number', 'numbered', 'ol', 'ordered', 'list'],
    markdown: '1. ',
    caret: 3,
  },
  {
    id: 'todo',
    title: 'To-do list',
    hint: 'Checkboxes',
    keywords: ['todo', 'task', 'checkbox', 'check', 'list'],
    markdown: '- [ ] ',
    caret: 6,
  },
  {
    id: 'table',
    title: 'Table',
    hint: 'Rows and columns',
    keywords: ['table', 'grid', 'spreadsheet', 'columns'],
    markdown: serializeMdTable(DEFAULT_TABLE),
    caret: 2,
  },
  {
    id: 'quote',
    title: 'Quote',
    hint: 'Quoted text',
    keywords: ['quote', 'blockquote', 'citation'],
    markdown: '> ',
    caret: 2,
  },
  {
    id: 'callout',
    title: 'Callout',
    hint: 'Highlighted note',
    keywords: ['callout', 'note', 'tip', 'warn', 'info'],
    markdown: '> [!NOTE] ',
    caret: 10,
  },
  {
    id: 'code',
    title: 'Code',
    hint: 'Fenced code block',
    keywords: ['code', 'snippet', 'fence', 'pre'],
    markdown: '```\n\n```',
    caret: 4,
  },
  {
    id: 'toggle',
    title: 'Toggle',
    hint: 'Collapsed details',
    keywords: ['toggle', 'details', 'collapse', 'spoiler'],
    markdown: ':::toggle \n\n:::',
    caret: 10,
  },
  {
    id: 'hr',
    title: 'Divider',
    hint: 'Horizontal line',
    keywords: ['divider', 'line', 'hr', 'rule', 'separator'],
    markdown: '---',
    caret: 3,
  },
  {
    id: 'ai',
    title: 'Inline AI',
    hint: 'Ask Mine in this note',
    keywords: ['ai', 'agent', 'mine', 'ask'],
    markdown: '',
    caret: 0,
    special: 'ai',
  },
  {
    id: 'reminder',
    title: 'Reminder',
    hint: 'Due date on this page',
    keywords: ['reminder', 'task', 'due', 'remind'],
    markdown: '',
    caret: 0,
    special: 'reminder',
  },
]

export function findSlashTrigger(text: string, caret: number): SlashTrigger | null {
  const safe = Math.max(0, Math.min(caret, text.length))
  const slice = text.slice(0, safe)
  const from = slice.lastIndexOf('/')
  if (from < 0) return null
  const prev = from === 0 ? '\n' : text[from - 1]
  if (prev !== '\n' && prev !== ' ' && prev !== '\t') return null
  const query = text.slice(from + 1, safe)
  if (query.includes('\n') || query.length > 32) return null
  if (/[:[\]]/.test(query)) return null
  return { from, to: safe, query }
}

export function filterSlashCommands(query: string): SlashCommand[] {
  const q = query.trim().toLowerCase()
  if (!q) return SLASH_COMMANDS
  return SLASH_COMMANDS.filter((cmd) => {
    if (cmd.title.toLowerCase().includes(q)) return true
    return cmd.keywords.some((key) => key.includes(q) || q.includes(key))
  })
}

export function applySlashCommand(text: string, slash: SlashTrigger, cmd: SlashCommand): BlockEdit {
  const before = text.slice(0, slash.from).replace(/[ \t]+$/, '')
  const after = text.slice(slash.to).replace(/^[ \t]+/, '')
  const inserted = cmd.markdown
  const pieces = [...(before.trim() ? [before] : []), inserted, ...(after.trim() ? [after] : [])]
  if (pieces.length === 1) {
    return {
      type: 'replace',
      text: inserted,
      caret: cmd.caret,
    }
  }
  return {
    type: 'split',
    blocks: pieces,
    focus: before.trim() ? 1 : 0,
    caret: cmd.caret,
  }
}

export function slashCommandMineType(cmd: SlashCommand): MineObjectType | null {
  if (cmd.special) return null
  if (cmd.id === 'ul') return 'list'
  if (cmd.id === 'ol') return 'numbered-list'
  if (cmd.id === 'todo') return 'todo'
  if (cmd.id === 'table') return 'table'
  if (cmd.id === 'quote') return 'quote'
  if (cmd.id === 'callout') return 'callout'
  if (cmd.id === 'toggle') return 'toggle'
  if (cmd.id === 'hr') return 'divider'
  if (cmd.id === 'h1' || cmd.id === 'h2' || cmd.id === 'h3' || cmd.id === 'h4') return 'heading'
  return null
}
