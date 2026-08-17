import assert from 'node:assert/strict'
import { test } from 'node:test'
import { componentsFromDocument } from './structuredParse.ts'
import { markdownToDoc } from '../src/lib/structuredDoc.ts'
import { formatMineBlock } from '../src/lib/mineObjects.ts'
import { DEFAULT_TABLE, serializeMdTable, setTableCell } from '../src/lib/mdTable.ts'

test('componentsFromDocument indexes nested list text inside a table cell', () => {
  const list = formatMineBlock('list', 'obj_list', '- milk\n- eggs')
  const table = formatMineBlock(
    'table',
    'obj_table',
    serializeMdTable(setTableCell(DEFAULT_TABLE, 0, 0, list)),
  )
  const { doc, objects } = markdownToDoc(table)
  const components = componentsFromDocument('note1', doc, objects)
  const contents = components.map((c) => c.content).join('\n')
  assert.match(contents, /milk/)
  assert.match(contents, /eggs/)
  assert.ok(components.some((c) => c.meta && (c.meta as { objectId?: string }).objectId === 'obj_list'))
})

test('componentsFromDocument strips callout markers and keeps IDEA body', () => {
  const callout = formatMineBlock(
    'callout',
    'obj_call',
    '> [!IDEA] Make your tables more fun by using creative headers',
  )
  const table = formatMineBlock(
    'table',
    'obj_table',
    serializeMdTable(setTableCell(DEFAULT_TABLE, 0, 0, callout)),
  )
  const { doc, objects } = markdownToDoc(table)
  const call = componentsFromDocument('note1', doc, objects).find((c) => c.type === 'callout')
  assert.ok(call)
  assert.equal(call!.meta.kind, 'IDEA')
  assert.match(call!.content, /Make your tables more fun/)
  assert.doesNotMatch(call!.content, /\[!IDEA\]/)
})
