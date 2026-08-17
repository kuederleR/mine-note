import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSettings } from './workspaceSettings.js'

test('objectPasteMode defaults to link and round-trips', () => {
  const fresh = parseSettings(null)
  assert.equal(fresh.objectPasteMode, 'link')
  const parsed = parseSettings(JSON.stringify({ objectPasteMode: 'embed' }))
  assert.equal(parsed.objectPasteMode, 'embed')
  const invalid = parseSettings(JSON.stringify({ objectPasteMode: 'nope' }))
  assert.equal(invalid.objectPasteMode, 'link')
  const omitted = parseSettings(JSON.stringify({ aiShortcut: '>' }))
  assert.equal(omitted.objectPasteMode, 'link')
})

test('theme defaults to system and round-trips', () => {
  const fresh = parseSettings(null)
  assert.equal(fresh.theme, 'system')
  const parsed = parseSettings(JSON.stringify({ theme: 'dark' }))
  assert.equal(parsed.theme, 'dark')
  const invalid = parseSettings(JSON.stringify({ theme: 'sepia' }))
  assert.equal(invalid.theme, 'system')
  const omitted = parseSettings(JSON.stringify({ aiShortcut: '>' }))
  assert.equal(omitted.theme, 'system')
})
