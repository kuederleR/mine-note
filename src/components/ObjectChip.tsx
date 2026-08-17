import {
  Bell,
  Heading1,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  Square,
  Table2,
  type LucideIcon,
} from 'lucide-react'
import type { ObjectLink } from '../lib/objectLink'

const ICONS: Record<string, LucideIcon> = {
  heading: Heading1,
  paragraph: Square,
  list: List,
  'numbered-list': ListOrdered,
  todo: ListChecks,
  table: Table2,
  quote: Quote,
  callout: Quote,
  toggle: List,
  divider: Minus,
  reminder: Bell,
}

type Props = {
  link: ObjectLink
  onOpen?: () => void
  onRemove?: () => void
}

export function ObjectChip({ link, onOpen, onRemove }: Props) {
  const Icon = ICONS[link.type] || Square
  return (
    <span className="obj-chip-wrap">
      <button
        type="button"
        className="obj-chip"
        title={link.label || link.type || 'Object'}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onOpen?.()
        }}
      >
        <Icon size={13} className="obj-chip-icon" />
        {link.label ? <span className="obj-chip-label">{link.label}</span> : null}
      </button>
      {onRemove ? (
        <button
          type="button"
          className="obj-chip-remove"
          aria-label="Remove object tag"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
        >
          ×
        </button>
      ) : null}
    </span>
  )
}
