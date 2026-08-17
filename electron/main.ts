import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { app, BrowserWindow, Menu, dialog, shell } = require('electron') as typeof import('electron')

const logDir = path.join(os.homedir(), '.mine-note')
function bootLog(message: string) {
  try {
    fs.mkdirSync(logDir, { recursive: true })
    fs.appendFileSync(path.join(logDir, 'electron.log'), `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    /* ignore */
  }
  console.log(message)
}

bootLog(`starting packaged=${app.isPackaged} dev=${process.env.MINE_DEV || ''} appPath=${app.getAppPath()}`)

const DEV_PORT = Number(process.env.PORT || 8787)
const DEV_HOST = '127.0.0.1'
const isDev = process.env.MINE_DEV === '1' && !app.isPackaged

process.env.MINE_ELECTRON = '1'
process.env.MINE_PACKAGED = app.isPackaged ? '1' : ''
process.env.MINE_APP_ROOT = app.getAppPath()
process.env.MINE_UI_DIR = path.join(app.getAppPath(), 'dist')

let mainWindow: BrowserWindow | null = null
let running: { url: string; close: () => Promise<void> } | null = null
let devChild: ChildProcess | null = null
let quitting = false

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function isHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${DEV_HOST}:${port}/api/health`)
    return res.ok
  } catch {
    return false
  }
}

async function waitForHealth(port: number, timeoutMs = 45_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await isHealthy(port)) return
    await delay(200)
  }
  throw new Error(`Mine server did not become ready on ${DEV_HOST}:${port}`)
}

function repoRoot(): string {
  return app.getAppPath()
}

function nodeBinary(): string {
  return process.env.npm_node_execpath || 'node'
}

async function startDevServer(): Promise<{ url: string }> {
  if (await isHealthy(DEV_PORT)) {
    return { url: `http://${DEV_HOST}:${DEV_PORT}` }
  }
  const root = repoRoot()
  const require = createRequire(path.join(root, 'package.json'))
  let tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  try {
    tsxCli = require.resolve('tsx/cli')
  } catch {
    /* fall back to dist/cli.mjs */
  }
  const serverEntry = path.join(root, 'server', 'index.ts')
  const env = { ...process.env, PORT: String(DEV_PORT), HOST: DEV_HOST }
  delete env.MINE_ELECTRON
  delete env.MINE_PACKAGED
  delete env.MINE_DEV
  devChild = spawn(nodeBinary(), [tsxCli, serverEntry], {
    cwd: root,
    stdio: 'inherit',
    env,
  })
  devChild.on('exit', (code) => {
    if (code && code !== 0 && !quitting) {
      console.error(`Mine server exited with code ${code}`)
    }
  })
  await waitForHealth(DEV_PORT)
  return { url: `http://${DEV_HOST}:${DEV_PORT}` }
}

async function startPackagedServer(): Promise<{ url: string }> {
  const here = path.dirname(fileURLToPath(import.meta.url))
  let serverPath = path.join(here, 'server', 'index.js')
  const asarNeedle = `${path.sep}app.asar${path.sep}`
  const asarUnpacked = `${path.sep}app.asar.unpacked${path.sep}`
  if (serverPath.includes(asarNeedle)) {
    serverPath = serverPath.replace(asarNeedle, asarUnpacked)
  }
  const mod = (await import(pathToFileURL(serverPath).href)) as {
    startServer: (opts?: { host?: string; port?: number }) => Promise<{
      url: string
      close: () => Promise<void>
    }>
  }
  running = await mod.startServer({ host: '127.0.0.1', port: 0 })
  return { url: running.url }
}

async function loadRenderer(win: BrowserWindow, backendUrl: string) {
  if (isDev) {
    const viteUrl = 'http://127.0.0.1:5173'
    for (let i = 0; i < 40; i++) {
      try {
        await win.loadURL(viteUrl)
        return
      } catch {
        await delay(250)
      }
    }
    throw new Error('Vite did not start at http://127.0.0.1:5173')
  }
  await win.loadURL(backendUrl)
}

function createMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [{ role: 'appMenu' as const }]
      : [{ label: 'File', submenu: [{ role: 'quit' as const }] }]),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function createWindow() {
  createMenu()
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 880,
    minHeight: 560,
    title: 'Mine',
    show: false,
    autoHideMenuBar: process.platform === 'win32',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow = win

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')
    if (!allowed) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    mainWindow = null
  })

  try {
    const backend = isDev ? await startDevServer() : await startPackagedServer()
    bootLog(`backend ${backend.url}`)
    await loadRenderer(win, backend.url)
    bootLog('renderer loaded')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    bootLog(`start failed: ${message}`)
    if (err instanceof Error && err.stack) bootLog(err.stack)
    dialog.showErrorBox('Mine failed to start', message)
    app.quit()
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  void app.whenReady().then(() => void createWindow())
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  quitting = true
  if (devChild && !devChild.killed) {
    devChild.kill()
    devChild = null
  }
  if (running) {
    void running.close()
    running = null
  }
})
