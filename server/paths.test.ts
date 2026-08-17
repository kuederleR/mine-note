import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { defaultNotesDirFor, toNativeFsPath, findRepoRoot } from './paths.js'

test('default notes dir is repo data/ when unpackaged', () => {
  assert.equal(
    defaultNotesDirFor({ packaged: false, home: '/Users/me', repoRoot: findRepoRoot() }),
    path.join(findRepoRoot(), 'data'),
  )
})

test('default notes dir is ~/.mine-note/notes when packaged', () => {
  assert.equal(
    defaultNotesDirFor({ packaged: true, home: '/Users/me', repoRoot: '/app' }),
    path.join('/Users/me', '.mine-note', 'notes'),
  )
})

test('asar paths rewrite to the unpacked sibling', () => {
  const packed =
    '/Applications/Mine.app/Contents/Resources/app.asar/dist-electron/server/embedWorker.js'
  const unpacked =
    '/Applications/Mine.app/Contents/Resources/app.asar.unpacked/dist-electron/server/embedWorker.js'
  assert.equal(toNativeFsPath(packed), unpacked)
  assert.equal(toNativeFsPath(unpacked), unpacked)
})
