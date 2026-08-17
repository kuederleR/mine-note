import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildCreateSystemPrompt,
  buildObjectLegend,
  creatableObjectSpecs,
  getObjectSpec,
} from './objectSpecs.js'
import { formatComponentForSearch } from './objectContext.js'
import { normalizeDrafts, serializeMineObjects } from './mineObjects.js'

test('creatable specs cover the inline create types', () => {
  const types = creatableObjectSpecs().map((spec) => spec.type)
  for (const type of [
    'heading',
    'paragraph',
    'list',
    'numbered-list',
    'todo',
    'table',
    'callout',
    'quote',
    'toggle',
    'divider',
    'reminder',
  ]) {
    assert.ok(types.includes(type), type)
  }
  assert.equal(getObjectSpec('embed')?.creatable, false)
  assert.equal(getObjectSpec('code')?.creatable, false)
})

test('buildCreateSystemPrompt teaches each creatable type as a tool', () => {
  const prompt = buildCreateSystemPrompt()
  assert.match(prompt, /object builder/i)
  assert.match(prompt, /- reminder:/)
  assert.match(prompt, /due/)
  assert.match(prompt, /- todo:/)
  assert.match(prompt, /\{ "objects":/)
})

test('formatComponentForSearch uses object specs', () => {
  assert.equal(
    formatComponentForSearch({
      type: 'reminder',
      content: 'Pack bag',
      meta: { due: '2026-08-16', status: 'todo' },
    }),
    'Reminder | due=2026-08-16 | status=todo | Pack bag',
  )
  assert.match(
    formatComponentForSearch({ type: 'todo', content: '- [ ] one\n- [x] two' }),
    /Todo \| open=1\/2/,
  )
})

test('buildObjectLegend lists only requested types', () => {
  const legend = buildObjectLegend(['reminder', 'todo', 'reminder'])
  assert.match(legend, /reminder:/)
  assert.match(legend, /todo:/)
  assert.equal(legend.includes('table:'), false)
})

test('create drafts still serialize through mine objects', () => {
  const drafts = normalizeDrafts({
    objects: [
      { type: 'reminder', text: 'Pack bag', due: '2026-08-16', status: 'todo' },
      { type: 'todo', items: [{ text: 'Ship it', checked: false }] },
    ],
  })
  assert.equal(drafts.length, 2)
  const md = serializeMineObjects(drafts, 'agent_test')
  assert.match(md, /mine:reminder:/)
  assert.match(md, /due=2026-08-16/)
  assert.match(md, /mine:todo:/)
  assert.match(md, /- \[ \] Ship it/)
})
