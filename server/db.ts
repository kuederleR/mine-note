import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(__dirname, '..', 'data')
const dbPath = path.join(dataDir, 'mine.db')

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true })
}

export const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
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

  CREATE INDEX IF NOT EXISTS idx_components_note ON components(note_id);
  CREATE INDEX IF NOT EXISTS idx_components_type ON components(type);
`)

export type NoteRow = {
  id: string
  title: string
  content: string
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
  created_at: string
  updated_at: string
}

export function bufferToFloat32(buf: Buffer | null): Float32Array | null {
  if (!buf) return null
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

export function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}
