import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
  Bell,
  Bot,
  GripVertical,
  Layers,
  Trash2,
  X,
} from 'lucide-react'
import { renderNoteHtml } from '../lib/renderMarkdown'
import {
  detectBlockKind,
  highlightMarkdownSource,
  joinMarkdownBlocks,
  splitMarkdownBlocks,
  toggleNthCheckbox,
} from '../lib/liveMarkdown'
import {
  handleHeadingEnter,
  handleListEnter,
  handleListTab,
  handlePlainEnter,
  isListBlockKind,
  type BlockEdit,
} from '../lib/listEdit'
import { findTagTrigger, formatTagLink, type TagTrigger } from '../lib/categoryTags'
import { formatAgentBlock, innerAgentMarkdown, parseAgentId } from '../lib/agentBlock'
import {
  findCanonicalMineObject,
  formatMineBlock,
  innerMineMarkdown,
  isMineObjectType,
  newMineId,
  parseBlockAgentId,
  parseMineFence,
  unwrapEmbed,
  type MineFence,
} from '../lib/mineObjects'
import {
  firstColumnId,
  formatReminder,
  newReminderId,
  parseReminder,
  patchReminderBlock,
} from '../lib/reminders'
import { AgentBlock } from './AgentBlock'
import { ReminderBlock, ObjectLinkMenu } from './ReminderBlock'
import { NestedInner } from './NestedObject'
import { TableBlock } from './TableBlock'
import { SlashMenu } from './SlashMenu'
import { parseMdTable, serializeMdTable } from '../lib/mdTable'
import { innerHasNestedFence } from '../lib/nestedObjects'
import { peekNestedDrag, takeNestedDrag } from '../lib/nestedDrag'
import {
  MINE_DOC_INSERT,
  dispatchMineDocInsert,
  findLiveMarkdownAt,
  gapGhostAtY,
  insertIndexAtY,
  type MineDocInsertDetail,
} from '../lib/mineDocTransfer'
import {
  clearDropHover,
  findObjectSlotAt,
  setDropHover,
  setObjectDragging,
} from '../lib/dropTarget'
import {
  dispatchMineSlotInsert,
  findCanonicalInMarkdown,
} from '../lib/mineEmbedSync'
import { applyCanonicalObjectUpdate } from '../lib/structuredDoc'
import {
  applySlashCommand,
  filterSlashCommands,
  findSlashTrigger,
  slashCommandMineType,
  type SlashCommand,
  type SlashTrigger,
} from '../lib/slashCommands'
import { matchMarkdownStarter } from '../lib/markdownStarters'
import { findPaneForNote } from '../lib/workspaceLayout'
import {
  applyDrop,
  flattenLeaves,
  normalizeDocument,
  parseDocument,
  serializeDocument,
  spliceLeaves,
  updateLeaf,
  verticalShifts,
  type DocNode,
  type DropTarget,
  type Leaf,
} from '../lib/layout'
import {
  canonicalObjectFromBlock,
  clipboardMatchesObject,
  ensureMineObject,
  insertObjectChip,
  pasteObjectMarkdown,
  peekObjectClipboard,
  readObjectClipboard,
  readObjectLink,
  writeObjectClipboard,
  type ObjectPasteMode,
} from '../lib/objectLink'
import { api } from '../api'
import { useAppStore } from '../store'
import { CatIcon } from './CatIcon'
import type { Category, Note } from '../types'

type DragGhost = {
  x: number
  y: number
  w: number
  h: number
  mode: 'gap' | 'left' | 'right' | 'center'
}

type DragState = {
  fromId: string
  x: number
  y: number
  width: number
  height: number
  grabX: number
  grabY: number
  previewHtml: string
  target: DropTarget | null
  ghost: DragGhost | null
  splitId: string | null
  shifts: Record<string, number>
  settling: boolean
  transfer: { el: HTMLElement; clientY: number } | null
  slot: HTMLElement | null
}

type Props = {
  value: string
  onChange: (value: string) => void
  noteId?: string
  placeholder?: string
  autoFocus?: boolean
}

export function LiveMarkdown({ value, onChange, noteId, placeholder, autoFocus }: Props) {
  const [nodes, setNodes] = useState<DocNode[]>(() => parseDocument(value))
  const [focused, setFocused] = useState<number | null>(autoFocus ? 0 : null)
  const [trigger, setTrigger] = useState<TagTrigger | null>(null)
  const [slash, setSlash] = useState<SlashTrigger | null>(null)
  const [menuIndex, setMenuIndex] = useState(0)
  const [openAgentId, setOpenAgentId] = useState<string | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [popId, setPopId] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ from: number; to: number } | null>(null)
  const [blockMenu, setBlockMenu] = useState<{ x: number; y: number; index: number } | null>(null)
  const [importGap, setImportGap] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const lastEmitted = useRef(value)
  const pendingValueRef = useRef<string | null>(null)
  const caretRef = useRef<number | null>(null)
  const skipBlur = useRef(false)
  const insertingAgent = useRef(false)
  const textareaRefs = useRef<Array<HTMLTextAreaElement | null>>([])
  const blocksRef = useRef<string[]>([])
  const nodesRef = useRef(nodes)
  const selectedRef = useRef(selected)
  const focusedRef = useRef(focused)
  const dragRef = useRef<DragState | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const pasteModeRef = useRef<ObjectPasteMode>('link')
  const beginHandleDragRef = useRef<(id: string, index: number, clientX: number, clientY: number) => void>(() => {})
  const moveHandleDragRef = useRef<(clientX: number, clientY: number) => void>(() => {})
  const finishHandleDragRef = useRef<() => void>(() => {})
  const pasteObjectAtRef = useRef<
    (index: number, mode: ObjectPasteMode, opts?: { atCaret?: boolean; replaceTo?: number }) => void
  >(() => {})
  const pendingHandleRef = useRef<{
    id: string
    index: number
    x: number
    y: number
  } | null>(null)
  const selectingRef = useRef<{
    start: number
    end: number
    x: number
    y: number
    dragged: boolean
  } | null>(null)
  const notes = useAppStore((s) => s.notes)
  const categories = useAppStore((s) => s.categories)
  const activeNoteId = useAppStore((s) => s.activeNoteId)
  const workspaceSettings = useAppStore((s) => s.workspaceSettings)
  const selectNote = useAppStore((s) => s.selectNote)
  const focusWorkspacePane = useAppStore((s) => s.focusWorkspacePane)
  const editorLayout = useAppStore((s) => s.editorLayout)
  const createNote = useAppStore((s) => s.createNote)
  const focusInlineAgentId = useAppStore((s) => s.focusInlineAgentId)
  const setFocusInlineAgentId = useAppStore((s) => s.setFocusInlineAgentId)
  const jobs = useAppStore((s) => s.agents)
  const aiShortcut = workspaceSettings.aiShortcut || '>'
  const reminderShortcut = workspaceSettings.reminderShortcut || '!'
  const reminderColumns = workspaceSettings.reminderColumns?.length
    ? workspaceSettings.reminderColumns
    : [{ id: 'todo', label: 'To do' }, { id: 'doing', label: 'Doing' }, { id: 'done', label: 'Done', done: true }]
  const focusReminderId = useAppStore((s) => s.focusReminderId)
  const setFocusReminderId = useAppStore((s) => s.setFocusReminderId)
  const focusMineObjectId = useAppStore((s) => s.focusMineObjectId)
  const setFocusMineObjectId = useAppStore((s) => s.setFocusMineObjectId)
  const openMineObject = useAppStore((s) => s.openMineObject)
  const syncReminderLocal = useAppStore((s) => s.syncReminderLocal)
  const draftTitle = useAppStore((s) => s.draftTitle)
  const mineObjects = useAppStore((s) => s.mineObjects)
  const loadMineObject = useAppStore((s) => s.loadMineObject)
  const rememberMineObject = useAppStore((s) => s.rememberMineObject)
  const propagateMineObjectUpdate = useAppStore((s) => s.propagateMineObjectUpdate)
  const objectPasteMode: ObjectPasteMode = workspaceSettings.objectPasteMode || 'link'
  const leaves = flattenLeaves(nodes)
  const blocks = leaves.map((leaf) => leaf.markdown)
  blocksRef.current = blocks
  nodesRef.current = nodes
  selectedRef.current = selected
  focusedRef.current = focused
  dragRef.current = drag
  pasteModeRef.current = objectPasteMode

  useEffect(() => {
    if (value === lastEmitted.current) {
      pendingValueRef.current = null
      return
    }
    // Keep the in-flight drag tree stable — queue external updates until drop settles.
    if (dragRef.current) {
      pendingValueRef.current = value
      return
    }
    pendingValueRef.current = null
    lastEmitted.current = value
    setNodes(parseDocument(value))
    setFocused(autoFocus ? 0 : null)
  }, [value, autoFocus])

  const flushPendingValue = () => {
    const pending = pendingValueRef.current
    pendingValueRef.current = null
    if (pending == null || pending === lastEmitted.current) return
    lastEmitted.current = pending
    setNodes(parseDocument(pending))
  }

  useEffect(() => {
    if (!focusInlineAgentId) return
    setOpenAgentId(focusInlineAgentId)
    setFocusInlineAgentId(null)
  }, [focusInlineAgentId, setFocusInlineAgentId])

  useEffect(() => {
    if (!focusReminderId) return
    const index = flattenLeaves(parseDocument(value)).findIndex((leaf) => {
      const fence = parseMineFence(leaf.markdown)
      return fence?.type === 'reminder' && fence.id === focusReminderId
    })
    if (index < 0) return
    setSelected({ from: index, to: index })
    setFocused(null)
    window.requestAnimationFrame(() => {
      document.querySelector(`[data-block-index="${index}"]`)?.scrollIntoView({ block: 'center' })
    })
    setFocusReminderId(null)
  }, [focusReminderId, value, setFocusReminderId])

  useEffect(() => {
    if (!focusMineObjectId) return
    const leavesNow = flattenLeaves(parseDocument(value))
    const canonical = leavesNow.findIndex((leaf) => {
      const fence = parseMineFence(leaf.markdown)
      return Boolean(fence && fence.type !== 'embed' && (fence.id === focusMineObjectId || leaf.id === focusMineObjectId))
    })
    const fallback = leavesNow.findIndex((leaf) => {
      const fence = parseMineFence(leaf.markdown)
      return (
        fence?.id === focusMineObjectId ||
        leaf.id === focusMineObjectId ||
        (fence?.type === 'embed' && fence.attrs.src === focusMineObjectId)
      )
    })
    const resolved = canonical >= 0 ? canonical : fallback
    if (resolved < 0) return
    setSelected({ from: resolved, to: resolved })
    setFocused(null)
    window.requestAnimationFrame(() => {
      document.querySelector(`[data-block-index="${resolved}"]`)?.scrollIntoView({ block: 'center' })
    })
    setFocusMineObjectId(null)
  }, [focusMineObjectId, value, setFocusMineObjectId])

  useEffect(() => {
    const seen = new Set<string>()
    for (const block of flattenLeaves(parseDocument(value)).map((leaf) => leaf.markdown)) {
      const mine = parseMineFence(block)
      if (mine?.type !== 'embed' || !mine.attrs.src || seen.has(mine.attrs.src)) continue
      seen.add(mine.attrs.src)
      const local = findCanonicalMineObject(value, mine.attrs.src)
      if (!local) void loadMineObject(mine.attrs.src, mine.attrs.note)
    }
  }, [value, loadMineObject])

  useLayoutEffect(() => {
    if (focused == null) return
    const el = textareaRefs.current[focused]
    if (!el) return
    if (document.activeElement !== el) el.focus({ preventScroll: true })
    const pos =
      caretRef.current != null ? Math.min(caretRef.current, el.value.length) : el.selectionStart
    if (caretRef.current != null) {
      el.setSelectionRange(pos, pos)
      caretRef.current = null
    }
    el.style.height = '0px'
    el.style.height = `${Math.max(el.scrollHeight, 28)}px`
    const slashNext = findSlashTrigger(el.value, pos)
    if (slashNext) {
      setSlash(slashNext)
      setTrigger(null)
      return
    }
    setSlash(null)
    setTrigger(findTagTrigger(el.value, pos, categories, workspaceSettings))
  }, [focused, categories, workspaceSettings])

  const focusBlock = (index: number, caret: number | null) => {
    skipBlur.current = true
    caretRef.current = caret
    setFocused(index)
    if (caret == null) return
    window.requestAnimationFrame(() => {
      const el = textareaRefs.current[index]
      if (!el) return
      el.focus({ preventScroll: true })
      const pos = caretRef.current != null ? Math.min(caretRef.current, el.value.length) : caret
      el.setSelectionRange(pos, pos)
      caretRef.current = null
    })
  }

  const emitNodes = (next: DocNode[]) => {
    const normalized = normalizeDocument(next)
    nodesRef.current = normalized
    setNodes(normalized)
    const joined = serializeDocument(normalized)
    lastEmitted.current = joined
    onChange(joined)
  }

  const emitSplice = (start: number, deleteCount: number, inserts: string[]) => {
    emitNodes(spliceLeaves(nodesRef.current, start, deleteCount, inserts))
  }

  const insertAtClientY = (clientY: number, markdown: string) => {
    const root = rootRef.current
    const index = root
      ? insertIndexAtY(root, clientY, blocksRef.current.length)
      : blocksRef.current.length
    emitSplice(Math.max(0, Math.min(index, blocksRef.current.length)), 0, [markdown])
  }

  const updateBlock = (index: number, text: string) => {
    const id = flattenLeaves(nodesRef.current)[index]?.id
    if (!id) return
    emitNodes(updateLeaf(nodesRef.current, id, text))
  }

  const insertAgentAt = async (index: number, text: string, from: number, to: number) => {
    if (!activeNoteId || insertingAgent.current) return
    insertingAgent.current = true
    setTrigger(null)
    setSlash(null)
    try {
      const agent = await api.createAgent(activeNoteId)
      const before = text.slice(0, from).replace(/[ \t]+$/, '')
      const after = text.slice(to).replace(/^[ \t]+/, '')
      const wrapped = formatAgentBlock(agent.id)
      const pieces = [...(before ? [before] : []), wrapped, after]
      emitSplice(index, 1, pieces)
      setOpenAgentId(agent.id)
      setFocused(null)
    } catch {
      updateBlock(index, text)
    } finally {
      insertingAgent.current = false
    }
  }

  const insertReminderAt = (index: number, text: string, from: number, to: number) => {
    const before = text.slice(0, from).replace(/[ \t]+$/, '')
    const after = text.slice(to).replace(/^[ \t]+/, '')
    const reminder = {
      id: newReminderId(),
      title: '',
      dueAt: null,
      status: firstColumnId(reminderColumns),
      position: 0,
    }
    const wrapped = formatReminder(reminder)
    const pieces = [...(before ? [before] : []), wrapped, after]
    emitSplice(index, 1, pieces)
    setTrigger(null)
    setSlash(null)
    setFocused(null)
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const title = document.querySelector(
          `[data-reminder-id="${reminder.id}"] .reminder-title`,
        ) as HTMLInputElement | null
        title?.focus()
      })
    })
    syncReminderLocal({
      id: reminder.id,
      noteId: activeNoteId || '',
      noteTitle: draftTitle,
      title: '',
      dueAt: null,
      status: reminder.status,
      position: 0,
      updatedAt: new Date().toISOString(),
    })
  }

  const openWiki = (title: string, categoryId?: string) => {
    const match = notes.find((n) => n.title.toLowerCase() === title.toLowerCase())
    if (match) void selectNote(match.id)
    else void createNote(title, categoryId || null)
  }

  const slashHits = slash ? filterSlashCommands(slash.query) : []
  const menuItems = trigger
    ? trigger.category
      ? notes.filter(
          (n) =>
            n.categoryId === trigger.category!.id &&
            n.id !== activeNoteId &&
            (!trigger.query || n.title.toLowerCase().includes(trigger.query.toLowerCase())),
        )
      : []
    : []
  const canCreate =
    Boolean(trigger?.category && trigger.query.trim()) &&
    !menuItems.some((n) => n.title.toLowerCase() === trigger!.query.trim().toLowerCase())
  const specialSlots =
    trigger && !trigger.category
      ? (trigger.showAi ? 1 : 0) + (trigger.showReminder ? 1 : 0)
      : 0
  const menuCount = trigger?.category
    ? menuItems.length + (canCreate ? 1 : 0)
    : specialSlots + (trigger?.categoryChoices.length || 0)

  useEffect(() => {
    setMenuIndex(0)
  }, [trigger?.from, trigger?.category?.id, trigger?.query, trigger?.categoryChoices.length, trigger?.showAi, trigger?.showReminder, slash?.from, slash?.query])

  const writeBlock = (index: number, text: string) => {
    const current = blocksRef.current[index]
    const mine = parseMineFence(current)
    if (mine?.type === 'embed') {
      commitEmbedInner(index, mine, text)
      return
    }
    if (mine) {
      const next = formatMineBlock(mine.type, mine.id, text, mine.agentId, mine.attrs)
      const doc = serializeDocument(nodesRef.current)
      const updated = applyCanonicalObjectUpdate(doc, mine.id, next)
      if (updated !== doc) emitNodes(parseDocument(updated))
      else updateBlock(index, next)
      propagateMineObjectUpdate(mine.id, next, { noteId: activeNoteId || undefined })
      return
    }
    updateBlock(index, text)
  }

  const restoreCaret = (index: number, caret: number) => {
    caretRef.current = caret
    window.requestAnimationFrame(() => {
      const el = textareaRefs.current[index]
      if (!el) return
      el.focus({ preventScroll: true })
      el.setSelectionRange(caret, caret)
    })
  }

  const commitInnerEdit = (index: number, edit: BlockEdit, keepObject: boolean) => {
    if (edit.type === 'replace') {
      writeBlock(index, edit.text)
      restoreCaret(index, edit.caret)
      return
    }
    if (keepObject) {
      const [head, ...tail] = edit.blocks
      writeBlock(index, head ?? '')
      if (tail.length) emitSplice(index + 1, 0, tail)
      setTrigger(null)
      setSlash(null)
      focusBlock(index + edit.focus, edit.caret)
      return
    }
    emitSplice(index, 1, edit.blocks)
    setTrigger(null)
    setSlash(null)
    focusBlock(index + edit.focus, edit.caret)
  }

  const findLocalSource = (srcId: string) => {
    for (const leaf of flattenLeaves(nodesRef.current)) {
      const fence = parseMineFence(leaf.markdown)
      if (fence && fence.id === srcId && fence.type !== 'embed') return leaf
      const nested = findCanonicalInMarkdown(leaf.markdown, srcId)
      if (nested) return { ...leaf, markdown: nested }
    }
    return null
  }

  const commitEmbedSource = (_index: number, embed: MineFence, sourceMarkdown: string) => {
    const srcId = embed.attrs.src
    if (!srcId) {
      updateBlock(_index, formatMineBlock(embed.type, embed.id, sourceMarkdown, embed.agentId, embed.attrs))
      return
    }
    const source = unwrapEmbed(sourceMarkdown)
    const current = serializeDocument(nodesRef.current)
    const next = applyCanonicalObjectUpdate(current, srcId, source)
    if (next !== current) emitNodes(parseDocument(next))
    propagateMineObjectUpdate(srcId, source, {
      noteId: embed.attrs.note || activeNoteId || undefined,
    })
  }

  const commitEmbedInner = (
    index: number,
    embed: NonNullable<ReturnType<typeof parseMineFence>>,
    innerContent: string,
  ) => {
    const srcId = embed.attrs.src || embed.id
    const srcType =
      embed.attrs.type && isMineObjectType(embed.attrs.type) && embed.attrs.type !== 'embed'
        ? embed.attrs.type
        : 'paragraph'
    const local = findLocalSource(srcId)
    const localFence = local ? parseMineFence(local.markdown) : parseMineFence(unwrapEmbed(blocksRef.current[index] || ''))
    const sourceMarkdown = formatMineBlock(
      localFence?.type && localFence.type !== 'embed' ? localFence.type : srcType,
      srcId,
      innerContent,
      localFence?.agentId ?? null,
      localFence?.attrs || {},
    )
    commitEmbedSource(index, embed, sourceMarkdown)
  }

  const displayMarkdownFor = (block: string) => {
    const mine = parseMineFence(block)
    if (mine?.type !== 'embed' || !mine.attrs.src) return block
    const local = findLocalSource(mine.attrs.src)
    if (local) return local.markdown
    const cached = mineObjects[mine.attrs.src]?.markdown
    if (cached) return cached
    return unwrapEmbed(block)
  }

  const syncReminderFromBlock = (block: string) => {
    const parsed = parseReminder(block)
    if (!parsed) return
    syncReminderLocal({
      id: parsed.id,
      noteId: activeNoteId || '',
      noteTitle: draftTitle,
      title: parsed.title,
      dueAt: parsed.dueAt,
      status: parsed.status,
      position: parsed.position,
      updatedAt: new Date().toISOString(),
      objectId: parsed.objectId ?? null,
      objectType: parsed.objectType ?? null,
      objectNoteId: parsed.objectNoteId ?? null,
      objectLabel: parsed.objectLabel ?? null,
    })
  }

  const copyObjectAt = (index: number, pasteAs: 'link' | 'content' = 'link') => {
    const block = blocksRef.current[index]
    if (!block) return
    const kind = detectBlockKind(block)
    const ensured = ensureMineObject(block, kind)
    if (ensured.markdown !== block && parseMineFence(block)?.type !== 'embed') {
      updateBlock(index, ensured.markdown)
    }
    writeObjectClipboard(
      canonicalObjectFromBlock(ensured.markdown, kind, activeNoteId || '', draftTitle),
      pasteAs,
    )
  }

  const pasteObjectAt = (
    index: number,
    mode: ObjectPasteMode,
    opts?: { atCaret?: boolean; replaceTo?: number },
  ) => {
    void (async () => {
      const clip = await readObjectClipboard()
      if (!clip) return
      const current = blocksRef.current[index] ?? ''
      const mine = parseMineFence(current)
      const inner = mine ? innerMineMarkdown(current) : current
      const empty = !inner.trim()
      const ta = textareaRefs.current[index]
      const allSelected = Boolean(
        ta && ta.selectionStart === 0 && ta.selectionEnd === ta.value.length && ta.value.length > 0,
      )
      const replaceCount =
        opts?.replaceTo != null ? Math.max(1, opts.replaceTo - index + 1) : empty || allSelected ? 1 : 0
      if (mode === 'link' && opts?.atCaret && !empty && !allSelected) {
        const caret = ta?.selectionStart ?? caretRef.current
        const nextInner = insertObjectChip(inner, caret, clip.link)
        writeBlock(index, nextInner)
        return
      }
      const markdown = pasteObjectMarkdown(clip, mode)
      if (replaceCount > 0) emitSplice(index, replaceCount, [markdown])
      else emitSplice(index + 1, 0, [markdown])
      if (mode === 'content') {
        const dup = parseMineFence(markdown)
        if (dup?.type === 'reminder') syncReminderFromBlock(markdown)
      }
      setSelected(null)
      setFocused(null)
    })()
  }
  pasteObjectAtRef.current = pasteObjectAt

  const dropObjectAt = async (index: number) => {
    const link = await readObjectLink()
    if (!link) return
    const block = blocksRef.current[index]
    if (!block) return
    const mine = parseMineFence(block)
    const kind = detectBlockKind(block)
    if (mine?.type === 'reminder' || parseReminder(block)) {
      const next = patchReminderBlock(block, {
        objectId: link.id,
        objectType: link.type,
        objectNoteId: link.noteId,
        objectLabel: link.label,
      })
      updateBlock(index, next)
      syncReminderFromBlock(next)
      return
    }
    const inner = mine ? innerMineMarkdown(block) : block
    if (kind === 'table' || mine?.type === 'table') {
      const table = parseMdTable(inner)
      if (!table) return
      const refs = table.refs || []
      if (refs.some((item) => item.id === link.id)) return
      writeBlock(index, serializeMdTable({ ...table, refs: [...refs, link] }))
      return
    }
    const ta = textareaRefs.current[index]
    const caret = focused === index ? ta?.selectionStart ?? caretRef.current : null
    const nextInner = insertObjectChip(inner, caret, link)
    updateBlock(index, mine ? formatMineBlock(mine.type, mine.id, nextInner, mine.agentId, mine.attrs) : nextInner)
  }

  const insertTag = (index: number, category: Category, title: string) => {
    const block = blocks[index]
    if (!trigger || !block) return
    const mine = parseMineFence(block)
    const source = mine ? innerMineMarkdown(block) : block
    const inserted = formatTagLink(category.tag, title)
    const next = source.slice(0, trigger.from) + inserted + source.slice(trigger.to)
    writeBlock(index, next)
    setTrigger(null)
    focusBlock(index, trigger.from + inserted.length)
  }

  const chooseMenu = async (index: number) => {
    if (!trigger || focused == null) return
    if (!trigger.category) {
      const specials: Array<'ai' | 'reminder'> = []
      if (trigger.showAi) specials.push('ai')
      if (trigger.showReminder) specials.push('reminder')
      const picked = specials[menuIndex]
      if (picked === 'ai') {
        const source = parseMineFence(blocks[index])
          ? innerMineMarkdown(blocks[index])
          : blocks[index]
        void insertAgentAt(index, source, trigger.from, trigger.to)
        return
      }
      if (picked === 'reminder') {
        const source = parseMineFence(blocks[index])
          ? innerMineMarkdown(blocks[index])
          : blocks[index]
        insertReminderAt(index, source, trigger.from, trigger.to)
        return
      }
      const category = trigger.categoryChoices[menuIndex - specials.length]
      if (!category) return
      const source = parseMineFence(blocks[index])
        ? innerMineMarkdown(blocks[index])
        : blocks[index]
      const next = source.slice(0, trigger.from) + `:${category.tag}` + source.slice(trigger.to)
      writeBlock(index, next)
      const caret = trigger.from + 1 + category.tag.length
      setTrigger({
        from: trigger.from,
        to: caret,
        category,
        query: '',
        categoryChoices: [],
        showAi: false,
        aiMatch: false,
        showReminder: false,
        reminderMatch: false,
      })
      focusBlock(index, caret)
      return
    }
    if (menuIndex < menuItems.length) {
      insertTag(index, trigger.category, menuItems[menuIndex].title)
      return
    }
    if (canCreate) {
      const title = trigger.query.trim()
      await createNote(title, trigger.category.id, { select: false })
      insertTag(index, trigger.category, title)
    }
  }

  const syncTrigger = (text: string, caret: number, kind: string) => {
    if (kind === 'code' || kind === 'agent' || kind === 'reminder') {
      setTrigger(null)
      setSlash(null)
      return
    }
    const slashNext = findSlashTrigger(text, caret)
    if (slashNext) {
      setSlash(slashNext)
      setTrigger(null)
      return
    }
    setSlash(null)
    const next = findTagTrigger(text, caret, categories, workspaceSettings)
    if (next?.aiMatch) {
      void insertAgentAt(focused ?? 0, text, next.from, next.to)
      return
    }
    if (next?.reminderMatch) {
      insertReminderAt(focused ?? 0, text, next.from, next.to)
      return
    }
    setTrigger(next)
  }

  const applySlash = (index: number, cmd: SlashCommand) => {
    if (!slash) return
    skipBlur.current = true
    const current = blocks[index]
    const mine = parseMineFence(current)
    const source = mine ? innerMineMarkdown(current) : current
    if (cmd.special === 'ai') {
      void insertAgentAt(index, source, slash.from, slash.to)
      return
    }
    if (cmd.special === 'reminder') {
      insertReminderAt(index, source, slash.from, slash.to)
      return
    }
    const edit = applySlashCommand(source, slash, cmd)
    const mineType = slashCommandMineType(cmd)
    const wrapObject = (text: string, reuseId?: string) => {
      if (!mineType) return text
      const id = reuseId || newMineId()
      const next = formatMineBlock(mineType, id, text, mine?.agentId, mine?.attrs)
      rememberMineObject({
        id,
        type: mineType,
        noteId: activeNoteId || '',
        noteTitle: draftTitle,
        inner: text,
        markdown: next,
      })
      return next
    }
    setSlash(null)
    setTrigger(null)
    if (edit.type === 'replace') {
      caretRef.current = edit.caret
      if (mineType) {
        updateBlock(index, wrapObject(edit.text, mine?.id))
      } else {
        writeBlock(index, edit.text)
      }
      if (cmd.id === 'table') {
        setFocused(index)
        return
      }
      focusBlock(index, edit.caret)
      return
    }
    const pieces = edit.blocks.map((block, i) =>
      i === edit.focus ? wrapObject(block) : block,
    )
    emitSplice(index, 1, pieces)
    if (cmd.id === 'table') {
      setFocused(index + edit.focus)
      return
    }
    focusBlock(index + edit.focus, edit.caret)
  }

  const promoteMarkdownStarter = (index: number, text: string, caret: number): boolean => {
    const starter = matchMarkdownStarter(text, caret)
    if (!starter) return false
    const current = blocksRef.current[index]
    const mine = parseMineFence(current)
    // Only plain paragraphs (or unfenced text) become objects from typed starters
    if (mine && mine.type !== 'paragraph') return false

    if (!starter.type) {
      caretRef.current = starter.caret
      updateBlock(index, starter.inner)
      focusBlock(index, starter.caret)
      return true
    }

    const id = mine?.id || newMineId()
    const next = formatMineBlock(starter.type, id, starter.inner, mine?.agentId, mine?.attrs)
    caretRef.current = starter.caret
    updateBlock(index, next)
    rememberMineObject({
      id,
      type: starter.type,
      noteId: activeNoteId || '',
      noteTitle: draftTitle,
      inner: starter.inner,
      markdown: next,
    })
    focusBlock(index, starter.caret)
    return true
  }

  const deleteBlocks = (from: number, to: number) => {
    const start = Math.min(from, to)
    const end = Math.max(from, to)
    const current = blocksRef.current
    for (let i = start; i <= end; i++) {
      const id = parseAgentId(current[i] || '')
      if (id) void api.deleteAgent(id).catch(() => {})
    }
    emitSplice(start, end - start + 1, [])
    setSelected(null)
    setOpenAgentId(null)
    setTrigger(null)
    setSlash(null)
    const remaining = flattenLeaves(nodesRef.current)
    const focusAt = Math.min(start, Math.max(0, remaining.length - 1))
    if (remaining[focusAt] && !parseAgentId(remaining[focusAt].markdown)) focusBlock(focusAt, 0)
    else setFocused(null)
  }

  const copyBlocks = async (from: number, to: number) => {
    const start = Math.min(from, to)
    const end = Math.max(from, to)
    const md = joinMarkdownBlocks(blocksRef.current.slice(start, end + 1))
    try {
      await navigator.clipboard.writeText(md)
    } catch {
      /* ignore */
    }
  }

  const hitTestDrop = (clientX: number, clientY: number, fromId: string, height: number): {
    target: DropTarget | null
    ghost: DragGhost | null
    splitId: string | null
    transfer: { el: HTMLElement; clientY: number } | null
    slot: HTMLElement | null
  } => {
    const root = rootRef.current
    const sourceLeaf = (
      root?.querySelector(`[data-leaf-id="${fromId}"]`) ||
      document.querySelector(`[data-leaf-id="${fromId}"]`)
    ) as HTMLElement | null

    // Another open note under the pointer — transfer there (slot or body gap)
    const foreignMd = findLiveMarkdownAt(clientX, clientY, root)
    if (foreignMd) {
      const foreignSlot = findObjectSlotAt(clientX, clientY, sourceLeaf)
      if (foreignSlot && foreignMd.contains(foreignSlot)) {
        const rect = (foreignSlot.closest('td, th') || foreignSlot).getBoundingClientRect()
        return {
          target: null,
          transfer: null,
          slot: foreignSlot,
          ghost: {
            x: rect.left,
            y: rect.top,
            w: rect.width,
            h: Math.max(rect.height, 28),
            mode: 'center',
          },
          splitId: null,
        }
      }
      const gap = gapGhostAtY(foreignMd, clientY)
      return {
        target: null,
        transfer: { el: foreignMd, clientY },
        slot: null,
        ghost: { x: gap.x, y: gap.y, w: gap.w, h: gap.h, mode: 'gap' },
        splitId: null,
      }
    }

    const under = document.elementFromPoint(clientX, clientY) as HTMLElement | null
    // Pointer left this note entirely — don't snap to end of the source note
    if (root && under && !root.contains(under) && !under.closest('.note-pane')) {
      return {
        target: null,
        transfer: null,
        slot: null,
        ghost: null,
        splitId: null,
      }
    }

    const pickLeaf = (): HTMLElement | null => {
      const direct = under?.closest('[data-leaf-id]') as HTMLElement | null
      if (
        direct &&
        direct.dataset.leafId &&
        direct.dataset.leafId !== fromId &&
        !direct.classList.contains('drag-source') &&
        (!root || root.contains(direct))
      ) {
        return direct
      }

      const els = (
        root
          ? [...root.querySelectorAll('[data-leaf-id]')]
          : [...document.querySelectorAll('[data-leaf-id]')]
      ) as HTMLElement[]
      let best: { el: HTMLElement; dist: number } | null = null
      for (const el of els) {
        const id = el.dataset.leafId
        if (!id || id === fromId || el.classList.contains('drag-source')) continue
        if (root && !root.contains(el)) continue
        const rect = el.getBoundingClientRect()
        if (rect.height < 4 || rect.width < 4) continue
        const padX = 36
        const padY = 20
        if (clientX < rect.left - padX || clientX > rect.right + padX) continue
        if (clientY < rect.top - padY || clientY > rect.bottom + padY) continue
        const cx = Math.min(Math.max(clientX, rect.left), rect.right)
        const cy = Math.min(Math.max(clientY, rect.top), rect.bottom)
        const dist = Math.hypot(clientX - cx, clientY - cy) + Math.hypot(clientX - (rect.left + rect.width / 2), clientY - (rect.top + rect.height / 2)) * 0.15
        if (!best || dist < best.dist) best = { el, dist }
      }
      return best?.el || null
    }

    const el = pickLeaf()
    if (!el) {
      const tail = (root?.querySelector('.live-md-tail') || null) as HTMLElement | null
      const rect = tail?.getBoundingClientRect()
      return {
        target: { type: 'end' },
        transfer: null,
        slot: null,
        ghost: {
          x: rect?.left ?? clientX,
          y: rect?.top ?? clientY,
          w: rect?.width ?? 240,
          h: 4,
          mode: 'gap',
        },
        splitId: null,
      }
    }

    const id = el.dataset.leafId!
    const rect = el.getBoundingClientRect()
    const row = el.closest('.live-row') as HTMLElement | null
    const col = el.closest('.live-col') as HTMLElement | null
    const host = col || el
    const hostRect = host.getBoundingClientRect()
    const rowRect = (row || el).getBoundingClientRect()
    const colCount = row ? row.querySelectorAll('.live-col').length : 0
    const sourceInRow = row?.querySelector(`[data-leaf-id="${fromId}"]`)
    const sourceCol = sourceInRow?.closest('.live-col')
    const sourceAlone = Boolean(sourceCol && sourceCol.querySelectorAll('[data-leaf-id]').length === 1)
    const colsAfterExtract = colCount - (sourceAlone ? 1 : 0)
    const edge = Math.min(72, Math.max(36, hostRect.width * 0.24))
    const canSplit = colsAfterExtract < 4
    const onRightEdge = canSplit && clientX >= hostRect.right - edge
    const onLeftEdge = canSplit && clientX <= hostRect.left + edge

    const splitGhost = (side: 'left' | 'right'): DragGhost => {
      const previewW = row
        ? Math.max(56, Math.min(hostRect.width * 0.38, 132))
        : Math.max(48, rect.width * 0.5 - 6)
      const top = (row ? rowRect.top : rect.top) + 3
      const h = Math.max((row ? rowRect.height : rect.height) - 6, height, 36)
      if (side === 'right') {
        const x = row
          ? Math.min(hostRect.right - previewW * 0.2, rowRect.right - previewW - 4)
          : rect.left + rect.width * 0.5 + 4
        return { x, y: top, w: previewW, h, mode: 'right' }
      }
      const x = row
        ? Math.max(rowRect.left + 4, hostRect.left - previewW * 0.8)
        : rect.left
      return { x, y: top, w: previewW, h, mode: 'left' }
    }

    // Column edges win over nesting into table/object slots — otherwise
    // object-heavy blocks almost never accept side-by-side splits.
    if (onRightEdge) {
      return {
        target: { type: 'right', id },
        transfer: null,
        slot: null,
        ghost: splitGhost('right'),
        splitId: id,
      }
    }
    if (onLeftEdge) {
      return {
        target: { type: 'left', id },
        transfer: null,
        slot: null,
        ghost: splitGhost('left'),
        splitId: id,
      }
    }

    const slot = findObjectSlotAt(clientX, clientY, sourceLeaf)
    if (slot && (!sourceLeaf || !sourceLeaf.contains(slot)) && (!root || root.contains(slot))) {
      const slotRect = (slot.closest('td, th') || slot).getBoundingClientRect()
      return {
        target: null,
        transfer: null,
        slot,
        ghost: {
          x: slotRect.left,
          y: slotRect.top,
          w: slotRect.width,
          h: Math.max(slotRect.height, 28),
          mode: 'center',
        },
        splitId: null,
      }
    }

    if (clientY < rect.top + rect.height / 2) {
      return {
        target: { type: 'before', id },
        transfer: null,
        slot: null,
        ghost: { x: rect.left, y: rect.top - 2, w: rect.width, h: 4, mode: 'gap' },
        splitId: null,
      }
    }
    return {
      target: { type: 'after', id },
      transfer: null,
      slot: null,
      ghost: { x: rect.left, y: rect.bottom - 2, w: rect.width, h: 4, mode: 'gap' },
      splitId: null,
    }
  }

  const beginHandleDrag = (id: string, index: number, clientX: number, clientY: number) => {
    const el = document.querySelector(`[data-leaf-id="${id}"]`) as HTMLElement | null
    if (!el) return
    const rect = el.getBoundingClientRect()
    const htmlEl = el.querySelector('.live-block-html, .agent-collapsed, .live-block-empty')
    const previewHtml = htmlEl instanceof HTMLElement ? htmlEl.innerHTML : el.innerText
    const tree = nodesRef.current
    const ids = flattenLeaves(tree).map((leaf) => leaf.id)
    const next: DragState = {
      fromId: id,
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: Math.max(rect.height, 28),
      grabX: clientX - rect.left,
      grabY: clientY - rect.top,
      previewHtml,
      target: { type: 'before', id: ids[index + 1] || id },
      ghost: null,
      splitId: null,
      shifts: {},
      settling: false,
      transfer: null,
      slot: null,
    }
    if (index + 1 < ids.length) next.target = { type: 'before', id: ids[index + 1] }
    else if (index > 0) next.target = { type: 'after', id: ids[index - 1] }
    else next.target = { type: 'end' }
    next.shifts = verticalShifts(tree, id, next.target, next.height)
    dragRef.current = next
    setDrag(next)
    setFocused(null)
    setSelected(null)
    setOpenAgentId(null)
  }

  const moveHandleDrag = (clientX: number, clientY: number) => {
    const current = dragRef.current
    if (!current || current.settling) return
    const hit = hitTestDrop(clientX, clientY, current.fromId, current.height)
    setDropHover(hit.slot)
    setObjectDragging(true)
    const next: DragState = {
      ...current,
      x: clientX - current.grabX,
      y: clientY - current.grabY,
      target: hit.transfer || hit.slot ? null : hit.target,
      ghost: hit.ghost,
      splitId: hit.splitId,
      transfer: hit.transfer,
      slot: hit.slot,
      shifts:
        hit.transfer || hit.slot
          ? {}
          : hit.target
            ? verticalShifts(nodesRef.current, current.fromId, hit.target, current.height)
            : {},
    }
    dragRef.current = next
    setDrag(next)
    const under = document.elementFromPoint(clientX, clientY) as HTMLElement | null
    const scroller = under?.closest('.editor-scroll') as HTMLElement | null
    if (scroller) {
      const box = scroller.getBoundingClientRect()
      if (clientY < box.top + 56) scroller.scrollTop -= 18
      else if (clientY > box.bottom - 56) scroller.scrollTop += 18
    }
  }

  const finishHandleDrag = () => {
    const current = dragRef.current
    pendingHandleRef.current = null
    if (!current || current.settling) return
    if (!current.target && !current.transfer && !current.slot) {
      dragRef.current = null
      setDrag(null)
      clearDropHover()
      setObjectDragging(false)
      flushPendingValue()
      return
    }
    const dest = current.ghost
    const settling: DragState = {
      ...current,
      settling: true,
      x: dest?.mode === 'gap' ? current.x : dest?.x ?? current.x,
      y: dest?.mode === 'gap' ? (dest.y - Math.max(0, current.height / 2 - 2)) : dest?.y ?? current.y,
      width: dest && dest.mode !== 'gap' ? dest.w : current.width,
    }
    if (dest?.mode === 'gap') {
      settling.x = dest.x
      settling.y = dest.y - 4
      settling.width = dest.w
    }
    dragRef.current = settling
    setDrag(settling)
    const fromId = current.fromId
    const target = current.target
    const transfer = current.transfer
    const slot = current.slot
    window.setTimeout(() => {
      if (slot) {
        const leaf = flattenLeaves(nodesRef.current).find((item) => item.id === fromId)
        const index = flattenLeaves(nodesRef.current).findIndex((item) => item.id === fromId)
        if (leaf && index >= 0) {
          dispatchMineSlotInsert(slot, { markdown: leaf.markdown })
          emitSplice(index, 1, [])
        }
      } else if (transfer) {
        const leaf = flattenLeaves(nodesRef.current).find((item) => item.id === fromId)
        const index = flattenLeaves(nodesRef.current).findIndex((item) => item.id === fromId)
        if (leaf && index >= 0) {
          dispatchMineDocInsert(transfer.el, {
            markdown: leaf.markdown,
            clientY: transfer.clientY,
            mode: 'block',
          })
          emitSplice(index, 1, [])
        }
      } else if (target) {
        emitNodes(applyDrop(nodesRef.current, fromId, target))
        setPopId(fromId)
        window.setTimeout(() => setPopId((id) => (id === fromId ? null : id)), 240)
      }
      // Drop owns the document now — discard any updates queued mid-drag.
      pendingValueRef.current = null
      dragRef.current = null
      setDrag(null)
      clearDropHover()
      setObjectDragging(false)
    }, 180)
  }

  beginHandleDragRef.current = beginHandleDrag
  moveHandleDragRef.current = moveHandleDrag
  finishHandleDragRef.current = finishHandleDrag

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (dragRef.current || pendingHandleRef.current) return
      const drag = selectingRef.current
      if (!drag) return
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return
      drag.dragged = true
      setFocused(null)
      const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-block-index]')
      if (!hit) return
      const end = Number(hit.getAttribute('data-block-index'))
      if (!Number.isFinite(end)) return
      drag.end = end
      if (end === drag.start) return
      document.getSelection()?.removeAllRanges()
      setSelected({ from: Math.min(drag.start, end), to: Math.max(drag.start, end) })
    }
    const onUp = (event: MouseEvent) => {
      if ((event.target as HTMLElement | null)?.closest?.('input[type="checkbox"]')) {
        selectingRef.current = null
        return
      }
      const drag = selectingRef.current
      selectingRef.current = null
      if (!drag) return
      if (drag.dragged) {
        if (drag.start === drag.end) setSelected(null)
        return
      }
      const block = blocksRef.current[drag.start]
      if (parseAgentId(block)) {
        setSelected({ from: drag.start, to: drag.start })
        setFocused(null)
        return
      }
      if (parseMineFence(block)?.type === 'reminder' || parseReminder(block)) {
        setSelected({ from: drag.start, to: drag.start })
        setFocused(null)
        return
      }
      if (parseMineFence(block)) {
        const already =
          selectedRef.current?.from === drag.start && selectedRef.current?.to === drag.start
        if (already) {
          setSelected(null)
          focusBlock(drag.start, null)
          return
        }
        setSelected({ from: drag.start, to: drag.start })
        setFocused(null)
        return
      }
      setSelected(null)
      focusBlock(drag.start, null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const pending = pendingHandleRef.current
      if (pending && !dragRef.current) {
        if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < 5) return
        beginHandleDragRef.current(pending.id, pending.index, pending.x, pending.y)
      }
      if (dragRef.current) {
        event.preventDefault()
        moveHandleDragRef.current(event.clientX, event.clientY)
      }
    }
    const onUp = (event: PointerEvent) => {
      const pending = pendingHandleRef.current
      if (dragRef.current) {
        event.preventDefault()
        finishHandleDragRef.current()
        return
      }
      pendingHandleRef.current = null
      if (pending) {
        setOpenAgentId(null)
        setFocused(null)
        setSelected({ from: pending.index, to: pending.index })
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onInsert = (event: Event) => {
      const detail = (event as CustomEvent<MineDocInsertDetail>).detail
      if (!detail?.markdown) return
      if (detail.mode === 'nested') {
        const drag = takeNestedDrag()
        drag?.remove()
      }
      insertAtClientY(detail.clientY, detail.markdown)
      setImportGap(null)
      // Focus the destination pane without reloading session content
      if (noteId) {
        const pane = findPaneForNote(editorLayout, noteId)
        if (pane) focusWorkspacePane(pane.id, noteId)
      }
    }
    root.addEventListener(MINE_DOC_INSERT, onInsert as EventListener)
    return () => root.removeEventListener(MINE_DOC_INSERT, onInsert as EventListener)
  }, [noteId, editorLayout, focusWorkspacePane])

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = peekNestedDrag()
      if (!drag || drag.settling) {
        setImportGap(null)
        return
      }
      const root = rootRef.current
      if (!root) return
      const under = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null
      const scroller = under?.closest('.editor-scroll') as HTMLElement | null
      if (scroller) {
        const box = scroller.getBoundingClientRect()
        if (event.clientY < box.top + 56) scroller.scrollTop -= 18
        else if (event.clientY > box.bottom - 56) scroller.scrollTop += 18
      }
      const slot = findObjectSlotAt(event.clientX, event.clientY)
      if (slot) {
        // Only highlight slots that belong to this note
        if (root.contains(slot)) setDropHover(slot)
        else clearDropHover()
        setImportGap(null)
        return
      }
      clearDropHover()
      const host = findLiveMarkdownAt(event.clientX, event.clientY)
      if (host !== root) {
        setImportGap(null)
        return
      }
      const gap = gapGhostAtY(root, event.clientY)
      setImportGap({ x: gap.x, y: gap.y, w: gap.w, h: gap.h })
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [])

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const inField = Boolean(target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT'))
      const range = selectedRef.current
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && !inField) {
        event.preventDefault()
        setSelected({ from: 0, to: Math.max(0, blocksRef.current.length - 1) })
        setFocused(null)
        return
      }
      if (!range || inField) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
        event.preventDefault()
        void copyBlocks(range.from, range.to)
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'x') {
        event.preventDefault()
        void copyBlocks(range.from, range.to)
        deleteBlocks(range.from, range.to)
        return
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault()
        deleteBlocks(range.from, range.to)
        return
      }
      if (event.key === 'Escape') {
        setSelected(null)
      }
    }
    const selectedMarkdown = () => {
      const range = selectedRef.current
      if (!range) return ''
      const start = Math.min(range.from, range.to)
      const end = Math.max(range.from, range.to)
      return joinMarkdownBlocks(blocksRef.current.slice(start, end + 1))
    }
    const inEditable = (event: Event) => {
      const target = event.target as HTMLElement | null
      return Boolean(target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT'))
    }
    const onCopy = (event: globalThis.ClipboardEvent) => {
      if (!selectedRef.current || inEditable(event)) return
      event.preventDefault()
      event.clipboardData?.setData('text/plain', selectedMarkdown())
    }
    const onCut = (event: globalThis.ClipboardEvent) => {
      const range = selectedRef.current
      if (!range || inEditable(event)) return
      event.preventDefault()
      event.clipboardData?.setData('text/plain', selectedMarkdown())
      deleteBlocks(range.from, range.to)
    }
    const onPaste = (event: globalThis.ClipboardEvent) => {
      if (inEditable(event)) return
      const text = event.clipboardData?.getData('text/plain') || ''
      const clip = peekObjectClipboard()
      if (clip && clipboardMatchesObject(text, clip)) {
        event.preventDefault()
        const range = selectedRef.current
        if (range) {
          const start = Math.min(range.from, range.to)
          const end = Math.max(range.from, range.to)
          pasteObjectAtRef.current(start, pasteModeRef.current, { replaceTo: end })
          return
        }
        const index = focusedRef.current ?? Math.max(0, blocksRef.current.length - 1)
        pasteObjectAtRef.current(index, pasteModeRef.current)
        return
      }
      const range = selectedRef.current
      if (!range) return
      if (!text) return
      event.preventDefault()
      const start = Math.min(range.from, range.to)
      const end = Math.max(range.from, range.to)
      const pieces = splitMarkdownBlocks(text)
      emitSplice(start, end - start + 1, pieces)
      setSelected(null)
      setFocused(null)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('copy', onCopy)
    window.addEventListener('cut', onCut)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('copy', onCopy)
      window.removeEventListener('cut', onCut)
      window.removeEventListener('paste', onPaste)
    }
  }, [])

  const setupShown = new Set<string>()
  const indexById = new Map(leaves.map((leaf, i) => [leaf.id, i]))

  const renderLeaf = (leaf: Leaf) => {
        const i = indexById.get(leaf.id) ?? 0
        const block = leaf.markdown
        const kind = detectBlockKind(block)
        const pendingId = parseAgentId(block)
        const mine = parseMineFence(block)
        const isEmbed = mine?.type === 'embed'
        const displayMd = isEmbed ? displayMarkdownFor(block) : block
        const displayMine = parseMineFence(displayMd)
        const agentId = parseBlockAgentId(block)
        const inner = pendingId
          ? innerAgentMarkdown(block)
          : displayMine
            ? innerMineMarkdown(displayMd)
            : displayMd
        const agentOpen = Boolean(agentId && openAgentId === agentId)
        const showSetup = Boolean(agentId && agentOpen && !setupShown.has(agentId))
        if (showSetup && agentId) setupShown.add(agentId)
        const creating = jobs.some(
          (job) =>
            job.kind === 'note-create' && job.noteAgentId === agentId && job.status === 'running',
        )
        const parsedTable = kind === 'table' ? parseMdTable(inner) : null
        const editing = focused === i && !pendingId && displayMine?.type !== 'reminder'
        const dragging = drag?.fromId === leaf.id
        const split = drag?.splitId === leaf.id ? drag.ghost?.mode : null
        return (
          <div
            key={leaf.id}
            data-block-index={i}
            data-leaf-id={leaf.id}
            className={`live-block live-block-${kind} ${isEmbed ? 'live-block-embed' : ''} ${editing ? 'editing' : 'rendered'} ${dragging ? 'drag-source' : ''} ${agentId ? 'has-agent' : ''} ${selected && i >= selected.from && i <= selected.to ? 'selected' : ''} ${split === 'left' || split === 'right' ? `drop-split drop-split-${split}` : ''} ${popId === leaf.id ? 'pop-in' : ''}`}
            data-mine-id={mine?.id || leaf.id}
            data-mine-src={isEmbed ? mine.attrs.src : undefined}
            style={
              dragging
                ? undefined
                : {
                    transform: drag?.shifts[leaf.id]
                      ? `translateY(${drag.shifts[leaf.id]}px)`
                      : undefined,
                  }
            }
            onMouseDown={(e) => {
              const target = e.target as HTMLElement
              if (target.closest('.reminder-card')) {
                if (!target.closest('input, select, button')) {
                  setSelected({ from: i, to: i })
                  setFocused(null)
                }
                return
              }
              const checkbox = target.closest('input[type="checkbox"]') as HTMLInputElement | null
              if (checkbox) {
                // Nested/table object surfaces own their rendered checkboxes
                if (target.closest('.mine-object-html, .mine-object, .note-table-wrap')) return
                e.preventDefault()
                e.stopPropagation()
                const root = (e.currentTarget as HTMLElement).querySelectorAll(
                  'input[type="checkbox"]',
                )
                const index = [...root].indexOf(checkbox)
                const source = displayMine ? inner : block
                const nextInner = toggleNthCheckbox(source, Math.max(0, index))
                writeBlock(i, nextInner)
                return
              }
              if (
                target.closest(
                  'button.wiki-link, button.obj-chip, summary, a, .tag-menu, .slash-menu, .note-table-wrap, .explorer-menu, .live-gutter, .agent-block, .agent-collapsed, .nested-object, .nested-object-body, .mine-object, .mine-object-html',
                )
              ) {
                return
              }
              if (e.button !== 0) return
              if (editing) return
              if (e.shiftKey) {
                e.preventDefault()
                const anchor = selected?.from ?? focused ?? i
                setSelected({ from: Math.min(anchor, i), to: Math.max(anchor, i) })
                setFocused(null)
                return
              }
              selectingRef.current = {
                start: i,
                end: i,
                x: e.clientX,
                y: e.clientY,
                dragged: false,
              }
            }}
            onContextMenu={(e) => {
              const target = e.target as HTMLElement
              if (
                target.closest(
                  '.note-table-wrap, .reminder-card, .agent-block, .agent-collapsed, .live-gutter, .tag-menu, .slash-menu, .explorer-menu, .obj-chip, .nested-object, input, select',
                )
              ) {
                return
              }
              e.preventDefault()
              setSelected({ from: i, to: i })
              setBlockMenu({ x: e.clientX, y: e.clientY, index: i })
            }}
          >
            <div className="live-gutter">
              <button
                type="button"
                className="live-handle"
                aria-label="Move block"
                onPointerDown={(e: ReactPointerEvent<HTMLButtonElement>) => {
                  if (e.button !== 0) return
                  e.preventDefault()
                  e.stopPropagation()
                  pendingHandleRef.current = {
                    id: leaf.id,
                    index: i,
                    x: e.clientX,
                    y: e.clientY,
                  }
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.preventDefault()}
              >
                <GripVertical size={14} />
              </button>
              {isEmbed ? (
                <span className="live-embed-badge" title="Embedded object — edits apply everywhere">
                  <Layers size={13} />
                </span>
              ) : null}
              {agentId ? (
                <button
                  type="button"
                  className={`live-agent-btn ${agentOpen ? 'open' : ''}`}
                  aria-label={agentOpen ? 'Hide AI setup' : 'View AI setup'}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    setOpenAgentId(agentOpen ? null : agentId)
                    setFocused(null)
                    setSelected(null)
                  }}
                >
                  <Bot size={14} />
                </button>
              ) : null}
              <button
                type="button"
                className="live-delete-btn"
                aria-label="Delete block"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => deleteBlocks(i, i)}
              >
                <Trash2 size={13} />
              </button>
            </div>

            {showSetup && agentId ? (
              <AgentBlock id={agentId} output={inner} onClose={() => setOpenAgentId(null)} />
            ) : null}

            {pendingId && !agentOpen ? (
              <div className="agent-collapsed">
                <button
                  type="button"
                  className="agent-collapsed-main"
                  onClick={() => {
                    setSelected(null)
                    setOpenAgentId(agentId)
                  }}
                >
                  <Bot size={16} />
                  <span>
                    <strong>{creating ? 'Writing objects…' : 'Inline AI'}</strong>
                    <em>
                      {creating
                        ? 'Gemma is working in Agents. You can keep writing.'
                        : 'Collapsed — click to continue exploring or creating'}
                    </em>
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Delete inline AI"
                  onClick={() => deleteBlocks(i, i)}
                >
                  <X size={14} />
                </button>
              </div>
            ) : null}

            {displayMine?.type === 'reminder' ? (
              <ReminderBlock
                reminder={parseReminder(displayMd) || { id: displayMine.id, title: inner, dueAt: null, status: firstColumnId(reminderColumns), position: 0, agentId: displayMine.agentId }}
                columns={reminderColumns}
                onCopyObject={() => copyObjectAt(i, 'content')}
                onCopyLink={() => copyObjectAt(i, 'link')}
                onPasteContent={() => pasteObjectAt(i, 'content')}
                onPasteLink={() => pasteObjectAt(i, 'link')}
                onEmbed={() => pasteObjectAt(i, 'embed')}
                onDropObject={() => void dropObjectAt(i)}
                onOpenObject={(noteId, objectId) => void openMineObject(noteId, objectId)}
                onChange={(patch) => {
                  const next = patchReminderBlock(displayMd, patch)
                  if (isEmbed && mine) {
                    commitEmbedSource(i, mine, next)
                    return
                  }
                  updateBlock(i, next)
                  syncReminderFromBlock(next)
                }}
              />
            ) : pendingId ? null : parsedTable ? (
              <TableBlock
                table={parsedTable}
                autoFocus={editing}
                active={editing}
                onActivate={() => {
                  setSelected(null)
                  setFocused(i)
                }}
                onCopyObject={() => copyObjectAt(i, 'content')}
                onCopyLink={() => copyObjectAt(i, 'link')}
                onPasteContent={() => pasteObjectAt(i, 'content')}
                onPasteLink={() => pasteObjectAt(i, 'link')}
                onEmbed={() => pasteObjectAt(i, 'embed')}
                onDropObject={() => void dropObjectAt(i)}
                onOpenObject={(link) => void openMineObject(link.noteId, link.id)}
                onChange={(markdown) => writeBlock(i, markdown)}
              />
            ) : innerHasNestedFence(inner) ? (
              <NestedInner inner={inner} kind={kind} depth={0} onChange={(text) => writeBlock(i, text)} />
            ) : editing ? (
              <>
                <EditBlock
                  refFn={(el) => {
                    textareaRefs.current[i] = el
                  }}
                  value={inner}
                  kind={kind}
                  placeholder={i === 0 ? placeholder : undefined}
                  onChange={(text, caret) => {
                    const nextTrigger = findTagTrigger(text, caret, categories, workspaceSettings)
                    if (nextTrigger?.aiMatch) {
                      void insertAgentAt(i, text, nextTrigger.from, nextTrigger.to)
                      return
                    }
                    if (nextTrigger?.reminderMatch) {
                      insertReminderAt(i, text, nextTrigger.from, nextTrigger.to)
                      return
                    }
                    if (promoteMarkdownStarter(i, text, caret)) return
                    writeBlock(i, text)
                    syncTrigger(text, caret, kind)
                  }}
                  onBlur={() => {
                    if (skipBlur.current) {
                      skipBlur.current = false
                      return
                    }
                    window.setTimeout(() => {
                      if (textareaRefs.current.some((el) => el === document.activeElement)) return
                      setFocused(null)
                      setTrigger(null)
                      setSlash(null)
                    }, 10)
                  }}
                  onKeyDown={(e) => {
                    const ta = e.currentTarget
                    if (slash) {
                      if (slashHits.length) {
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
                          applySlash(i, slashHits[menuIndex] || slashHits[0])
                          return
                        }
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setSlash(null)
                        return
                      }
                      if (e.key === 'Enter' || e.key === 'Tab') {
                        e.preventDefault()
                        return
                      }
                    }
                    if (trigger && menuCount > 0) {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault()
                        setMenuIndex((n) => (n + 1) % menuCount)
                        return
                      }
                      if (e.key === 'ArrowUp') {
                        e.preventDefault()
                        setMenuIndex((n) => (n - 1 + menuCount) % menuCount)
                        return
                      }
                      if (e.key === 'Enter' || e.key === 'Tab') {
                        e.preventDefault()
                        void chooseMenu(i)
                        return
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setTrigger(null)
                        return
                      }
                    }
                    if (e.key === 'Enter' && !e.shiftKey && kind !== 'code' && kind !== 'toggle') {
                      e.preventDefault()
                      const caret = ta.selectionStart
                      let edit: BlockEdit
                      if (isListBlockKind(kind)) {
                        edit = handleListEnter(inner, caret) ?? handlePlainEnter(inner, caret)
                      } else if (kind === 'h1' || kind === 'h2' || kind === 'h3' || kind === 'h4' || kind === 'hr') {
                        edit = handleHeadingEnter(inner, caret)
                      } else {
                        edit = handlePlainEnter(inner, caret)
                      }
                      commitInnerEdit(i, edit, Boolean(mine || isEmbed))
                      return
                    }
                    if (e.key === 'Tab' && !trigger && !slash) {
                      e.preventDefault()
                      if (!isListBlockKind(kind)) return
                      const edit = handleListTab(inner, ta.selectionStart, e.shiftKey)
                      if (edit?.type === 'replace') commitInnerEdit(i, edit, Boolean(mine || isEmbed))
                      return
                    }
                    if (
                      e.key === 'Backspace' &&
                      ta.selectionStart === 0 &&
                      ta.selectionEnd === ta.value.length &&
                      ta.value.length > 0 &&
                      (mine || pendingId)
                    ) {
                      e.preventDefault()
                      deleteBlocks(i, i)
                      return
                    }
                    if (
                      e.key === 'Backspace' &&
                      ta.selectionStart === 0 &&
                      ta.selectionEnd === 0
                    ) {
                      e.preventDefault()
                      if ((mine || pendingId) && !inner.trim()) {
                        deleteBlocks(i, i)
                        return
                      }
                      if (i > 0) {
                        const prev = blocks[i - 1]
                        if (parseAgentId(prev) || parseMineFence(prev)) {
                          deleteBlocks(i - 1, i - 1)
                          return
                        }
                        emitSplice(i - 1, 2, [prev + (prev && inner ? '\n' : '') + inner])
                        setTrigger(null)
                        focusBlock(i - 1, prev.length)
                      }
                      return
                    }
                    if (e.key === 'ArrowUp' && ta.selectionStart === 0 && i > 0) {
                      e.preventDefault()
                      setTrigger(null)
                      setSlash(null)
                      focusBlock(i - 1, blocks[i - 1].length)
                    }
                    if (e.key === 'ArrowDown' && ta.selectionStart === inner.length && i < blocks.length - 1) {
                      e.preventDefault()
                      setTrigger(null)
                      setSlash(null)
                      focusBlock(i + 1, 0)
                    }
                  }}
                  onPaste={(e) => {
                    const text = e.clipboardData.getData('text/plain')
                    const clip = peekObjectClipboard()
                    if (clip && clipboardMatchesObject(text, clip)) {
                      e.preventDefault()
                      pasteObjectAt(i, objectPasteMode, { atCaret: true })
                      return
                    }
                    if (!text.includes('\n')) return
                    e.preventDefault()
                    const ta = e.currentTarget
                    const combined =
                      inner.slice(0, ta.selectionStart) + text + inner.slice(ta.selectionEnd)
                    if (mine || displayMine) {
                      writeBlock(i, combined)
                      return
                    }
                    const pieces = splitMarkdownBlocks(combined)
                    emitSplice(i, 1, pieces)
                    setTrigger(null)
                    setSlash(null)
                    focusBlock(i + pieces.length - 1, pieces[pieces.length - 1]?.length ?? 0)
                  }}
                />
                {trigger && !trigger.aiMatch && !trigger.reminderMatch && (
                  <TagMenu
                    trigger={trigger}
                    notes={menuItems}
                    canCreate={canCreate}
                    activeIndex={menuIndex}
                    aiShortcut={aiShortcut}
                    reminderShortcut={reminderShortcut}
                    onHover={setMenuIndex}
                    onPickAi={() => {
                      skipBlur.current = true
                      void insertAgentAt(i, inner, trigger.from, trigger.to)
                    }}
                    onPickReminder={() => {
                      skipBlur.current = true
                      insertReminderAt(i, inner, trigger.from, trigger.to)
                    }}
                    onPickCategory={(category) => {
                      skipBlur.current = true
                      const source = mine ? inner : block
                      const next =
                        source.slice(0, trigger.from) + `:${category.tag}` + source.slice(trigger.to)
                      writeBlock(i, next)
                      const caret = trigger.from + 1 + category.tag.length
                      setTrigger({
                        from: trigger.from,
                        to: caret,
                        category,
                        query: '',
                        categoryChoices: [],
                        showAi: false,
                        aiMatch: false,
                        showReminder: false,
                        reminderMatch: false,
                      })
                      focusBlock(i, caret)
                    }}
                    onPickNote={(note) => {
                      skipBlur.current = true
                      insertTag(i, trigger.category!, note.title)
                    }}
                    onCreate={() => {
                      skipBlur.current = true
                      void chooseMenu(i)
                    }}
                  />
                )}
                {slash ? (
                  <SlashMenu
                    commands={slashHits}
                    activeIndex={menuIndex}
                    onHover={setMenuIndex}
                    onPick={(cmd) => applySlash(i, cmd)}
                  />
                ) : null}
              </>
            ) : inner.trim() ? (
              <div
                className="live-block-html prose"
                dangerouslySetInnerHTML={{ __html: renderNoteHtml(inner, categories) }}
              />
            ) : (
              <div className="live-block-empty" />
            )}
          </div>
        )
  }

  return (
    <div
      ref={rootRef}
      className={`live-md ${drag ? 'is-dragging' : ''}`}
      data-live-md=""
      data-note-id={noteId || undefined}
      onClick={(e) => {
        const target = e.target as HTMLElement
        const chip = target.closest('.obj-chip') as HTMLButtonElement | null
        if (chip?.dataset.obj) {
          e.preventDefault()
          void openMineObject(chip.dataset.objNote || activeNoteId || '', chip.dataset.obj)
          return
        }
        const wiki = target.closest('.wiki-link') as HTMLButtonElement | null
        if (!wiki?.dataset.wiki) return
        e.preventDefault()
        openWiki(wiki.dataset.wiki, wiki.dataset.cat)
      }}
    >
      {nodes.map((node) =>
        node.type === 'row' ? (
          <div
            key={node.id}
            className="live-row"
            style={
              drag?.shifts[`row:${node.id}`]
                ? { transform: `translateY(${drag.shifts[`row:${node.id}`]}px)` }
                : undefined
            }
          >
            {node.columns.map((col) => (
              <div key={col.id} className="live-col">
                {col.leaves.map((leaf) => renderLeaf(leaf))}
              </div>
            ))}
          </div>
        ) : (
          renderLeaf(node.leaf)
        ),
      )}
      <div
        className="live-md-tail"
        onClick={() => {
          setSelected(null)
          if (blocks[blocks.length - 1]?.trim()) {
            emitSplice(blocks.length, 0, [''])
            focusBlock(blocks.length, 0)
          } else {
            setFocused(Math.max(0, blocks.length - 1))
          }
        }}
      />
      {drag
        ? createPortal(
            <>
              {drag.ghost ? (
                <div
                  className={`live-drop-ghost mode-${drag.ghost.mode}`}
                  style={{
                    left: drag.ghost.x,
                    top: drag.ghost.y,
                    width: drag.ghost.w,
                    height: drag.ghost.h,
                  }}
                />
              ) : null}
              <div
                className={`live-drag-card ${drag.settling ? 'settling' : ''}`}
                style={{
                  left: drag.x,
                  top: drag.y,
                  width: drag.width,
                  minHeight: drag.height,
                }}
              >
                <div
                  className="live-block-html prose"
                  dangerouslySetInnerHTML={{ __html: drag.previewHtml }}
                />
              </div>
            </>,
            document.body,
          )
        : null}
      {blockMenu ? (
        <ObjectLinkMenu
          x={blockMenu.x}
          y={blockMenu.y}
          onClose={() => setBlockMenu(null)}
          onCopyObject={() => copyObjectAt(blockMenu.index, 'content')}
          onCopyLink={() => copyObjectAt(blockMenu.index, 'link')}
          onPasteContent={() => pasteObjectAt(blockMenu.index, 'content')}
          onPasteLink={() => pasteObjectAt(blockMenu.index, 'link')}
          onEmbed={() => pasteObjectAt(blockMenu.index, 'embed')}
          onDrop={() => void dropObjectAt(blockMenu.index)}
        />
      ) : null}
      {importGap
        ? createPortal(
            <div
              className="live-drop-ghost mode-gap"
              style={{
                left: importGap.x,
                top: importGap.y,
                width: importGap.w,
                height: importGap.h,
              }}
            />,
            document.body,
          )
        : null}
    </div>
  )
}

function EditBlock({
  value,
  kind,
  placeholder,
  onChange,
  onBlur,
  onKeyDown,
  onPaste,
  refFn,
}: {
  value: string
  kind: string
  placeholder?: string
  onChange: (value: string, caret: number) => void
  onBlur: () => void
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void
  refFn: (el: HTMLTextAreaElement | null) => void
}) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null)

  useLayoutEffect(() => {
    const el = innerRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.max(el.scrollHeight, 28)}px`
  }, [value])

  return (
    <div className="live-block-edit">
      <pre
        className="live-block-mirror"
        aria-hidden
        dangerouslySetInnerHTML={{
          __html: highlightMarkdownSource(value) + (value.endsWith('\n') ? '\n' : ''),
        }}
      />
      <textarea
        ref={(el) => {
          innerRef.current = el
          refFn(el)
        }}
        className={`live-block-input kind-${kind}`}
        value={value}
        placeholder={placeholder}
        spellCheck={kind !== 'code'}
        onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        rows={1}
      />
    </div>
  )
}

function TagMenu({
  trigger,
  notes,
  canCreate,
  activeIndex,
  aiShortcut,
  reminderShortcut,
  onHover,
  onPickAi,
  onPickReminder,
  onPickCategory,
  onPickNote,
  onCreate,
}: {
  trigger: TagTrigger
  notes: Note[]
  canCreate: boolean
  activeIndex: number
  aiShortcut: string
  reminderShortcut: string
  onHover: (index: number) => void
  onPickAi: () => void
  onPickReminder: () => void
  onPickCategory: (category: Category) => void
  onPickNote: (note: Note) => void
  onCreate: () => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    rootRef.current?.querySelector('.tag-menu-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])
  return (
    <div
      ref={rootRef}
      className="tag-menu"
      role="listbox"
      onMouseDown={(e) => e.preventDefault()}
    >
      {!trigger.category ? (
        trigger.showAi || trigger.showReminder || trigger.categoryChoices.length ? (
          <>
            {trigger.showAi ? (
              <button
                type="button"
                className={`tag-menu-item ${0 === activeIndex ? 'active' : ''}`}
                onMouseEnter={() => onHover(0)}
                onClick={onPickAi}
              >
                <Bot size={14} />
                <span>:{aiShortcut}</span>
                <span className="tag-menu-name">Inline AI</span>
              </button>
            ) : null}
            {trigger.showReminder ? (
              <button
                type="button"
                className={`tag-menu-item ${(trigger.showAi ? 1 : 0) === activeIndex ? 'active' : ''}`}
                onMouseEnter={() => onHover(trigger.showAi ? 1 : 0)}
                onClick={onPickReminder}
              >
                <Bell size={14} />
                <span>:{reminderShortcut}</span>
                <span className="tag-menu-name">Reminder</span>
              </button>
            ) : null}
            {trigger.categoryChoices.map((category) => {
              const index =
                (trigger.showAi ? 1 : 0) +
                (trigger.showReminder ? 1 : 0) +
                trigger.categoryChoices.indexOf(category)
              return (
                <button
                  key={category.id}
                  type="button"
                  className={`tag-menu-item ${index === activeIndex ? 'active' : ''}`}
                  onMouseEnter={() => onHover(index)}
                  onClick={() => onPickCategory(category)}
                >
                  <CatIcon name={category.icon} color={category.color} size={14} />
                  <span>:{category.tag}</span>
                  <span className="tag-menu-name">{category.name}</span>
                </button>
              )
            })}
          </>
        ) : (
          <div className="tag-menu-empty">No matching shortcuts</div>
        )
      ) : notes.length || canCreate ? (
        <>
          {notes.map((note, index) => (
              <button
                key={note.id}
                type="button"
                className={`tag-menu-item ${index === activeIndex ? 'active' : ''}`}
                onMouseEnter={() => onHover(index)}
                onClick={() => onPickNote(note)}
              >
                <CatIcon
                  name={trigger.category!.icon}
                  color={trigger.category!.color}
                  size={14}
                />
                <span className="tag-menu-name">{note.title || 'Untitled'}</span>
              </button>
          ))}
          {canCreate ? (
            <button
              type="button"
              className={`tag-menu-item ${notes.length === activeIndex ? 'active' : ''}`}
              onMouseEnter={() => onHover(notes.length)}
              onClick={onCreate}
            >
              Create “{trigger.query.trim()}” in {trigger.category.name}
            </button>
          ) : null}
        </>
      ) : (
        <div className="tag-menu-empty">
          No {trigger.category.name.toLowerCase()} yet. Type a name to create one.
        </div>
      )}
    </div>
  )
}
