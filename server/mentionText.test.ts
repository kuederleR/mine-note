import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  alreadyLinked,
  entityLinkedInText,
  extractLinkTitles,
  findUnlinkedSurfaces,
  surfaceIsAlreadyLinked,
} from './mentionText.js'

test('alreadyLinked recognizes wiki and tagged Mine links', () => {
  assert.equal(alreadyLinked('See [[Stacie]] tomorrow', 'Stacie'), true)
  assert.equal(alreadyLinked('See :@[Stacie] tomorrow', 'Stacie'), true)
  assert.equal(alreadyLinked('See :people[Stacie] tomorrow', 'Stacie'), true)
  assert.equal(alreadyLinked('See [[Stacie Chen|Stacie]] tomorrow', 'Stacie Chen'), true)
  assert.equal(alreadyLinked('Stacie called', 'Stacie'), false)
})

test('surfaceIsAlreadyLinked ignores names inside an applied link', () => {
  const tagged = 'Call :@[Stacie] later'
  assert.equal(surfaceIsAlreadyLinked(tagged, tagged.indexOf('Stacie'), 'Stacie'.length), true)

  const wiki = 'Call [[Stacie]] later'
  assert.equal(surfaceIsAlreadyLinked(wiki, wiki.indexOf('Stacie'), 'Stacie'.length), true)

  const plain = 'Call Stacie later'
  assert.equal(surfaceIsAlreadyLinked(plain, plain.indexOf('Stacie'), 'Stacie'.length), false)
})

test('entityLinkedInText treats first-name aliases as already linked', () => {
  const note = 'Met with :@[Stacie Chen] about the launch.'
  assert.deepEqual(extractLinkTitles(note), ['Stacie Chen'])
  assert.equal(entityLinkedInText(note, ['Stacie Chen', 'Stacie']), true)
  assert.equal(entityLinkedInText(note, ['Eric']), false)
  assert.equal(findUnlinkedSurfaces(note, 'Stacie').length, 0)
  assert.equal(findUnlinkedSurfaces(note, 'Stacie Chen').length, 0)
})

test('findUnlinkedSurfaces still finds a leftover plain mention', () => {
  const note = 'Saw :@[Stacie] yesterday. Also, Eric called.'
  assert.equal(findUnlinkedSurfaces(note, 'Stacie').length, 0)
  assert.equal(findUnlinkedSurfaces(note, 'Eric').length, 1)
})
