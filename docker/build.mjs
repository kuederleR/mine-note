#!/usr/bin/env node
/**
 * Cross-compile desktop installers inside Docker.
 *
 * Native addons ship N-API / platform prebuilds (better-sqlite3, onnxruntime-node).
 * sqlite-vec uses optional platform packages that npm ci only installs for Linux,
 * so this script adds the target OS copies without touching the lockfile.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv[2]

const SQLITE_VEC = '0.1.9'

const targets = {
  win: {
    native: [`sqlite-vec-windows-x64@${SQLITE_VEC}`],
    pack: ['electron-builder', '--win', 'nsis', '--x64', '--publish', 'never'],
  },
  mac: {
    native: [
      `sqlite-vec-darwin-arm64@${SQLITE_VEC}`,
      `sqlite-vec-darwin-x64@${SQLITE_VEC}`,
    ],
    // zip works from Linux; dmg needs macOS hdiutil
    pack: ['electron-builder', '--mac', 'zip', '--arm64', '--x64', '--publish', 'never'],
  },
}

if (!targets[target]) {
  console.error('Usage: node docker/build.mjs <win|mac>')
  process.exit(1)
}

process.chdir(root)
process.env.NPM_CONFIG_DANGEROUSLY_ALLOW_ALL_SCRIPTS = 'true'
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'

function run(command, args) {
  console.log(`\n$ ${command} ${args.join(' ')}\n`)
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: process.env,
  })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

run('npm', ['ci'])
run('npm', ['install', '--no-save', '--no-package-lock', '--ignore-scripts', ...targets[target].native])
run('npm', ['run', 'build:desktop'])
run('npx', targets[target].pack)

const releaseDir = path.join(root, 'release')
console.log(`\nArtifacts in ${releaseDir}:`)
if (fs.existsSync(releaseDir)) {
  for (const name of fs.readdirSync(releaseDir).sort()) {
    console.log(`  ${name}`)
  }
}
