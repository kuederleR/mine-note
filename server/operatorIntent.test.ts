import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyDueIntent } from './operatorIntent.js'

test('classifyDueIntent routes natural due questions without exact phrases', async () => {
  const weekend = await classifyDueIntent('what stuff do I still need to knock out this weekend')
  assert.equal(weekend.isDueQuestion, true)
  assert.equal(weekend.window, 'weekend')

  const today = await classifyDueIntent('what reminders are due today')
  assert.equal(today.isDueQuestion, true)
  assert.equal(today.window, 'today')

  const identity = await classifyDueIntent('who is Ada Lovelace')
  assert.equal(identity.isDueQuestion, false)
})

test('classifyDueIntent picks overdue vs tomorrow', async () => {
  const overdue = await classifyDueIntent('what reminders are overdue')
  assert.equal(overdue.isDueQuestion, true)
  assert.equal(overdue.window, 'overdue')

  const tomorrow = await classifyDueIntent('what do I need to finish tomorrow')
  assert.equal(tomorrow.isDueQuestion, true)
  assert.equal(tomorrow.window, 'tomorrow')
})
