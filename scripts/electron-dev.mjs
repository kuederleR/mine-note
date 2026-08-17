import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronBin = String(require('electron')).trim()

const child = spawn(electronBin, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, MINE_DEV: '1' },
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 0)
})
