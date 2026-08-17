import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dueWindowFromQuery, reminderInDueWindow, weekendBounds } from './reminders.js'
import { componentSearchText, parseNoteToComponents } from './parser.js'

test('dueWindowFromQuery recognizes what is due today', () => {
  assert.equal(dueWindowFromQuery("what's due today"), 'today')
  assert.equal(dueWindowFromQuery('what is due today?'), 'today')
  assert.equal(dueWindowFromQuery('due today'), 'today')
  assert.equal(dueWindowFromQuery('reminders for tomorrow'), 'tomorrow')
  assert.equal(dueWindowFromQuery("what's due this week"), 'week')
  assert.equal(dueWindowFromQuery('anything overdue'), 'overdue')
  assert.equal(dueWindowFromQuery('who is Ada?'), null)
  assert.equal(dueWindowFromQuery('late due to rain'), null)
})

test('dueWindowFromQuery recognizes natural task phrasing', () => {
  assert.equal(dueWindowFromQuery('what do I have to do tonight'), 'today')
  assert.equal(dueWindowFromQuery('what do I have to do today?'), 'today')
  assert.equal(dueWindowFromQuery('anything to do tomorrow'), 'tomorrow')
  assert.equal(dueWindowFromQuery('tasks for this week'), 'week')
  assert.equal(dueWindowFromQuery('what do I have to do'), null)
  assert.equal(dueWindowFromQuery('what I need to do this weekend'), 'weekend')
  assert.equal(dueWindowFromQuery('what do I need to do this weekend?'), 'weekend')
  assert.equal(dueWindowFromQuery('reminders for sunday'), 'weekend')
})

test('reminderInDueWindow uses the civil date', () => {
  const dates = {
    today: '2026-08-14',
    tomorrow: '2026-08-15',
    weekStart: '2026-08-10',
    weekEnd: '2026-08-16',
    weekendStart: '2026-08-15',
    weekendEnd: '2026-08-16',
  }
  assert.equal(reminderInDueWindow('2026-08-14', 'today', dates), true)
  assert.equal(reminderInDueWindow('2026-08-14T09:00', 'today', dates), true)
  assert.equal(reminderInDueWindow('2026-08-15', 'today', dates), false)
  assert.equal(reminderInDueWindow('2026-08-13', 'overdue', dates), true)
  assert.equal(reminderInDueWindow('2026-08-14', 'overdue', dates), false)
  assert.equal(reminderInDueWindow(null, 'today', dates), false)
  assert.equal(reminderInDueWindow('2026-08-16', 'weekend', dates), true)
  assert.equal(reminderInDueWindow('2026-08-14', 'weekend', dates), false)
})

test('weekendBounds finds the upcoming Saturday–Sunday', () => {
  // Friday Aug 14, 2026 → Sat 15 / Sun 16
  assert.deepEqual(weekendBounds('2026-08-14'), {
    weekendStart: '2026-08-15',
    weekendEnd: '2026-08-16',
  })
  // Sunday Aug 16, 2026 → that weekend Sat 15 / Sun 16
  assert.deepEqual(weekendBounds('2026-08-16'), {
    weekendStart: '2026-08-15',
    weekendEnd: '2026-08-16',
  })
})

test('parseNoteToComponents indexes reminder due dates', () => {
  const md = `<!-- mine:reminder:rm_abc due=2026-08-14 status=todo pos=0 -->
Call dentist
<!-- /mine:reminder -->`
  const parsed = parseNoteToComponents('n1', md)
  const reminder = parsed.find((c) => c.type === 'reminder')
  assert.ok(reminder)
  assert.equal(reminder?.content, 'Call dentist')
  assert.equal(reminder?.meta.due, '2026-08-14')
  assert.equal(componentSearchText(reminder!), 'Reminder | due=2026-08-14 | status=todo | Call dentist')
})
