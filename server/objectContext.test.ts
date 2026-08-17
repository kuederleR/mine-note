import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatComponentForAi, formatComponentForSearch, formatEvidenceBlock } from './objectContext.js'

test('formatComponentForSearch labels reminders with due and status', () => {
  assert.equal(
    formatComponentForSearch({
      type: 'reminder',
      content: 'Call dentist',
      meta: { due: '2026-08-14', status: 'todo' },
    }),
    'Reminder | due=2026-08-14 | status=todo | Call dentist',
  )
})

test('formatComponentForSearch summarizes todos', () => {
  assert.equal(
    formatComponentForSearch({
      type: 'todo',
      content: '- [ ] one\n- [x] two',
    }),
    'Todo | open=1/2 | - [ ] one - [x] two',
  )
})

test('formatEvidenceBlock includes type for the model', () => {
  const block = formatEvidenceBlock({
    index: 1,
    type: 'reminder',
    content: 'Pack bag',
    meta: { due: '2026-08-14' },
    noteId: 'n1',
    noteTitle: 'Tonight',
  })
  assert.match(block, /type=reminder/)
  assert.match(block, /due=2026-08-14/)
  assert.match(block, /Pack bag/)
  assert.equal(
    formatComponentForAi({ type: 'reminder', content: 'Pack bag', meta: { due: '2026-08-14' } }).includes(
      'due=',
    ),
    true,
  )
})
