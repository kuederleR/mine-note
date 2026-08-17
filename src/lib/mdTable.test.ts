import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_TABLE,
  addTableColumn,
  addTableRow,
  mergeCells,
  parseMdTable,
  removeTableColumn,
  removeTableRow,
  serializeMdTable,
  setTableCell,
  unmergeCells,
} from './mdTable.js'

test('parseMdTable reads GitHub-flavored tables', () => {
  const table = parseMdTable('| Name | Role |\n| --- | ---: |\n| Ada | Engineer |')
  assert.ok(table)
  assert.deepEqual(table.headers, ['Name', 'Role'])
  assert.deepEqual(table.aligns, ['', 'right'])
  assert.deepEqual(table.rows, [['Ada', 'Engineer']])
})

test('serializeMdTable round-trips with escaped pipes', () => {
  const md = serializeMdTable({
    headers: ['A|B', 'C'],
    aligns: ['center', ''],
    rows: [['1', '2']],
  })
  const parsed = parseMdTable(md)
  assert.equal(md.split('\n')[0], '| A\\|B | C |')
  assert.ok(parsed)
  assert.deepEqual(parsed.headers, ['A|B', 'C'])
  assert.equal(parsed.aligns[0], 'center')
})

test('DEFAULT_TABLE serializes into a block the editor can parse', () => {
  const md = serializeMdTable(DEFAULT_TABLE)
  const parsed = parseMdTable(md)
  assert.ok(parsed)
  assert.equal(parsed.headers.length, 3)
  assert.equal(parsed.rows.length, 2)
})

test('parse/serialize keeps leading, trailing, and internal spaces', () => {
  const md = serializeMdTable({
    headers: [' hello ', 'a b'],
    aligns: ['', ''],
    rows: [[' ', 'x  y']],
  })
  const parsed = parseMdTable(md)
  assert.ok(parsed)
  assert.deepEqual(parsed.headers, [' hello ', 'a b'])
  assert.deepEqual(parsed.rows, [[' ', 'x  y']])

  const typed = serializeMdTable(setTableCell(DEFAULT_TABLE, 0, 0, 'hello '))
  const again = parseMdTable(typed)
  assert.ok(again)
  assert.equal(again.rows[0][0], 'hello ')
})

test('newlines in cells round-trip as breaks', () => {
  const md = serializeMdTable(setTableCell(DEFAULT_TABLE, 0, 0, 'hello\nworld'))
  assert.match(md, /hello<br>world/)
  const parsed = parseMdTable(md)
  assert.ok(parsed)
  assert.equal(parsed.rows[0][0], 'hello\nworld')
})

test('column widths, row heights, and merges persist in a comment', () => {
  const md = serializeMdTable({
    ...DEFAULT_TABLE,
    colWidths: [120, 80, 90],
    rowHeights: [40, 50, 60],
    merges: [{ row: 0, col: 0, rowspan: 1, colspan: 2 }],
  })
  assert.match(md, /<!-- mine-table:/)
  const parsed = parseMdTable(md)
  assert.ok(parsed)
  assert.deepEqual(parsed.colWidths, [120, 80, 90])
  assert.deepEqual(parsed.merges, [{ row: 0, col: 0, rowspan: 1, colspan: 2 }])
})

test('object refs persist in the table comment', () => {
  const md = serializeMdTable({
    ...DEFAULT_TABLE,
    refs: [{ id: 'obj_1', type: 'todo', noteId: 'n1', noteTitle: 'Tasks', label: 'Buy milk' }],
  })
  assert.match(md, /<!-- mine-table:/)
  const parsed = parseMdTable(md)
  assert.ok(parsed)
  assert.equal(parsed.refs?.[0]?.id, 'obj_1')
  assert.equal(parsed.refs?.[0]?.label, 'Buy milk')
})

test('mergeCells joins a rectangle and unmergeCells restores the grid', () => {
  let table = setTableCell(DEFAULT_TABLE, 0, 0, 'A')
  table = setTableCell(table, 0, 1, 'B')
  table = mergeCells(table, { row: 0, col: 0 }, { row: 0, col: 1 })
  assert.equal(table.rows[0][0], 'A\nB')
  assert.equal(table.rows[0][1], '')
  assert.deepEqual(table.merges, [{ row: 0, col: 0, rowspan: 1, colspan: 2 }])
  table = unmergeCells(table, 0, 0)
  assert.equal(table.merges?.length || 0, 0)
  assert.equal(table.rows[0][0], 'A\nB')
})

test('adding and removing columns keeps merge coordinates valid', () => {
  let table = mergeCells(DEFAULT_TABLE, { row: 0, col: 1 }, { row: 0, col: 2 })
  table = addTableColumn(table, 0)
  assert.deepEqual(table.merges, [{ row: 0, col: 2, rowspan: 1, colspan: 2 }])
  table = removeTableColumn(table, 0)
  assert.deepEqual(table.merges, [{ row: 0, col: 1, rowspan: 1, colspan: 2 }])
})

test('setTableCell, add, and remove keep a usable grid', () => {
  let table = setTableCell(DEFAULT_TABLE, -1, 0, 'Title')
  table = setTableCell(table, 0, 1, 'cell')
  table = addTableRow(table)
  table = addTableColumn(table)
  assert.equal(table.headers[0], 'Title')
  assert.equal(table.rows[0][1], 'cell')
  assert.equal(table.rows.length, 3)
  assert.equal(table.headers.length, 4)
  table = removeTableRow(table, 2)
  table = removeTableColumn(table, 3)
  assert.equal(table.rows.length, 2)
  assert.equal(table.headers.length, 3)
})
