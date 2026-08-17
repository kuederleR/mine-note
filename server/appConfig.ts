import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDefaultNotesDir } from './paths.js'

export const DEFAULT_NOTES_DIR = getDefaultNotesDir()

export type AppConfig = {
  notesDir: string
  gitEnabled: boolean
}

const configDir = path.join(os.homedir(), '.mine-note')
const configPath = path.join(configDir, 'config.json')

function expandHome(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '~') return os.homedir()
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2))
  return trimmed
}

export function resolveNotesDir(raw: string): string {
  return path.resolve(expandHome(raw || DEFAULT_NOTES_DIR))
}

export function readAppConfig(): AppConfig {
  let notesDir = DEFAULT_NOTES_DIR
  let gitEnabled = false
  try {
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<AppConfig>
      if (parsed.notesDir) notesDir = resolveNotesDir(String(parsed.notesDir))
      gitEnabled = Boolean(parsed.gitEnabled)
    }
  } catch {
    /* defaults */
  }
  if (process.env.MINE_NOTES_DIR) notesDir = resolveNotesDir(process.env.MINE_NOTES_DIR)
  return { notesDir, gitEnabled }
}

export function writeAppConfig(input: Partial<AppConfig>): AppConfig {
  const current = readAppConfig()
  const next: AppConfig = {
    notesDir:
      input.notesDir !== undefined ? resolveNotesDir(input.notesDir) : current.notesDir,
    gitEnabled: input.gitEnabled !== undefined ? Boolean(input.gitEnabled) : current.gitEnabled,
  }
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

export function ensureNotesDir(notesDir: string) {
  fs.mkdirSync(notesDir, { recursive: true })
  const gitignore = path.join(notesDir, '.gitignore')
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(
      gitignore,
      ['# Mine note workspace', '*.db-wal', '*.db-shm', '.DS_Store', ''].join('\n'),
      'utf8',
    )
  }
}

export function getConfigPath() {
  return configPath
}
