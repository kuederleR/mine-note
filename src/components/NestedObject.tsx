import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { GripVertical } from 'lucide-react'
import { handleListEnter, handleListTab, handlePlainEnter, isListBlockKind } from '../lib/listEdit'
import {
  detectBlockKind,
  highlightMarkdownSource,
  toggleNthCheckbox,
} from '../lib/liveMarkdown'
import { renderNoteHtml } from '../lib/renderMarkdown'
import { defaultInnerCaret, matchMarkdownStarter } from '../lib/markdownStarters'
import {
  formatMineBlock,
  innerMineMarkdown,
  newMineId,
  parseMineFence,
  type MineObjectType,
} from '../lib/mineObjects'
import {
  appendNestedObject,
  applySlashAsNested,
  innerHasNestedFence,
  isCompleteMineFence,
  moveInnerSegment,
  pasteIntoCell,
  pasteIntoMarkdown,
  replaceInnerSegment,
  splitInnerSegments,
  unwrapNestedMarkdown,
} from '../lib/nestedObjects'
import {
  beginNestedDrag,
  clearNestedDrag,
  moveNestedDrag,
  peekNestedDrag,
  settleNestedDrag,
  takeNestedDrag,
} from '../lib/nestedDrag'
import { dispatchMineDocInsert, findLiveMarkdownAt, gapGhostAtY } from '../lib/mineDocTransfer'
import {
  clearDropHover,
  findObjectSlotAt,
  setDropHover,
  setObjectDragging,
} from '../lib/dropTarget'
import {
  cellMatchesDrag,
  dispatchMineSlotInsert,
  MINE_SLOT_INSERT,
  resolveEmbedDisplay,
  type MineSlotInsertDetail,
} from '../lib/mineEmbedSync'
import { parseMdTable } from '../lib/mdTable'
import {
  canonicalObjectFromBlock,
  pasteObjectMarkdown,
  readObjectClipboard,
  writeObjectClipboard,
} from '../lib/objectLink'
import { firstColumnId, parseReminder, patchReminderBlock } from '../lib/reminders'
import {
  filterSlashCommands,
  findSlashTrigger,
  slashCommandMineType,
  type SlashCommand,
  type SlashTrigger,
} from '../lib/slashCommands'
import { TableBlock } from './TableBlock'
import { ObjectLinkMenu, ReminderBlock } from './ReminderBlock'
import { SlashMenu } from './SlashMenu'
import { useAppStore } from '../store'

type SlotVariant = 'default' | 'cell'

type ObjectSlotProps = {
  value: string
  onChange: (value: string) => void
  depth?: number
  variant?: SlotVariant
  placeholder?: string
  /** When true (e.g. focused table cell), object surfaces stay in edit mode */
  active?: boolean
  /** Table-aware drop that can clear the source cell in one commit */
  onAcceptDrop?: (markdown: string) => boolean
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void
}

/** A place an object can live. Empty = editable container; slash fills it with an object. */
export function ObjectSlot({
  value,
  onChange,
  depth = 0,
  variant = 'default',
  placeholder,
  active = false,
  onAcceptDrop,
  onKeyDown,
}: ObjectSlotProps) {
  const [dropOver, setDropOver] = useState(false)
  const slotRef = useRef<HTMLDivElement | null>(null)
  const occupied = isCompleteMineFence(value)

  const insertMarkdown = (payload: string) => {
    if (cellMatchesDrag(value, payload)) {
      clearNestedDrag()
      return
    }
    if (onAcceptDrop?.(payload)) return
    const drag = peekNestedDrag()
    if (drag) {
      const taken = takeNestedDrag()
      if (!taken) return
      taken.remove()
      if (!value.trim()) {
        onChange(taken.markdown)
        return
      }
      if (occupied) {
        onChange(pasteIntoMarkdown(value, taken.markdown))
        return
      }
      onChange(pasteIntoCell(value, taken.markdown))
      return
    }
    if (!value.trim()) {
      onChange(payload)
      return
    }
    if (occupied) {
      onChange(pasteIntoMarkdown(value, payload))
      return
    }
    onChange(pasteIntoCell(value, payload))
  }
  const insertRef = useRef(insertMarkdown)
  insertRef.current = insertMarkdown

  const acceptDrop = () => {
    const drag = peekNestedDrag()
    if (!drag?.settling) return
    insertMarkdown(drag.markdown)
  }

  useEffect(() => {
    const el = slotRef.current
    if (!el) return
    const onInsert = (event: Event) => {
      const detail = (event as CustomEvent<MineSlotInsertDetail>).detail
      if (!detail?.markdown) return
      insertRef.current(detail.markdown)
    }
    el.addEventListener(MINE_SLOT_INSERT, onInsert as EventListener)
    return () => el.removeEventListener(MINE_SLOT_INSERT, onInsert as EventListener)
  }, [])

  return (
    <div
      ref={slotRef}
      className={`object-slot object-slot-${variant} ${occupied ? 'is-occupied' : 'is-empty'} ${dropOver ? 'is-drop-over' : ''}`}
      data-object-slot=""
      onPointerEnter={() => {
        if (peekNestedDrag()) setDropOver(true)
      }}
      onPointerLeave={() => setDropOver(false)}
      onPointerUp={() => {
        if (peekNestedDrag()) {
          setDropOver(false)
          acceptDrop()
        }
      }}
    >
      {occupied ? (
        <MineObject
          markdown={value}
          onChange={onChange}
          depth={depth}
          variant={variant}
          active={active}
          onKeyDown={onKeyDown}
        />
      ) : (
        <SlotEditor
          value={value}
          variant={variant}
          active={active}
          placeholder={placeholder}
          onChange={onChange}
          onKeyDown={onKeyDown}
        />
      )}
    </div>
  )
}

type MineObjectProps = {
  markdown: string
  onChange: (markdown: string) => void
  depth?: number
  variant?: SlotVariant
  draggable?: boolean
  active?: boolean
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void
}

/** Unified object: same chrome, editor, and drag whether nested or in a cell. */
export function MineObject({
  markdown,
  onChange,
  depth = 1,
  variant = 'default',
  draggable = true,
  active = false,
  onKeyDown,
}: MineObjectProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const reminderColumns = useAppStore((s) => s.workspaceSettings.reminderColumns) || []
  const activeNoteId = useAppStore((s) => s.activeNoteId)
  const draftTitle = useAppStore((s) => s.draftTitle)
  const mineObjects = useAppStore((s) => s.mineObjects)
  const loadMineObject = useAppStore((s) => s.loadMineObject)
  const propagateMineObjectUpdate = useAppStore((s) => s.propagateMineObjectUpdate)
  const complete = isCompleteMineFence(markdown)
  const fence = parseMineFence(markdown)
  const display = resolveEmbedDisplay(markdown, (srcId) => mineObjects[srcId]?.markdown)
  const displayFence = complete ? parseMineFence(display) : null
  const inner = displayFence ? innerMineMarkdown(display) : display
  const kind = detectBlockKind(display)
  const inCell = variant === 'cell'
  const embed = fence?.type === 'embed' ? fence : null

  useEffect(() => {
    const src = embed?.attrs.src
    if (!src || mineObjects[src]?.markdown) return
    void loadMineObject(src, embed.attrs.note || activeNoteId || undefined)
  }, [embed?.attrs.src, embed?.attrs.note, mineObjects, loadMineObject, activeNoteId])

  const emitDisplay = (nextDisplay: string) => {
    const canonicalId =
      embed?.attrs.src ||
      (fence && fence.type !== 'embed' ? fence.id : null) ||
      (displayFence && displayFence.type !== 'embed' ? displayFence.id : null)

    if (complete && embed && canonicalId) {
      // Embeds are projections — write the canonical object everywhere at once.
      propagateMineObjectUpdate(canonicalId, nextDisplay, {
        noteId: embed.attrs.note || activeNoteId || undefined,
      })
      return
    }

    onChange(nextDisplay)

    // Nested canonical objects must still refresh every embed of the same id.
    if (complete && canonicalId && fence?.type !== 'embed') {
      const source = parseMineFence(nextDisplay)
        ? nextDisplay
        : formatMineBlock(
            fence?.type || displayFence?.type || 'paragraph',
            canonicalId,
            nextDisplay,
            fence?.agentId ?? displayFence?.agentId,
            fence?.attrs || displayFence?.attrs,
          )
      propagateMineObjectUpdate(canonicalId, source, {
        noteId: activeNoteId || undefined,
      })
    }
  }

  const writeInner = (nextInner: string) => {
    if (!nextInner.trim() && inCell) {
      onChange('')
      return
    }
    if (!displayFence) {
      emitDisplay(nextInner)
      return
    }
    emitDisplay(
      formatMineBlock(displayFence.type, displayFence.id, nextInner, displayFence.agentId, displayFence.attrs),
    )
  }

  const retypeHost = (type: MineObjectType, nextInner: string) => {
    const id = displayFence?.id || fence?.id || newMineId()
    emitDisplay(formatMineBlock(type, id, nextInner, displayFence?.agentId, displayFence?.attrs))
  }

  const applySlashResult = (result: ReturnType<typeof applySlashAsNested>) => {
    if (result.hostType) {
      retypeHost(result.hostType, result.text)
      return
    }
    writeInner(result.text)
  }

  const copySelf = () => {
    writeObjectClipboard(
      canonicalObjectFromBlock(display, kind, activeNoteId || '', draftTitle),
      'content',
    )
  }

  const pasteChild = (mode: 'link' | 'content' | 'embed') => {
    void (async () => {
      const clip = await readObjectClipboard()
      if (!clip) return
      const pasted = pasteObjectMarkdown(clip, mode)
      if (!complete) {
        emitDisplay(appendNestedObject(display, pasted))
        return
      }
      emitDisplay(pasteIntoMarkdown(display, pasted))
    })()
  }

  const startDrag = (event: ReactPointerEvent) => {
    if (!draggable || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const root = rootRef.current
    if (!root) return
    const rect = root.getBoundingClientRect()
    const preview =
      root.querySelector('.mine-object-body, .note-table-wrap, .reminder-card, .live-block-html, .mine-object-html')
    const previewHtml =
      preview instanceof HTMLElement ? preview.innerHTML : root.innerText
    const startX = event.clientX
    const startY = event.clientY
    let started = false
    const grabX = event.clientX - rect.left
    const grabY = event.clientY - rect.top
    // Always drag the stored cell/slot markdown (keep embed wrappers intact)
    const payload = markdown

    const onMove = (moveEvent: PointerEvent) => {
      if (!started) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 5) return
        started = true
        root.classList.add('is-dragging')
        setObjectDragging(true)
        beginNestedDrag({
          markdown: payload,
          previewHtml,
          x: rect.left,
          y: rect.top,
          width: Math.max(Math.min(rect.width, 280), 120),
          height: Math.max(Math.min(rect.height, 96), 28),
          grabX: Math.min(grabX, 40),
          grabY: Math.min(grabY, 24),
          remove: () => onChange(''),
        })
      }
      moveNestedDrag(moveEvent.clientX - Math.min(grabX, 40), moveEvent.clientY - Math.min(grabY, 24))
      setDropHover(findObjectSlotAt(moveEvent.clientX, moveEvent.clientY, root))
    }

    const onUp = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
      root.classList.remove('is-dragging')
      if (!started) {
        setObjectDragging(false)
        return
      }
      upEvent.stopPropagation()
      const drag = peekNestedDrag()
      if (!drag) {
        setObjectDragging(false)
        return
      }
      const hit = findObjectSlotAt(upEvent.clientX, upEvent.clientY, root)
      if (hit) {
        const dest = hit.getBoundingClientRect()
        settleNestedDrag(dest.left, dest.top, Math.max(dest.width, 120))
        window.setTimeout(() => {
          dispatchMineSlotInsert(hit, { markdown: drag.markdown })
          clearDropHover()
          setObjectDragging(false)
          if (peekNestedDrag()) clearNestedDrag()
        }, 160)
        return
      }
      const hostMd = findLiveMarkdownAt(upEvent.clientX, upEvent.clientY)
      if (hostMd) {
        const gap = gapGhostAtY(hostMd, upEvent.clientY)
        settleNestedDrag(gap.x, gap.y - Math.max(0, drag.height / 2 - 2), Math.max(gap.w, 120))
        window.setTimeout(() => {
          dispatchMineDocInsert(hostMd, {
            markdown: drag.markdown,
            clientY: upEvent.clientY,
            mode: 'nested',
          })
          clearDropHover()
          setObjectDragging(false)
        }, 160)
        return
      }
      settleNestedDrag(rect.left, rect.top, rect.width)
      window.setTimeout(() => {
        clearNestedDrag()
        clearDropHover()
        setObjectDragging(false)
      }, 160)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
  }

  const body = () => {
    if (displayFence?.type === 'reminder') {
      const reminder =
        parseReminder(display) || {
          id: displayFence.id,
          title: inner,
          dueAt: null,
          status: firstColumnId(reminderColumns),
          position: 0,
          agentId: displayFence.agentId,
        }
      return (
        <ReminderBlock
          reminder={reminder}
          columns={reminderColumns}
          onChange={(patch) => emitDisplay(patchReminderBlock(display, patch) || display)}
        />
      )
    }
    const table = kind === 'table' ? parseMdTable(inner) : null
    if (table) {
      return (
        <TableBlock
          table={table}
          onChange={writeInner}
          nestDepth={depth}
          onCopyObject={copySelf}
          onCopyLink={copySelf}
        />
      )
    }
    return (
      <NestedInner
        inner={inner}
        kind={kind}
        depth={depth}
        variant={variant}
        active={active}
        onChange={writeInner}
        onSlashHost={applySlashResult}
        onKeyDown={onKeyDown}
      />
    )
  }

  return (
    <div
      ref={rootRef}
      className={`mine-object mine-object-${kind} mine-object-${variant} ${draggable ? 'is-draggable' : ''}`}
      data-nested-id={displayFence?.id || fence?.id || undefined}
      onContextMenu={(e) => {
        if (kind === 'table' && (e.target as HTMLElement).closest('.note-table-wrap')) return
        e.preventDefault()
        e.stopPropagation()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      {draggable ? (
        <button
          type="button"
          className="mine-object-handle"
          aria-label="Move object"
          onPointerDown={startDrag}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <GripVertical size={13} />
        </button>
      ) : null}
      <div className="mine-object-body">{body()}</div>
      {menu ? (
        <ObjectLinkMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onCopyObject={copySelf}
          onCopyLink={copySelf}
          onUnwrap={complete ? () => emitDisplay(unwrapNestedMarkdown(display)) : undefined}
          onPasteContent={() => pasteChild('content')}
          onPasteLink={() => pasteChild('link')}
          onEmbed={() => pasteChild('embed')}
        />
      ) : null}
    </div>
  )
}

/** @deprecated Use MineObject — kept for existing imports */
export const NestedObject = MineObject

export function NestedInner({
  inner,
  kind,
  depth,
  onChange,
  variant = 'default',
  active = false,
  onSlashHost,
  onKeyDown,
}: {
  inner: string
  kind: string
  depth: number
  onChange: (inner: string) => void
  variant?: SlotVariant
  active?: boolean
  onSlashHost?: (result: ReturnType<typeof applySlashAsNested>) => void
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void
}) {
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  if (!innerHasNestedFence(inner)) {
    return (
      <ObjectEditor
        value={inner}
        kind={kind}
        variant={variant}
        active={active}
        onChange={onChange}
        onSlashHost={onSlashHost}
        onKeyDown={onKeyDown}
      />
    )
  }

  const segments = splitInnerSegments(inner)

  const onDropAt = (index: number) => {
    const drag = peekNestedDrag()
    if (!drag?.settling) return
    const taken = takeNestedDrag()
    if (!taken) return
    const from = segments.findIndex((segment) => cellMatchesDrag(segment, taken.markdown))
    if (from >= 0) {
      onChange(moveInnerSegment(inner, from, index))
      setDropIndex(null)
      return
    }
    taken.remove()
    const next = [...segments]
    next.splice(Math.max(0, Math.min(index, next.length)), 0, taken.markdown)
    onChange(next.join('\n\n'))
    setDropIndex(null)
  }

  return (
    <div className="mine-object-stack">
      {segments.map((segment, index) => (
        <div
          key={parseMineFence(segment)?.id || `seg-${index}`}
          className={`object-drop-slot ${dropIndex === index ? 'is-active' : ''}`}
          data-object-slot=""
          onPointerEnter={() => {
            if (peekNestedDrag()) setDropIndex(index)
          }}
          onPointerLeave={() => setDropIndex((n) => (n === index ? null : n))}
          onPointerUp={() => {
            if (peekNestedDrag()) onDropAt(index)
          }}
        >
          <ObjectSlot
            value={segment}
            depth={depth + 1}
            variant={variant}
            onChange={(next) => onChange(replaceInnerSegment(inner, index, next))}
          />
        </div>
      ))}
      <div
        className={`object-drop-slot object-drop-end ${dropIndex === segments.length ? 'is-active' : ''}`}
        data-object-slot=""
        onPointerEnter={() => {
          if (peekNestedDrag()) setDropIndex(segments.length)
        }}
        onPointerLeave={() => setDropIndex((n) => (n === segments.length ? null : n))}
        onPointerUp={() => {
          if (peekNestedDrag()) onDropAt(segments.length)
        }}
      />
    </div>
  )
}

function SlotEditor({
  value,
  onChange,
  variant,
  placeholder,
  active = false,
  onKeyDown,
}: {
  value: string
  onChange: (value: string) => void
  variant: SlotVariant
  placeholder?: string
  active?: boolean
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void
}) {
  const [slash, setSlash] = useState<SlashTrigger | null>(null)
  const [menuIndex, setMenuIndex] = useState(0)
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const slashHits = slash ? filterSlashCommands(slash.query) : []
  const cell = variant === 'cell'

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.max(el.scrollHeight, cell ? 32 : 28)}px`
  }, [value, cell])

  useEffect(() => {
    if (!active) return
    const el = ref.current
    if (!el || document.activeElement === el) return
    el.focus()
  }, [active])

  useEffect(() => {
    setMenuIndex(0)
  }, [slash?.from, slash?.query])

  const pickSlash = (cmd: SlashCommand) => {
    if (!slash || cmd.special) {
      setSlash(null)
      return
    }
    const type = slashCommandMineType(cmd)
    const result = applySlashAsNested(value, slash, cmd, type)
    setSlash(null)
    if (result.hostType) {
      onChange(formatMineBlock(result.hostType, newMineId(), result.text))
      return
    }
    if (type) {
      // Container beside existing text: keep plain host, nest object
      onChange(result.text)
      return
    }
    onChange(result.text)
  }

  return (
    <div className={`object-slot-editor ${cell ? 'is-cell' : ''}`}>
      <textarea
        ref={ref}
        className={cell ? 'note-table-cell' : 'live-block-input'}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          const text = e.target.value
          const caret = e.target.selectionStart
          const starter = matchMarkdownStarter(text, caret)
          if (starter?.type) {
            setSlash(null)
            onChange(formatMineBlock(starter.type, newMineId(), starter.inner))
            return
          }
          if (starter && !starter.type) {
            setSlash(null)
            onChange(starter.inner)
            return
          }
          onChange(text)
          setSlash(findSlashTrigger(text, caret))
        }}
        onKeyDown={(e) => {
          if (slash && slashHits.length) {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setMenuIndex((n) => (n + 1) % slashHits.length)
              return
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setMenuIndex((n) => (n - 1 + slashHits.length) % slashHits.length)
              return
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault()
              e.stopPropagation()
              pickSlash(slashHits[menuIndex] || slashHits[0])
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setSlash(null)
              return
            }
          }
          if (cell && e.key === 'Enter' && !e.shiftKey) {
            // Let table navigation happen unless slash handled above
            onKeyDown?.(e)
            return
          }
          onKeyDown?.(e)
        }}
      />
      {slash ? (
        <SlashMenu
          commands={slashHits}
          activeIndex={menuIndex}
          onHover={setMenuIndex}
          onPick={pickSlash}
        />
      ) : null}
    </div>
  )
}

function ObjectEditor({
  value,
  kind,
  onChange,
  variant,
  active = false,
  onSlashHost,
  onKeyDown,
}: {
  value: string
  kind: string
  onChange: (value: string) => void
  variant: SlotVariant
  active?: boolean
  onSlashHost?: (result: ReturnType<typeof applySlashAsNested>) => void
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void
}) {
  const categories = useAppStore((s) => s.categories)
  const [localEdit, setLocalEdit] = useState(!value.trim())
  const [slash, setSlash] = useState<SlashTrigger | null>(null)
  const [menuIndex, setMenuIndex] = useState(0)
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const caretRef = useRef<number | null>(null)
  const skipBlur = useRef(false)
  const wasEditing = useRef(false)
  const slashHits = slash ? filterSlashCommands(slash.query) : []
  const cell = variant === 'cell'
  // Cells follow table focus only — leaving the cell must return to HTML.
  const editing = !value.trim() || (cell ? active : localEdit)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.max(el.scrollHeight, cell ? 32 : 28)}px`
  }, [value, cell, editing])

  useLayoutEffect(() => {
    if (!editing) {
      wasEditing.current = false
      return
    }
    const el = ref.current
    if (!el) return
    const justEntered = !wasEditing.current
    wasEditing.current = true
    if (caretRef.current != null) {
      const caret = Math.max(0, Math.min(caretRef.current, el.value.length))
      el.focus({ preventScroll: true })
      el.setSelectionRange(caret, caret)
      caretRef.current = null
      return
    }
    if (justEntered) {
      const starter = matchMarkdownStarter(value, value.length)
      const caret = starter ? starter.caret : defaultInnerCaret(value)
      el.focus({ preventScroll: true })
      el.setSelectionRange(caret, caret)
    }
  }, [editing, value])

  useEffect(() => {
    setMenuIndex(0)
  }, [slash?.from, slash?.query])

  useEffect(() => {
    if (!value.trim()) setLocalEdit(true)
  }, [value])

  useEffect(() => {
    if (cell && !active) setLocalEdit(false)
  }, [cell, active])

  const applyEdit = (text: string, caret: number) => {
    caretRef.current = caret
    onChange(text)
  }

  const tryPromoteStarter = (text: string, caret: number): boolean => {
    const starter = matchMarkdownStarter(text, caret)
    if (!starter) return false
    // Only promote from plain paragraph bodies
    if (kind !== 'p' && kind !== 'paragraph') return false
    if (starter.type) {
      if (onSlashHost) {
        onSlashHost({ text: starter.inner, caret: starter.caret, hostType: starter.type })
        return true
      }
      caretRef.current = starter.caret
      onChange(formatMineBlock(starter.type, newMineId(), starter.inner))
      return true
    }
    caretRef.current = starter.caret
    onChange(starter.inner)
    return true
  }

  const pickSlash = (cmd: SlashCommand) => {
    if (!slash || cmd.special) {
      setSlash(null)
      return
    }
    const result = applySlashAsNested(value, slash, cmd, slashCommandMineType(cmd))
    setSlash(null)
    if (result.hostType && onSlashHost) {
      caretRef.current = result.caret
      onSlashHost(result)
      return
    }
    if (result.hostType) {
      caretRef.current = result.caret
      onChange(formatMineBlock(result.hostType, newMineId(), result.text))
      return
    }
    if (onSlashHost) {
      caretRef.current = result.caret
      onSlashHost(result)
      return
    }
    applyEdit(result.text, result.caret)
  }

  if (!editing) {
    return (
      <div
        className={`mine-object-html prose kind-${kind} ${cell ? 'is-cell' : ''}`}
        onPointerDown={(e) => {
          const checkbox = (e.target as HTMLElement).closest(
            'input[type="checkbox"]',
          ) as HTMLInputElement | null
          if (checkbox) {
            // Toggle before any parent (table cell) can enter edit mode and
            // unmount this rendered surface mid-click.
            e.preventDefault()
            e.stopPropagation()
            const boxes = (e.currentTarget as HTMLElement).querySelectorAll(
              'input[type="checkbox"]',
            )
            const index = [...boxes].indexOf(checkbox)
            onChange(toggleNthCheckbox(value, Math.max(0, index)))
            return
          }
          // Keep the gesture from stealing focus before the textarea mounts;
          // still bubble so table cells can mark themselves active.
          e.preventDefault()
          if (!cell) setLocalEdit(true)
        }}
        dangerouslySetInnerHTML={{ __html: renderNoteHtml(value, categories) }}
      />
    )
  }

  return (
    <div className={`mine-object-editor kind-${kind} ${cell ? 'is-cell' : ''}`}>
      <div className="live-block-edit">
        <pre
          className="live-block-mirror"
          aria-hidden
          dangerouslySetInnerHTML={{
            __html: highlightMarkdownSource(value) + (value.endsWith('\n') ? '\n' : ''),
          }}
        />
        <textarea
          ref={ref}
          className={`live-block-input kind-${kind}`}
          value={value}
          spellCheck={kind !== 'code'}
          onChange={(e) => {
            const text = e.target.value
            const caret = e.target.selectionStart
            if (tryPromoteStarter(text, caret)) return
            onChange(text)
            setSlash(findSlashTrigger(text, caret))
          }}
          onBlur={() => {
            if (skipBlur.current) {
              skipBlur.current = false
              return
            }
            window.setTimeout(() => {
              if (ref.current === document.activeElement) return
              setSlash(null)
              if (value.trim() && !(cell && active)) setLocalEdit(false)
            }, 10)
          }}
          onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
            const ta = e.currentTarget
            if (slash && slashHits.length) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setMenuIndex((n) => (n + 1) % slashHits.length)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setMenuIndex((n) => (n - 1 + slashHits.length) % slashHits.length)
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                e.stopPropagation()
                pickSlash(slashHits[menuIndex] || slashHits[0])
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setSlash(null)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && kind !== 'code' && kind !== 'toggle') {
              e.preventDefault()
              e.stopPropagation()
              const edit = isListBlockKind(kind)
                ? handleListEnter(value, ta.selectionStart) ?? handlePlainEnter(value, ta.selectionStart)
                : handlePlainEnter(value, ta.selectionStart)
              if (edit.type === 'replace') {
                applyEdit(edit.text, edit.caret)
                return
              }
              const content = edit.blocks.filter((block) => block.trim()).join('\n\n')
              applyEdit(content, edit.caret)
              return
            }
            if (e.key === 'Tab' && isListBlockKind(kind)) {
              e.preventDefault()
              e.stopPropagation()
              const edit = handleListTab(value, ta.selectionStart, e.shiftKey)
              if (edit?.type === 'replace') applyEdit(edit.text, edit.caret)
              return
            }
            onKeyDown?.(e)
          }}
          rows={1}
        />
      </div>
      {slash ? (
        <SlashMenu
          commands={slashHits}
          activeIndex={menuIndex}
          onHover={setMenuIndex}
          onPick={(cmd) => {
            skipBlur.current = true
            pickSlash(cmd)
          }}
        />
      ) : null}
    </div>
  )
}
