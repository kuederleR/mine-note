import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  allPanes,
  applyWorkspaceDrop,
  closeTab,
  emptyLayout,
  findPaneForNote,
  focusNote,
  focusedNoteId,
  hitTestSplitSide,
  layoutWithNote,
  MAX_EDITOR_PANES,
  normalizeLayout,
  openInPane,
  panesAfterExtract,
  splitPane,
  tabInsertIndex,
} from './workspaceLayout.js'

function panes(layout: ReturnType<typeof layoutWithNote>) {
  return allPanes(layout)
}

function noteIds(layout: ReturnType<typeof layoutWithNote>) {
  return allPanes(layout).map((pane) => pane.tabs)
}

const box = { left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400 }

test('layoutWithNote opens a single pane and tab', () => {
  const layout = layoutWithNote('n1')
  assert.equal(panes(layout).length, 1)
  assert.deepEqual(panes(layout)[0].tabs, ['n1'])
  assert.equal(focusedNoteId(layout), 'n1')
})

test('openInPane adds a tab and focuses it without duplicating', () => {
  let layout = layoutWithNote('n1')
  const paneId = panes(layout)[0].id
  layout = openInPane(layout, paneId, 'n2')
  assert.deepEqual(panes(layout)[0].tabs, ['n1', 'n2'])
  assert.equal(panes(layout)[0].activeTabId, 'n2')

  layout = openInPane(layout, paneId, 'n1', 0)
  assert.deepEqual(panes(layout)[0].tabs, ['n1', 'n2'])
  assert.equal(panes(layout)[0].activeTabId, 'n1')
})

test('openInPane moves a tab from another pane', () => {
  let layout = layoutWithNote('n1')
  layout = splitPane(layout, panes(layout)[0].id, 'right', 'n2')
  assert.equal(panes(layout).length, 2)
  const left = panes(layout)[0].id
  layout = openInPane(layout, left, 'n2', 1)
  assert.equal(panes(layout).length, 1)
  assert.deepEqual(panes(layout)[0].tabs, ['n1', 'n2'])
})

test('splitPane creates a pane on the left or right', () => {
  let layout = layoutWithNote('n1')
  const origin = panes(layout)[0].id
  layout = splitPane(layout, origin, 'right', 'n2')
  assert.deepEqual(noteIds(layout), [['n1'], ['n2']])
  assert.equal(focusedNoteId(layout), 'n2')
  assert.equal(layout.root?.type, 'split')
  if (layout.root?.type === 'split') assert.equal(layout.root.dir, 'row')

  layout = splitPane(layout, panes(layout)[0].id, 'left', 'n3')
  assert.deepEqual(noteIds(layout), [['n3'], ['n1'], ['n2']])
})

test('splitPane stacks panes on the top or bottom', () => {
  let layout = layoutWithNote('n1')
  const origin = panes(layout)[0].id
  layout = splitPane(layout, origin, 'bottom', 'n2')
  assert.deepEqual(noteIds(layout), [['n1'], ['n2']])
  assert.equal(layout.root?.type, 'split')
  if (layout.root?.type === 'split') assert.equal(layout.root.dir, 'col')

  layout = splitPane(layout, origin, 'top', 'n3')
  assert.deepEqual(noteIds(layout), [['n3'], ['n1'], ['n2']])
})

test('orthogonal split nests a row inside a column', () => {
  let layout = layoutWithNote('n1')
  const a = panes(layout)[0].id
  layout = splitPane(layout, a, 'bottom', 'n2')
  layout = splitPane(layout, a, 'right', 'n3')
  assert.equal(layout.root?.type, 'split')
  if (layout.root?.type !== 'split') throw new Error('expected split')
  assert.equal(layout.root.dir, 'col')
  const top = layout.root.children[0]
  assert.equal(top.type, 'split')
  if (top.type !== 'split') throw new Error('expected nested row')
  assert.equal(top.dir, 'row')
  assert.deepEqual(noteIds(layout), [['n1'], ['n3'], ['n2']])
})

test('splitting the only tab onto its own edge is a no-op', () => {
  const layout = layoutWithNote('n1')
  const next = splitPane(layout, panes(layout)[0].id, 'right', 'n1')
  assert.equal(panes(next).length, 1)
  assert.deepEqual(panes(next)[0].tabs, ['n1'])
})

test('dragging the only tab onto another pane edge reorders panes', () => {
  let layout = layoutWithNote('n1')
  layout = splitPane(layout, panes(layout)[0].id, 'right', 'n2')
  const right = panes(layout)[1].id
  layout = splitPane(layout, right, 'right', 'n1')
  assert.deepEqual(noteIds(layout), [['n2'], ['n1']])
})

test('splitPane becomes a tab when the pane cap is reached', () => {
  let layout = layoutWithNote('a')
  for (let i = 1; i < MAX_EDITOR_PANES; i++) {
    layout = splitPane(layout, panes(layout)[panes(layout).length - 1].id, 'right', `n${i}`)
  }
  assert.equal(panes(layout).length, MAX_EDITOR_PANES)
  const last = panes(layout)[panes(layout).length - 1]
  layout = splitPane(layout, last.id, 'bottom', 'extra')
  assert.equal(panes(layout).length, MAX_EDITOR_PANES)
  assert.ok(allPanes(layout).some((pane) => pane.tabs.includes('extra')))
  assert.ok(findPaneForNote(layout, 'extra'))
})

test('closeTab activates a neighbor and drops empty panes', () => {
  let layout = layoutWithNote('n1')
  const paneId = panes(layout)[0].id
  layout = openInPane(layout, paneId, 'n2')
  layout = openInPane(layout, paneId, 'n3')
  layout = closeTab(layout, paneId, 'n3')
  assert.deepEqual(panes(layout)[0].tabs, ['n1', 'n2'])
  assert.equal(panes(layout)[0].activeTabId, 'n2')

  layout = splitPane(layout, paneId, 'bottom', 'n4')
  const bottom = panes(layout)[1].id
  layout = closeTab(layout, bottom, 'n4')
  assert.equal(panes(layout).length, 1)
  assert.deepEqual(panes(layout)[0].tabs, ['n1', 'n2'])
})

test('normalizeLayout drops missing notes and duplicate tabs', () => {
  const layout = layoutWithNote('keep')
  const dirty = {
    panes: [
      { ...panes(layout)[0], tabs: ['keep', 'gone', 'keep'], activeTabId: 'gone' },
      { id: 'empty', tabs: ['gone'], activeTabId: 'gone', size: 1 },
    ],
    focusedPaneId: 'empty',
  }
  const next = normalizeLayout(dirty, new Set(['keep']))
  assert.equal(panes(next).length, 1)
  assert.deepEqual(panes(next)[0].tabs, ['keep'])
  assert.equal(panes(next)[0].activeTabId, 'keep')
  assert.equal(next.focusedPaneId, panes(next)[0].id)
})

test('focusNote selects the pane that already has the note', () => {
  let layout = layoutWithNote('n1')
  layout = splitPane(layout, panes(layout)[0].id, 'right', 'n2')
  layout = focusNote(layout, 'n1')
  assert.equal(layout.focusedPaneId, panes(layout)[0].id)
  assert.equal(panes(layout)[0].activeTabId, 'n1')
})

test('applyWorkspaceDrop empty / tab / split', () => {
  const empty = applyWorkspaceDrop(emptyLayout(), 'n1', { type: 'empty' })
  assert.deepEqual(panes(empty)[0].tabs, ['n1'])

  let layout = layoutWithNote('n1')
  layout = applyWorkspaceDrop(layout, 'n2', { type: 'tab', paneId: panes(layout)[0].id, index: 0 })
  assert.deepEqual(panes(layout)[0].tabs, ['n2', 'n1'])

  layout = applyWorkspaceDrop(layout, 'n3', { type: 'split', paneId: panes(layout)[0].id, side: 'bottom' })
  assert.deepEqual(noteIds(layout), [['n2', 'n1'], ['n3']])
})

test('tabInsertIndex skips the dragged tab', () => {
  const tabs = [
    { id: 'a', left: 0, width: 80 },
    { id: 'b', left: 80, width: 80 },
    { id: 'c', left: 160, width: 80 },
  ]
  assert.equal(tabInsertIndex(tabs, 10), 0)
  assert.equal(tabInsertIndex(tabs, 200), 3)
  assert.equal(tabInsertIndex(tabs, 200, 'b'), 2)
  assert.equal(tabInsertIndex(tabs, 90, 'b'), 1)
})

test('hitTestSplitSide uses edge bands on all four sides', () => {
  assert.equal(hitTestSplitSide(20, 200, box, true), 'left')
  assert.equal(hitTestSplitSide(380, 200, box, true), 'right')
  assert.equal(hitTestSplitSide(200, 20, box, true), 'top')
  assert.equal(hitTestSplitSide(200, 380, box, true), 'bottom')
  assert.equal(hitTestSplitSide(200, 200, box, true), 'center')
  assert.equal(hitTestSplitSide(20, 200, box, false), 'center')
})

test('panesAfterExtract accounts for a pane that will disappear', () => {
  let layout = layoutWithNote('n1')
  layout = splitPane(layout, panes(layout)[0].id, 'right', 'n2')
  assert.equal(panesAfterExtract(layout, 'n2', panes(layout)[1].id), 1)
  assert.equal(panesAfterExtract(layout, 'n3'), 2)
})
