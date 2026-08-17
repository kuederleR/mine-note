import { cosineSimilarity, embedText } from './embeddings.js'
import type { DueWindow } from './reminders.js'

/**
 * Embedding-based routing for due/reminder questions.
 * Extends by adding example utterances — no per-phrase regex required.
 */

const DUE_EXAMPLES = [
  "what's due today",
  'what is due tonight',
  'anything due tomorrow',
  'what do I have to do tonight',
  'what do I have to do today',
  'what I need to do this weekend',
  'what do I need to do this weekend',
  'anything to do this weekend',
  'reminders for sunday',
  'tasks for this week',
  "what's on my plate today",
  'what should I do tonight',
  'any reminders due',
  "what's overdue",
  'overdue tasks',
  'things I need to finish this weekend',
  'plans for saturday',
  'what am I supposed to do tomorrow',
  'show my todos for today',
  'what work is due this week',
]

const OTHER_EXAMPLES = [
  'who is Ada',
  'what is this note about',
  'what did we discuss in the meeting',
  'notes about copper mining',
  'when was the last meeting with Sam',
  'who else was there',
  'what is their phone number',
  'summarize the research inbox',
  'how does product vision connect to research',
  'find notes mentioning gardens',
]

const WINDOW_EXAMPLES: Record<Exclude<DueWindow, 'overdue'> | 'overdue', string[]> = {
  today: [
    'due today',
    'tonight',
    'this evening',
    'what do I have to do today',
    "what's on my plate tonight",
    'reminders for today',
    'before the day ends',
    'wrap up today',
    'later today',
  ],
  tomorrow: [
    'due tomorrow',
    'what do I have to do tomorrow',
    'reminders for tomorrow',
    'tasks tomorrow',
  ],
  weekend: [
    'this weekend',
    'saturday',
    'sunday',
    'what I need to do this weekend',
    'plans for the weekend',
    'reminders for sunday',
  ],
  week: [
    'this week',
    'tasks for this week',
    "what's due this week",
    'reminders this week',
  ],
  overdue: ['overdue', 'past due', 'late reminders', 'what did I miss'],
}

let dueCentroid: Float32Array | null = null
let otherCentroid: Float32Array | null = null
let windowCentroids: Record<DueWindow, Float32Array> | null = null

function mean(vecs: Float32Array[]): Float32Array {
  const out = new Float32Array(vecs[0].length)
  for (const v of vecs) {
    for (let i = 0; i < v.length; i += 1) out[i] += v[i]
  }
  let n = 0
  for (let i = 0; i < out.length; i += 1) n += out[i] * out[i]
  n = Math.sqrt(n) || 1
  for (let i = 0; i < out.length; i += 1) out[i] /= n
  return out
}

async function ensureCentroids() {
  if (dueCentroid && otherCentroid && windowCentroids) return
  const [dueVecs, otherVecs] = await Promise.all([
    Promise.all(DUE_EXAMPLES.map((s) => embedText(s))),
    Promise.all(OTHER_EXAMPLES.map((s) => embedText(s))),
  ])
  dueCentroid = mean(dueVecs)
  otherCentroid = mean(otherVecs)

  const windows = {} as Record<DueWindow, Float32Array>
  for (const key of Object.keys(WINDOW_EXAMPLES) as DueWindow[]) {
    windows[key] = mean(await Promise.all(WINDOW_EXAMPLES[key].map((s) => embedText(s))))
  }
  windowCentroids = windows
}

export type DueIntentResult = {
  isDueQuestion: boolean
  window: DueWindow
  dueScore: number
  otherScore: number
}

const DUE_MIN = 0.34
const DUE_MARGIN = 0.03

function windowFromLexicalHints(query: string): DueWindow | null {
  const q = query.toLowerCase()
  if (/\boverdue\b|\bpast due\b/.test(q)) return 'overdue'
  if (/\btomorrow\b/.test(q)) return 'tomorrow'
  if (/\bthis weekend\b|\bweekends?\b|\bsaturday\b|\bsunday\b/.test(q)) return 'weekend'
  if (/\bthis week\b/.test(q)) return 'week'
  if (/\btoday\b|\btonight\b|\bthis evening\b|\blater today\b/.test(q)) return 'today'
  return null
}

/** Classify whether a question is about due work/reminders, and which time window. */
export async function classifyDueIntent(query: string): Promise<DueIntentResult> {
  const q = query.trim()
  if (!q) {
    return { isDueQuestion: false, window: 'today', dueScore: -1, otherScore: -1 }
  }
  await ensureCentroids()
  const qVec = await embedText(q)
  const dueScore = cosineSimilarity(qVec, dueCentroid!)
  const otherScore = cosineSimilarity(qVec, otherCentroid!)
  const isDueQuestion = dueScore >= DUE_MIN && dueScore >= otherScore + DUE_MARGIN

  const hinted = windowFromLexicalHints(q)
  let window: DueWindow = hinted || 'today'
  if (!hinted) {
    let best = -1
    for (const [key, centroid] of Object.entries(windowCentroids!) as Array<[DueWindow, Float32Array]>) {
      const score = cosineSimilarity(qVec, centroid)
      if (score > best) {
        best = score
        window = key
      }
    }
    if (best < 0.28) window = 'today'
  }

  return { isDueQuestion, window, dueScore, otherScore }
}
