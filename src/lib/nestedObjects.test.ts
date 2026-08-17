import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_TABLE,
  parseMdTable,
  serializeMdTable,
  setTableCell,
} from './mdTable.js'
import {
  appendNestedObject,
  applySlashAsNested,
  innerHasNestedFence,
  insertNestedIntoCell,
  insertNestedIntoMarkdown,
  isCompleteMineFence,
  moveInnerSegment,
  nestedObjectForInsert,
  pasteIntoCell,
  replaceInnerSegment,
  splitInnerSegments,
  unwrapNestedMarkdown,
} from './nestedObjects.js'
import { innerMineMarkdown, parseMineFence } from './mineObjects.js'

test('nestedObjectForInsert wraps defaults in a mine fence', () => {
  const list = nestedObjectForInsert('list', 'Milk')
  const fence = parseMineFence(list)
  assert.equal(fence?.type, 'list')
  assert.equal(innerMineMarkdown(list), '- Milk')

  const table = nestedObjectForInsert('table', 'Ada')
  assert.equal(parseMineFence(table)?.type, 'table')
  assert.match(innerMineMarkdown(table), /Ada/)
})

test('insertNestedIntoCell wraps plain text and nests into an existing object', () => {
  const wrapped = insertNestedIntoCell('Hello', 'list')
  assert.equal(parseMineFence(wrapped)?.type, 'list')
  assert.equal(innerMineMarkdown(wrapped), '- Hello')

  const nested = insertNestedIntoCell(wrapped, 'table')
  assert.equal(parseMineFence(nested)?.type, 'list')
  assert.equal(innerHasNestedFence(innerMineMarkdown(nested)), true)
  assert.match(innerMineMarkdown(nested), /mine:table:/)
})

test('table cells round-trip a nested list object', () => {
  const list = nestedObjectForInsert('list', 'alpha')
  const table = setTableCell(DEFAULT_TABLE, 0, 1, list)
  const parsed = parseMdTable(serializeMdTable(table))
  assert.ok(parsed)
  assert.equal(parsed.rows[0][1], list)
  assert.equal(parseMineFence(parsed.rows[0][1])?.type, 'list')
  assert.equal(innerMineMarkdown(parsed.rows[0][1]), '- alpha')
})

test('table cells round-trip a nested table object', () => {
  const inner = nestedObjectForInsert('table', 'Ada')
  const table = setTableCell(DEFAULT_TABLE, 0, 0, inner)
  const parsed = parseMdTable(serializeMdTable(table))
  assert.ok(parsed)
  assert.equal(parseMineFence(parsed.rows[0][0])?.type, 'table')
  const nested = parseMdTable(innerMineMarkdown(parsed.rows[0][0]))
  assert.ok(nested)
  assert.match(nested.rows[0][0], /Ada/)
})

test('splitInnerSegments keeps host markdown and nested fences apart', () => {
  const child = nestedObjectForInsert('table')
  const inner = appendNestedObject('- one\n- two', child)
  const parts = splitInnerSegments(inner)
  assert.equal(parts.length, 2)
  assert.equal(parts[0], '- one\n- two')
  assert.equal(parseMineFence(parts[1])?.type, 'table')
  assert.equal(replaceInnerSegment(inner, 1, ''), '- one\n- two')
})

test('unwrapNestedMarkdown returns the inner source', () => {
  const block = nestedObjectForInsert('quote', 'Hi')
  assert.equal(unwrapNestedMarkdown(block), '> Hi')
})

test('insertNestedIntoMarkdown nests a list inside a table cell', () => {
  const table = nestedObjectForInsert('table')
  const next = insertNestedIntoMarkdown(table, 'list')
  assert.equal(parseMineFence(next)?.type, 'table')
  const parsed = parseMdTable(innerMineMarkdown(next))
  assert.ok(parsed)
  assert.equal(parseMineFence(parsed.rows[0][0])?.type, 'list')
})

test('pasteIntoCell nests into an existing cell object', () => {
  const list = nestedObjectForInsert('list', 'alpha')
  const table = nestedObjectForInsert('table')
  const next = pasteIntoCell(list, table)
  assert.equal(parseMineFence(next)?.type, 'list')
  assert.match(innerMineMarkdown(next), /mine:table:/)
})

test('isCompleteMineFence rejects mixed sibling fences', () => {
  const a = nestedObjectForInsert('list', 'one')
  const b = nestedObjectForInsert('quote', 'two')
  assert.equal(isCompleteMineFence(a), true)
  assert.equal(isCompleteMineFence(`${a}\n\n${b}`), false)
})

test('applySlashAsNested wraps a cell as a list object', () => {
  const result = applySlashAsNested('/', { from: 0, to: 1, query: '' }, {
    id: 'ul',
    markdown: '- ',
    caret: 2,
  }, 'list')
  assert.equal(result.hostType, 'list')
  assert.equal(result.text, '- ')
})

test('applySlashAsNested nests a table beside existing text', () => {
  const result = applySlashAsNested('Hello /', { from: 6, to: 7, query: '' }, {
    id: 'table',
    markdown: '| A | B |\n| --- | --- |\n|  |  |',
    caret: 2,
  }, 'table')
  assert.equal(result.hostType, undefined)
  assert.match(result.text, /^Hello\n\n<!-- mine:table:/)
})

test('moveInnerSegment reorders nested fences', () => {
  const a = nestedObjectForInsert('list', 'one')
  const b = nestedObjectForInsert('quote', 'two')
  const inner = `${a}\n\n${b}`
  const moved = moveInnerSegment(inner, 1, 0)
  assert.equal(parseMineFence(splitInnerSegments(moved)[0])?.type, 'quote')
})
