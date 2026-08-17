/** How a Mine object type teaches models to read it and to create it. */

export type ObjectContextInput = {
  type: string
  content: string
  meta?: Record<string, unknown>
}

export type ObjectSpec = {
  type: string
  /** One-line identity for prompts and legends. */
  label: string
  /** What this object means in a note. */
  descriptionForAi: string
  /** When the create model should pick this type. */
  whenToUse: string
  /** JSON shape the create model should emit. */
  createSchema: string
  /** Few-shot draft example (JSON). */
  example: string
  /** Whether the create agent may emit this type. */
  creatable: boolean
  /** Compact text for FTS / embeddings / answer excerpts. */
  formatForSearch: (input: ObjectContextInput) => string
}

function str(value: unknown): string {
  return String(value ?? '').trim()
}

function checklistSummary(content: string): { open: number; total: number } {
  const items = content.match(/^\s*[-*+]\s+\[[ xX]\]/gm) || []
  const open = (content.match(/^\s*[-*+]\s+\[\s\]/gm) || []).length
  return { open, total: items.length }
}

function plain(input: ObjectContextInput): string {
  return input.content.replace(/\s+/g, ' ').trim()
}

const SPECS: ObjectSpec[] = [
  {
    type: 'heading',
    label: 'Heading',
    descriptionForAi: 'Section title that structures the note.',
    whenToUse: 'Introduce a section or break the page into labeled parts.',
    createSchema: '{ "type":"heading", "level": 1-4, "text": "..." }',
    example: '{ "type":"heading", "level": 2, "text": "Next steps" }',
    creatable: true,
    formatForSearch: (input) => plain(input),
  },
  {
    type: 'paragraph',
    label: 'Paragraph',
    descriptionForAi: 'Prose block for narrative or a short explanation.',
    whenToUse: 'A single thought that is not a list, table, or reminder.',
    createSchema: '{ "type":"paragraph", "text": "..." }',
    example: '{ "type":"paragraph", "text": "Ship the retrieval fix before Friday." }',
    creatable: true,
    formatForSearch: (input) => plain(input),
  },
  {
    type: 'list',
    label: 'List',
    descriptionForAi: 'Unordered bullet list; items may nest other objects.',
    whenToUse: 'Several related facts, options, or next steps without order.',
    createSchema:
      '{ "type":"list", "items": [ string | { "text":"...", "children":[Object] } ] }',
    example: '{ "type":"list", "items": ["Call Stacie", "Review the index"] }',
    creatable: true,
    formatForSearch: (input) => {
      const body = plain(input)
      return body ? `List | ${body}` : 'List'
    },
  },
  {
    type: 'numbered-list',
    label: 'Numbered list',
    descriptionForAi: 'Ordered steps; items may nest other objects.',
    whenToUse: 'A sequence that must stay in order.',
    createSchema:
      '{ "type":"numbered-list", "items": [ string | { "text":"...", "children":[Object] } ] }',
    example: '{ "type":"numbered-list", "items": ["Open the PR", "Run tests", "Merge"] }',
    creatable: true,
    formatForSearch: (input) => {
      const body = plain(input)
      return body ? `Numbered list | ${body}` : 'Numbered list'
    },
  },
  {
    type: 'todo',
    label: 'Todo',
    descriptionForAi: 'Checklist of unfinished or finished work (open=N/total in search text).',
    whenToUse: 'Track unfinished work with checkboxes.',
    createSchema:
      '{ "type":"todo", "items": [ { "text":"...", "checked": false, "children":[Object]? } ] }',
    example:
      '{ "type":"todo", "items": [{ "text":"Pack bag", "checked": false }, { "text":"Buy milk", "checked": true }] }',
    creatable: true,
    formatForSearch: (input) => {
      const { open, total } = checklistSummary(input.content)
      const body = plain(input)
      const prefix = total ? `Todo | open=${open}/${total}` : 'Todo'
      return body ? `${prefix} | ${body}` : prefix
    },
  },
  {
    type: 'table',
    label: 'Table',
    descriptionForAi: 'Grid of headers and rows for comparisons or structured facts.',
    whenToUse: 'Compare people, dates, actions, or columns of related values.',
    createSchema: '{ "type":"table", "headers": ["..."], "rows": [["cell","cell"]] }',
    example:
      '{ "type":"table", "headers": ["Person", "Role"], "rows": [["Stacie", "Retrieval"], ["Eric", "Index"]] }',
    creatable: true,
    formatForSearch: (input) => {
      const body = plain(input)
      return body ? `Table | ${body}` : 'Table'
    },
  },
  {
    type: 'callout',
    label: 'Callout',
    descriptionForAi: 'Highlighted NOTE/TIP/WARN/IDEA takeaway.',
    whenToUse: 'Emphasize a warning, tip, or key takeaway.',
    createSchema: '{ "type":"callout", "kind": "NOTE"|"TIP"|"WARN"|"IDEA", "text": "..." }',
    example: '{ "type":"callout", "kind": "WARN", "text": "Do not ship without reindexing." }',
    creatable: true,
    formatForSearch: (input) => {
      const kind = str(input.meta?.kind) || 'NOTE'
      const body = plain(input)
      return body ? `Callout | ${kind} | ${body}` : `Callout | ${kind}`
    },
  },
  {
    type: 'quote',
    label: 'Quote',
    descriptionForAi: 'Quoted passage or cited line.',
    whenToUse: 'Preserve someone else’s words or a short citation.',
    createSchema: '{ "type":"quote", "text": "..." }',
    example: '{ "type":"quote", "text": "Ship the hybrid search backend." }',
    creatable: true,
    formatForSearch: (input) => {
      const body = plain(input)
      return body ? `Quote | ${body}` : 'Quote'
    },
  },
  {
    type: 'toggle',
    label: 'Toggle',
    descriptionForAi: 'Collapsible section with a title and nested objects.',
    whenToUse: 'Hide detail under a short title.',
    createSchema: '{ "type":"toggle", "title": "...", "children": [Object] }',
    example:
      '{ "type":"toggle", "title": "Details", "children": [{ "type":"paragraph", "text": "Longer notes…" }] }',
    creatable: true,
    formatForSearch: (input) => {
      const title = str(input.meta?.title)
      const body = plain(input)
      if (title && body) return `Toggle | ${title} | ${body}`
      if (title) return `Toggle | ${title}`
      return body ? `Toggle | ${body}` : 'Toggle'
    },
  },
  {
    type: 'divider',
    label: 'Divider',
    descriptionForAi: 'Visual break between sections.',
    whenToUse: 'Separate major sections without a heading.',
    createSchema: '{ "type":"divider" }',
    example: '{ "type":"divider" }',
    creatable: true,
    formatForSearch: () => '',
  },
  {
    type: 'reminder',
    label: 'Reminder',
    descriptionForAi:
      'Dated follow-up tracked in the reminders pane. Search text includes due= and status=.',
    whenToUse: 'Something that must happen on a date/time and be tracked as a reminder.',
    createSchema:
      '{ "type":"reminder", "text": "...", "due": "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm", "status": "todo"|"doing"|"done" }',
    example: '{ "type":"reminder", "text": "Pack bag", "due": "2026-08-16", "status": "todo" }',
    creatable: true,
    formatForSearch: (input) => {
      const due = str(input.meta?.due)
      const status = str(input.meta?.status)
      const bits = ['Reminder']
      if (due) bits.push(`due=${due}`)
      if (status) bits.push(`status=${status}`)
      const body = plain(input) || 'Untitled reminder'
      return `${bits.join(' | ')} | ${body}`
    },
  },
  {
    type: 'code',
    label: 'Code',
    descriptionForAi: 'Fenced code sample with an optional language.',
    whenToUse: 'Not created by the inline agent yet; appears when users paste code.',
    createSchema: '{ "type":"code", "language": "text", "text": "..." }',
    example: '{ "type":"code", "language": "ts", "text": "const x = 1" }',
    creatable: false,
    formatForSearch: (input) => {
      const language = str(input.meta?.language) || 'text'
      const body = plain(input)
      return body ? `Code | ${language} | ${body}` : `Code | ${language}`
    },
  },
  {
    type: 'embed',
    label: 'Embed',
    descriptionForAi:
      'Live projection of another object (src id). Edits write through to the canonical object.',
    whenToUse: 'Not invented by the create agent; users embed existing objects.',
    createSchema: '{ "type":"embed", "src": "objectId", "note": "noteId?" }',
    example: '{ "type":"embed", "src": "obj_abc" }',
    creatable: false,
    formatForSearch: (input) => {
      const body = plain(input)
      return body ? `Embed | ${body}` : 'Embed'
    },
  },
  {
    type: 'wikilink',
    label: 'Wiki link',
    descriptionForAi: 'Reference to another note page.',
    whenToUse: 'Indexed from [[Title]] / :tag[Title] in text; not a top-level create type.',
    createSchema: 'Use :{tag}[Exact Page Title] or [[Exact Page Title]] inside text fields.',
    example: ':@[Stacie Hoelscher]',
    creatable: false,
    formatForSearch: (input) => {
      const body = plain(input)
      return body ? `Link | ${body}` : 'Link'
    },
  },
]

const BY_TYPE = new Map(SPECS.map((spec) => [spec.type, spec]))

export function getObjectSpec(type: string): ObjectSpec | undefined {
  return BY_TYPE.get(type)
}

export function creatableObjectSpecs(): ObjectSpec[] {
  return SPECS.filter((spec) => spec.creatable)
}

export function allObjectSpecs(): ObjectSpec[] {
  return SPECS
}

/** System prompt for the inline create agent — each type is an object-building tool. */
export function buildCreateSystemPrompt(options: { compact?: boolean } = {}): string {
  const compact = options.compact !== false
  const tools = creatableObjectSpecs()
    .map((spec) =>
      compact
        ? `- ${spec.type}: ${spec.createSchema}\n  ${spec.whenToUse}`
        : `### ${spec.type} — ${spec.label}
${spec.descriptionForAi}
When to use: ${spec.whenToUse}
Emit: ${spec.createSchema}
Example: ${spec.example}`,
    )
    .join('\n')

  return `You are Mine’s object builder. Compose typed Mine Objects, not a prose blob, unless one paragraph is enough.
Return JSON only: { "objects": [ ... ] }

Object tools:
${tools}

Rules:
- list/todo/numbered-list Item = string or { "text":"...", "checked":false, "children":[Object] }
- Nest objects via children when useful.
- Links in text: :{tag}[Exact Title] or [[Exact Title]]. Prefer connected-page links.
- Do not invent facts. Use reminder for dated follow-ups, todo for checklists, table for comparisons.`
}

let cachedCompactPrompt: string | null = null

/** Cached compact catalog — avoids rebuilding a large system prompt on every create. */
export function getCreateSystemPrompt(): string {
  if (!cachedCompactPrompt) cachedCompactPrompt = buildCreateSystemPrompt({ compact: true })
  return cachedCompactPrompt
}

/** Short legend for answer grounding from the types actually present. */
export function buildObjectLegend(types: string[]): string {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const type of types) {
    if (seen.has(type)) continue
    seen.add(type)
    const spec = getObjectSpec(type)
    if (!spec) continue
    lines.push(`- ${type}: ${spec.descriptionForAi}`)
  }
  return lines.length ? `Object types in excerpts:\n${lines.join('\n')}` : ''
}

export function isCreatableMineType(type: string): boolean {
  return Boolean(getObjectSpec(type)?.creatable)
}
