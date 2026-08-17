import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  collectObjectIdsDeep,
  docToMarkdown,
  markdownToDoc,
  moveObjectInMdTable,
  parseDocJson,
  stringifyDoc,
  DOC_VERSION,
} from './structuredDoc.js'
import { formatMineBlock, parseMineFence } from './mineObjects.js'
import { DEFAULT_TABLE, serializeMdTable, setTableCell, parseMdTable } from './mdTable.js'
import { formatEmbedBlock } from './mineObjects.js'
import { formatRow } from './layout.js'

test('markdownToDoc preserves a nested list object inside a table cell', () => {
  const list = formatMineBlock('list', 'obj_list1', '- alpha\n- beta')
  const tableMd = serializeMdTable(setTableCell(DEFAULT_TABLE, 0, 1, list))
  const table = formatMineBlock('table', 'obj_table1', tableMd)

  const { doc, objects } = markdownToDoc(table)
  assert.equal(doc.version, DOC_VERSION)
  assert.equal(doc.nodes.length, 1)
  assert.equal(doc.nodes[0]?.type, 'block')
  if (doc.nodes[0]?.type !== 'block') return
  assert.equal(doc.nodes[0].slot.kind, 'object')
  assert.equal(doc.nodes[0].slot.kind === 'object' && doc.nodes[0].slot.objectId, 'obj_table1')

  const tableObj = objects.find((obj) => obj.id === 'obj_table1')
  assert.ok(tableObj)
  assert.equal(tableObj.type, 'table')
  assert.equal(tableObj.body.kind, 'table')
  if (tableObj.body.kind !== 'table') return
  const cell = tableObj.body.table.rows[0]?.[1]
  assert.ok(cell)
  assert.equal(cell.kind, 'object')
  assert.equal(cell.kind === 'object' && cell.objectId, 'obj_list1')

  const listObj = objects.find((obj) => obj.id === 'obj_list1')
  assert.ok(listObj)
  assert.equal(listObj.type, 'list')
  assert.equal(listObj.body.kind, 'inline')
  if (listObj.body.kind === 'inline') {
    assert.equal(listObj.body.markdown, '- alpha\n- beta')
  }
})

test('doc round-trip keeps nested table object ids', () => {
  const list = formatMineBlock('list', 'obj_list2', '- milk')
  const table = formatMineBlock(
    'table',
    'obj_table2',
    serializeMdTable(setTableCell(DEFAULT_TABLE, 0, 0, list)),
  )
  const first = markdownToDoc(table)
  const exported = docToMarkdown(first.doc, first.objects)
  const second = markdownToDoc(exported)

  assert.deepEqual(
    collectObjectIdsDeep(first.doc, first.objects).sort(),
    collectObjectIdsDeep(second.doc, second.objects).sort(),
  )
  assert.ok(second.objects.some((obj) => obj.id === 'obj_list2' && obj.type === 'list'))
  assert.ok(second.objects.some((obj) => obj.id === 'obj_table2' && obj.type === 'table'))

  const tableObj = second.objects.find((obj) => obj.id === 'obj_table2')
  assert.equal(tableObj?.body.kind, 'table')
  if (tableObj?.body.kind !== 'table') return
  const cell = tableObj.body.table.rows[0]?.[0]
  assert.equal(cell?.kind, 'object')
  assert.equal(cell?.kind === 'object' && cell.objectId, 'obj_list2')

  // Serialized cell still round-trips through MdTable encoding
  const projected = docToMarkdown(second.doc, second.objects)
  const fenceInner = projected.includes('obj_list2')
  assert.equal(fenceInner, true)
  const parsed = parseMdTable(
    projected
      .split('\n')
      .filter((line) => line.includes('|') || line.includes('mine-table'))
      .join('\n') || '',
  )
  // full note is fenced table — parse from object body path instead
  const again = markdownToDoc(projected)
  const t = again.objects.find((obj) => obj.id === 'obj_table2')
  assert.equal(t?.body.kind, 'table')
  void parsed
})

test('embed round-trip preserves embed id and src id', () => {
  const source = formatMineBlock('list', 'obj_src1', '- one\n- two')
  const embed = formatEmbedBlock(source, 'note_abc', 'Groceries')
  const { doc, objects } = markdownToDoc(embed)
  const embedObj = objects.find((obj) => obj.type === 'embed')
  assert.ok(embedObj)
  assert.equal(embedObj.body.kind, 'embed')
  if (embedObj.body.kind !== 'embed') return
  assert.equal(embedObj.body.srcId, 'obj_src1')
  assert.equal(embedObj.body.noteId, 'note_abc')
  assert.ok(objects.some((obj) => obj.id === 'obj_src1' && obj.type === 'list'))

  const exported = docToMarkdown(doc, objects)
  const again = markdownToDoc(exported)
  const embed2 = again.objects.find((obj) => obj.type === 'embed')
  assert.ok(embed2)
  assert.equal(embed2.id, embedObj.id)
  assert.equal(embed2.body.kind, 'embed')
  if (embed2.body.kind !== 'embed') return
  assert.equal(embed2.body.srcId, 'obj_src1')
  assert.ok(again.objects.some((obj) => obj.id === 'obj_src1'))
})

test('row layout round-trip preserves row and column ids', () => {
  const left = formatMineBlock('paragraph', 'obj_left', 'Hello')
  const right = formatMineBlock('paragraph', 'obj_right', 'World')
  const md = formatRow({
    type: 'row',
    id: 'row_main',
    columns: [
      { id: 'col_a', leaves: [{ id: 'obj_left', markdown: left }] },
      { id: 'col_b', leaves: [{ id: 'obj_right', markdown: right }] },
    ],
  })

  const first = markdownToDoc(md)
  assert.equal(first.doc.nodes[0]?.type, 'row')
  if (first.doc.nodes[0]?.type !== 'row') return
  assert.equal(first.doc.nodes[0].id, 'row_main')
  assert.equal(first.doc.nodes[0].columns[0]?.id, 'col_a')
  assert.equal(first.doc.nodes[0].columns[1]?.id, 'col_b')
  assert.equal(first.doc.nodes[0].columns[0]?.blocks[0]?.slot.kind, 'object')
  assert.equal(
    first.doc.nodes[0].columns[0]?.blocks[0]?.slot.kind === 'object' &&
      first.doc.nodes[0].columns[0]?.blocks[0]?.slot.objectId,
    'obj_left',
  )

  const exported = docToMarkdown(first.doc, first.objects)
  const second = markdownToDoc(exported)
  assert.equal(second.doc.nodes[0]?.type, 'row')
  if (second.doc.nodes[0]?.type !== 'row') return
  assert.equal(second.doc.nodes[0].id, 'row_main')
  assert.deepEqual(
    second.doc.nodes[0].columns.map((col) => col.id),
    ['col_a', 'col_b'],
  )
  assert.ok(second.objects.some((obj) => obj.id === 'obj_left'))
  assert.ok(second.objects.some((obj) => obj.id === 'obj_right'))
})

test('plain markdown becomes text slots and round-trips', () => {
  const md = 'Hello world\n\n## Title\n\n- a\n- b'
  const { doc, objects } = markdownToDoc(md)
  assert.equal(objects.length, 0)
  assert.ok(doc.nodes.length >= 1)
  const exported = docToMarkdown(doc, objects)
  const again = markdownToDoc(exported)
  assert.equal(again.objects.length, 0)
  assert.equal(again.doc.nodes.length, doc.nodes.length)
})

test('stack body preserves nested object beside host markdown', () => {
  const child = formatMineBlock('quote', 'obj_quote1', '> hi')
  const host = formatMineBlock('list', 'obj_host1', `- one\n\n${child}`)
  const { objects } = markdownToDoc(host)
  const hostObj = objects.find((obj) => obj.id === 'obj_host1')
  assert.ok(hostObj)
  assert.equal(hostObj.body.kind, 'stack')
  if (hostObj.body.kind !== 'stack') return
  assert.ok(hostObj.body.children.some((slot) => slot.kind === 'text'))
  assert.ok(
    hostObj.body.children.some((slot) => slot.kind === 'object' && slot.objectId === 'obj_quote1'),
  )
  assert.ok(objects.some((obj) => obj.id === 'obj_quote1' && obj.type === 'quote'))
})

test('moveObjectInMdTable moves by object id without copying', () => {
  const list = formatMineBlock('list', 'obj_move1', '- x')
  const table = setTableCell(DEFAULT_TABLE, 0, 0, list)
  const result = moveObjectInMdTable(table, list, 0, 2)
  assert.equal(result.external, false)
  assert.equal(result.table.rows[0][0], '')
  assert.equal(parseMineFence(result.table.rows[0][2] || '')?.id, 'obj_move1')
})

test('stringifyDoc / parseDocJson round-trip', () => {
  const { doc } = markdownToDoc('Hi')
  const raw = stringifyDoc(doc)
  const parsed = parseDocJson(raw)
  assert.deepEqual(parsed, doc)
  assert.equal(parseDocJson(null), null)
  assert.equal(parseDocJson('{'), null)
})
