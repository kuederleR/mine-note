import { useEffect, useRef } from 'react'
import { Globe } from 'lucide-react'
import type { ChatSlashCommand } from '../lib/world'

export function ChatSlashMenu({
  commands,
  activeIndex,
  onHover,
  onPick,
}: {
  commands: ChatSlashCommand[]
  activeIndex: number
  onHover: (index: number) => void
  onPick: (cmd: ChatSlashCommand) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    rootRef.current?.querySelector('.tag-menu-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])
  return (
    <div ref={rootRef} className="tag-menu slash-menu chat-slash-menu" role="listbox" onMouseDown={(e) => e.preventDefault()}>
      {commands.length ? (
        commands.map((cmd, index) => (
          <button
            key={cmd.id}
            type="button"
            className={`tag-menu-item ${index === activeIndex ? 'active' : ''}`}
            onMouseEnter={() => onHover(index)}
            onClick={() => onPick(cmd)}
          >
            <Globe size={15} />
            <span className="tag-menu-name">{cmd.token}</span>
            <span className="slash-menu-hint">{cmd.hint}</span>
          </button>
        ))
      ) : (
        <div className="tag-menu-empty">No matching commands</div>
      )}
    </div>
  )
}
