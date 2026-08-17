import { cosineSimilarity, embedText } from './embeddings.js'
import type { SynthesizedAnswer } from './answer.js'

export const SUBJECT_TITLE_MIN = 0.42
export const IDENTITY_FIT_MIN = 0.66
export const ANSWER_WRAP_MIN = 0.4

export function unknownAnswer(relatedTitle?: string): SynthesizedAnswer {
  return {
    text: relatedTitle
      ? `I don’t see that in your notes about ${relatedTitle}.`
      : 'I don’t see that in your notes.',
    bullets: [],
    sources: [],
    alternatives: [],
  }
}

export async function identityFit(queryVec: Float32Array, title: string): Promise<number> {
  const prototypes = [`who is ${title}`, `tell me about ${title}`, `what is ${title}`]
  const vecs = await Promise.all(prototypes.map((p) => embedText(p)))
  return vecs.reduce((max, vec) => Math.max(max, cosineSimilarity(queryVec, vec)), -1)
}
