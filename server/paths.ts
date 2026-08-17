import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export function isPackagedApp(): boolean {
  return process.env.MINE_PACKAGED === '1'
}

export function findRepoRoot(): string {
  if (process.env.MINE_APP_ROOT) return process.env.MINE_APP_ROOT
  let dir = here
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src'))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.join(here, '..')
}

export function getAppRoot(): string {
  return process.env.MINE_APP_ROOT || findRepoRoot()
}

export function getUiDistDir(): string {
  if (process.env.MINE_UI_DIR) return process.env.MINE_UI_DIR
  return path.join(getAppRoot(), 'dist')
}

export function defaultNotesDirFor(opts: { packaged: boolean; home: string; repoRoot: string }): string {
  if (opts.packaged) return path.join(opts.home, '.mine-note', 'notes')
  return path.join(opts.repoRoot, 'data')
}

export function getDefaultNotesDir(): string {
  return defaultNotesDirFor({
    packaged: isPackagedApp(),
    home: os.homedir(),
    repoRoot: findRepoRoot(),
  })
}

/** Worker threads and native addons cannot run from inside an asar archive. */
export function toNativeFsPath(filePath: string): string {
  const needle = `${path.sep}app.asar${path.sep}`
  const replacement = `${path.sep}app.asar.unpacked${path.sep}`
  return filePath.includes(needle) ? filePath.replace(needle, replacement) : filePath
}
