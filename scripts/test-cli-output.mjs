/* Agent CLI 输出验证：默认 JSON、缩进 JSON、人类可读表格与错误通道。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatHumanResponse } from './safedb-format.mjs'
import { helpText, SUPPORTED_HELP_LOCALES } from './safedb-help.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'scripts', 'safedb.mjs')
const socketPath = join(tmpdir(), `safe-db-cli-output-${process.pid}.sock`)
if (existsSync(socketPath)) unlinkSync(socketPath)

function responseFor(request) {
  const envelope = {
    protocolVersion: '1',
    requestId: request.requestId
  }
  switch (request.method) {
    case 'connection.list':
      return {
        ...envelope,
        status: 'ok',
        data: {
          connections: [{
            id: 'conn-1',
            name: '测试库',
            type: 'postgres',
            defaultDatabase: 'app',
            permissionMode: 'approval',
            permissionModeLocked: true,
            sshEnabled: false
          }]
        }
      }
    case 'database.list':
      return {
        ...envelope,
        status: 'error',
        error: { code: 'CONNECTION_NOT_FOUND', message: '连接不存在', retryable: false }
      }
    case 'object.ddl':
      return {
        ...envelope,
        status: 'ok',
        data: { ddl: 'CREATE TABLE users (id bigint);' }
      }
    case 'sql.run':
      return {
        ...envelope,
        status: 'ok',
        data: {
          status: 'ok',
          sqlKind: 'READ',
          durationMs: 8,
          results: [{
            kind: 'rows',
            columns: [{ name: 'id' }, { name: 'name' }, { name: 'note' }],
            rows: [{ id: '1', name: 'Alice', note: null }]
          }]
        }
      }
    default:
      return {
        ...envelope,
        status: 'error',
        error: { code: 'METHOD_NOT_FOUND', message: '方法不存在', retryable: false }
      }
  }
}

const server = createServer((socket) => {
  socket.setEncoding('utf8')
  let input = ''
  socket.on('data', (chunk) => {
    input += chunk
    const newline = input.indexOf('\n')
    if (newline < 0) return
    const request = JSON.parse(input.slice(0, newline))
    socket.end(JSON.stringify(responseFor(request)) + '\n')
  })
})

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(socketPath, resolve)
})

function runCli(args, input = '', extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      env: { ...process.env, ...extraEnv, SAFE_DB_AGENT_SOCKET: socketPath },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}

try {
  const json = await runCli(['connection', 'list'])
  assert.equal(json.code, 0)
  assert.equal(json.stderr, '')
  assert.equal(json.stdout.trim().split('\n').length, 1)
  assert.equal(JSON.parse(json.stdout).data.connections[0].name, '测试库')

  const pretty = await runCli(['connection', 'list', '--format', 'pretty'])
  assert.equal(pretty.code, 0)
  assert.match(pretty.stdout, /\n  "protocolVersion": "1"/)
  assert.equal(JSON.parse(pretty.stdout).status, 'ok')

  const human = await runCli(['connection', 'list', '--human'])
  assert.equal(human.code, 0)
  assert.equal(human.stderr, '')
  assert.match(human.stdout, /ID\s+名称\s+类型/)
  assert.match(human.stdout, /conn-1\s+测试库\s+postgres/)
  assert.match(human.stdout, /共 1 个连接/)

  const ddl = await runCli([
    'object', 'ddl', '--connection', 'conn-1', '--name', 'users', '--format', 'human'
  ])
  assert.equal(ddl.stdout, 'CREATE TABLE users (id bigint);\n')

  const sql = await runCli([
    'sql', 'run', '--connection', 'conn-1', '--stdin', '--format', 'human'
  ], 'SELECT 1')
  assert.equal(sql.code, 0)
  assert.match(sql.stdout, /Alice\s+NULL/)
  assert.match(sql.stdout, /1 行/)
  assert.match(sql.stdout, /耗时：8 ms/)

  const serviceError = await runCli([
    'database', 'list', '--connection', 'missing', '--format', 'human'
  ])
  assert.equal(serviceError.code, 11)
  assert.equal(serviceError.stdout, '')
  assert.match(serviceError.stderr, /错误 \[CONNECTION_NOT_FOUND\]：连接不存在/)

  const cliError = await runCli(['connection', 'list', '--format', 'invalid'])
  assert.equal(cliError.code, 2)
  assert.equal(JSON.parse(cliError.stdout).error.code, 'CLI_ERROR')

  const conflictingFormats = await runCli(['connection', 'list', '--human', '--format', 'json'])
  assert.equal(conflictingFormats.code, 2)
  assert.equal(conflictingFormats.stdout, '')
  assert.match(conflictingFormats.stderr, /--human 不能与非 human 的 --format/)

  const chineseHelp = await runCli(['--help', '--lang', 'zh-CN'])
  assert.equal(chineseHelp.code, 0)
  assert.match(chineseHelp.stdout, /命令:/)
  assert.match(chineseHelp.stdout, /帮助语言:/)

  const englishHelp = await runCli(['--help', '--lang', 'en-US'])
  assert.equal(englishHelp.code, 0)
  assert.match(englishHelp.stdout, /Commands:/)
  assert.match(englishHelp.stdout, /Help language:/)

  const japaneseCommandHelp = await runCli(['help', 'table', 'describe', '--lang', 'ja-JP'])
  assert.equal(japaneseCommandHelp.code, 0)
  assert.match(japaneseCommandHelp.stdout, /使用方法:/)
  assert.match(japaneseCommandHelp.stdout, /テーブル構造/)

  const globalLanguageBeforeHelp = await runCli(['--lang', 'de-DE', 'help', 'connection', 'list'])
  assert.equal(globalLanguageBeforeHelp.code, 0)
  assert.match(globalLanguageBeforeHelp.stdout, /Verwendung:/)
  assert.match(globalLanguageBeforeHelp.stdout, /gespeicherte Verbindungen/)

  const environmentHelp = await runCli(['--help'], '', { SAFE_DB_LANG: 'fr-FR' })
  assert.equal(environmentHelp.code, 0)
  assert.match(environmentHelp.stdout, /Commandes:/)

  const invalidHelpLocale = await runCli(['--help', '--lang', 'xx-XX'])
  assert.equal(invalidHelpLocale.code, 2)
  assert.equal(JSON.parse(invalidHelpLocale.stdout).error.code, 'CLI_ERROR')

  const missingHelpLocale = await runCli(['--help', '--lang'])
  assert.equal(missingHelpLocale.code, 2)
  assert.match(JSON.parse(missingHelpLocale.stdout).error.message, /--lang requires a value/)

  for (const locale of SUPPORTED_HELP_LOCALES) {
    const localizedRoot = helpText(['--help'], locale)
    const localizedCommand = helpText(['help', 'sql', 'run'], locale)
    assert.doesNotMatch(localizedRoot, /undefined/)
    assert.doesNotMatch(localizedCommand, /undefined/)
    assert.match(localizedRoot, /--lang <locale>/)
    assert.match(localizedCommand, /safedb sql run/)
  }

  const description = formatHumanResponse({
    status: 'partial',
    data: {
      summary: { requested: 2, succeeded: 1, failed: 1 },
      tables: [{
        status: 'ok',
        schema: 'public',
        name: 'users',
        type: 'table',
        columns: [{
          name: 'display_name',
          dataType: 'varchar(255)',
          nullable: false,
          primaryKey: false,
          autoIncrement: false,
          defaultValue: null,
          comment: '这是一段超过四十个终端宽度的很长很长很长很长很长字段备注'
        }],
        indexes: [],
        foreignKeys: [],
        checks: []
      }, {
        status: 'error',
        name: 'missing',
        error: { code: 'TABLE_NOT_FOUND', message: '表不存在' }
      }]
    }
  }, 'table.describe')
  assert.match(description, /表：public\.users/)
  assert.match(description, /读取失败 \[TABLE_NOT_FOUND\]：表不存在/)
  assert.match(description, /汇总：请求 2，成功 1，失败 1/)
  assert.match(description, /使用 --format json 查看完整值/)
} finally {
  await new Promise((resolve) => server.close(resolve))
  if (existsSync(socketPath)) unlinkSync(socketPath)
}

console.log('✔ Agent CLI 输出格式测试通过')
