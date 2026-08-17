import * as esbuild from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const watch = process.argv.includes('--watch')

const common = {
  platform: 'node',
  format: 'esm',
  bundle: true,
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
  absWorkingDir: root,
}

const mainOptions = {
  ...common,
  entryPoints: [path.join(root, 'electron', 'main.ts')],
  outfile: path.join(root, 'dist-electron', 'main.js'),
  external: ['electron'],
}

const serverOptions = {
  ...common,
  entryPoints: [path.join(root, 'server', 'index.ts')],
  outfile: path.join(root, 'dist-electron', 'server', 'index.js'),
}

const workerOptions = {
  ...common,
  entryPoints: [path.join(root, 'server', 'embedWorker.ts')],
  outfile: path.join(root, 'dist-electron', 'server', 'embedWorker.js'),
}

if (watch) {
  const [mainCtx, serverCtx, workerCtx] = await Promise.all([
    esbuild.context(mainOptions),
    esbuild.context(serverOptions),
    esbuild.context(workerOptions),
  ])
  await Promise.all([mainCtx.watch(), serverCtx.watch(), workerCtx.watch()])
  console.log('Watching electron + server for rebuilds')
} else {
  await Promise.all([
    esbuild.build(mainOptions),
    esbuild.build(serverOptions),
    esbuild.build(workerOptions),
  ])
}
