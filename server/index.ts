import express from 'express'
import cors from 'cors'
import path from 'node:path'
import type { Server } from 'node:http'
import {
  listNotes,
  getNote,
  getNoteComponents,
  createNote,
  updateNote,
  deleteNote,
  reindexAll,
  ensureEmbedSchema,
  resetNotesWorkspace,
  ensureNoteDocuments,
} from './notes.js'
import { getMineObject, updateMineObjectInner } from './objects.js'
import {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  reassignCollidingTags,
} from './categories.js'
import { confirmMentionLink, dismissMention } from './entities.js'
import { searchConnectionGraph } from './search.js'
import { sanitizeWorld } from './world.js'
import { getEmbeddingStatus, warmEmbeddings } from './embeddings.js'
import { getGeneratorStatus, warmGenerator } from './generate.js'
import { categorizeNote, draftCategory, draftCategoryWithProgress } from './categoryAi.js'
import { db, getNotesDir, reopenDatabase, copyDatabaseTo, getDbPath, isVecReady } from './db.js'
import { retrieve } from './hybrid.js'
import { getWorkspaceSettings, setWorkspaceSettings } from './workspaceSettings.js'
import {
  DEFAULT_NOTES_DIR,
  readAppConfig,
  writeAppConfig,
  resolveNotesDir,
  ensureNotesDir,
  getConfigPath,
} from './appConfig.js'
import { getUiDistDir } from './paths.js'
import { getGitStatus, initGitRepo, syncGit } from './git.js'
import {
  createReminderInNote,
  listReminders,
  rebuildReminders,
  updateReminder,
} from './reminders.js'
import {
  createFolder,
  deleteFolder,
  listFolders,
  updateFolder,
} from './folders.js'
import {
  createNoteAgent,
  createFromAgent,
  createFromAgentWithProgress,
  deleteNoteAgent,
  exploreNoteAgent,
  getNoteAgent,
  updateNoteAgent,
} from './noteAgents.js'

const app = express()
const DEFAULT_PORT = Number(process.env.PORT || 8787)
const DEFAULT_HOST = process.env.HOST || '127.0.0.1'

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
    generator: getGeneratorStatus(),
    search: { vec: isVecReady(), fts: true, hybrid: true },
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
      categoryId: req.body?.categoryId,
      folderId: req.body?.folderId,
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
      categoryId: req.body?.categoryId,
      folderId: req.body?.folderId,
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

app.post('/api/workspace/reset-notes', (_req, res) => {
  try {
    const result = resetNotesWorkspace()
    res.json({ ok: true, ...result })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Reset failed' })
  }
})

app.post('/api/workspace/backfill-docs', (_req, res) => {
  try {
    const count = ensureNoteDocuments()
    res.json({ ok: true, backfilled: count })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Backfill failed' })
  }
})

app.get('/api/objects/:id', (req, res) => {
  const noteId = typeof req.query.note === 'string' ? req.query.note : undefined
  const object = getMineObject(req.params.id, noteId)
  if (!object) {
    res.status(404).json({ error: 'Object not found' })
    return
  }
  res.json(object)
})

app.patch('/api/objects/:id', async (req, res) => {
  try {
    const inner = typeof req.body?.inner === 'string' ? req.body.inner : null
    if (inner == null) {
      res.status(400).json({ error: 'inner is required' })
      return
    }
    const noteId = typeof req.body?.noteId === 'string' ? req.body.noteId : undefined
    const object = await updateMineObjectInner(req.params.id, inner, noteId)
    if (!object) {
      res.status(404).json({ error: 'Object not found' })
      return
    }
    res.json(object)
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Update object failed' })
  }
})

app.get('/api/folders', (_req, res) => {
  res.json(listFolders())
})

app.post('/api/folders', (req, res) => {
  try {
    const folder = createFolder({
      name: req.body?.name,
      color: req.body?.color,
      parentId: req.body?.parentId ?? null,
    })
    res.status(201).json(folder)
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'Create folder failed' })
  }
})

app.put('/api/folders/:id', (req, res) => {
  try {
    const folder = updateFolder(req.params.id, {
      name: req.body?.name,
      color: req.body?.color,
      parentId: req.body?.parentId,
      position: typeof req.body?.position === 'number' ? req.body.position : undefined,
    })
    if (!folder) {
      res.status(404).json({ error: 'Folder not found' })
      return
    }
    res.json(folder)
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'Update folder failed' })
  }
})

app.delete('/api/folders/:id', (req, res) => {
  const ok = deleteFolder(req.params.id)
  if (!ok) {
    res.status(404).json({ error: 'Folder not found' })
    return
  }
  res.status(204).end()
})

app.get('/api/categories', (_req, res) => {
  res.json(listCategories())
})

app.post('/api/categories', async (req, res) => {
  try {
    const category = await createCategory({
      name: req.body?.name,
      icon: req.body?.icon,
      color: req.body?.color,
      description: req.body?.description,
      embedInstruction: req.body?.embedInstruction,
      queryHints: req.body?.queryHints,
      template: req.body?.template,
      tag: req.body?.tag,
    })
    res.status(201).json(category)
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Create category failed' })
  }
})

app.put('/api/categories/:id', async (req, res) => {
  try {
    const category = await updateCategory(req.params.id, {
      name: req.body?.name,
      icon: req.body?.icon,
      color: req.body?.color,
      description: req.body?.description,
      embedInstruction: req.body?.embedInstruction,
      queryHints: req.body?.queryHints,
      template: req.body?.template,
      tag: req.body?.tag,
      position: req.body?.position,
    })
    if (!category) {
      res.status(404).json({ error: 'Category not found' })
      return
    }
    res.json(category)
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Update category failed' })
  }
})

app.delete('/api/categories/:id', async (req, res) => {
  try {
    const ok = await deleteCategory(req.params.id)
    if (!ok) {
      res.status(404).json({ error: 'Category not found' })
      return
    }
    res.status(204).end()
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Delete category failed' })
  }
})

app.post('/api/categories/draft', async (req, res) => {
  const name = req.body?.name ? String(req.body.name) : ''
  const prompt = req.body?.prompt ? String(req.body.prompt) : ''
  const stream = Boolean(req.body?.stream) || String(req.headers.accept || '').includes('text/event-stream')

  if (!stream) {
    try {
      const draft = await draftCategory({ name, prompt })
      res.json(draft)
    } catch (e) {
      res.status(503).json({ error: e instanceof Error ? e.message : 'Category setup failed' })
    }
    return
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()
  const send = (event: object) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  try {
    await draftCategoryWithProgress({ name, prompt }, send)
  } catch (e) {
    send({
      type: 'error',
      status: 'Build failed.',
      progress: 1,
      error: e instanceof Error ? e.message : 'Category setup failed',
    })
  } finally {
    res.end()
  }
})

app.post('/api/categorize', async (req, res) => {
  try {
    const title = String(req.body?.title || '')
    const content = String(req.body?.content || '')
    const result = await categorizeNote(title, content)
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Categorize failed' })
  }
})

app.post('/api/search', async (req, res) => {
  const query = String(req.body?.query || '')
  const categoryId = req.body?.categoryId ? String(req.body.categoryId) : null
  const history = Array.isArray(req.body?.history) ? req.body.history : []
  const world = sanitizeWorld(req.body?.world)
  const stream =
    req.body?.stream === true || String(req.headers.accept || '').includes('ndjson')

  if (stream) {
    res.status(200)
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()
    const write = (event: unknown) => {
      res.write(`${JSON.stringify(event)}\n`)
    }
    try {
      const result = await searchConnectionGraph(query, {
        categoryId,
        history,
        world,
        onProgress: (event) => write(event),
      })
      write({ type: 'done', result })
    } catch (e) {
      write({ type: 'error', error: e instanceof Error ? e.message : 'Search failed' })
    }
    res.end()
    return
  }

  try {
    const result = await searchConnectionGraph(query, { categoryId, history, world })
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Search failed' })
  }
})

app.post('/api/retrieve', async (req, res) => {
  try {
    const query = String(req.body?.query || '')
    const categoryId = req.body?.categoryId ? String(req.body.categoryId) : null
    const noteIds = Array.isArray(req.body?.noteIds)
      ? req.body.noteIds.map((id: unknown) => String(id)).filter(Boolean)
      : undefined
    const limit = Number(req.body?.limit) > 0 ? Math.min(Number(req.body.limit), 100) : 24
    const result = await retrieve(query, { categoryId, noteIds, limit })
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Retrieve failed' })
  }
})

app.post('/api/mentions/confirm', async (req, res) => {
  try {
    const result = await confirmMentionLink({
      mentionId: req.body?.mentionId ? String(req.body.mentionId) : undefined,
      sourceNoteId: String(req.body?.sourceNoteId || ''),
      surface: String(req.body?.surface || ''),
      entityNoteId: String(req.body?.entityNoteId || ''),
    })
    res.json(result)
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'Confirm failed' })
  }
})

app.post('/api/mentions/dismiss', (req, res) => {
  try {
    const mentionId = String(req.body?.mentionId || '')
    if (!mentionId) {
      res.status(400).json({ error: 'mentionId required' })
      return
    }
    dismissMention(mentionId)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'Dismiss failed' })
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

app.get('/api/settings', (_req, res) => {
  res.json(getWorkspaceSettings())
})

app.put('/api/settings', (req, res) => {
  try {
    const next = setWorkspaceSettings({
      aiShortcut: req.body?.aiShortcut,
      reminderShortcut: req.body?.reminderShortcut,
      reservedShortcuts: Array.isArray(req.body?.reservedShortcuts)
        ? req.body.reservedShortcuts
        : undefined,
      reminderColumns: req.body?.reminderColumns,
      objectPasteMode: req.body?.objectPasteMode,
    })
    reassignCollidingTags(next.reservedShortcuts)
    res.json(next)
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Save settings failed' })
  }
})

app.get('/api/storage', (_req, res) => {
  const config = readAppConfig()
  res.json({
    notesDir: getNotesDir(),
    dbPath: getDbPath(),
    defaultNotesDir: DEFAULT_NOTES_DIR,
    gitEnabled: config.gitEnabled,
    configPath: getConfigPath(),
  })
})

app.put('/api/storage', (req, res) => {
  try {
    const current = readAppConfig()
    const nextDirRaw = req.body?.notesDir
    const gitEnabled =
      req.body?.gitEnabled !== undefined ? Boolean(req.body.gitEnabled) : current.gitEnabled
    const copyExisting = Boolean(req.body?.copyExisting)
    let notesDir = current.notesDir
    let reopened = false

    if (typeof nextDirRaw === 'string' && nextDirRaw.trim()) {
      const resolved = resolveNotesDir(nextDirRaw)
      if (resolved !== getNotesDir()) {
        ensureNotesDir(resolved)
        if (copyExisting) copyDatabaseTo(resolved)
        reopenDatabase(resolved)
        rebuildReminders()
        notesDir = resolved
        reopened = true
      }
    }

    const config = writeAppConfig({ notesDir, gitEnabled })
    if (config.gitEnabled && !req.body?.skipGitInit) {
      // leave init explicit via /api/git/init
    }

    res.json({
      notesDir: getNotesDir(),
      dbPath: getDbPath(),
      defaultNotesDir: DEFAULT_NOTES_DIR,
      gitEnabled: config.gitEnabled,
      configPath: getConfigPath(),
      reopened,
    })
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'Update storage failed' })
  }
})

app.get('/api/git/status', async (_req, res) => {
  try {
    res.json(await getGitStatus())
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Git status failed' })
  }
})

app.post('/api/git/init', async (_req, res) => {
  try {
    writeAppConfig({ gitEnabled: true })
    res.json(await initGitRepo())
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Git init failed' })
  }
})

app.post('/api/git/sync', async (req, res) => {
  try {
    if (!readAppConfig().gitEnabled) {
      res.status(400).json({ error: 'Enable git in Storage settings first' })
      return
    }
    const result = await syncGit({ message: req.body?.message ? String(req.body.message) : undefined })
    res.status(result.ok ? 200 : 400).json(result)
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Git sync failed' })
  }
})

app.post('/api/agents', (req, res) => {
  const noteId = String(req.body?.noteId || '')
  const note = getNote(noteId)
  if (!note) {
    res.status(404).json({ error: 'Note not found' })
    return
  }
  res.status(201).json(createNoteAgent(noteId))
})

app.get('/api/agents/:id', (req, res) => {
  const agent = getNoteAgent(req.params.id)
  if (!agent) {
    res.status(404).json({ error: 'Agent block not found' })
    return
  }
  res.json(agent)
})

app.put('/api/agents/:id', (req, res) => {
  const agent = updateNoteAgent(req.params.id, {
    mode: req.body?.mode,
    thread: req.body?.thread,
    connections: req.body?.connections,
    objects: req.body?.objects,
    output: req.body?.output,
  })
  if (!agent) {
    res.status(404).json({ error: 'Agent block not found' })
    return
  }
  res.json(agent)
})

app.delete('/api/agents/:id', (req, res) => {
  if (!deleteNoteAgent(req.params.id)) {
    res.status(404).json({ error: 'Agent block not found' })
    return
  }
  res.status(204).end()
})

app.post('/api/agents/:id/explore', async (req, res) => {
  try {
    const agent = await exploreNoteAgent(
      req.params.id,
      String(req.body?.query || ''),
      sanitizeWorld(req.body?.world),
    )
    res.json(agent)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Explore failed'
    res.status(message === 'Agent block not found' ? 404 : 500).json({ error: message })
  }
})

app.post('/api/agents/:id/create', async (req, res) => {
  const stream =
    req.body?.stream === true || String(req.headers.accept || '').includes('text/event-stream')
  try {
    if (!stream) {
      const agent = await createFromAgent(
        req.params.id,
        String(req.body?.prompt || ''),
        req.body?.noteTitle ? String(req.body.noteTitle) : '',
        sanitizeWorld(req.body?.world),
      )
      res.json(agent)
      return
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()
    const send = (event: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
      // @ts-expect-error flush exists when compression is enabled
      res.flush?.()
    }
    await createFromAgentWithProgress(
      req.params.id,
      String(req.body?.prompt || ''),
      req.body?.noteTitle ? String(req.body.noteTitle) : '',
      sanitizeWorld(req.body?.world),
      send,
    )
    res.end()
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Create failed'
    if (stream && !res.headersSent) {
      res.status(message === 'Agent block not found' ? 404 : 500).json({ error: message })
      return
    }
    if (stream) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: message, status: message })}\n\n`)
      res.end()
      return
    }
    res.status(message === 'Agent block not found' ? 404 : 500).json({ error: message })
  }
})

app.get('/api/reminders', (_req, res) => {
  res.json(listReminders())
})

app.post('/api/reminders', (req, res) => {
  const noteId = String(req.body?.noteId || '')
  const created = createReminderInNote(noteId, {
    title: req.body?.title,
    dueAt: req.body?.dueAt ?? null,
    status: req.body?.status,
  })
  if (!created) {
    res.status(404).json({ error: 'Note not found' })
    return
  }
  res.status(201).json(created)
})

app.patch('/api/reminders/:id', (req, res) => {
  const dueAt = req.body?.dueAt
  const updated = updateReminder(req.params.id, {
    title: req.body?.title,
    dueAt: dueAt === undefined ? undefined : dueAt || null,
    status: req.body?.status,
    position: typeof req.body?.position === 'number' ? req.body.position : undefined,
    objectId: req.body?.objectId === undefined ? undefined : req.body.objectId || null,
    objectType: req.body?.objectType === undefined ? undefined : req.body.objectType || null,
    objectNoteId: req.body?.objectNoteId === undefined ? undefined : req.body.objectNoteId || null,
    objectLabel: req.body?.objectLabel === undefined ? undefined : req.body.objectLabel || null,
  })
  if (!updated) {
    res.status(404).json({ error: 'Reminder not found' })
    return
  }
  res.json(updated)
})

const dist = getUiDistDir()
app.use(express.static(dist))
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(dist, 'index.html'), (err) => {
    if (err) res.status(404).json({ error: 'UI not built. Run npm run dev or npm run build.' })
  })
})

export type RunningServer = {
  port: number
  host: string
  url: string
  close: () => Promise<void>
}

function listen(host: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server))
    server.once('error', reject)
  })
}

export async function startServer(opts?: { host?: string; port?: number }): Promise<RunningServer> {
  const host = opts?.host ?? DEFAULT_HOST
  const requested = opts?.port ?? DEFAULT_PORT

  void warmEmbeddings().then(() => ensureEmbedSchema())
  void warmGenerator()

  let server: Server
  try {
    server = await listen(host, requested)
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
    if (code === 'EADDRINUSE') {
      console.warn(`Port ${requested} in use; trying an ephemeral port`)
      server = await listen(host, 0)
    } else {
      throw err
    }
  }

  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : requested
  rebuildReminders()
  const url = `http://${host}:${port}`
  console.log(`Mine server listening on ${url}`)
  return {
    port,
    host,
    url,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((closeErr) => (closeErr ? reject(closeErr) : resolve()))
      }),
  }
}

if (process.env.MINE_ELECTRON !== '1') {
  void startServer()
}
