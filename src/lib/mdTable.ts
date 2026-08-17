import { parseObjectChip, type ObjectLink } from './objectLink'

export type MdAlign = 'left' | 'center' | 'right' | ''

export type CellPos = { row: number; col: number }

export type TableMerge = {
  row: number
  col: number
  rowspan: number
  colspan: number
}

export type MdTable = {
  headers: string[]
  aligns: MdAlign[]
  rows: string[][]
  colWidths?: number[]
  rowHeights?: number[]
  merges?: TableMerge[]
  refs?: ObjectLink[]
}

export const MIN_COL_WIDTH = 72
export const MIN_ROW_HEIGHT = 32

export const DEFAULT_TABLE: MdTable = {
  headers: ['Column 1', 'Column 2', 'Column 3'],
  aligns: ['', '', ''],
  rows: [
    ['', '', ''],
    ['', '', ''],
  ],
}

const META_RE = /^<!--\s*mine-table:(.*?)\s*-->$/

function unpadCell(cell: string): string {
  if (cell.startsWith(' ')) cell = cell.slice(1)
  if (cell.endsWith(' ')) cell = cell.slice(0, -1)
  return cell
}

function decodeCell(cell: string): string {
  return unpadCell(cell).replace(/<br\s*\/?>/gi, '\n')
}

function encodeCell(cell: string): string {
  return cell.replace(/\|/g, '\\|').replace(/\n/g, '<br>')
}

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|'
      i += 1
      continue
    }
    if (s[i] === '|') {
      cells.push(decodeCell(cur))
      cur = ''
      continue
    }
    cur += s[i]
  }
  cells.push(decodeCell(cur))
  return cells
}

function isSeparatorRow(line: string): boolean {
  const cells = splitRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell.replace(/\s/g, '')))
}

function parseAlign(cell: string): MdAlign {
  const t = cell.replace(/\s/g, '')
  const left = t.startsWith(':')
  const right = t.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return ''
}

function sepCell(align: MdAlign): string {
  if (align === 'left') return ':---'
  if (align === 'right') return '---:'
  if (align === 'center') return ':---:'
  return '---'
}

function padRow<T extends string>(cells: T[], cols: number): T[] {
  const next = cells.map((cell) => cell ?? ('' as T))
  while (next.length < cols) next.push('' as T)
  return next.slice(0, cols)
}

function padNums(values: number[] | undefined, count: number): number[] {
  const next = [...(values || [])]
  while (next.length < count) next.push(0)
  return next.slice(0, count)
}

function mergeEnd(merge: TableMerge): CellPos {
  return { row: merge.row + merge.rowspan - 1, col: merge.col + merge.colspan - 1 }
}

export function colCount(table: MdTable): number {
  return Math.max(1, table.headers.length)
}

export function bodyRowCount(table: MdTable): number {
  return Math.max(1, table.rows.length)
}

export function inTableBounds(table: MdTable, row: number, col: number): boolean {
  return col >= 0 && col < colCount(table) && row >= -1 && row < table.rows.length
}

export function coversCell(merge: TableMerge, row: number, col: number): boolean {
  const end = mergeEnd(merge)
  return row >= merge.row && row <= end.row && col >= merge.col && col <= end.col
}

function rangesOverlap(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 <= b1 && b0 <= a1
}

export function mergesOverlap(a: TableMerge, b: TableMerge): boolean {
  const ae = mergeEnd(a)
  const be = mergeEnd(b)
  return rangesOverlap(a.row, ae.row, b.row, be.row) && rangesOverlap(a.col, ae.col, b.col, be.col)
}

export function findMerge(table: MdTable, row: number, col: number): TableMerge | undefined {
  return (table.merges || []).find((merge) => coversCell(merge, row, col))
}

export function isCoveredCell(table: MdTable, row: number, col: number): boolean {
  const merge = findMerge(table, row, col)
  return Boolean(merge && (merge.row !== row || merge.col !== col))
}

export function isMergeOrigin(table: MdTable, row: number, col: number): boolean {
  const merge = findMerge(table, row, col)
  return Boolean(merge && merge.row === row && merge.col === col && (merge.rowspan > 1 || merge.colspan > 1))
}

export function rectFrom(a: CellPos, b: CellPos): TableMerge {
  const row = Math.min(a.row, b.row)
  const col = Math.min(a.col, b.col)
  return {
    row,
    col,
    rowspan: Math.abs(a.row - b.row) + 1,
    colspan: Math.abs(a.col - b.col) + 1,
  }
}

export function cellInRect(rect: TableMerge, row: number, col: number): boolean {
  return coversCell(rect, row, col)
}

export function cellText(table: MdTable, row: number, col: number): string {
  if (row < 0) return table.headers[col] ?? ''
  return table.rows[row]?.[col] ?? ''
}

function cleanMerges(table: MdTable, merges: TableMerge[] | undefined): TableMerge[] {
  const cols = colCount(table)
  const maxRow = table.rows.length - 1
  return (merges || [])
    .map((merge) => {
      if (merge.row < -1 || merge.col < 0) return null
      const rowspan = Math.min(merge.rowspan, maxRow - merge.row + 1)
      const colspan = Math.min(merge.colspan, cols - merge.col)
      if (rowspan < 1 || colspan < 1) return null
      if (rowspan === 1 && colspan === 1) return null
      return { row: merge.row, col: merge.col, rowspan, colspan }
    })
    .filter((merge): merge is TableMerge => Boolean(merge))
}

function parseMeta(raw: string): Pick<MdTable, 'colWidths' | 'rowHeights' | 'merges' | 'refs'> {
  try {
    const data = JSON.parse(raw) as {
      colWidths?: number[]
      rowHeights?: number[]
      merges?: TableMerge[]
      refs?: ObjectLink[]
    }
    return {
      colWidths: Array.isArray(data.colWidths) ? data.colWidths.map((n) => Number(n) || 0) : [],
      rowHeights: Array.isArray(data.rowHeights) ? data.rowHeights.map((n) => Number(n) || 0) : [],
      merges: Array.isArray(data.merges)
        ? data.merges
            .map((merge) => ({
              row: Number(merge.row),
              col: Number(merge.col),
              rowspan: Math.max(1, Number(merge.rowspan) || 1),
              colspan: Math.max(1, Number(merge.colspan) || 1),
            }))
            .filter((merge) => Number.isFinite(merge.row) && Number.isFinite(merge.col))
        : [],
      refs: Array.isArray(data.refs)
        ? data.refs.filter((ref) => ref && typeof ref.id === 'string' && ref.id)
        : [],
    }
  } catch {
    return {}
  }
}

function serializeMeta(table: MdTable): string | null {
  const cols = colCount(table)
  const colWidths = padNums(table.colWidths, cols)
  const rowHeights = padNums(table.rowHeights, table.rows.length + 1)
  const merges = cleanMerges(table, table.merges)
  const refs = (table.refs || []).filter((ref) => ref?.id)
  const data: Record<string, unknown> = {}
  if (colWidths.some((n) => n > 0)) data.colWidths = colWidths
  if (rowHeights.some((n) => n > 0)) data.rowHeights = rowHeights
  if (merges.length) data.merges = merges
  if (refs.length) data.refs = refs
  if (!Object.keys(data).length) return null
  return `<!-- mine-table:${JSON.stringify(data)} -->`
}

export function parseMdTable(md: string): MdTable | null {
  const all = md
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
  let meta: Pick<MdTable, 'colWidths' | 'rowHeights' | 'merges' | 'refs'> = {}
  const extraRefs: ObjectLink[] = []
  const lines = all.filter((line) => {
    const match = line.match(META_RE)
    if (match) {
      meta = parseMeta(match[1] || '{}')
      return false
    }
    const chip = parseObjectChip(line.trim())
    if (chip) {
      extraRefs.push(chip)
      return false
    }
    return true
  })
  if (lines.length < 2 || !lines[0].includes('|') || !isSeparatorRow(lines[1])) return null
  const headers = splitRow(lines[0])
  if (!headers.length) return null
  const cols = headers.length
  const aligns = padRow(splitRow(lines[1]).map(parseAlign), cols) as MdAlign[]
  const rows = lines.slice(2).map((line) => padRow(splitRow(line), cols))
  const table: MdTable = {
    headers: padRow(headers, cols),
    aligns,
    rows: rows.length ? rows : [Array.from({ length: cols }, () => '')],
    colWidths: meta.colWidths,
    rowHeights: meta.rowHeights,
    merges: meta.merges,
    refs: [...(meta.refs || []), ...extraRefs],
  }
  table.merges = cleanMerges(table, table.merges)
  return table
}

export function serializeMdTable(table: MdTable): string {
  const cols = colCount(table)
  const line = (row: string[]) =>
    `| ${padRow(row, cols)
      .map(encodeCell)
      .join(' | ')} |`
  const sep = `| ${padRow(table.aligns, cols).map(sepCell).join(' | ')} |`
  const rows = table.rows.length ? table.rows : [Array.from({ length: cols }, () => '')]
  const gfm = [line(table.headers), sep, ...rows.map(line)]
  const meta = serializeMeta({ ...table, rows })
  if (meta) gfm.push(meta)
  return gfm.join('\n')
}

export function getTableCell(table: MdTable, row: number, col: number): string {
  if (row < 0) return table.headers[col] ?? ''
  return table.rows[row]?.[col] ?? ''
}

export function setTableCell(table: MdTable, row: number, col: number, value: string): MdTable {
  if (row < 0) {
    const headers = [...table.headers]
    if (col < 0 || col >= headers.length) return table
    headers[col] = value
    return { ...table, headers }
  }
  const rows = table.rows.map((r) => [...r])
  if (!rows[row] || col < 0 || col >= rows[row].length) return table
  rows[row] = [...rows[row]]
  rows[row][col] = value
  return { ...table, rows }
}

export function setColWidths(table: MdTable, colWidths: number[]): MdTable {
  return { ...table, colWidths: padNums(colWidths, colCount(table)) }
}

export function setRowHeights(table: MdTable, rowHeights: number[]): MdTable {
  return { ...table, rowHeights: padNums(rowHeights, table.rows.length + 1) }
}

function shiftSpan(
  start: number,
  span: number,
  index: number,
  insert: boolean,
): { start: number; span: number } | null {
  const end = start + span - 1
  if (insert) {
    if (index <= start) return { start: start + 1, span }
    if (index <= end) return { start, span: span + 1 }
    return { start, span }
  }
  if (index < start) return { start: start - 1, span }
  if (index > end) return { start, span }
  const nextSpan = span - 1
  if (nextSpan < 1) return null
  return { start, span: nextSpan }
}

function mapMerges(
  table: MdTable,
  fn: (merge: TableMerge) => TableMerge | null,
): TableMerge[] {
  return cleanMerges(
    table,
    (table.merges || []).map(fn).filter((merge): merge is TableMerge => Boolean(merge)),
  )
}

export function addTableRow(table: MdTable, at?: number): MdTable {
  const cols = colCount(table)
  const row = Array.from({ length: cols }, () => '')
  const rows = [...table.rows]
  const index = at == null ? rows.length : Math.max(0, Math.min(at, rows.length))
  rows.splice(index, 0, row)
  const rowHeights = table.rowHeights ? [...table.rowHeights] : undefined
  if (rowHeights) rowHeights.splice(index + 1, 0, 0)
  const next = { ...table, rows, rowHeights }
  next.merges = mapMerges(next, (merge) => {
    const shifted = shiftSpan(merge.row, merge.rowspan, index, true)
    if (!shifted) return null
    return { ...merge, row: shifted.start, rowspan: shifted.span }
  })
  return next
}

export function addTableColumn(table: MdTable, at?: number): MdTable {
  const index = at == null ? table.headers.length : Math.max(0, Math.min(at, table.headers.length))
  const headers = [...table.headers]
  const aligns = [...table.aligns]
  headers.splice(index, 0, `Column ${headers.length + 1}`)
  aligns.splice(index, 0, '')
  const rows = table.rows.map((row) => {
    const next = [...row]
    next.splice(index, 0, '')
    return next
  })
  const colWidths = table.colWidths ? [...table.colWidths] : undefined
  if (colWidths) colWidths.splice(index, 0, 0)
  const next = { ...table, headers, aligns, rows, colWidths }
  next.merges = mapMerges(next, (merge) => {
    const shifted = shiftSpan(merge.col, merge.colspan, index, true)
    if (!shifted) return null
    return { ...merge, col: shifted.start, colspan: shifted.span }
  })
  return next
}

export function removeTableRow(table: MdTable, index: number): MdTable {
  if (table.rows.length <= 1) {
    return {
      ...table,
      rows: [table.rows[0]?.map(() => '') || ['']],
      merges: (table.merges || []).filter((merge) => merge.row < 0),
    }
  }
  const rows = table.rows.filter((_, i) => i !== index)
  const rowHeights = table.rowHeights ? table.rowHeights.filter((_, i) => i !== index + 1) : undefined
  const next = { ...table, rows, rowHeights }
  next.merges = mapMerges(next, (merge) => {
    const shifted = shiftSpan(merge.row, merge.rowspan, index, false)
    if (!shifted) return null
    return { ...merge, row: shifted.start, rowspan: shifted.span }
  })
  return next
}

export function removeTableColumn(table: MdTable, index: number): MdTable {
  if (table.headers.length <= 1) {
    return {
      headers: [''],
      aligns: [''],
      rows: table.rows.map(() => ['']),
      rowHeights: table.rowHeights,
      colWidths: [0],
      merges: [],
    }
  }
  const next: MdTable = {
    ...table,
    headers: table.headers.filter((_, i) => i !== index),
    aligns: table.aligns.filter((_, i) => i !== index),
    rows: table.rows.map((row) => row.filter((_, i) => i !== index)),
    colWidths: table.colWidths ? table.colWidths.filter((_, i) => i !== index) : undefined,
  }
  next.merges = mapMerges(next, (merge) => {
    const shifted = shiftSpan(merge.col, merge.colspan, index, false)
    if (!shifted) return null
    return { ...merge, col: shifted.start, colspan: shifted.span }
  })
  return next
}

export function mergeCells(table: MdTable, from: CellPos, to: CellPos): MdTable {
  const rect = rectFrom(from, to)
  if (rect.rowspan === 1 && rect.colspan === 1) return table
  if (!inTableBounds(table, rect.row, rect.col)) return table
  if (!inTableBounds(table, rect.row + rect.rowspan - 1, rect.col + rect.colspan - 1)) return table
  const parts: string[] = []
  let next: MdTable = { ...table, merges: (table.merges || []).filter((merge) => !mergesOverlap(merge, rect)) }
  for (let row = rect.row; row < rect.row + rect.rowspan; row++) {
    for (let col = rect.col; col < rect.col + rect.colspan; col++) {
      const text = cellText(next, row, col)
      if (text) parts.push(text)
      if (row !== rect.row || col !== rect.col) next = setTableCell(next, row, col, '')
    }
  }
  next = setTableCell(next, rect.row, rect.col, parts.join('\n'))
  return { ...next, merges: cleanMerges(next, [...(next.merges || []), rect]) }
}

export function unmergeCells(table: MdTable, row: number, col: number): MdTable {
  const merge = findMerge(table, row, col)
  if (!merge) return table
  return {
    ...table,
    merges: (table.merges || []).filter(
      (item) => item.row !== merge.row || item.col !== merge.col,
    ),
  }
}

export function nextVisibleCell(
  table: MdTable,
  row: number,
  col: number,
  dRow: number,
  dCol: number,
): CellPos {
  const merge = findMerge(table, row, col)
  let nextRow = row + dRow
  let nextCol = col + dCol
  if (merge && merge.row === row && merge.col === col) {
    if (dCol === 1 && dRow === 0) nextCol = merge.col + merge.colspan
    if (dCol === -1 && dRow === 0) nextCol = merge.col - 1
    if (dRow === 1 && dCol === 0) nextRow = merge.row + merge.rowspan
    if (dRow === -1 && dCol === 0) nextRow = merge.row - 1
  }
  const cols = colCount(table)
  if (nextCol >= cols) {
    nextRow += 1
    nextCol = 0
  }
  if (nextCol < 0) {
    nextRow -= 1
    nextCol = cols - 1
  }
  nextRow = Math.max(-1, Math.min(table.rows.length - 1, nextRow))
  nextCol = Math.max(0, Math.min(cols - 1, nextCol))
  const covered = findMerge(table, nextRow, nextCol)
  if (covered && (covered.row !== nextRow || covered.col !== nextCol)) {
    return { row: covered.row, col: covered.col }
  }
  return { row: nextRow, col: nextCol }
}
