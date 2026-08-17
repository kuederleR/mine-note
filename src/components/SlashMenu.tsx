import { useEffect, useRef } from 'react'
import {
  Bell,
  Bot,
  ChevronsDownUp,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Info,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  Table2,
  type LucideIcon,
} from 'lucide-react'
import type { SlashCommand } from '../lib/slashCommands'

const SLASH_ICONS: Record<string, LucideIcon> = {
  h1: Heading1,
  h2: Heading2,
  h3: Heading3,
  h4: Heading4,
  ul: List,
  ol: ListOrdered,
  todo: ListChecks,
  table: Table2,
  quote: Quote,
  callout: Info,
  code: Code,
  toggle: ChevronsDownUp,
  hr: Minus,
  ai: Bot,
  reminder: Bell,
}

export function SlashMenu({
  commands,
  activeIndex,
  onHover,
  onPick,
}: {
  commands: SlashCommand[]
  activeIndex: number
  onHover: (index: number) => void
  onPick: (cmd: SlashCommand) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    rootRef.current?.querySelector('.tag-menu-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])
  return (
    <div ref={rootRef} className="tag-menu slash-menu" role="listbox" onMouseDown={(e) => e.preventDefault()}>
      {commands.length ? (
        commands.map((cmd, index) => {
          const Icon = SLASH_ICONS[cmd.id] || List
          return (
            <button
              key={cmd.id}
              type="button"
              className={`tag-menu-item ${index === activeIndex ? 'active' : ''}`}
              onMouseEnter={() => onHover(index)}
              onClick={() => onPick(cmd)}
            >
              <Icon size={15} />
              <span className="tag-menu-name">{cmd.title}</span>
              <span className="slash-menu-hint">{cmd.hint}</span>
            </button>
          )
        })
      ) : (
        <div className="tag-menu-empty">No matching blocks</div>
      )}
    </div>
  )
}
