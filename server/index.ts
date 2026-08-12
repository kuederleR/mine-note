import express from 'express'
import cors from 'cors'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  listNotes,
  getNote,
  getNoteComponents,
  createNote,
  updateNote,
  deleteNote,
  reindexAll,
} from './notes.js'
import { searchConnectionGraph } from './search.js'
import { getEmbeddingStatus, warmEmbeddings } from './embeddings.js'
import { db } from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = Number(process.env.PORT || 8787)

app.use(cors())
app.use(express.json({ limit: '2mb' }))

app.get('/api/health', (_req, res) => {
  const noteCount = (db.prepare(`SELECT COUNT(*) as c FROM notes`).get() as { c: number }).c
  const componentCount = (
    db.prepare(`SELECT COUNT(*) as c FROM components`).get() as { c: number }
  ).c
  res.json({
    ok: true,
    app: 'Mine Note',
    embeddings: getEmbeddingStatus(),
    notes: noteCount,
    components: componentCount,
  })
})

app.get('/api/notes', (_req, res) => {
  res.json(listNotes())
})

app.get('/api/notes/:id', (req, res) => {
  const note = getNote(req.params.id)
  if (!note) {
    res.status(404).json({ error: 'Note not found' })
    return
  }
  res.json(note)
})

app.get('/api/notes/:id/components', (req, res) => {
  const note = getNote(req.params.id)
  if (!note) {
    res.status(404).json({ error: 'Note not found' })
    return
  }
  res.json(getNoteComponents(req.params.id))
})

app.post('/api/notes', async (req, res) => {
  try {
    const note = await createNote({
      title: req.body?.title,
      content: req.body?.content,
    })
    res.status(201).json(note)
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Create failed' })
  }
})

app.put('/api/notes/:id', async (req, res) => {
  try {
    const note = await updateNote(req.params.id, {
      title: req.body?.title,
      content: req.body?.content,
    })
    if (!note) {
      res.status(404).json({ error: 'Note not found' })
      return
    }
    res.json(note)
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Update failed' })
  }
})

app.delete('/api/notes/:id', (req, res) => {
  const ok = deleteNote(req.params.id)
  if (!ok) {
    res.status(404).json({ error: 'Note not found' })
    return
  }
  res.status(204).end()
})

app.post('/api/search', async (req, res) => {
  try {
    const query = String(req.body?.query || '')
    const result = await searchConnectionGraph(query)
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Search failed' })
  }
})

app.post('/api/reindex', async (_req, res) => {
  try {
    const result = await reindexAll()
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Reindex failed' })
  }
})

const dist = path.join(__dirname, '..', 'dist')
app.use(express.static(dist))
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(dist, 'index.html'), (err) => {
    if (err) res.status(404).json({ error: 'UI not built. Run npm run dev or npm run build.' })
  })
})

warmEmbeddings()

app.listen(PORT, () => {
  console.log(`Mine server listening on http://localhost:${PORT}`)
  console.log(`Embeddings: ${JSON.stringify(getEmbeddingStatus())}`)
})
