#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatResponse } from './safedb-format.mjs'
import { helpText, isHelpRequest, resolveHelpLocale } from './safedb-help.mjs'

const PROTOCOL_VERSION = '1'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

class CliError extends Error {
  constructor(code, message, exitCode = 2) {
    super(message)
    this.code = code
    this.exitCode = exitCode
  }
}

function responseError(code, message, retryable = false, details) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: `cli_${randomUUID()}`,
    status: 'error',
    error: { code, message, retryable, ...(details === undefined ? {} : { details }) }
  }
}

function writeResponse(response, method, format) {
  const output = formatResponse(response, method, format) + '\n'
  if (format === 'human' && response.status === 'error') process.stderr.write(output)
  else process.stdout.write(output)
}

function fail(code, message, exitCode = 2, details, format = 'json') {
  writeResponse(responseError(code, message, false, details), undefined, format)
  process.exitCode = exitCode
}

function userDataPath() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'safe db')
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'safe db')
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'safe db')
}

function socketPath() {
  if (process.env.SAFE_DB_AGENT_SOCKET) return process.env.SAFE_DB_AGENT_SOCKET
  return process.platform === 'win32' ? '\\\\.\\pipe\\safe-db-agent' : join(userDataPath(), 'agent.sock')
}

function parseArgs(argv) {
  const positionals = []
  const options = new Map()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const key = arg.slice(2)
    if (key === 'stdin' || key === 'human') {
      options.set(key, true)
      continue
    }
    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) throw new Error(`参数 --${key} 缺少值`)
    const current = options.get(key)
    if (current === undefined) options.set(key, value)
    else if (Array.isArray(current)) current.push(value)
    else options.set(key, [current, value])
  }
  return { positionals, options }
}

function outputFormat(options) {
  const human = options.get('human') === true
  const format = one(options, 'format') ?? 'json'
  if (!['json', 'pretty', 'human'].includes(format)) {
    throw new Error('--format 必须是 json、pretty 或 human')
  }
  if (human && options.has('format') && format !== 'human') {
    throw new Error('--human 不能与非 human 的 --format 同时使用')
  }
  return human ? 'human' : format
}

function hintedOutputFormat(rawArgs) {
  if (rawArgs.includes('--human')) return 'human'
  const index = rawArgs.lastIndexOf('--format')
  return ['json', 'pretty', 'human'].includes(rawArgs[index + 1]) ? rawArgs[index + 1] : 'json'
}

function one(options, key, required = false) {
  const value = options.get(key)
  if (Array.isArray(value)) throw new Error(`参数 --${key} 不能重复`)
  if (required && (typeof value !== 'string' || !value)) throw new Error(`缺少参数 --${key}`)
  return typeof value === 'string' ? value : undefined
}

function many(options, key) {
  const value = options.get(key)
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

async function stdinText() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function sqlText(options) {
  const useStdin = options.get('stdin') === true
  const file = one(options, 'file')
  if (useStdin === Boolean(file)) throw new Error('SQL 必须且只能通过 --stdin 或 --file 提供')
  const sql = useStdin ? await stdinText() : await readFile(resolve(String(file)), 'utf8')
  if (!sql.trim()) throw new Error('SQL 不能为空')
  return sql
}

async function commandRequest(positionals, options) {
  const command = positionals.slice(0, 2).join(' ')
  switch (command) {
    case 'version':
    case 'capabilities':
      return { method: 'capabilities', params: {} }
    case 'connection list':
      return { method: 'connection.list', params: {} }
    case 'database list':
      return { method: 'database.list', params: { connection: one(options, 'connection', true) } }
    case 'object list':
      return {
        method: 'object.list',
        params: {
          connection: one(options, 'connection', true),
          database: one(options, 'database')
        }
      }
    case 'object ddl':
      return {
        method: 'object.ddl',
        params: {
          connection: one(options, 'connection', true),
          database: one(options, 'database'),
          schema: one(options, 'schema'),
          name: one(options, 'name', true)
        }
      }
    case 'table describe': {
      const tables = many(options, 'table')
      if (tables.length === 0) throw new Error('至少需要一个 --table 参数')
      return {
        method: 'table.describe',
        params: {
          connection: one(options, 'connection', true),
          database: one(options, 'database'),
          schema: one(options, 'schema'),
          tables
        }
      }
    }
    case 'sql check':
    case 'sql run':
      return {
        method: command.replace(' ', '.'),
        params: {
          connection: one(options, 'connection', true),
          database: one(options, 'database'),
          sql: await sqlText(options)
        }
      }
    case 'request get':
      return { method: 'request.get', params: { requestId: positionals[2] || one(options, 'id', true) } }
    case 'request wait': {
      const seconds = Number(one(options, 'timeout') ?? '30')
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) throw new Error('--timeout 必须是 0 到 60 秒')
      return {
        method: 'request.wait',
        params: { requestId: positionals[2] || one(options, 'id', true), timeoutMs: seconds * 1000 }
      }
    }
    default:
      throw new Error(`未知命令：${command || '(空)'}`)
  }
}

function exchange(request) {
  return new Promise((resolveResponse, reject) => {
    const socket = createConnection(socketPath())
    socket.setEncoding('utf8')
    let output = ''
    socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'))
    socket.on('data', (chunk) => { output += chunk })
    socket.once('end', () => {
      try {
        resolveResponse(JSON.parse(output))
      } catch {
        reject(new Error('safe db 返回了无效响应'))
      }
    })
    socket.once('error', reject)
  })
}

function startService() {
  const mainEntry = join(root, 'out', 'main', 'index.js')
  if (!existsSync(mainEntry)) {
    throw new CliError('BUILD_REQUIRED', '尚未构建 safe db，请先运行 npm run build')
  }
  const prepared = spawnSync(process.execPath, [join(root, 'scripts', 'dev.mjs'), '--prepare-only'], {
    cwd: root,
    encoding: 'utf8'
  })
  if (prepared.status !== 0) throw new CliError('SERVICE_START_FAILED', prepared.stderr?.trim() || '无法准备 Electron 运行时', 30)
  const executable = prepared.stdout.trim().split(/\r?\n/).at(-1)
  if (!executable) throw new CliError('SERVICE_START_FAILED', '无法找到 Electron 运行时', 30)
  const child = spawn(executable, [root, '--agent-headless'], {
    cwd: root,
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
  return child
}

async function sendWithAutoStart(request) {
  try {
    return await exchange(request)
  } catch (firstError) {
    const code = firstError && typeof firstError === 'object' ? firstError.code : undefined
    if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw firstError
    const starter = startService()
    let starterExited = false
    starter.once('exit', () => { starterExited = true })
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
      try {
        return await exchange(request)
      } catch (error) {
        const retryCode = error && typeof error === 'object' ? error.code : undefined
        if (retryCode !== 'ENOENT' && retryCode !== 'ECONNREFUSED') throw error
      }
      if (starterExited && attempt >= 19) {
        throw new CliError(
          'SERVICE_RESTART_REQUIRED',
          '检测到已有 safe db 进程，但该进程没有启动 Agent CLI 服务；请完全退出并重新启动 safe db',
          30
        )
      }
    }
    throw new CliError('SERVICE_START_TIMEOUT', 'safe db 后台服务启动超时', 30)
  }
}

function exitCode(response) {
  if (response.status === 'denied') return 10
  if (response.status !== 'error') return 0
  const code = response.error?.code
  if (code === 'CONNECTION_NOT_FOUND' || code === 'AMBIGUOUS_CONNECTION') return 11
  if (code === 'TABLE_NOT_FOUND' || code === 'TABLES_NOT_FOUND') return 12
  if (code === 'SQL_EXECUTION_FAILED') return 20
  if (code === 'PROTOCOL_VERSION_MISMATCH') return 40
  return 2
}

const rawArgs = process.argv.slice(2)
let selectedOutputFormat = hintedOutputFormat(rawArgs)

try {
  const wantsHelp = isHelpRequest(rawArgs)
  if (wantsHelp) {
    process.stdout.write(helpText(rawArgs, resolveHelpLocale(rawArgs)) + '\n')
  } else {
    const { positionals, options } = parseArgs(rawArgs)
    if (options.has('lang')) throw new Error('--lang 仅用于 help 或 --help')
    selectedOutputFormat = outputFormat(options)
    const command = await commandRequest(positionals, options)
    const request = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: `cli_${randomUUID()}`,
      method: command.method,
      params: command.params
    }
    const response = await sendWithAutoStart(request)
    writeResponse(response, command.method, selectedOutputFormat)
    process.exitCode = exitCode(response)
  }
} catch (error) {
  fail(
    error instanceof CliError ? error.code : 'CLI_ERROR',
    error instanceof Error ? error.message : String(error),
    error instanceof CliError ? error.exitCode : 2,
    undefined,
    selectedOutputFormat
  )
}
