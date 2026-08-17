import type { Category, CategoryDraft } from '../types'
import { CATEGORY_COLORS } from './categoryIcons'

export const CATEGORY_AUTO_KEYS = [
  'description',
  'icon',
  'color',
  'embedInstruction',
  'queryHints',
  'template',
  'tag',
] as const

export function emptyCategoryDraft(): CategoryDraft {
  return {
    name: '',
    icon: 'Folder',
    color: CATEGORY_COLORS[0],
    description: '',
    embedInstruction: '',
    queryHints: '',
    template: '# {{title}}\n\n',
    tag: '',
  }
}

export function draftFromCategory(category: Category): CategoryDraft {
  return {
    name: category.name,
    icon: category.icon,
    color: category.color,
    description: category.description,
    embedInstruction: category.embedInstruction,
    queryHints: category.queryHints,
    template: category.template,
    tag: category.tag,
  }
}

export function applyCategoryDraft(
  current: CategoryDraft,
  draft: CategoryDraft,
  locked: Iterable<string>,
): CategoryDraft {
  const lockedKeys = new Set(locked)
  return {
    name: current.name,
    icon: lockedKeys.has('icon') ? current.icon : draft.icon,
    color: lockedKeys.has('color') ? current.color : draft.color,
    description: lockedKeys.has('description') ? current.description : draft.description,
    embedInstruction: lockedKeys.has('embedInstruction') ? current.embedInstruction : draft.embedInstruction,
    queryHints: lockedKeys.has('queryHints') ? current.queryHints : draft.queryHints,
    template: lockedKeys.has('template') ? current.template : draft.template,
    tag: lockedKeys.has('tag') ? current.tag : draft.tag,
  }
}
