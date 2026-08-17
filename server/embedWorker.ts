import { parentPort } from 'node:worker_threads'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { pipeline, env } from '@xenova/transformers'

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'
const EMBED_DIMS = 384

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const cacheDir = path.join(os.homedir(), '.mine-note', 'transformers-cache')
fs.mkdirSync(cacheDir, { recursive: true })

env.allowLocalModels = false
env.allowRemoteModels = true
env.useBrowserCache = false
env.cacheDir = cacheDir
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.numThreads = 1
}

type Pipe = (text: string, options?: Record<string, unknown>) => Promise<{ data: Float32Array | number[] }>

let pipe: Pipe | null = null

function normalize(v: Float32Array): Float32Array {
  let n = 0
  for (let i = 0; i < v.length; i += 1) n += v[i] * v[i]
  n = Math.sqrt(n) || 1
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i += 1) out[i] = v[i] / n
  return out
}

function meanPool(data: Float32Array | number[], dims: number): Float32Array {
  const arr = data instanceof Float32Array ? data : Float32Array.from(data)
  if (arr.length === dims) return normalize(arr)
  const tokens = Math.floor(arr.length / dims) || 1
  const out = new Float32Array(dims)
  for (let t = 0; t < tokens; t += 1) {
    for (let d = 0; d < dims; d += 1) out[d] += arr[t * dims + d]
  }
  for (let d = 0; d < dims; d += 1) out[d] /= tokens
  return normalize(out)
}

async function getPipe(): Promise<Pipe> {
  if (pipe) return pipe
  pipe = (await pipeline('feature-extraction', MODEL_ID)) as unknown as Pipe
  return pipe
}

parentPort?.on('message', async (msg: { id: number; text: string }) => {
  try {
    const fn = await getPipe()
    const output = await fn(msg.text, { pooling: 'mean', normalize: true })
    const data = output.data
    const vec =
      data instanceof Float32Array
        ? data.length === EMBED_DIMS
          ? normalize(data)
          : meanPool(data, EMBED_DIMS)
        : meanPool(Float32Array.from(data), EMBED_DIMS)
    parentPort?.postMessage({ id: msg.id, ok: true, vector: Array.from(vec) })
  } catch (e) {
    parentPort?.postMessage({
      id: msg.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    })
  }
})
