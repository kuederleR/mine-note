export const CATEGORY_COLORS = [
  '#c06a3a',
  '#0f3d38',
  '#2a8f80',
  '#d47848',
  '#8b6bb0',
  '#c4554d',
  '#9f6b53',
  '#3d6b73',
]

export const LUCIDE_ICON_NAMES = [
  'Users',
  'User',
  'Contact',
  'Handshake',
  'MapPin',
  'Globe',
  'Building2',
  'Briefcase',
  'Target',
  'Flag',
  'Folder',
  'Layers',
  'Boxes',
  'Lightbulb',
  'Sparkles',
  'BookOpen',
  'Library',
  'Notebook',
  'StickyNote',
  'FileText',
  'ClipboardList',
  'Calendar',
  'MessageSquare',
  'Mail',
  'Phone',
  'Link',
  'Bookmark',
  'Star',
  'Heart',
  'Home',
  'Landmark',
  'GraduationCap',
  'Wrench',
  'Code',
  'Palette',
  'Camera',
  'Music',
  'Leaf',
  'Coffee',
  'Plane',
  'Archive',
  'Inbox',
  'Tag',
  'Network',
  'GitBranch',
  'Microscope',
  'FlaskConical',
  'Search',
] as const

export type LucideIconName = (typeof LUCIDE_ICON_NAMES)[number]

export function isLucideIconName(value: string): value is LucideIconName {
  return (LUCIDE_ICON_NAMES as readonly string[]).includes(value)
}

export function defaultLucideIcon(name: string): LucideIconName {
  const n = name.toLowerCase()
  if (/\b(people|person|contact)\b/.test(n)) return 'Users'
  if (/\b(place|places|location)\b/.test(n)) return 'MapPin'
  if (/\b(project)\b/.test(n)) return 'Target'
  if (/\b(compan|org|work)\b/.test(n)) return 'Building2'
  if (/\b(book|reading|note)\b/.test(n)) return 'BookOpen'
  if (/\b(idea)\b/.test(n)) return 'Lightbulb'
  if (/\b(meeting|event|calendar)\b/.test(n)) return 'Calendar'
  return 'Folder'
}
