import { db, isVecReady, EMBED_DIMS, bufferToFloat32, float32ToBuffer } from './db.js'

function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  for (let i = 0; i < n; i += 1) dot += a[i] * b[i]
  return dot
}

export type DenseHit = {
  componentId: string
  distance: number
  score: number
}

function upsertRowId(chunkId: string): bigint {
  db.prepare(`INSERT OR IGNORE INTO vec_row_map (chunk_id) VALUES (?)`).run(chunkId)
  const row = db.prepare(`SELECT rowid FROM vec_row_map WHERE chunk_id = ?`).get(chunkId) as
    | { rowid: number | bigint }
    | undefined
  if (!row) throw new Error(`vec_row_map missing ${chunkId}`)
  return BigInt(row.rowid)
}

export function upsertChunkVector(chunkId: string, vector: Float32Array): void {
  if (!isVecReady() || vector.length !== EMBED_DIMS) return
  const rowid = upsertRowId(chunkId)
  db.prepare(`DELETE FROM vec_chunks WHERE rowid = ?`).run(rowid)
  db.prepare(`INSERT INTO vec_chunks(rowid, embedding) VALUES (?, ?)`).run(rowid, vector)
}

export function deleteChunkVector(chunkId: string): void {
  if (!isVecReady()) return
  const row = db.prepare(`SELECT rowid FROM vec_row_map WHERE chunk_id = ?`).get(chunkId) as
    | { rowid: number | bigint }
    | undefined
  if (!row) return
  const rowid = BigInt(row.rowid)
  try {
    db.prepare(`DELETE FROM vec_chunks WHERE rowid = ?`).run(rowid)
  } catch {
    /* ignore */
  }
  db.prepare(`DELETE FROM vec_row_map WHERE chunk_id = ?`).run(chunkId)
}

export function deleteNoteVectors(noteId: string): void {
  const ids = db.prepare(`SELECT id FROM components WHERE note_id = ?`).all(noteId) as Array<{ id: string }>
  for (const row of ids) deleteChunkVector(row.id)
}

function bruteForceDense(
  queryVec: Float32Array,
  options: { limit: number; noteIds?: string[]; categoryId?: string | null },
): DenseHit[] {
  let sql = `SELECT c.id, c.embedding
             FROM components c
             JOIN notes n ON n.id = c.note_id
             WHERE c.embedding IS NOT NULL AND c.type != 'divider'`
  const params: string[] = []
  if (options.categoryId) {
    sql += ` AND n.category_id = ?`
    params.push(options.categoryId)
  }
  if (options.noteIds?.length) {
    sql += ` AND c.note_id IN (${options.noteIds.map(() => '?').join(',')})`
    params.push(...options.noteIds)
  }
  const rows = db.prepare(sql).all(...params) as Array<{ id: string; embedding: Buffer }>
  const scored: DenseHit[] = []
  for (const row of rows) {
    const vec = bufferToFloat32(row.embedding)
    if (!vec) continue
    const score = cosine(queryVec, vec)
    scored.push({ componentId: row.id, score, distance: 1 - score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, options.limit)
}

/** KNN over sqlite-vec; falls back to a cosine scan of stored BLOBs. */
export function searchDense(
  queryVec: Float32Array,
  options: { limit?: number; noteIds?: string[]; categoryId?: string | null } = {},
): DenseHit[] {
  const limit = options.limit ?? 32
  if (!isVecReady()) return bruteForceDense(queryVec, { ...options, limit })

  try {
    const buf = float32ToBuffer(queryVec)
    const knn = db
      .prepare(
        `SELECT rowid, distance FROM vec_chunks
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`,
      )
      .all(buf, limit * 2) as Array<{ rowid: number | bigint; distance: number }>

    const allow = options.noteIds?.length ? new Set(options.noteIds) : null
    const hits: DenseHit[] = []
    for (const row of knn) {
      const mapped = db
        .prepare(
          `SELECT m.chunk_id as id, c.note_id as noteId, n.category_id as categoryId
           FROM vec_row_map m
           JOIN components c ON c.id = m.chunk_id
           JOIN notes n ON n.id = c.note_id
           WHERE m.rowid = ?`,
        )
        .get(BigInt(row.rowid)) as
        | { id: string; noteId: string; categoryId: string | null }
        | undefined
      if (!mapped) continue
      if (allow && !allow.has(mapped.noteId)) continue
      if (options.categoryId && mapped.categoryId !== options.categoryId) continue
      hits.push({
        componentId: mapped.id,
        distance: row.distance,
        score: 1 / (1 + Math.max(0, row.distance)),
      })
      if (hits.length >= limit) break
    }
    return hits
  } catch {
    return bruteForceDense(queryVec, { ...options, limit })
  }
}
