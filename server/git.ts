import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { getNotesDir, checkpointDatabase } from './db.js'
import { readAppConfig } from './appConfig.js'

const execFileAsync = promisify(execFile)

export type GitStatus = {
  enabled: boolean
  isRepo: boolean
  branch: string | null
  remote: string | null
  dirty: boolean
  ahead: number
  behind: number
  lastMessage: string | null
  error: string | null
}

async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, {
    cwd,
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  })
}

export function isGitRepo(dir = getNotesDir()): boolean {
  return fs.existsSync(path.join(dir, '.git'))
}

export async function getGitStatus(): Promise<GitStatus> {
  const enabled = readAppConfig().gitEnabled
  const cwd = getNotesDir()
  const base: GitStatus = {
    enabled,
    isRepo: false,
    branch: null,
    remote: null,
    dirty: false,
    ahead: 0,
    behind: 0,
    lastMessage: null,
    error: null,
  }
  if (!enabled) return base
  if (!isGitRepo(cwd)) {
    return { ...base, error: 'Notes folder is not a git repository' }
  }
  base.isRepo = true
  try {
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).stdout.trim()
    base.branch = branch || null
    try {
      base.remote = (await git(['remote', 'get-url', 'origin'], cwd)).stdout.trim() || null
    } catch {
      base.remote = null
    }
    const porcelain = (await git(['status', '--porcelain'], cwd)).stdout.trim()
    base.dirty = Boolean(porcelain)
    try {
      const counts = (
        await git(['rev-list', '--left-right', '--count', `HEAD...@{upstream}`], cwd)
      ).stdout
        .trim()
        .split(/\s+/)
      base.ahead = Number(counts[0] || 0) || 0
      base.behind = Number(counts[1] || 0) || 0
    } catch {
      /* no upstream */
    }
    try {
      base.lastMessage = (await git(['log', '-1', '--pretty=%s'], cwd)).stdout.trim() || null
    } catch {
      base.lastMessage = null
    }
    return base
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : 'Git status failed' }
  }
}

export async function initGitRepo(): Promise<GitStatus> {
  const cwd = getNotesDir()
  if (!isGitRepo(cwd)) {
    await git(['init'], cwd)
  }
  return getGitStatus()
}

export type GitSyncResult = {
  ok: boolean
  pulled: boolean
  pushed: boolean
  committed: boolean
  message: string
  status: GitStatus
}

export async function syncGit(opts?: { message?: string }): Promise<GitSyncResult> {
  const cwd = getNotesDir()
  const enabled = readAppConfig().gitEnabled
  if (!enabled) {
    return {
      ok: false,
      pulled: false,
      pushed: false,
      committed: false,
      message: 'Git sync is disabled',
      status: await getGitStatus(),
    }
  }
  if (!isGitRepo(cwd)) {
    return {
      ok: false,
      pulled: false,
      pushed: false,
      committed: false,
      message: 'Notes folder is not a git repository',
      status: await getGitStatus(),
    }
  }

  checkpointDatabase()

  let pulled = false
  let pushed = false
  let committed = false

  try {
    // Stage & commit local changes first so pull can rebase cleanly when possible.
    await git(['add', '-A'], cwd)
    const staged = (await git(['status', '--porcelain'], cwd)).stdout.trim()
    if (staged) {
      const message =
        (opts?.message || '').trim() ||
        `Mine sync ${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}`
      await git(['commit', '-m', message], cwd)
      committed = true
    }

    try {
      await git(['fetch', 'origin'], cwd)
      await git(['pull', '--rebase', '--autostash', 'origin', 'HEAD'], cwd)
      pulled = true
    } catch (e) {
      // Try plain pull if rebase fails / no upstream yet
      try {
        await git(['pull', '--autostash', 'origin', 'HEAD'], cwd)
        pulled = true
      } catch (pullError) {
        const msg = pullError instanceof Error ? pullError.message : String(e)
        if (!/There is no tracking information|no upstream|does not appear to be a git repository/i.test(msg)) {
          throw pullError
        }
      }
    }

    try {
      await git(['push', '-u', 'origin', 'HEAD'], cwd)
      pushed = true
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Push failed'
      if (/no upstream|has no upstream|does not appear to be a git repository|Could not read from remote/i.test(msg) && !pushed) {
        const status = await getGitStatus()
        return {
          ok: committed || pulled,
          pulled,
          pushed: false,
          committed,
          message: committed
            ? 'Committed locally. Set an origin remote to push.'
            : `Could not push: ${msg}`,
          status,
        }
      }
      throw e
    }

    const status = await getGitStatus()
    const parts = [
      committed ? 'committed' : null,
      pulled ? 'pulled' : null,
      pushed ? 'pushed' : null,
    ].filter(Boolean)
    return {
      ok: true,
      pulled,
      pushed,
      committed,
      message: parts.length ? `Synced (${parts.join(', ')})` : 'Already up to date',
      status,
    }
  } catch (e) {
    return {
      ok: false,
      pulled,
      pushed,
      committed,
      message: e instanceof Error ? e.message : 'Git sync failed',
      status: await getGitStatus(),
    }
  }
}
