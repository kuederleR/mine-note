import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultInnerCaret, matchMarkdownStarter } from './markdownStarters.js'

test('matchMarkdownStarter promotes bullet, numbered, and todo markers', () => {
  assert.deepEqual(matchMarkdownStarter('- ', 2), { type: 'list', inner: '- ', caret: 2 })
  assert.deepEqual(matchMarkdownStarter('* ', 2), { type: 'list', inner: '- ', caret: 2 })
  assert.deepEqual(matchMarkdownStarter('1. ', 3), {
    type: 'numbered-list',
    inner: '1. ',
    caret: 3,
  })
  assert.deepEqual(matchMarkdownStarter('- [ ] ', 6), {
    type: 'todo',
    inner: '- [ ] ',
    caret: 6,
  })
})

test('matchMarkdownStarter promotes headings, quotes, code, and dividers', () => {
  assert.deepEqual(matchMarkdownStarter('## ', 3), {
    type: 'heading',
    inner: '## ',
    caret: 3,
  })
  assert.deepEqual(matchMarkdownStarter('> ', 2), { type: 'quote', inner: '> ', caret: 2 })
  assert.deepEqual(matchMarkdownStarter('```', 3), {
    type: null,
    inner: '```\n\n```',
    caret: 4,
  })
  assert.deepEqual(matchMarkdownStarter('---', 3), {
    type: 'divider',
    inner: '---',
    caret: 3,
  })
})

test('matchMarkdownStarter ignores incomplete or mid-text markers', () => {
  assert.equal(matchMarkdownStarter('-', 1), null)
  assert.equal(matchMarkdownStarter('- hello', 7), null)
  assert.equal(matchMarkdownStarter('- ', 1), null)
  assert.equal(matchMarkdownStarter('note - ', 7), null)
})

test('defaultInnerCaret lands after list and heading prefixes', () => {
  assert.equal(defaultInnerCaret('- '), 2)
  assert.equal(defaultInnerCaret('- [ ] '), 6)
  assert.equal(defaultInnerCaret('1. '), 3)
  assert.equal(defaultInnerCaret('## '), 3)
  assert.equal(defaultInnerCaret('```\n\n```'), 4)
})
