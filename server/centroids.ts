import { db, bufferToFloat32, float32ToBuffer } from './db.js'

function normalize(v: Float32Array): Float32Array {
  let n = 0
  for (let i = 0; i < v.length; i += 1) n += v[i] * v[i]
  n = Math.sqrt(n) || 1
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i += 1) out[i] = v[i] / n
  return out
}

export function saveEntityCentroid(noteId: string, vec: Float32Array): void {
  db.prepare(
    `INSERT INTO entity_centroids (note_id, embedding, dim, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(note_id) DO UPDATE SET
       embedding = excluded.embedding,
       dim = excluded.dim,
       updated_at = excluded.updated_at`,
  ).run(noteId, float32ToBuffer(vec), vec.length, new Date().toISOString())
}

export function loadEntityCentroid(noteId: string): Float32Array | null {
  const row = db
    .prepare(`SELECT embedding FROM entity_centroids WHERE note_id = ?`)
    .get(noteId) as { embedding: Buffer } | undefined
  return row ? bufferToFloat32(row.embedding) : null
}

export function loadCentroids(noteIds: string[]): Float32Array[] {
  const out: Float32Array[] = []
  for (const id of noteIds) {
    const v = loadEntityCentroid(id)
    if (v) out.push(v)
  }
  return out
}

/** Mix passage embedding with linked entity centroids (α passage + β links). */
export function composeWithLinks(
  passageVec: Float32Array,
  linkNoteIds: string[],
  alpha = 0.72,
  beta = 0.28,
): Float32Array {
  const links = loadCentroids(linkNoteIds)
  if (!links.length) return passageVec
  const mean = new Float32Array(passageVec.length)
  for (const v of links) {
    const n = Math.min(v.length, mean.length)
    for (let i = 0; i < n; i += 1) mean[i] += v[i]
  }
  for (let i = 0; i < mean.length; i += 1) mean[i] /= links.length
  const mixed = new Float32Array(passageVec.length)
  for (let i = 0; i < mixed.length; i += 1) {
    mixed[i] = alpha * passageVec[i] + beta * (mean[i] || 0)
  }
  return normalize(mixed)
}

export function linkedNoteIdsFromMeta(meta: Record<string, unknown>, titleToId: Map<string, string>): string[] {
  const ids = new Set<string>()
  const wiki = Array.isArray(meta.wikiLinks) ? (meta.wikiLinks as string[]) : []
  const tagged = Array.isArray(meta.taggedLinks)
    ? (meta.taggedLinks as Array<{ title?: string }>)
    : []
  for (const t of wiki) {
    const id = titleToId.get(t.toLowerCase())
    if (id) ids.add(id)
  }
  for (const t of tagged) {
    const title = String(t.title || '')
    const id = titleToId.get(title.toLowerCase())
    if (id) ids.add(id)
  }
  return [...ids]
}
