import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { Plus } from 'lucide-react'
import type { ObjectLink } from '../lib/objectLink'
import { peekObjectClipboard, pasteObjectMarkdown, readObjectClipboard } from '../lib/objectLink'
import { ObjectChip } from './ObjectChip'
import { ObjectSlot } from './NestedObject'
import { pasteIntoCell } from '../lib/nestedObjects'
import { moveObjectInMdTable } from '../lib/structuredDoc'
import { peekNestedDrag, takeNestedDrag } from '../lib/nestedDrag'
import {
  MIN_COL_WIDTH,
  MIN_ROW_HEIGHT,
  addTableColumn,
  addTableRow,
  cellInRect,
  colCount,
  findMerge,
  getTableCell,
  isCoveredCell,
  isMergeOrigin,
  mergeCells,
  nextVisibleCell,
  rectFrom,
  removeTableColumn,
  removeTableRow,
  serializeMdTable,
  setColWidths,
  setRowHeights,
  setTableCell,
  unmergeCells,
  type CellPos,
  type MdTable,
} from '../lib/mdTable'

type Props = {
  table: MdTable
  onChange: (markdown: string) => void
  autoFocus?: boolean
  active?: boolean
  nestDepth?: number
  onActivate?: () => void
  onCopyObject?: () => void
  onCopyLink?: () => void
  onPasteContent?: () => void
  onPasteLink?: () => void
  onEmbed?: () => void
  onDropObject?: () => void
  onOpenObject?: (link: ObjectLink) => void
}

function isSelectMod(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return event.ctrlKey || event.metaKey
}

function caretEnds(el: HTMLTextAreaElement): { atFirst: boolean; atLast: boolean } {
  const start = el.selectionStart ?? 0
  const end = el.selectionEnd ?? start
  return {
    atFirst: !el.value.slice(0, start).includes('\n'),
    atLast: !el.value.slice(end).includes('\n'),
  }
}

function samePos(a: CellPos | null, b: CellPos | null): boolean {
  return Boolean(a && b && a.row === b.row && a.col === b.col)
}

export function TableBlock({
  table,
  onChange,
  autoFocus,
  active,
  onActivate,
  onCopyObject,
  onCopyLink,
  onDropObject,
  onOpenObject,
}: Props) {
  const [focus, setFocus] = useState<CellPos | null>(autoFocus ? { row: -1, col: 0 } : null)
  const [selection, setSelection] = useState<{ from: CellPos; to: CellPos } | null>(null)
  const [draft, setDraft] = useState<MdTable | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; row: number; col: number } | null>(null)
  const tableRef = useRef<HTMLTableElement | null>(null)
  const dragSel = useRef<{ from: CellPos } | null>(null)
  const suppressMenu = useRef(false)
  const menuOpen = useRef(false)
  menuOpen.current = Boolean(menu)
  const view = draft || table
  const viewRef = useRef(view)
  viewRef.current = view
  const cols = colCount(view)

  useEffect(() => {
    // Only clear when the host block explicitly deactivates (nested tables omit `active`).
    if (active === false) {
      setFocus(null)
      setSelection(null)
      setMenu(null)
    }
  }, [active])

  const clearCellFocus = () => {
    setFocus(null)
    setSelection(null)
    setMenu(null)
  }
  const clearCellFocusRef = useRef(clearCellFocus)
  clearCellFocusRef.current = clearCellFocus

  useEffect(() => {
    if (!focus && !selection) return
    const onPointerDown = (event: PointerEvent) => {
      if (menuOpen.current) return
      const wrap = tableRef.current?.closest('.note-table-wrap')
      const target = event.target as Node | null
      if (!wrap || !target || wrap.contains(target)) return
      clearCellFocusRef.current()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [focus, selection])
  const commit = (next: MdTable) => {
    setDraft(null)
    onChange(serializeMdTable(next))
  }

  const pasteInto = (row: number, col: number, mode: 'link' | 'content' | 'embed') => {
    void (async () => {
      const clip = await readObjectClipboard()
      if (!clip) return
      const pasted = pasteObjectMarkdown(clip, mode)
      commit(setTableCell(viewRef.current, row, col, pasteIntoCell(getTableCell(viewRef.current, row, col), pasted)))
    })()
  }

  const acceptNestedDrop = (row: number, col: number, markdown: string): boolean => {
    const drag = peekNestedDrag()
    // Ignore mid-drag pointer noise; settled nested drags and block→slot inserts are fine
    if (drag && !drag.settling) return false
    const { table: next, external } = moveObjectInMdTable(viewRef.current, markdown, row, col)
    commit(next)
    if (drag) {
      takeNestedDrag()
      if (external) drag.remove()
    }
    setFocus({ row, col })
    return true
  }

  const go = (row: number, col: number) => {
    setFocus({ row, col })
    setSelection(null)
    window.requestAnimationFrame(() => {
      const el = tableRef.current?.querySelector(
        `[data-row="${row}"][data-col="${col}"] textarea`,
      ) as HTMLTextAreaElement | null
      el?.focus()
      el?.select()
    })
  }

  const onCellKey = (event: KeyboardEvent<HTMLTextAreaElement>, row: number, col: number) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.currentTarget.blur()
      clearCellFocus()
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      const next = nextVisibleCell(view, row, col, 0, event.shiftKey ? -1 : 1)
      if (next.row > view.rows.length - 1) {
        const added = addTableRow(view)
        commit(added)
        go(added.rows.length - 1, 0)
        return
      }
      go(next.row, next.col)
      return
    }
    // Enter in empty slots moves down; object editors stopPropagation for lists
    if (event.key === 'Enter' && !event.shiftKey) {
      const kind = event.currentTarget.className
      if (/\bkind-(ul|ol|todo)\b/.test(kind)) return
      event.preventDefault()
      event.stopPropagation()
      const next = nextVisibleCell(view, row, col, 1, 0)
      if (next.row === row && row === view.rows.length - 1) {
        const added = addTableRow(view)
        commit(added)
        go(added.rows.length - 1, col)
        return
      }
      go(next.row, next.col)
      return
    }
    const ends = caretEnds(event.currentTarget)
    if (event.key === 'ArrowRight' && event.currentTarget.selectionStart === event.currentTarget.value.length) {
      event.preventDefault()
      const next = nextVisibleCell(view, row, col, 0, 1)
      go(next.row, next.col)
      return
    }
    if (event.key === 'ArrowLeft' && event.currentTarget.selectionStart === 0) {
      event.preventDefault()
      const next = nextVisibleCell(view, row, col, 0, -1)
      go(next.row, next.col)
      return
    }
    if (event.key === 'ArrowDown' && ends.atLast) {
      event.preventDefault()
      const next = nextVisibleCell(view, row, col, 1, 0)
      go(next.row, next.col)
      return
    }
    if (event.key === 'ArrowUp' && ends.atFirst) {
      event.preventDefault()
      const next = nextVisibleCell(view, row, col, -1, 0)
      go(next.row, next.col)
    }
  }

  const measureCols = (): number[] => {
    const el = tableRef.current
    const first = el?.rows[0]
    const widths = Array.from({ length: cols }, (_, i) => view.colWidths?.[i] || 0)
    if (!first) return widths.map((w) => w || MIN_COL_WIDTH)
    for (const cell of [...first.cells]) {
      const col = Number((cell as HTMLElement).dataset.col)
      if (!Number.isFinite(col)) continue
      const span = Math.max(1, (cell as HTMLTableCellElement).colSpan || 1)
      const width = cell.getBoundingClientRect().width / span
      for (let i = 0; i < span; i++) widths[col + i] = Math.max(MIN_COL_WIDTH, width)
    }
    return widths
  }

  const measureRows = (): number[] => {
    const el = tableRef.current
    const heights = Array.from({ length: view.rows.length + 1 }, (_, i) => view.rowHeights?.[i] || 0)
    if (!el) return heights.map((h) => h || MIN_ROW_HEIGHT)
    ;[...el.rows].forEach((row, i) => {
      heights[i] = Math.max(MIN_ROW_HEIGHT, row.getBoundingClientRect().height)
    })
    return heights
  }

  const startColResize = (event: ReactPointerEvent, col: number) => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const widths = measureCols()
    const startW = widths[col] || MIN_COL_WIDTH
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    let lastX = startX
    const track = (moveEvent: Event) => {
      lastX = (moveEvent as PointerEvent).clientX
      const next = [...widths]
      next[col] = Math.max(MIN_COL_WIDTH, startW + lastX - startX)
      setDraft(setColWidths(table, next))
    }
    const finish = () => {
      target.removeEventListener('pointermove', track)
      target.removeEventListener('pointerup', finish)
      const next = [...widths]
      next[col] = Math.max(MIN_COL_WIDTH, startW + lastX - startX)
      commit(setColWidths(table, next))
    }
    target.addEventListener('pointermove', track)
    target.addEventListener('pointerup', finish)
  }

  const startRowResize = (event: ReactPointerEvent, row: number) => {
    event.preventDefault()
    event.stopPropagation()
    const startY = event.clientY
    const heights = measureRows()
    const index = row + 1
    const startH = heights[index] || MIN_ROW_HEIGHT
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    let lastY = startY
    const track = (moveEvent: Event) => {
      lastY = (moveEvent as PointerEvent).clientY
      const next = [...heights]
      next[index] = Math.max(MIN_ROW_HEIGHT, startH + lastY - startY)
      setDraft(setRowHeights(table, next))
    }
    const finish = () => {
      target.removeEventListener('pointermove', track)
      target.removeEventListener('pointerup', finish)
      const next = [...heights]
      next[index] = Math.max(MIN_ROW_HEIGHT, startH + lastY - startY)
      commit(setRowHeights(table, next))
    }
    target.addEventListener('pointermove', track)
    target.addEventListener('pointerup', finish)
  }

  const selectRect = selection ? rectFrom(selection.from, selection.to) : null
  const canMerge = Boolean(selectRect && (selectRect.rowspan > 1 || selectRect.colspan > 1))
  const unmergePos = focus && isMergeOrigin(view, focus.row, focus.col) ? focus : selectRect
    ? { row: selectRect.row, col: selectRect.col }
    : null
  const canUnmerge = Boolean(
    unmergePos && findMerge(view, unmergePos.row, unmergePos.col) && isMergeOrigin(view, unmergePos.row, unmergePos.col),
  )

  const onCellPointerDown = (event: ReactPointerEvent, row: number, col: number) => {
    if (
      (event.target as HTMLElement).closest(
        '.note-table-resizer, .mine-object-handle, input[type="checkbox"]',
      )
    ) {
      return
    }
    if (event.button !== 0) return
    onActivate?.()
    if (isSelectMod(event)) {
      event.preventDefault()
      const from = selection?.from ?? focus ?? { row, col }
      setFocus({ row, col })
      setSelection({ from, to: { row, col } })
      dragSel.current = { from }
      suppressMenu.current = true
      return
    }
    dragSel.current = null
    setFocus({ row, col })
    setSelection(null)
    window.requestAnimationFrame(() => {
      const el = tableRef.current?.querySelector(
        `[data-row="${row}"][data-col="${col}"] textarea`,
      ) as HTMLTextAreaElement | null
      el?.focus({ preventScroll: true })
    })
  }

  const openMenu = (event: ReactMouseEvent, row: number, col: number) => {
    event.preventDefault()
    event.stopPropagation()
    if (suppressMenu.current) {
      suppressMenu.current = false
      return
    }
    onActivate?.()
    if (!isSelectMod(event)) {
      setFocus({ row, col })
      setSelection(null)
    }
    setMenu({ x: event.clientX, y: event.clientY, row, col })
  }

  const onCellPointerEnter = (row: number, col: number) => {
    const drag = dragSel.current
    if (!drag) return
    if (drag.from.row === row && drag.from.col === col) return
    setSelection({ from: drag.from, to: { row, col } })
  }

  const renderCell = (row: number, col: number, value: string, header: boolean) => {
    if (isCoveredCell(view, row, col)) return null
    const merge = findMerge(view, row, col)
    const colspan = merge && merge.row === row && merge.col === col ? merge.colspan : 1
    const rowspan = merge && merge.row === row && merge.col === col ? merge.rowspan : 1
    const selected = selectRect ? cellInRect(selectRect, row, col) : samePos(focus, { row, col })
    const Tag = header ? 'th' : 'td'
    return (
      <Tag
        key={`${row}:${col}`}
        data-row={row}
        data-col={col}
        colSpan={colspan > 1 ? colspan : undefined}
        rowSpan={rowspan > 1 ? rowspan : undefined}
        className={selected ? 'is-selected' : undefined}
        onPointerDown={(e) => onCellPointerDown(e, row, col)}
        onPointerEnter={() => onCellPointerEnter(row, col)}
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest('.mine-object')) return
          openMenu(e, row, col)
        }}
      >
        <ObjectSlot
          value={value}
          variant="cell"
          active={samePos(focus, { row, col })}
          placeholder={header ? `Column ${col + 1}` : undefined}
          onChange={(next) => commit(setTableCell(viewRef.current, row, col, next))}
          onAcceptDrop={(markdown) => acceptNestedDrop(row, col, markdown)}
          onKeyDown={(e) => onCellKey(e, row, col)}
        />
        <span
          className="note-table-resizer note-table-col-resizer"
          onPointerDown={(e) => startColResize(e, merge ? merge.col + merge.colspan - 1 : col)}
        />
        <span
          className="note-table-resizer note-table-row-resizer"
          onPointerDown={(e) => startRowResize(e, merge ? merge.row + merge.rowspan - 1 : row)}
        />
      </Tag>
    )
  }

  return (
    <div
      className={`note-table-wrap ${focus || selection ? 'has-cell-focus' : ''}`}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerUp={() => {
        dragSel.current = null
      }}
      onBlur={(e) => {
        const root = e.currentTarget
        const next = e.relatedTarget as Node | null
        if (next && root.contains(next)) return
        window.setTimeout(() => {
          if (menuOpen.current) return
          if (root.contains(document.activeElement)) return
          clearCellFocus()
        }, 0)
      }}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('[data-row], .obj-chip-wrap, .mine-object')) return
        const pos = focus || { row: -1, col: 0 }
        openMenu(e, pos.row, pos.col)
      }}
    >
      {view.refs?.length ? (
        <div className="obj-chip-row">
          {view.refs.map((link) => (
            <ObjectChip
              key={`${link.noteId}:${link.id}`}
              link={link}
              onOpen={() => onOpenObject?.(link)}
              onRemove={() =>
                commit({ ...view, refs: (view.refs || []).filter((item) => item.id !== link.id) })
              }
            />
          ))}
        </div>
      ) : null}
      <div className="note-table-frame">
        <div className="note-table-scroll">
          <table
            ref={tableRef}
            className={`note-table ${view.colWidths?.some((w) => w > 0) ? 'has-widths' : ''}`}
          >
            {view.colWidths?.some((w) => w > 0) ? (
              <colgroup>
                {Array.from({ length: cols }, (_, i) => (
                  <col key={i} style={view.colWidths?.[i] ? { width: view.colWidths[i] } : undefined} />
                ))}
              </colgroup>
            ) : null}
            <tbody>
              <tr>
                {view.headers.map((header, col) => renderCell(-1, col, header, true))}
              </tr>
              {view.rows.map((row, rowIndex) => (
                <tr key={`r-${rowIndex}`}>
                  {row.map((cell, col) => renderCell(rowIndex, col, cell, false))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          className="note-table-add-col"
          title="Add column"
          onClick={() => {
            const next = addTableColumn(view)
            commit(next)
            go(-1, next.headers.length - 1)
          }}
        >
          <Plus size={14} />
        </button>
      </div>
      <button
        type="button"
        className="note-table-add-row"
        onClick={() => {
          const next = addTableRow(view)
          commit(next)
          go(next.rows.length - 1, 0)
        }}
      >
        <Plus size={13} /> Add row
      </button>
      {menu ? (
        <TableContextMenu
          x={menu.x}
          y={menu.y}
          row={menu.row}
          canDeleteRow={menu.row >= 0 && view.rows.length > 1}
          canDeleteCol={view.headers.length > 1}
          canMerge={canMerge}
          canUnmerge={canUnmerge}
          onClose={() => setMenu(null)}
          onInsertRowAbove={() => {
            if (menu.row < 0) return
            const next = addTableRow(view, menu.row)
            commit(next)
            go(menu.row, menu.col)
          }}
          onInsertRowBelow={() => {
            const at = menu.row < 0 ? 0 : menu.row + 1
            const next = addTableRow(view, at)
            commit(next)
            go(at, menu.col)
          }}
          onDeleteRow={() => {
            if (menu.row < 0) return
            commit(removeTableRow(view, menu.row))
            go(Math.max(0, menu.row - 1), menu.col)
          }}
          onInsertColLeft={() => {
            const next = addTableColumn(view, menu.col)
            commit(next)
            go(menu.row, menu.col)
          }}
          onInsertColRight={() => {
            const next = addTableColumn(view, menu.col + 1)
            commit(next)
            go(menu.row, menu.col + 1)
          }}
          onDeleteCol={() => {
            commit(removeTableColumn(view, menu.col))
            go(menu.row === -1 ? -1 : menu.row, Math.max(0, menu.col - 1))
          }}
          onMerge={() => {
            if (!selection) return
            const next = mergeCells(view, selection.from, selection.to)
            commit(next)
            go(Math.min(selection.from.row, selection.to.row), Math.min(selection.from.col, selection.to.col))
          }}
          onUnmerge={() => {
            if (!unmergePos) return
            commit(unmergeCells(view, unmergePos.row, unmergePos.col))
          }}
          onCopyObject={onCopyObject}
          onCopyLink={onCopyLink}
          onPasteContent={() => pasteInto(menu.row, menu.col, 'content')}
          onPasteLink={() => pasteInto(menu.row, menu.col, 'link')}
          onEmbed={() => pasteInto(menu.row, menu.col, 'embed')}
          onDropObject={onDropObject}
        />
      ) : null}
    </div>
  )
}

function TableContextMenu({
  x,
  y,
  row,
  canDeleteRow,
  canDeleteCol,
  canMerge,
  canUnmerge,
  onClose,
  onInsertRowAbove,
  onInsertRowBelow,
  onDeleteRow,
  onInsertColLeft,
  onInsertColRight,
  onDeleteCol,
  onMerge,
  onUnmerge,
  onCopyObject,
  onCopyLink,
  onPasteContent,
  onPasteLink,
  onEmbed,
  onDropObject,
}: {
  x: number
  y: number
  row: number
  canDeleteRow: boolean
  canDeleteCol: boolean
  canMerge: boolean
  canUnmerge: boolean
  onClose: () => void
  onInsertRowAbove: () => void
  onInsertRowBelow: () => void
  onDeleteRow: () => void
  onInsertColLeft: () => void
  onInsertColRight: () => void
  onDeleteCol: () => void
  onMerge: () => void
  onUnmerge: () => void
  onCopyObject?: () => void
  onCopyLink?: () => void
  onPasteContent?: () => void
  onPasteLink?: () => void
  onEmbed?: () => void
  onDropObject?: () => void
}) {
  useEffect(() => {
    const close = () => onClose()
    const onKey = (event: globalThis.KeyboardEvent) => {
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
  const top = Math.min(y, window.innerHeight - 520)
  const canPaste = Boolean(peekObjectClipboard())
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
      <button type="button" role="menuitem" disabled={row < 0} onClick={() => run(onInsertRowAbove)}>
        Insert row above
      </button>
      <button type="button" role="menuitem" onClick={() => run(onInsertRowBelow)}>
        Insert row below
      </button>
      <button type="button" role="menuitem" className="danger" disabled={!canDeleteRow} onClick={() => run(onDeleteRow)}>
        Delete row
      </button>
      <div className="explorer-menu-sep" />
      <button type="button" role="menuitem" onClick={() => run(onInsertColLeft)}>
        Insert column left
      </button>
      <button type="button" role="menuitem" onClick={() => run(onInsertColRight)}>
        Insert column right
      </button>
      <button type="button" role="menuitem" className="danger" disabled={!canDeleteCol} onClick={() => run(onDeleteCol)}>
        Delete column
      </button>
      <div className="explorer-menu-sep" />
      <button type="button" role="menuitem" disabled={!canMerge} onClick={() => run(onMerge)}>
        Merge cells
      </button>
      <button type="button" role="menuitem" disabled={!canUnmerge} onClick={() => run(onUnmerge)}>
        Unmerge cells
      </button>
      {onCopyObject || onCopyLink || onDropObject || onPasteContent || onPasteLink || onEmbed ? (
        <>
          <div className="explorer-menu-sep" />
          {onCopyObject ? (
            <button type="button" role="menuitem" onClick={() => run(onCopyObject)}>
              Copy object
            </button>
          ) : null}
          {onCopyLink || onCopyObject ? (
            <button type="button" role="menuitem" onClick={() => run(onCopyLink || onCopyObject!)}>
              Copy object link
            </button>
          ) : null}
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
          {onDropObject ? (
            <button type="button" role="menuitem" disabled={!canPaste} onClick={() => run(onDropObject)}>
              Drop object tag
            </button>
          ) : null}
        </>
      ) : null}
    </div>,
    document.body,
  )
}
