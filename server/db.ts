import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { uniqueTag } from './categoryTags.js'
import { ensureNotesDir, readAppConfig } from './appConfig.js'

const require = createRequire(import.meta.url)

export type NoteRow = {
  id: string
  title: string
  content: string
  created_at: string
  updated_at: string
  category_id: string | null
  folder_id: string | null
  /** Structured document JSON (schema v1+). Null until dual-write/backfill. */
  doc_json?: string | null
  /** 0 = markdown-only legacy; 1+ = doc_json is authoritative. */
  doc_version?: number
}

export type MineObjectRow = {
  id: string
  note_id: string
  type: string
  body_json: string
  agent_id: string | null
  attrs_json: string
  updated_at: string
}

export type FolderRow = {
  id: string
  name: string
  color: string
  parent_id: string | null
  position: number
  created_at: string
  updated_at: string
}

export type CategoryRow = {
  id: string
  name: string
  slug: string
  icon: string
  color: string
  description: string
  embed_instruction: string
  query_hints: string
  template: string
  tag: string
  position: number
  created_at: string
  updated_at: string
}

export type ComponentRow = {
  id: string
  note_id: string
  type: string
  content: string
  meta_json: string
  position: number
  embedding: Buffer | null
  embedding_dim: number | null
  content_hash: string | null
  context_path: string | null
  created_at: string
  updated_at: string
}

export const EMBED_DIMS = 384
export const FTS_SCHEMA = 'fts-v2-context'
export const VEC_SCHEMA = 'vec-v1'

let vecReady = false

export function isVecReady(): boolean {
  return vecReady
}

let notesDir = readAppConfig().notesDir
ensureNotesDir(notesDir)

export let db: Database.Database = openAt(notesDir)

function openAt(dir: string): Database.Database {
  ensureNotesDir(dir)
  const database = new Database(path.join(dir, 'mine.db'))
  database.pragma('journal_mode = WAL')
  database.pragma('foreign_keys = ON')
  vecReady = loadSqliteVec(database)
  migrate(database)
  return database
}

function loadSqliteVec(database: Database.Database): boolean {
  try {
    // Loaded dynamically so the app still boots if the native extension is missing.
    const sqliteVec = require('sqlite-vec') as { load: (db: Database.Database) => void }
    sqliteVec.load(database)
    database.prepare(`SELECT vec_version() as v`).get()
    return true
  } catch (e) {
    console.warn(
      `sqlite-vec unavailable (${e instanceof Error ? e.message : String(e)}); using brute-force cosine.`,
    )
    return false
  }
}

function columnNames(database: Database.Database, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map((r) => r.name))
}

function migrate(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS components (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      meta_json TEXT NOT NULL DEFAULT '{}',
      position INTEGER NOT NULL,
      embedding BLOB,
      embedding_dim INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      icon TEXT NOT NULL DEFAULT '📁',
      color TEXT NOT NULL DEFAULT '#c06a3a',
      description TEXT NOT NULL DEFAULT '',
      embed_instruction TEXT NOT NULL DEFAULT '',
      query_hints TEXT NOT NULL DEFAULT '',
      template TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS note_agents (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'explore',
      thread_json TEXT NOT NULL DEFAULT '[]',
      connections_json TEXT NOT NULL DEFAULT '[]',
      objects_json TEXT NOT NULL DEFAULT '[]',
      output TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#787774',
      parent_id TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      due_at TEXT,
      status TEXT NOT NULL DEFAULT 'todo',
      position INTEGER NOT NULL DEFAULT 0,
      object_id TEXT,
      object_type TEXT,
      object_note_id TEXT,
      object_label TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS entity_aliases (
      entity_note_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      PRIMARY KEY (entity_note_id, alias),
      FOREIGN KEY (entity_note_id) REFERENCES notes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mentions (
      id TEXT PRIMARY KEY,
      source_note_id TEXT NOT NULL,
      source_component_id TEXT,
      surface TEXT NOT NULL,
      entity_note_id TEXT,
      status TEXT NOT NULL DEFAULT 'candidate',
      confidence REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (source_note_id) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (entity_note_id) REFERENCES notes(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_components_note ON components(note_id);
    CREATE INDEX IF NOT EXISTS idx_components_type ON components(type);
    CREATE INDEX IF NOT EXISTS idx_note_agents_note ON note_agents(note_id);
    CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
    CREATE INDEX IF NOT EXISTS idx_reminders_note ON reminders(note_id);
    CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status);
    CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at);
    CREATE INDEX IF NOT EXISTS idx_entity_aliases_alias ON entity_aliases(alias);
    CREATE INDEX IF NOT EXISTS idx_mentions_source ON mentions(source_note_id);
    CREATE INDEX IF NOT EXISTS idx_mentions_entity ON mentions(entity_note_id);
    CREATE INDEX IF NOT EXISTS idx_mentions_status ON mentions(status);

    CREATE TABLE IF NOT EXISTS entity_centroids (
      note_id TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      dim INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vec_row_map (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id TEXT NOT NULL UNIQUE
    );
  `)

  if (!columnNames(database, 'components').has('content_hash')) {
    database.exec(`ALTER TABLE components ADD COLUMN content_hash TEXT`)
  }
  if (!columnNames(database, 'components').has('context_path')) {
    database.exec(`ALTER TABLE components ADD COLUMN context_path TEXT`)
  }
  database.exec(`CREATE INDEX IF NOT EXISTS idx_components_hash ON components(content_hash)`)

  ensureFts(database)
  if (vecReady) ensureVecTable(database)

  if (!columnNames(database, 'notes').has('category_id')) {
    database.exec(`ALTER TABLE notes ADD COLUMN category_id TEXT`)
  }
  database.exec(`CREATE INDEX IF NOT EXISTS idx_notes_category ON notes(category_id)`)

  if (!columnNames(database, 'notes').has('folder_id')) {
    database.exec(`ALTER TABLE notes ADD COLUMN folder_id TEXT`)
  }
  database.exec(`CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder_id)`)

  if (!columnNames(database, 'categories').has('tag')) {
    database.exec(`ALTER TABLE categories ADD COLUMN tag TEXT NOT NULL DEFAULT ''`)
  }

  if (!columnNames(database, 'note_agents').has('objects_json')) {
    database.exec(`ALTER TABLE note_agents ADD COLUMN objects_json TEXT NOT NULL DEFAULT '[]'`)
  }

  if (!columnNames(database, 'reminders').has('object_id')) {
    database.exec(`ALTER TABLE reminders ADD COLUMN object_id TEXT`)
  }
  if (!columnNames(database, 'reminders').has('object_type')) {
    database.exec(`ALTER TABLE reminders ADD COLUMN object_type TEXT`)
  }
  if (!columnNames(database, 'reminders').has('object_note_id')) {
    database.exec(`ALTER TABLE reminders ADD COLUMN object_note_id TEXT`)
  }
  if (!columnNames(database, 'reminders').has('object_label')) {
    database.exec(`ALTER TABLE reminders ADD COLUMN object_label TEXT`)
  }

  if (!columnNames(database, 'notes').has('doc_json')) {
    database.exec(`ALTER TABLE notes ADD COLUMN doc_json TEXT`)
  }
  if (!columnNames(database, 'notes').has('doc_version')) {
    database.exec(`ALTER TABLE notes ADD COLUMN doc_version INTEGER NOT NULL DEFAULT 0`)
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS mine_objects (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      type TEXT NOT NULL,
      body_json TEXT NOT NULL,
      agent_id TEXT,
      attrs_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_mine_objects_note ON mine_objects(note_id);
    CREATE INDEX IF NOT EXISTS idx_mine_objects_type ON mine_objects(type);
  `)

  const rows = database.prepare(`SELECT id, name, tag FROM categories`).all() as Array<{
    id: string
    name: string
    tag: string
  }>
  const taken: string[] = []
  for (const row of rows) {
    const tag = uniqueTag(row.name, taken, row.tag)
    taken.push(tag)
    if (tag !== row.tag) {
      database.prepare(`UPDATE categories SET tag = ? WHERE id = ?`).run(tag, row.id)
    }
  }
}

function ftsReady(database: Database.Database): boolean {
  const cols = database.prepare(`PRAGMA table_info(components_fts)`).all() as Array<{ name: string }>
  return cols.some((c) => c.name === 'context_path')
}

function ensureFts(database: Database.Database) {
  const exists = database
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'components_fts'`)
    .get() as { name: string } | undefined
  if (exists && ftsReady(database)) return
  database.exec(`DROP TABLE IF EXISTS components_fts`)
  database.exec(`
    CREATE VIRTUAL TABLE components_fts USING fts5(
      content,
      note_title,
      context_path,
      component_id UNINDEXED,
      note_id UNINDEXED,
      tokenize = 'porter unicode61'
    );
  `)
}

function ensureVecTable(database: Database.Database) {
  const exists = database
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vec_chunks'`)
    .get() as { name: string } | undefined
  if (exists) return
  database.exec(`
    CREATE VIRTUAL TABLE vec_chunks USING vec0(
      embedding float[${EMBED_DIMS}]
    );
  `)
}

export function getNotesDir() {
  return notesDir
}

export function getDbPath() {
  return path.join(notesDir, 'mine.db')
}

/** Flush WAL so git can see a consistent mine.db. */
export function checkpointDatabase() {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch {
    /* ignore */
  }
}

export function reopenDatabase(nextNotesDir: string) {
  const resolved = path.resolve(nextNotesDir)
  checkpointDatabase()
  db.close()
  notesDir = resolved
  db = openAt(resolved)
  return { notesDir, dbPath: getDbPath() }
}

export function getAppMeta(key: string): string | null {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setAppMeta(key: string, value: string) {
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value)
}

export function bufferToFloat32(buf: Buffer | null): Float32Array | null {
  if (!buf) return null
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

export function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}

/** Copy mine.db (+ wal/shm if present) into a target notes folder. */
export function copyDatabaseTo(targetDir: string) {
  ensureNotesDir(targetDir)
  checkpointDatabase()
  const src = getDbPath()
  const dest = path.join(targetDir, 'mine.db')
  if (path.resolve(src) === path.resolve(dest)) return
  if (!fs.existsSync(src)) return
  fs.copyFileSync(src, dest)
  for (const suffix of ['-wal', '-shm']) {
    const side = src + suffix
    if (fs.existsSync(side)) fs.copyFileSync(side, dest + suffix)
  }
}
