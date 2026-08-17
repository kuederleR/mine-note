import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  duplicateMineObject,
  findCanonicalMineObject,
  formatEmbedBlock,
  formatMineBlock,
  innerMineMarkdown,
  parseMineFence,
  refreshEmbedSnapshots,
  replaceMineObjectInner,
  unwrapEmbed,
} from './mineObjects.js'
import { detectBlockKind } from './liveMarkdown.js'

test('embed fence round-trips source snapshot', () => {
  const source = formatMineBlock('todo', 'obj_abc', '- [ ] Buy milk')
  const embed = formatEmbedBlock(source, 'note1', 'Buy milk')
  const fence = parseMineFence(embed)
  assert.equal(fence?.type, 'embed')
  assert.equal(fence?.attrs.src, 'obj_abc')
  assert.equal(fence?.attrs.type, 'todo')
  assert.equal(fence?.attrs.note, 'note1')
  assert.match(fence?.id || '', /^emb_/)
  assert.equal(unwrapEmbed(embed), source)
  assert.notEqual(fence?.id, 'obj_abc')
})

test('duplicateMineObject assigns a new id', () => {
  const source = formatMineBlock('paragraph', 'obj_abc', 'Hello')
  const copy = duplicateMineObject(source)
  const fence = parseMineFence(copy)
  assert.equal(fence?.type, 'paragraph')
  assert.notEqual(fence?.id, 'obj_abc')
  assert.equal(innerMineMarkdown(copy), 'Hello')
})

test('duplicateMineObject unwraps embeds to a new source copy', () => {
  const source = formatMineBlock('quote', 'obj_q', '> echoed')
  const embed = formatEmbedBlock(source, 'n1', 'echoed')
  const copy = duplicateMineObject(embed)
  const fence = parseMineFence(copy)
  assert.equal(fence?.type, 'quote')
  assert.notEqual(fence?.id, 'obj_q')
  assert.notEqual(fence?.type, 'embed')
  assert.equal(innerMineMarkdown(copy), '> echoed')
})

test('replaceMineObjectInner skips embed fences', () => {
  const source = formatMineBlock('paragraph', 'obj_abc', 'one')
  const embed = formatEmbedBlock(source, 'n1', 'one')
  const content = `${source}\n\n${embed}`
  const next = replaceMineObjectInner(content, 'obj_abc', 'two')
  assert.ok(next)
  const found = findCanonicalMineObject(next!, 'obj_abc')
  assert.equal(found?.inner, 'two')
  const embedFence = parseMineFence(embed)
  assert.ok(next!.includes(`mine:embed:${embedFence?.id}`))
  assert.equal(findCanonicalMineObject(next!, embedFence!.id), null)
})

test('refreshEmbedSnapshots updates nested source copies', () => {
  const source = formatMineBlock('paragraph', 'obj_abc', 'one')
  const embed = formatEmbedBlock(source, 'n1', 'one')
  const next = refreshEmbedSnapshots(`${source}\n\n${embed}`, 'obj_abc', formatMineBlock('paragraph', 'obj_abc', 'two'))
  const embedFence = parseMineFence(embed)!
  assert.match(next, new RegExp(`mine:embed:${embedFence.id}[\\s\\S]*two`))
})

test('detectBlockKind treats fenced and embedded lists as lists', () => {
  const source = formatMineBlock('list', 'obj_abc', '- a\n- b')
  const embed = formatEmbedBlock(source, 'n1', 'a')
  assert.equal(detectBlockKind(source), 'ul')
  assert.equal(detectBlockKind(embed), 'ul')
})

test('findCanonicalMineObject walks nested objects', () => {
  const child = formatMineBlock('table', 'obj_tbl', '| A | B |\n| --- | --- |\n| 1 | 2 |')
  const parent = formatMineBlock('list', 'obj_list', `- items\n\n${child}`)
  const found = findCanonicalMineObject(parent, 'obj_tbl')
  assert.equal(found?.fence.type, 'table')
  assert.equal(found?.fence.id, 'obj_tbl')
  const next = replaceMineObjectInner(parent, 'obj_tbl', '| A | B |\n| --- | --- |\n| 3 | 4 |')
  assert.ok(next)
  assert.match(next!, /\| 3 \| 4 \|/)
  assert.match(next!, /mine:list:obj_list/)
})
