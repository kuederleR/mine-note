import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { Bell } from 'lucide-react'
import type { ReminderColumn } from '../types'
import type { ReminderDraft } from '../lib/reminders'
import { doneColumnId, dueAtForInput, firstColumnId, isDoneStatus, normalizeDueAt, reminderObjectLink } from '../lib/reminders'
import { ObjectChip } from './ObjectChip'
import { peekObjectClipboard } from '../lib/objectLink'

type Props = {
  reminder: ReminderDraft
  columns: ReminderColumn[]
  onChange: (patch: Partial<ReminderDraft>) => void
  onCopyObject?: () => void
  onCopyLink?: () => void
  onPasteContent?: () => void
  onPasteLink?: () => void
  onEmbed?: () => void
  onDropObject?: () => void
  onOpenObject?: (noteId: string, objectId: string) => void
}

export function ReminderBlock({
  reminder,
  columns,
  onChange,
  onCopyObject,
  onCopyLink,
  onPasteContent,
  onPasteLink,
  onEmbed,
  onDropObject,
  onOpenObject,
}: Props) {
  const done = isDoneStatus(reminder.status, columns)
  const doneId = doneColumnId(columns)
  const openId = firstColumnId(columns)
  const object = reminderObjectLink(reminder)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const openMenu = (e: ReactMouseEvent) => {
    if ((e.target as HTMLElement).closest('input, select, button.reminder-check, .obj-chip-wrap')) return
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY })
  }

  return (
    <div
      className={`reminder-card ${done ? 'done' : ''}`}
      data-reminder-id={reminder.id}
      onContextMenu={openMenu}
    >
      <button
        type="button"
        className={`reminder-check ${done ? 'checked' : ''}`}
        aria-label={done ? 'Mark reminder open' : 'Complete reminder'}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => onChange({ status: done ? openId : doneId })}
      >
        {done ? '✓' : ''}
      </button>
      <div className="reminder-main">
        <div className="reminder-title-row">
          <Bell size={14} />
          <input
            className="reminder-title"
            value={reminder.title}
            placeholder="Reminder"
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => onChange({ title: e.target.value })}
          />
          {object ? (
            <ObjectChip
              link={object}
              onOpen={() => onOpenObject?.(object.noteId, object.id)}
              onRemove={() =>
                onChange({ objectId: null, objectType: null, objectNoteId: null, objectLabel: null })
              }
            />
          ) : null}
        </div>
        <div className="reminder-meta">
          <input
            type="datetime-local"
            className="reminder-due"
            value={dueAtForInput(reminder.dueAt)}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => onChange({ dueAt: normalizeDueAt(e.target.value) })}
          />
          <select
            className="reminder-status"
            value={columns.some((col) => col.id === reminder.status) ? reminder.status : openId}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => onChange({ status: e.target.value })}
          >
            {columns.map((col) => (
              <option key={col.id} value={col.id}>
                {col.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {menu ? (
        <ObjectLinkMenu
          x={menu.x}
          y={menu.y}
          canRemove={Boolean(object)}
          onClose={() => setMenu(null)}
          onCopyObject={onCopyObject}
          onCopyLink={onCopyLink || onCopyObject}
          onPasteContent={onPasteContent}
          onPasteLink={onPasteLink}
          onEmbed={onEmbed}
          onDrop={() => void onDropObject?.()}
          onRemove={() => onChange({ objectId: null, objectType: null, objectNoteId: null, objectLabel: null })}
        />
      ) : null}
    </div>
  )
}

export function ObjectLinkMenu({
  x,
  y,
  canRemove,
  onClose,
  onCopy,
  onCopyObject,
  onCopyLink,
  onPasteContent,
  onPasteLink,
  onEmbed,
  onDrop,
  onRemove,
  onUnwrap,
}: {
  x: number
  y: number
  canRemove?: boolean
  onClose: () => void
  onCopy?: () => void
  onCopyObject?: () => void
  onCopyLink?: () => void
  onPasteContent?: () => void
  onPasteLink?: () => void
  onEmbed?: () => void
  onDrop?: () => void
  onRemove?: () => void
  onUnwrap?: () => void
}) {
  const canPaste = Boolean(peekObjectClipboard())
  const copyLink = onCopyLink || onCopy
  useEffect(() => {
    const close = () => onClose()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const width = 220
  const left = Math.min(x, window.innerWidth - width - 8)
  const top = Math.min(y, window.innerHeight - 360)
  const run = (fn: () => void) => {
    onClose()
    fn()
  }

  return createPortal(
    <div
      className="explorer-menu"
      style={{ left, top, width }}
      onMouseDown={(e) => e.stopPropagation()}
      role="menu"
    >
      {onCopyObject ? (
        <button type="button" role="menuitem" onClick={() => run(onCopyObject)}>
          Copy object
        </button>
      ) : null}
      {copyLink ? (
        <button type="button" role="menuitem" onClick={() => run(copyLink)}>
          Copy object link
        </button>
      ) : null}
      {onPasteContent || onPasteLink || onEmbed ? (
        <>
          <div className="explorer-menu-sep" />
          {onPasteContent ? (
            <button type="button" role="menuitem" disabled={!canPaste} onClick={() => run(onPasteContent)}>
              Paste content
            </button>
          ) : null}
          {onPasteLink ? (
            <button type="button" role="menuitem" disabled={!canPaste} onClick={() => run(onPasteLink)}>
              Paste link
            </button>
          ) : null}
          {onEmbed ? (
            <button type="button" role="menuitem" disabled={!canPaste} onClick={() => run(onEmbed)}>
              Embed object
            </button>
          ) : null}
        </>
      ) : null}
      {onDrop ? (
        <>
          <div className="explorer-menu-sep" />
          <button type="button" role="menuitem" disabled={!canPaste} onClick={() => run(onDrop)}>
            Drop object tag
          </button>
        </>
      ) : null}
      {canRemove && onRemove ? (
        <button type="button" role="menuitem" className="danger" onClick={() => run(onRemove)}>
          Remove object tag
        </button>
      ) : null}
      {onUnwrap ? (
        <button type="button" role="menuitem" onClick={() => run(onUnwrap)}>
          Unwrap object
        </button>
      ) : null}
    </div>,
    document.body,
  )
}
