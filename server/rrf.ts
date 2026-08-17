/** Reciprocal Rank Fusion: score = Σ 1/(k + rank). Rank is 1-based. */
export const RRF_K = 60

export function reciprocalRankFusion(
  lists: Array<Array<{ id: string }>>,
  k = RRF_K,
): Map<string, number> {
  const scores = new Map<string, number>()
  for (const list of lists) {
    list.forEach((item, index) => {
      const add = 1 / (k + index + 1)
      scores.set(item.id, (scores.get(item.id) || 0) + add)
    })
  }
  return scores
}
