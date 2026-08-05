#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const PRODUCT_NAME = 'safe db'
const BUNDLE_ID = 'dev.safe-db.app'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} 执行失败（退出码 ${result.status ?? 'unknown'}）`)
}

/**
 * app.setName() 只会修改 Electron 内部名称，macOS 菜单栏读取的是 .app bundle 名称。
 * 开发模式使用 node_modules 里的 Electron.app，因此创建一份缓存的品牌化运行时，
 * 并让 electron-vite 通过 ELECTRON_EXEC_PATH 启动它。
 */
function prepareMacRuntime() {
  const electronExecutable = require('electron')
  const electronVersion = require('electron/package.json').version
  const sourceApp = resolve(dirname(electronExecutable), '../..')
  const cacheDir = join(root, 'node_modules', '.cache', 'safe-db-electron', electronVersion)
  const targetApp = join(cacheDir, `${PRODUCT_NAME}.app`)
  const targetExecutable = join(targetApp, 'Contents', 'MacOS', PRODUCT_NAME)
  const markerFile = join(cacheDir, 'runtime.json')

  if (existsSync(targetExecutable) && existsSync(markerFile)) {
    try {
      const marker = JSON.parse(readFileSync(markerFile, 'utf8'))
      if (marker.electronVersion === electronVersion && marker.productName === PRODUCT_NAME) {
        return targetExecutable
      }
    } catch {
      // 缓存不完整时在下方重建。
    }
  }

  rmSync(cacheDir, { recursive: true, force: true })
  mkdirSync(cacheDir, { recursive: true })
  cpSync(sourceApp, targetApp, { recursive: true, verbatimSymlinks: true })

  const contents = join(targetApp, 'Contents')
  const originalExecutable = join(contents, 'MacOS', 'Electron')
  renameSync(originalExecutable, targetExecutable)

  const plist = join(contents, 'Info.plist')
  const plistBuddy = '/usr/libexec/PlistBuddy'
  run(plistBuddy, ['-c', `Set :CFBundleName ${PRODUCT_NAME}`, plist])
  run(plistBuddy, ['-c', `Set :CFBundleDisplayName ${PRODUCT_NAME}`, plist])
  run(plistBuddy, ['-c', `Set :CFBundleExecutable ${PRODUCT_NAME}`, plist])
  run(plistBuddy, ['-c', `Set :CFBundleIdentifier ${BUNDLE_ID}`, plist])

  // 修改 bundle 后使用本地临时签名，避免 macOS 拒绝启动被修改的 Electron.app。
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', targetApp])
  writeFileSync(markerFile, JSON.stringify({ electronVersion, productName: PRODUCT_NAME }, null, 2))
  return targetExecutable
}

const electronExecutable = process.platform === 'darwin' ? prepareMacRuntime() : require('electron')
if (process.argv.includes('--prepare-only')) {
  console.log(electronExecutable)
  process.exit(0)
}

const cli = join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
const args = process.argv.slice(2).filter((arg) => arg !== '--prepare-only')
const child = spawn(process.execPath, [cli, 'dev', ...args], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_EXEC_PATH: electronExecutable }
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}

child.on('error', (error) => {
  console.error(error)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
