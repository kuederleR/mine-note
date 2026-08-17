import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ensureMineObject,
  insertObjectChip,
  objectLinkFromAttrs,
  objectLinkToAttrs,
  parseObjectChip,
  pasteObjectMarkdown,
  serializeObjectChip,
} from './objectLink.js'
import { innerMineMarkdown, parseMineFence } from './mineObjects.js'

test('serialize/parse object chips', () => {
  const chip = serializeObjectChip({
    id: 'obj_abc',
    type: 'todo',
    noteId: 'note1',
    noteTitle: 'Tasks',
    label: 'Buy milk',
  })
  assert.equal(chip, '::obj[obj_abc|todo|note1|Buy milk]')
  const parsed = parseObjectChip(chip)
  assert.deepEqual(parsed, {
    id: 'obj_abc',
    type: 'todo',
    noteId: 'note1',
    noteTitle: '',
    label: 'Buy milk',
  })
})

test('insertObjectChip adds spacing around the chip', () => {
  assert.equal(
    insertObjectChip('Hello world', 5, {
      id: 'obj_1',
      type: 'paragraph',
      noteId: 'n',
      noteTitle: '',
      label: 'X',
    }),
    'Hello ::obj[obj_1|paragraph|n|X] world',
  )
})

test('ensureMineObject wraps a plain block with a stable id', () => {
  const first = ensureMineObject('- [ ] Task', 'todo')
  assert.match(first.markdown, /<!-- mine:todo:obj_/)
  assert.equal(first.type, 'todo')
  const again = ensureMineObject(first.markdown, 'todo')
  assert.equal(again.id, first.id)
  assert.equal(again.markdown, first.markdown)
})

test('object link fence attrs encode spaces in labels', () => {
  const attrs = objectLinkToAttrs({
    id: 'obj_1',
    type: 'heading',
    noteId: 'n1',
    noteTitle: '',
    label: 'Q2 plan',
  })
  assert.equal(attrs.obj, 'obj_1')
  assert.equal(attrs.objlabel, 'Q2%20plan')
  const back = objectLinkFromAttrs(attrs)
  assert.equal(back?.label, 'Q2 plan')
  assert.equal(back?.noteId, 'n1')
})

test('pasteObjectMarkdown link/content/embed', () => {
  const markdown = '<!-- mine:paragraph:obj_abc -->\nHello\n<!-- /mine:paragraph -->'
  const clip = {
    link: { id: 'obj_abc', type: 'paragraph', noteId: 'n1', noteTitle: 'Note', label: 'Hello' },
    markdown,
  }
  assert.equal(pasteObjectMarkdown(clip, 'link'), '::obj[obj_abc|paragraph|n1|Hello]')
  const content = pasteObjectMarkdown(clip, 'content')
  const contentFence = parseMineFence(content)
  assert.equal(contentFence?.type, 'paragraph')
  assert.notEqual(contentFence?.id, 'obj_abc')
  assert.equal(innerMineMarkdown(content), 'Hello')
  const embed = pasteObjectMarkdown(clip, 'embed')
  const embedFence = parseMineFence(embed)
  assert.equal(embedFence?.type, 'embed')
  assert.equal(embedFence?.attrs.src, 'obj_abc')
  assert.match(embedFence?.id || '', /^emb_/)
})

