import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatEmbedBlock, formatMineBlock, innerMineMarkdown, parseMineFence } from './mineObjects.js'
import {
  applyCanonicalObjectUpdate,
} from './structuredDoc.js'
import {
  findCanonicalInMarkdown,
  refreshEmbedsDeep,
  replaceCanonicalInMarkdown,
} from './mineEmbedSync.js'
import { nestedObjectForInsert } from './nestedObjects.js'
import { serializeMdTable, DEFAULT_TABLE, setTableCell } from './mdTable.js'

test('applyCanonicalObjectUpdate syncs original across multi-block docs', () => {
  const source = formatMineBlock('list', 'obj_src', '- one')
  const other = formatMineBlock('paragraph', 'obj_other', 'keep')
  const embed = formatEmbedBlock(source, 'note1', 'one')
  const doc = `${other}\n\n${source}\n\n${embed}`
  const updated = formatMineBlock('list', 'obj_src', '- one\n- two')
  const next = applyCanonicalObjectUpdate(doc, 'obj_src', updated)
  assert.match(next, /obj_other/)
  assert.match(next, /- one\n- two/)
  const embedFence = parseMineFence(embed)!
  assert.match(next, new RegExp(`mine:embed:${embedFence.id}[\\s\\S]*- two`))
  const found = findCanonicalInMarkdown(next, 'obj_src')
  assert.equal(innerMineMarkdown(found || ''), '- one\n- two')
})

test('applyCanonicalObjectUpdate syncs embed edits into table cells', () => {
  const source = formatMineBlock('todo', 'obj_todo', '- [ ] task')
  const embed = formatEmbedBlock(source, 'note1', 'task')
  let table = {
    ...DEFAULT_TABLE,
    headers: ['A', 'B'],
    rows: [
      [embed, ''],
      ['', ''],
    ],
  }
  const tableBlock = formatMineBlock('table', 'obj_table', serializeMdTable(table))
  const doc = `${source}\n\n${tableBlock}`
  const edited = formatMineBlock('todo', 'obj_todo', '- [x] task')
  const next = applyCanonicalObjectUpdate(doc, 'obj_todo', edited)
  assert.match(findCanonicalInMarkdown(next, 'obj_todo') || '', /\[x\]/)
  assert.match(next, /mine:embed:[\s\S]*\[x\]/)
})

test('replaceCanonicalInMarkdown updates objects living in table cells', () => {
  const list = nestedObjectForInsert('list', 'milk')
  const fence = parseMineFence(list)!
  const table = setTableCell(
    { ...DEFAULT_TABLE, headers: ['Items', 'Notes'], rows: [['', ''], ['', '']] },
    0,
    0,
    list,
  )
  const tableMd = formatMineBlock('table', 'obj_tbl', serializeMdTable(table))
  const updated = formatMineBlock('list', fence.id, '- milk\n- eggs')
  const next = replaceCanonicalInMarkdown(tableMd, fence.id, updated)
  assert.ok(next)
  assert.match(next!, /- eggs/)
  assert.match(refreshEmbedsDeep(`${updated}\n\n${formatEmbedBlock(updated, 'n1')}`, fence.id, updated), /- eggs/)
})
