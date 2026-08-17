import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseMdTable, serializeMdTable } from './mdTable.js'
import {
  SLASH_COMMANDS,
  applySlashCommand,
  filterSlashCommands,
  findSlashTrigger,
} from './slashCommands.js'
import { detectBlockKind, splitMarkdownBlocks } from './liveMarkdown.js'

test('findSlashTrigger opens after a line start or space, not inside words or URLs', () => {
  assert.deepEqual(findSlashTrigger('/', 1), { from: 0, to: 1, query: '' })
  assert.deepEqual(findSlashTrigger('See /tab', 8), { from: 4, to: 8, query: 'tab' })
  assert.equal(findSlashTrigger('foo/', 4), null)
  assert.equal(findSlashTrigger('https://example.com', 8), null)
  assert.equal(findSlashTrigger('/hello:world', 12), null)
})

test('filterSlashCommands matches titles and keywords', () => {
  const tables = filterSlashCommands('table')
  assert.ok(tables.some((cmd) => cmd.id === 'table'))
  const headings = filterSlashCommands('h2')
  assert.ok(headings.some((cmd) => cmd.id === 'h2'))
  const bullets = filterSlashCommands('bullet')
  assert.ok(bullets.some((cmd) => cmd.id === 'ul'))
  assert.equal(filterSlashCommands('').length, SLASH_COMMANDS.length)
  assert.equal(filterSlashCommands('zzzz-nope').length, 0)
})

test('applySlashCommand replaces an empty line and splits around existing text', () => {
  const table = SLASH_COMMANDS.find((cmd) => cmd.id === 'table')
  const h2 = SLASH_COMMANDS.find((cmd) => cmd.id === 'h2')
  assert.ok(table && h2)

  const empty = applySlashCommand('/', { from: 0, to: 1, query: '' }, h2)
  assert.equal(empty.type, 'replace')
  if (empty.type === 'replace') {
    assert.equal(empty.text, '## ')
    assert.equal(empty.caret, 3)
  }

  const afterText = applySlashCommand('Notes /', { from: 6, to: 7, query: '' }, h2)
  assert.equal(afterText.type, 'split')
  if (afterText.type === 'split') {
    assert.deepEqual(afterText.blocks, ['Notes', '## '])
    assert.equal(afterText.focus, 1)
  }

  const around = applySlashCommand('Keep / leftover', { from: 5, to: 7, query: '' }, table)
  assert.equal(around.type, 'split')
  if (around.type === 'split') {
    assert.equal(around.blocks[0], 'Keep')
    assert.ok(parseMdTable(around.blocks[1]))
    assert.equal(around.blocks[2], 'leftover')
    assert.equal(around.focus, 1)
  }
})

test('slash table markdown is one live markdown table block', () => {
  const table = SLASH_COMMANDS.find((cmd) => cmd.id === 'table')
  assert.ok(table)
  const blocks = splitMarkdownBlocks(table.markdown)
  assert.equal(blocks.length, 1)
  assert.equal(detectBlockKind(blocks[0]), 'table')
  assert.ok(parseMdTable(blocks[0]))
})

test('splitMarkdownBlocks keeps table layout comments on the table', () => {
  const md = serializeMdTable({
    headers: ['A', 'B'],
    aligns: ['', ''],
    rows: [['1', '2']],
    colWidths: [100, 120],
    merges: [{ row: 0, col: 0, rowspan: 1, colspan: 2 }],
  })
  const blocks = splitMarkdownBlocks(`Intro\n\n${md}\n\nTail`)
  assert.equal(blocks.length, 3)
  assert.equal(detectBlockKind(blocks[1]), 'table')
  const parsed = parseMdTable(blocks[1])
  assert.ok(parsed)
  assert.deepEqual(parsed.colWidths, [100, 120])
  assert.deepEqual(parsed.merges, [{ row: 0, col: 0, rowspan: 1, colspan: 2 }])
})
