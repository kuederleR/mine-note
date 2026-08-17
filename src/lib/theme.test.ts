import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseThemeMode, resolvedTheme } from './theme.ts'

test('parseThemeMode accepts system, light, and dark', () => {
  assert.equal(parseThemeMode('system'), 'system')
  assert.equal(parseThemeMode('light'), 'light')
  assert.equal(parseThemeMode('dark'), 'dark')
  assert.equal(parseThemeMode('nope'), 'system')
  assert.equal(parseThemeMode(undefined), 'system')
})

test('resolvedTheme follows the explicit choice or the system preference', () => {
  assert.equal(resolvedTheme('light', true), 'light')
  assert.equal(resolvedTheme('dark', false), 'dark')
  assert.equal(resolvedTheme('system', true), 'dark')
  assert.equal(resolvedTheme('system', false), 'light')
})
