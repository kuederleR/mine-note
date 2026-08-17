import { getObjectSpec, type ObjectContextInput } from './objectSpecs.js'

export type { ObjectContextInput }

/** Compact retrieval / FTS / embedding text for a component. */
export function formatComponentForSearch(input: ObjectContextInput): string {
  const spec = getObjectSpec(input.type)
  if (spec) return spec.formatForSearch(input)
  if (input.type === 'entity' || input.type === 'chunk') {
    return input.content.replace(/\s+/g, ' ').trim()
  }
  const body = input.content.replace(/\s+/g, ' ').trim()
  return body ? `${input.type}: ${body}` : ''
}

/** Richer excerpt line for answer grounding. */
export function formatComponentForAi(input: ObjectContextInput): string {
  return formatComponentForSearch(input)
}

export function formatEvidenceBlock(
  match: ObjectContextInput & { noteId: string; noteTitle: string; index: number },
): string {
  const body = formatComponentForAi(match)
  const type = match.type || 'paragraph'
  return `[${match.index}] type=${type} noteId=${match.noteId} title=${match.noteTitle}\n${body}`
}
