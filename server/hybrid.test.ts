import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  contextualizeComponents,
  formatContextPath,
  wrapForEmbedding,
} from './embedContext.js'
import { cosineSimilarity, hashEmbedInput, hashedEmbedding } from './embeddings.js'
import { parseNoteToComponents } from './parser.js'
import { reciprocalRankFusion, RRF_K } from './rrf.js'

test('formatContextPath joins title and heading hierarchy', () => {
  assert.equal(formatContextPath('Kickoff', ['Agenda', 'Parking lot']), 'Kickoff > Agenda > Parking lot')
  assert.equal(formatContextPath('Kickoff', ['Kickoff']), 'Kickoff')
})

test('wrapForEmbedding prepends hierarchy and keeps the block body', () => {
  const wrapped = wrapForEmbedding('Call Stacie at 555-0100', {
    title: 'Weekly standup',
    category: 'Meetings',
    headingPath: ['Follow-ups'],
    mentions: ['Stacie'],
  })
  assert.match(wrapped, /^\[Meetings\] Weekly standup > Follow-ups: Call Stacie at 555-0100/)
  assert.match(wrapped, /Entities: Stacie/)
})

test('chunking splits markdown blocks and attaches heading context', () => {
  const markdown = `# Agenda\n\nShip the hybrid search backend.\n\n## People\n\n- Stacie owns retrieval\n- Eric reviews the index`
  const parsed = parseNoteToComponents('note_test', markdown)
  const types = parsed.map((c) => c.type)
  assert.ok(types.includes('heading'))
  assert.ok(types.includes('paragraph') || types.includes('list'))

  const ctx = contextualizeComponents('Search notes', 'Engineering', parsed, ['Stacie', 'Eric'])
  assert.ok(ctx.length > parsed.length, 'long blocks should emit extra passage chunks')
  const peopleChunk = ctx.find((row) => row.embedInput.includes('Stacie owns retrieval'))
  assert.ok(peopleChunk)
  assert.equal(peopleChunk.contextPath, 'Search notes > Agenda > People')
  assert.match(peopleChunk.embedInput, /\[Engineering\] Search notes > Agenda > People:/)
  assert.equal(peopleChunk.comp.content.includes('[Engineering]'), false)
})

test('hashEmbedInput is stable and changes when the embed text changes', () => {
  const a = hashEmbedInput('Kickoff > Agenda: Ship it')
  const b = hashEmbedInput('Kickoff > Agenda: Ship it')
  const c = hashEmbedInput('Kickoff > Agenda: Ship it later')
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.equal(a.length, 40)
})

test('hashedEmbedding is unit-normalized and ranks related text higher', () => {
  const q = hashedEmbedding('Stacie phone number')
  const close = hashedEmbedding('[People] Stacie: phone 555-0100')
  const far = hashedEmbedding('[Recipes] Chocolate cake batter')
  assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-5)
  assert.ok(cosineSimilarity(q, close) > cosineSimilarity(q, far))
})

test('RRF fuses dense and lexical ranks', () => {
  const dense = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const lexical = [{ id: 'c' }, { id: 'a' }, { id: 'd' }]
  const fused = reciprocalRankFusion([dense, lexical])
  const ranked = [...fused.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id)
  assert.equal(ranked[0], 'a')
  assert.ok(ranked.includes('d'))
  const expectedA = 1 / (RRF_K + 1) + 1 / (RRF_K + 2)
  assert.ok(Math.abs((fused.get('a') || 0) - expectedA) < 1e-12)
})
