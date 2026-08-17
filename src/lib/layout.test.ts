import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyDrop,
  flattenLeaves,
  normalizeDocument,
  parseDocument,
  serializeDocument,
  type DocNode,
} from './layout.js'
import { formatMineBlock } from './mineObjects.js'

function todo(id: string, text: string) {
  return formatMineBlock('todo', id, `- [ ] ${text}`)
}

function leafIds(nodes: DocNode[]) {
  return flattenLeaves(nodes).map((leaf) => leaf.id)
}

function columnCount(nodes: DocNode[], leafId: string) {
  const flat = flattenLeaves(nodes).find((leaf) => leaf.id === leafId)
  if (!flat || flat.colIndex == null) return 1
  const node = nodes[flat.nodeIndex]
  return node?.type === 'row' ? node.columns.length : 1
}

test('applyDrop creates a two-column row beside a block', () => {
  const a = todo('obj_a', 'alpha')
  const b = todo('obj_b', 'beta')
  const doc = parseDocument(`${a}\n\n${b}`)
  const next = applyDrop(doc, 'obj_a', { type: 'right', id: 'obj_b' })
  assert.equal(next.length, 1)
  assert.equal(next[0]?.type, 'row')
  if (next[0]?.type !== 'row') return
  assert.equal(next[0].columns.length, 2)
  assert.deepEqual(
    next[0].columns.map((col) => col.leaves.map((leaf) => leaf.id)),
    [['obj_b'], ['obj_a']],
  )
})

test('applyDrop inserts a third column into an existing row', () => {
  const a = todo('obj_a', 'alpha')
  const b = todo('obj_b', 'beta')
  const c = todo('obj_c', 'gamma')
  const split = applyDrop(parseDocument(`${a}\n\n${b}`), 'obj_a', { type: 'right', id: 'obj_b' })
  const withThird = parseDocument(`${serializeDocument(split)}\n\n${c}`)
  const next = applyDrop(withThird, 'obj_c', { type: 'left', id: 'obj_b' })
  assert.equal(columnCount(next, 'obj_b'), 3)
  assert.deepEqual(leafIds(next), ['obj_c', 'obj_b', 'obj_a'])
})

test('applyDrop extracting one side of a two-column row unwraps then re-splits', () => {
  const a = todo('obj_a', 'alpha')
  const b = todo('obj_b', 'beta')
  const c = todo('obj_c', 'gamma')
  const row = applyDrop(parseDocument(`${a}\n\n${b}`), 'obj_a', { type: 'right', id: 'obj_b' })
  const doc = parseDocument(`${serializeDocument(row)}\n\n${c}`)
  const next = applyDrop(doc, 'obj_a', { type: 'left', id: 'obj_c' })
  assert.equal(next.length, 2)
  assert.equal(columnCount(next, 'obj_c'), 2)
  assert.ok(leafIds(next).includes('obj_b'))
})

test('normalizeDocument collapses single-column rows', () => {
  const a = todo('obj_a', 'alpha')
  const b = todo('obj_b', 'beta')
  const row = applyDrop(parseDocument(`${a}\n\n${b}`), 'obj_a', { type: 'right', id: 'obj_b' })
  const extracted = applyDrop(row, 'obj_a', { type: 'end' })
  assert.equal(extracted.length, 2)
  assert.equal(extracted.every((node) => node.type === 'block'), true)
  assert.deepEqual(normalizeDocument(extracted).map((node) => node.type), ['block', 'block'])
})

test('applyDrop before/after keeps a vertical stack', () => {
  const a = todo('obj_a', 'alpha')
  const b = todo('obj_b', 'beta')
  const c = todo('obj_c', 'gamma')
  const doc = parseDocument(`${a}\n\n${b}\n\n${c}`)
  const next = applyDrop(doc, 'obj_c', { type: 'before', id: 'obj_a' })
  assert.deepEqual(leafIds(next), ['obj_c', 'obj_a', 'obj_b'])
  assert.equal(next.every((node) => node.type === 'block'), true)
})
