import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { pipeline, env } from '@huggingface/transformers'
import { toNativeFsPath } from './paths.js'

export const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'
export const EMBED_DIMS = 384
const LOAD_TIMEOUT_MS = 120_000
const EMBED_CACHE_MAX = 4096

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const legacyCache = path.join(__dirname, '..', 'data', 'transformers-cache')
const cacheDir = path.join(os.homedir(), '.mine-note', 'transformers-cache')
if (fs.existsSync(legacyCache) && !fs.existsSync(cacheDir)) {
  fs.mkdirSync(path.dirname(cacheDir), { recursive: true })
  try {
    fs.renameSync(legacyCache, cacheDir)
  } catch {
    fs.mkdirSync(cacheDir, { recursive: true })
  }
} else {
  fs.mkdirSync(cacheDir, { recursive: true })
}

env.allowLocalModels = false
env.allowRemoteModels = true
env.useBrowserCache = false
env.cacheDir = cacheDir
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.numThreads = 1
}

type Embedder = (text: string, options?: Record<string, unknown>) => Promise<{
  data: Float32Array | number[]
}>

let embedderPromise: Promise<Embedder> | null = null
let ready = false
let warming = false
let error: string | null = null
let worker: Worker | null = null
let workerFailed = false
let nextJob = 1
const pending = new Map<
  number,
  { resolve: (v: Float32Array) => void; reject: (e: Error) => void }
>()

export function getEmbeddingStatus() {
  return { ready, warming, error, model: MODEL_ID, worker: Boolean(worker) }
}

function logEmbeddingStatus() {
  console.log(`Embeddings: ${JSON.stringify(getEmbeddingStatus())}`)
}

export function hashEmbedInput(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

function meanPool(data: Float32Array | number[], dims: number): Float32Array {
  const arr = data instanceof Float32Array ? data : Float32Array.from(data)
  if (arr.length === dims) return normalize(arr)
  const tokens = Math.floor(arr.length / dims)
  const out = new Float32Array(dims)
  for (let t = 0; t < tokens; t += 1) {
    for (let d = 0; d < dims; d += 1) out[d] += arr[t * dims + d]
  }
  for (let d = 0; d < dims; d += 1) out[d] /= tokens || 1
  return normalize(out)
}

export function normalize(v: Float32Array): Float32Array {
  let norm = 0
  for (let i = 0; i < v.length; i += 1) norm += v[i] * v[i]
  norm = Math.sqrt(norm) || 1
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i += 1) out[i] = v[i] / norm
  return out
}

async function loadEmbedder(): Promise<Embedder> {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      warming = true
      ready = false
      error = null
      console.log(`Embeddings: warming ${MODEL_ID}`)
      const timeoutId = setTimeout(() => {
        if (!ready && warming) {
          error = `Timed out after ${LOAD_TIMEOUT_MS / 1000}s loading ${MODEL_ID}`
          warming = false
          logEmbeddingStatus()
        }
      }, LOAD_TIMEOUT_MS)
      try {
        const pipe = await pipeline('feature-extraction', MODEL_ID, {
          progress_callback: (x: { status?: string; file?: string }) => {
            if (x.status === 'download' || x.status === 'done') {
              console.log(`Embeddings: ${x.status}${x.file ? ` ${x.file}` : ''}`)
            }
          },
        })
        ready = true
        warming = false
        error = null
        logEmbeddingStatus()
        return pipe as unknown as Embedder
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
        ready = false
        warming = false
        embedderPromise = null
        logEmbeddingStatus()
        throw e
      } finally {
        clearTimeout(timeoutId)
      }
    })()
  }
  return embedderPromise
}

function startWorker(): Worker | null {
  if (workerFailed) return null
  if (worker) return worker
  if (process.env.NODE_TEST_CONTEXT) return null
  try {
    const ext = path.extname(fileURLToPath(import.meta.url)) || '.js'
    const workerUrl = new URL(`./embedWorker${ext}`, import.meta.url)
    const workerPath = toNativeFsPath(fileURLToPath(workerUrl))
    const execArgv = ext === '.ts' ? ['--import', 'tsx'] : []
    worker = new Worker(workerPath, { execArgv })
    worker.unref()
    worker.on('message', (msg: { id: number; ok: boolean; vector?: number[]; error?: string }) => {
      const job = pending.get(msg.id)
      if (!job) return
      pending.delete(msg.id)
      if (msg.ok && msg.vector) job.resolve(normalize(Float32Array.from(msg.vector)))
      else job.reject(new Error(msg.error || 'embed worker failed'))
    })
    worker.on('error', (err) => {
      workerFailed = true
      worker = null
      console.warn(`Embeddings: worker failed (${err.message}); using in-process pipeline`)
      for (const [, job] of pending) job.reject(err)
      pending.clear()
    })
    worker.on('exit', () => {
      worker = null
    })
    return worker
  } catch (e) {
    workerFailed = true
    console.warn(`Embeddings: could not start worker (${e instanceof Error ? e.message : String(e)})`)
    return null
  }
}

function embedViaWorker(text: string): Promise<Float32Array> | null {
  const w = startWorker()
  if (!w) return null
  const id = nextJob++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('embed worker timed out'))
    }, 60_000)
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      reject: (e) => {
        clearTimeout(timer)
        reject(e)
      },
    })
    w.postMessage({ id, text })
  })
}

/** Warm the model in the background so the first save is faster. */
export function warmEmbeddings() {
  startWorker()
  return loadEmbedder().catch(() => {
    /* status captured in getEmbeddingStatus */
  })
}

const embedCache = new Map<string, Float32Array>()

function cacheGet(key: string): Float32Array | undefined {
  const hit = embedCache.get(key)
  if (!hit) return undefined
  embedCache.delete(key)
  embedCache.set(key, hit)
  return hit
}

function cacheSet(key: string, vec: Float32Array): void {
  if (embedCache.has(key)) embedCache.delete(key)
  embedCache.set(key, vec)
  while (embedCache.size > EMBED_CACHE_MAX) {
    const oldest = embedCache.keys().next().value
    if (oldest === undefined) break
    embedCache.delete(oldest)
  }
}

async function embedInProcess(cleaned: string): Promise<Float32Array> {
  const pipe = await loadEmbedder()
  const output = await pipe(cleaned, { pooling: 'mean', normalize: true })
  const data = output.data
  if (data instanceof Float32Array) {
    return data.length === EMBED_DIMS ? normalize(data) : meanPool(data, EMBED_DIMS)
  }
  return meanPool(Float32Array.from(data), EMBED_DIMS)
}

/**
 * Local sentence embedding. Inference prefers a worker thread so the Express
 * event loop stays free; falls back to in-process ONNX, then hashed vectors.
 */
export async function embedText(text: string): Promise<Float32Array> {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (!cleaned) return new Float32Array(EMBED_DIMS)
  const cached = cacheGet(cleaned)
  if (cached) return cached

  try {
    const viaWorker = embedViaWorker(cleaned)
    const vec = viaWorker ? await viaWorker.catch(() => embedInProcess(cleaned)) : await embedInProcess(cleaned)
    ready = true
    cacheSet(cleaned, vec)
    return vec
  } catch {
    const vec = hashedEmbedding(cleaned, EMBED_DIMS)
    cacheSet(cleaned, vec)
    return vec
  }
}

/** Lightweight local fallback embedding (no network, no model download). */
export function hashedEmbedding(text: string, dims = EMBED_DIMS): Float32Array {
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
