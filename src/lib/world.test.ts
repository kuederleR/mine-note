import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  collectWorldSnapshot,
  filterChatSlashCommands,
  findChatSlashTrigger,
  insertChatSlashCommand,
  looksTemporal,
  parseWorldCommand,
  shouldIncludeWorld,
} from './world.js'

test('findChatSlashTrigger opens on / at start or after space, not in URLs', () => {
  assert.deepEqual(findChatSlashTrigger('/', 1), { from: 0, to: 1, query: '' })
  assert.deepEqual(findChatSlashTrigger('/wor', 4), { from: 0, to: 4, query: 'wor' })
  assert.deepEqual(findChatSlashTrigger('ask /wo', 7), { from: 4, to: 7, query: 'wo' })
  assert.equal(findChatSlashTrigger('https://example.com', 12), null)
  assert.equal(findChatSlashTrigger('foo/bar', 4), null)
})

test('parseWorldCommand strips /world tokens', () => {
  assert.deepEqual(parseWorldCommand('/world'), { query: '', requested: true })
  assert.deepEqual(parseWorldCommand('/world what is due today?'), {
    query: 'what is due today?',
    requested: true,
  })
  assert.deepEqual(parseWorldCommand('due today /world'), {
    query: 'due today',
    requested: true,
  })
  assert.deepEqual(parseWorldCommand('what is due today?'), {
    query: 'what is due today?',
    requested: false,
  })
})

test('temporal questions opt into world without /world', () => {
  assert.equal(looksTemporal('what is due today?'), true)
  assert.equal(looksTemporal('who is Ada?'), false)
  assert.equal(shouldIncludeWorld('/world'), true)
  assert.equal(shouldIncludeWorld('reminders this week'), true)
  assert.equal(shouldIncludeWorld('phone number for Sam'), false)
})

test('insertChatSlashCommand replaces the trigger with /world', () => {
  const next = insertChatSlashCommand('/w', { from: 0, to: 2, query: 'w' }, '/world')
  assert.equal(next, '/world ')
})

test('collectWorldSnapshot has a civil date and timezone', () => {
  const world = collectWorldSnapshot(new Date('2026-08-14T17:08:00.000Z'))
  assert.match(world.date, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(world.today, world.date)
  assert.ok(world.timeZone)
  assert.match(world.utcOffset, /^UTC[+-]\d{2}:\d{2}$/)
})

test('filterChatSlashCommands matches world', () => {
  assert.ok(filterChatSlashCommands('wo').some((cmd) => cmd.id === 'world'))
  assert.equal(filterChatSlashCommands('zzzz').length, 0)
})
