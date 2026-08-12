import { pipeline, env } from '@xenova/transformers'

env.allowLocalModels = false
env.useBrowserCache = false

type Embedder = (text: string, options?: Record<string, unknown>) => Promise<{
  data: Float32Array | number[]
}>

let embedderPromise: Promise<Embedder> | null = null
let ready = false
let error: string | null = null

export function getEmbeddingStatus() {
  return { ready, error, model: 'Xenova/all-MiniLM-L6-v2' }
}

async function loadEmbedder(): Promise<Embedder> {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      try {
        const pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
        ready = true
        error = null
        return pipe as unknown as Embedder
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
        ready = false
        throw e
      }
    })()
  }
  return embedderPromise
}

/** Warm the model in the background so the first save is faster. */
export function warmEmbeddings() {
  loadEmbedder().catch(() => {
    /* status captured in getEmbeddingStatus */
  })
}

function meanPool(data: Float32Array | number[], dims: number): Float32Array {
  const arr = data instanceof Float32Array ? data : Float32Array.from(data)
  // transformers.js returns [1, tokens, dims] flattened or already pooled depending on options
  if (arr.length === dims) {
    return normalize(arr)
  }
  const tokens = Math.floor(arr.length / dims)
  const out = new Float32Array(dims)
  for (let t = 0; t < tokens; t += 1) {
    for (let d = 0; d < dims; d += 1) {
      out[d] += arr[t * dims + d]
    }
  }
  for (let d = 0; d < dims; d += 1) out[d] /= tokens
  return normalize(out)
}

function normalize(v: Float32Array): Float32Array {
  let norm = 0
  for (let i = 0; i < v.length; i += 1) norm += v[i] * v[i]
  norm = Math.sqrt(norm) || 1
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i += 1) out[i] = v[i] / norm
  return out
}

/**
 * Local sentence embedding. Falls back to a deterministic hashed bag-of-words
 * vector if the transformer model cannot load (still fully local).
 */
export async function embedText(text: string): Promise<Float32Array> {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (!cleaned) return new Float32Array(384)

  try {
    const pipe = await loadEmbedder()
    const output = await pipe(cleaned, { pooling: 'mean', normalize: true })
    const data = output.data
    if (data instanceof Float32Array) {
      return data.length === 384 ? normalize(data) : meanPool(data, 384)
    }
    return meanPool(Float32Array.from(data), 384)
  } catch {
    return hashedEmbedding(cleaned, 384)
  }
}

/** Lightweight local fallback embedding (no network, no model download). */
export function hashedEmbedding(text: string, dims = 384): Float32Array {
  const vec = new Float32Array(dims)
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)

  for (const token of tokens) {
    let h1 = 2166136261
    let h2 = 16777619
    for (let i = 0; i < token.length; i += 1) {
      h1 ^= token.charCodeAt(i)
      h1 = Math.imul(h1, 16777619)
      h2 ^= token.charCodeAt(i)
      h2 = Math.imul(h2, 2166136261)
    }
    const i1 = Math.abs(h1) % dims
    const i2 = Math.abs(h2) % dims
    vec[i1] += 1
    vec[i2] -= 0.5
  }
  return normalize(vec)
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  for (let i = 0; i < n; i += 1) dot += a[i] * b[i]
  return dot
}
