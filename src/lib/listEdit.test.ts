import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleListEnter, handleListTab, handlePlainEnter, parseListItem } from './listEdit.js'
import { detectBlockKind, splitMarkdownBlocks } from './liveMarkdown.js'

test('plain Enter inserts a newline unless the current line is blank', () => {
  const typed = handlePlainEnter('Hello', 5)
  assert.deepEqual(typed, { type: 'replace', text: 'Hello\n', caret: 6 })

  const blank = handlePlainEnter('Hello\n', 6)
  assert.equal(blank.type, 'split')
  if (blank.type === 'split') {
    assert.deepEqual(blank.blocks, ['Hello', ''])
    assert.equal(blank.focus, 1)
  }
})

test('splitMarkdownBlocks groups consecutive bullets and todos', () => {
  const blocks = splitMarkdownBlocks('Intro line\n\n- alpha\n- beta\n  - nested\n\n- [ ] one\n- [ ] two\n\nTail')
  assert.deepEqual(blocks, ['Intro line', '- alpha\n- beta\n  - nested', '- [ ] one\n- [ ] two', 'Tail'])
  assert.equal(detectBlockKind(blocks[1]), 'ul')
  assert.equal(detectBlockKind(blocks[2]), 'todo')
})

test('list Enter creates a sibling bullet and splits text at the caret', () => {
  const result = handleListEnter('- hello world', 8)
  assert.equal(result?.type, 'replace')
  if (result?.type === 'replace') {
    assert.equal(result.text, '- hello \n- world')
    assert.equal(result.text.slice(result.caret), 'world')
  }
})

test('list Enter on an empty bullet exits the list', () => {
  const result = handleListEnter('- keep\n- ', 9)
  assert.equal(result?.type, 'split')
  if (result?.type === 'split') {
    assert.deepEqual(result.blocks, ['- keep', ''])
  }
})

test('list Enter on an empty nested bullet outdents', () => {
  const result = handleListEnter('- keep\n  - ', 11)
  assert.equal(result?.type, 'replace')
  if (result?.type === 'replace') {
    assert.equal(result.text, '- keep\n- ')
  }
})

test('Tab and Shift+Tab indent list items', () => {
  const inTab = handleListTab('- item', 2, false)
  assert.equal(inTab?.type, 'replace')
  if (inTab?.type === 'replace') assert.equal(inTab.text, '  - item')

  const out = handleListTab('  - item', 4, true)
  assert.equal(out?.type, 'replace')
  if (out?.type === 'replace') assert.equal(out.text, '- item')
})

test('parseListItem keeps checkbox prefixes', () => {
  const item = parseListItem('- [x] done')
  assert.deepEqual(item, { indent: '', marker: '-', gap: ' ', check: '[x] ', text: 'done' })
})
