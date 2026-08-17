const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '')
export const GEMMA_MODEL = process.env.GEMMA_MODEL || 'gemma4:e2b'

export type GeneratorStatus = {
  ready: boolean
  warming: boolean
  available: boolean
  pulling: boolean
  error: string | null
  model: string
}

let ready = false
let warming = false
let pulling = false
let available = false
let error: string | null = null
let warmPromise: Promise<void> | null = null

export function getGeneratorStatus(): GeneratorStatus {
  return { ready, warming, available, pulling, error, model: GEMMA_MODEL }
}

async function ollama(path: string, init?: RequestInit, timeoutMs = 30_000): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(`${OLLAMA_HOST}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    })
  } finally {
    clearTimeout(timer)
  }
}

async function listTags(): Promise<string[]> {
  const res = await ollama('/api/tags', { method: 'GET' }, 8_000)
  if (!res.ok) throw new Error(`Ollama tags failed (${res.status})`)
  const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> }
  return (body.models || []).map((m) => m.name || m.model || '').filter(Boolean)
}

function hasModel(tags: string[]): boolean {
  const want = GEMMA_MODEL.toLowerCase()
  return tags.some((t) => {
    const name = t.toLowerCase()
    return name === want || name.startsWith(`${want}:`) || name.startsWith(`${want}-`)
  })
}

async function pullModel(): Promise<void> {
  pulling = true
  const res = await ollama(
    '/api/pull',
    { method: 'POST', body: JSON.stringify({ name: GEMMA_MODEL, stream: false }) },
    20 * 60_000,
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text.slice(0, 240) || `Ollama pull failed (${res.status})`)
  }
}

export function warmGenerator() {
  if (warmPromise) return warmPromise
  warmPromise = (async () => {
    warming = true
    ready = false
    error = null
    try {
      const tags = await listTags()
      available = true
      if (!hasModel(tags)) {
        console.log(`Generator: pulling ${GEMMA_MODEL}`)
        await pullModel()
      }
      pulling = false
      // Load weights into memory so the first real request is not cold.
      console.log(`Generator: loading ${GEMMA_MODEL}`)
      const warm = await ollama(
        '/api/chat',
        {
          method: 'POST',
          body: JSON.stringify({
            model: GEMMA_MODEL,
            stream: false,
            keep_alive: '60m',
            options: { num_predict: 1, temperature: 0 },
            messages: [{ role: 'user', content: 'ok' }],
          }),
        },
        180_000,
      )
      if (!warm.ok) {
        const text = await warm.text()
        throw new Error(text.slice(0, 240) || `Ollama warm failed (${warm.status})`)
      }
      ready = true
      error = null
      console.log(`Generator: ready ${GEMMA_MODEL}`)
    } catch (e) {
      available = false
      ready = false
      pulling = false
      error =
        e instanceof Error && e.name === 'AbortError'
          ? `Could not reach Ollama at ${OLLAMA_HOST}`
          : e instanceof Error
            ? e.message
            : String(e)
      warmPromise = null
      console.log(`Generator: ${error}`)
    } finally {
      warming = false
    }
  })()
  return warmPromise
}

function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('Gemma did not return JSON')
  return JSON.parse(text.slice(start, end + 1))
}

export async function generateText(
  prompt: string,
  options: {
    system?: string
    json?: boolean
    timeoutMs?: number
    /** Cap generation length (Ollama num_predict). */
    numPredict?: number
    numCtx?: number
    temperature?: number
  } = {},
): Promise<string> {
  if (!ready) await warmGenerator()
  if (!ready) {
    throw new Error(
      error ||
        `Gemma 4 E2B is not available. Install Ollama and pull ${GEMMA_MODEL}, or start Ollama on ${OLLAMA_HOST}.`,
    )
  }

  const res = await ollama(
    '/api/chat',
    {
      method: 'POST',
      body: JSON.stringify({
        model: GEMMA_MODEL,
        stream: false,
        format: options.json ? 'json' : undefined,
        keep_alive: '60m',
        options: {
          temperature: options.temperature ?? 0.2,
          ...(options.numPredict != null ? { num_predict: options.numPredict } : {}),
          ...(options.numCtx != null ? { num_ctx: options.numCtx } : {}),
        },
        messages: [
          ...(options.system ? [{ role: 'system', content: options.system }] : []),
          { role: 'user', content: prompt },
        ],
      }),
    },
    options.timeoutMs ?? 90_000,
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text.slice(0, 240) || `Ollama generate failed (${res.status})`)
  }
  const body = (await res.json()) as { message?: { content?: string }; response?: string }
  const content = body.message?.content || body.response || ''
  if (!content.trim()) throw new Error('Gemma returned an empty response')
  return content
}

export async function generateJson<T>(
  prompt: string,
  options: {
    system?: string
    timeoutMs?: number
    numPredict?: number
    numCtx?: number
    temperature?: number
  } = {},
): Promise<T> {
  const text = await generateText(prompt, { ...options, json: true })
  return extractJson(text) as T
}

export async function streamChat(
  prompt: string,
  options: {
    system?: string
    json?: boolean
    timeoutMs?: number
    numPredict?: number
    numCtx?: number
    temperature?: number
    onStart?: () => void
    onContent?: (full: string) => void
  } = {},
): Promise<string> {
  // Fire before warm/fetch so the UI can show activity during cold load + prompt eval.
  options.onStart?.()
  if (!ready) await warmGenerator()
  if (!ready) {
    throw new Error(
      error ||
        `Gemma 4 E2B is not available. Install Ollama and pull ${GEMMA_MODEL}, or start Ollama on ${OLLAMA_HOST}.`,
    )
  }

  const res = await ollama(
    '/api/chat',
    {
      method: 'POST',
      body: JSON.stringify({
        model: GEMMA_MODEL,
        stream: true,
        format: options.json ? 'json' : undefined,
        keep_alive: '60m',
        options: {
          temperature: options.temperature ?? 0.2,
          ...(options.numPredict != null ? { num_predict: options.numPredict } : {}),
          ...(options.numCtx != null ? { num_ctx: options.numCtx } : {}),
        },
        messages: [
          ...(options.system ? [{ role: 'system', content: options.system }] : []),
          { role: 'user', content: prompt },
        ],
      }),
    },
    options.timeoutMs ?? 90_000,
  )
  if (!res.ok || !res.body) {
    const text = await res.text()
    throw new Error(text.slice(0, 240) || `Ollama generate failed (${res.status})`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let content = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      const raw = line.trim()
      if (!raw) continue
      let chunk: {
        message?: { content?: string }
        response?: string
        done?: boolean
      }
      try {
        chunk = JSON.parse(raw) as {
          message?: { content?: string }
          response?: string
          done?: boolean
        }
      } catch {
        continue
      }
      const piece = chunk.message?.content || chunk.response || ''
      if (!piece) continue
      content += piece
      options.onContent?.(content)
    }
  }
  if (!content.trim()) throw new Error('Gemma returned an empty response')
  return content
}

export async function streamJson<T>(
  prompt: string,
  options: {
    system?: string
    timeoutMs?: number
    numPredict?: number
    numCtx?: number
    temperature?: number
    /** Ollama JSON grammar — safer parse, slower first token. Default off for streaming. */
    constrained?: boolean
    onStart?: () => void
    onContent?: (full: string) => void
  } = {},
): Promise<T> {
  const text = await streamChat(prompt, {
    ...options,
    json: options.constrained === true,
  })
  return extractJson(text) as T
}
