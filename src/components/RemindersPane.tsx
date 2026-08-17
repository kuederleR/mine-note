import { useMemo, useState, type DragEvent } from 'react'
import { LayoutGrid, List, Plus, X } from 'lucide-react'
import { useAppStore } from '../store'
import {
  doneColumnId,
  firstColumnId,
  formatDueDisplay,
  formatReminder,
  isDoneStatus,
  isDueOverdue,
  isDueToday,
  reminderDueGroup,
  reminderObjectLink,
  DEFAULT_REMINDER_COLUMNS,
} from '../lib/reminders'
import { readObjectLink, writeObjectClipboard, type ObjectLink } from '../lib/objectLink'
import type { Reminder } from '../types'
import { ObjectChip } from './ObjectChip'
import { ObjectLinkMenu } from './ReminderBlock'

const LIST_GROUPS: Array<{ id: string; label: string }> = [
  { id: 'overdue', label: 'Overdue' },
  { id: 'today', label: 'Today' },
  { id: 'tomorrow', label: 'Tomorrow' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'none', label: 'No date' },
  { id: 'done', label: 'Completed' },
]

export function RemindersPane() {
  const reminders = useAppStore((s) => s.reminders)
  const view = useAppStore((s) => s.remindersView)
  const setView = useAppStore((s) => s.setRemindersView)
  const columns =
    useAppStore((s) => s.workspaceSettings.reminderColumns) || DEFAULT_REMINDER_COLUMNS
  const shortcut = useAppStore((s) => s.workspaceSettings.reminderShortcut) || '!'
  const toggleReminders = useAppStore((s) => s.toggleReminders)
  const addReminder = useAppStore((s) => s.addReminder)
  const patchReminder = useAppStore((s) => s.patchReminder)
  const openReminder = useAppStore((s) => s.openReminder)
  const openMineObject = useAppStore((s) => s.openMineObject)
  const openSettings = useAppStore((s) => s.openSettings)
  const dirty = useAppStore((s) => s.dirty)
  const saving = useAppStore((s) => s.saving)
  const save = useAppStore((s) => s.save)
  const [hideDone, setHideDone] = useState(() => {
    try {
      return localStorage.getItem('mine.hideCompletedReminders') !== '0'
    } catch {
      return true
    }
  })
  const [dragId, setDragId] = useState<string | null>(null)

  const setHideDonePersist = (next: boolean) => {
    setHideDone(next)
    try {
      localStorage.setItem('mine.hideCompletedReminders', next ? '1' : '0')
    } catch {
      /* ignore */
    }
  }

  const visible = hideDone
    ? reminders.filter((item) => !isDoneStatus(item.status, columns))
    : reminders

  const grouped = useMemo(() => {
    const map = new Map<string, Reminder[]>()
    for (const group of LIST_GROUPS) {
      if (hideDone && group.id === 'done') continue
      map.set(group.id, [])
    }
    for (const item of visible) {
      const key = reminderDueGroup(item.dueAt, isDoneStatus(item.status, columns))
      map.get(key)?.push(item)
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.dueAt || '9999').localeCompare(b.dueAt || '9999') || a.title.localeCompare(b.title))
    }
    return map
  }, [visible, columns, hideDone])

  const onDrop = (status: string, at: number) => {
    if (!dragId) return
    const moving = reminders.find((item) => item.id === dragId)
    setDragId(null)
    if (!moving) return
    void patchReminder(dragId, { status, position: at })
  }

  return (
    <main className="editor reminders-shell">
      <header className="editor-toolbar">
        <div>
          <div className="mine-kicker">Workspace</div>
          <h1 className="reminders-title">Reminders</h1>
        </div>
        <div className="toolbar-right reminders-actions">
          <div className="agent-mode">
            <button type="button" className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>
              <List size={14} /> List
            </button>
            <button type="button" className={view === 'board' ? 'active' : ''} onClick={() => setView('board')}>
              <LayoutGrid size={14} /> Board
            </button>
          </div>
          <label className="reminders-hide">
            <input
              type="checkbox"
              checked={hideDone}
              onChange={(e) => setHideDonePersist(e.target.checked)}
            />
            Hide completed
          </label>
          <button type="button" className="btn ghost" onClick={() => openSettings(null, 'reminders')}>
            Columns
          </button>
          <button type="button" className="btn ghost" disabled={saving || !dirty} onClick={() => void save()}>
            Save
          </button>
          <button type="button" className="btn primary" onClick={() => void addReminder()}>
            <Plus size={14} /> New
          </button>
          <button type="button" className="icon-btn" aria-label="Close reminders" onClick={() => toggleReminders(false)}>
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="editor-scroll">
        {view === 'list' ? (
          <div className="reminders-list page">
            {LIST_GROUPS.map((group) => {
              const items = grouped.get(group.id) || []
              if (!items.length) return null
              return (
                <section key={group.id} className={`reminder-group group-${group.id}`}>
                  <h2>{group.label}</h2>
                  <ul>
                    {items.map((item) => (
                      <ReminderRow
                        key={item.id}
                        reminder={item}
                        onOpen={() => void openReminder(item.id)}
                        onPatch={patchReminder}
                        onOpenObject={(noteId, objectId) => void openMineObject(noteId, objectId)}
                      />
                    ))}
                  </ul>
                </section>
              )
            })}
            {!visible.length ? (
              <p className="muted">
                {reminders.length && hideDone
                  ? 'Completed reminders are hidden. Uncheck “Hide completed” to show them — they remain in their notes.'
                  : `No reminders yet. Type :${shortcut} in a note, or create one here.`}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="reminders-board page">
            {columns.map((col) => {
              const items = visible
                .filter((item) => (item.status === col.id) || (!columns.some((c) => c.id === item.status) && col.id === firstColumnId(columns)))
                .sort((a, b) => a.position - b.position)
              return (
                <section
                  key={col.id}
                  className={`kanban-col ${col.done ? 'done' : ''}`}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDrop(col.id, items.length)}
                >
                  <header>
                    <h2>{col.label}</h2>
                    <span>{items.length}</span>
                  </header>
                  <div className="kanban-cards">
                    {items.map((item, index) => (
                      <KanbanReminderCard
                        key={item.id}
                        reminder={item}
                        done={Boolean(col.done)}
                        onDragStart={() => setDragId(item.id)}
                        onDragEnd={() => setDragId(null)}
                        onDragOver={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                        }}
                        onDrop={(e) => {
                          e.stopPropagation()
                          onDrop(col.id, index)
                        }}
                        onOpen={() => void openReminder(item.id)}
                        onPatch={patchReminder}
                        onOpenObject={(noteId, objectId) => void openMineObject(noteId, objectId)}
                      />
                    ))}
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </div>
    </main>
  )
}

function dueClass(dueAt: string, done: boolean) {
  if (done || !dueAt) return ''
  if (isDueOverdue(dueAt, done)) return 'overdue'
  if (isDueToday(dueAt)) return 'today'
  return ''
}

function objectPatch(link: ObjectLink) {
  return {
    objectId: link.id,
    objectType: link.type,
    objectNoteId: link.noteId,
    objectLabel: link.label,
  }
}

function copyReminderObject(reminder: Reminder, pasteAs: 'link' | 'content' = 'link') {
  writeObjectClipboard(
    {
      link: {
        id: reminder.id,
        type: 'reminder',
        noteId: reminder.noteId,
        noteTitle: reminder.noteTitle,
        label: reminder.title || 'Reminder',
      },
      markdown: formatReminder({
        id: reminder.id,
        title: reminder.title,
        dueAt: reminder.dueAt,
        status: reminder.status,
        position: reminder.position,
      }),
    },
    pasteAs,
  )
}

async function dropOnReminder(
  reminder: Reminder,
  onPatch: (id: string, input: ReturnType<typeof objectPatch> | { objectId: null; objectType: null; objectNoteId: null; objectLabel: null }) => Promise<void>,
) {
  const link = await readObjectLink()
  if (!link) return
  await onPatch(reminder.id, objectPatch(link))
}

function ReminderObjectMenu({
  reminder,
  menu,
  onClose,
  onPatch,
}: {
  reminder: Reminder
  menu: { x: number; y: number }
  onClose: () => void
  onPatch: (
    id: string,
    input: {
      objectId?: string | null
      objectType?: string | null
      objectNoteId?: string | null
      objectLabel?: string | null
    },
  ) => Promise<void>
}) {
  return (
    <ObjectLinkMenu
      x={menu.x}
      y={menu.y}
      canRemove={Boolean(reminder.objectId)}
      onClose={onClose}
      onCopyObject={() => copyReminderObject(reminder, 'content')}
      onCopyLink={() => copyReminderObject(reminder, 'link')}
      onDrop={() => void dropOnReminder(reminder, onPatch)}
      onRemove={() =>
        void onPatch(reminder.id, { objectId: null, objectType: null, objectNoteId: null, objectLabel: null })
      }
    />
  )
}

function ReminderRow({
  reminder,
  onOpen,
  onPatch,
  onOpenObject,
}: {
  reminder: Reminder
  onOpen: () => void
  onPatch: (
    id: string,
    input: {
      title?: string
      dueAt?: string | null
      status?: string
      objectId?: string | null
      objectType?: string | null
      objectNoteId?: string | null
      objectLabel?: string | null
    },
  ) => Promise<void>
  onOpenObject: (noteId: string, objectId: string) => void
}) {
  const columns =
    useAppStore((s) => s.workspaceSettings.reminderColumns) || DEFAULT_REMINDER_COLUMNS
  const done = isDoneStatus(reminder.status, columns)
  const doneId = doneColumnId(columns)
  const openId = firstColumnId(columns)
  const object = reminderObjectLink(reminder)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  return (
    <li
      className={`reminder-row ${done ? 'done' : ''}`}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      <button
        type="button"
        className={`reminder-check ${done ? 'checked' : ''}`}
        onClick={() => void onPatch(reminder.id, { status: done ? openId : doneId })}
      >
        {done ? '✓' : ''}
      </button>
      <span className="reminder-row-main">
        <button type="button" className="reminder-row-title" onClick={onOpen}>
          {reminder.title || 'Untitled reminder'}
        </button>
        {object ? (
          <ObjectChip
            link={object}
            onOpen={() => onOpenObject(object.noteId, object.id)}
            onRemove={() =>
              void onPatch(reminder.id, { objectId: null, objectType: null, objectNoteId: null, objectLabel: null })
            }
          />
        ) : null}
      </span>
      <span className={`reminder-row-due ${dueClass(reminder.dueAt || '', done)}`}>
        {formatDueDisplay(reminder.dueAt)}
      </span>
      <span className="reminder-row-note">{reminder.noteTitle}</span>
      {menu ? (
        <ReminderObjectMenu reminder={reminder} menu={menu} onClose={() => setMenu(null)} onPatch={onPatch} />
      ) : null}
    </li>
  )
}

function KanbanReminderCard({
  reminder,
  done,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onOpen,
  onPatch,
  onOpenObject,
}: {
  reminder: Reminder
  done: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onDragOver: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
  onOpen: () => void
  onPatch: (
    id: string,
    input: {
      objectId?: string | null
      objectType?: string | null
      objectNoteId?: string | null
      objectLabel?: string | null
    },
  ) => Promise<void>
  onOpenObject: (noteId: string, objectId: string) => void
}) {
  const object = reminderObjectLink(reminder)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  return (
    <article
      className="kanban-card"
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      <button type="button" className="kanban-title" onClick={onOpen}>
        {reminder.title || 'Untitled reminder'}
      </button>
      {object ? (
        <ObjectChip
          link={object}
          onOpen={() => onOpenObject(object.noteId, object.id)}
          onRemove={() =>
            void onPatch(reminder.id, { objectId: null, objectType: null, objectNoteId: null, objectLabel: null })
          }
        />
      ) : null}
      <div className="kanban-meta">
        {reminder.dueAt ? (
          <span className={dueClass(reminder.dueAt, done)}>{formatDueDisplay(reminder.dueAt)}</span>
        ) : (
          <span>No date</span>
        )}
        <span>{reminder.noteTitle || 'Untitled'}</span>
      </div>
      {menu ? (
        <ReminderObjectMenu reminder={reminder} menu={menu} onClose={() => setMenu(null)} onPatch={onPatch} />
      ) : null}
    </article>
  )
}
