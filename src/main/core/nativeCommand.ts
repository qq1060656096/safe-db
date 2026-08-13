import type { DbType, SqlKind } from '../../shared/types'
import { classifySql, type ClassifiedSql } from './sqlClassify'

export interface MongoCommandInput {
  raw: string
  command: Record<string, unknown>
}

export interface RedisCommandInput {
  raw: string
  args: string[]
}

/** 收集 SQL 正文中的 @name 引用，忽略 @@系统变量、字符串、标识符和注释。 */
function referencedMysqlUserVariables(input: string): Set<string> {
  const names = new Set<string>()
  let quote: "'" | '"' | '`' | null = null
  let lineComment = false
  let blockComment = false

  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    const next = input[i + 1]
    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') { i++; blockComment = false }
      continue
    }
    if (quote) {
      if (char === '\\') i++
      else if (char === quote) {
        if (next === quote) i++
        else quote = null
      }
      continue
    }
    if ((char === '-' && next === '-') || char === '#') {
      if (char === '-') i++
      lineComment = true
      continue
    }
    if (char === '/' && next === '*') { i++; blockComment = true; continue }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue }
    if (char !== '@' || next === '@' || input[i - 1] === '@') continue
    const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(input.slice(i + 1))
    if (!match) continue
    names.add(match[0].toLowerCase())
    i += match[0].length
  }
  return names
}

/**
 * 兼容查询编辑器中常见的 MySQL 用户变量简写：
 *   @name = 'value';              → SET @name = 'value';
 *   SET name = 'value'; ... @name → SET @name = 'value'; ... @name
 * 第二种仅在正文中确实存在同名 @name 引用时转换，避免改写 autocommit、sql_mode
 * 等合法系统变量。扫描会避开字符串、标识符和注释。
 */
export function normalizeMysqlSessionVariables(input: string): string {
  const referencedVariables = referencedMysqlUserVariables(input)
  let output = ''
  let statementStart = true
  let quote: "'" | '"' | '`' | null = null
  let lineComment = false
  let blockComment = false

  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    const next = input[i + 1]

    if (lineComment) {
      output += char
      if (char === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      output += char
      if (char === '*' && next === '/') {
        output += next
        i++
        blockComment = false
      }
      continue
    }
    if (quote) {
      output += char
      if (char === '\\') {
        if (next !== undefined) {
          output += next
          i++
        }
      } else if (char === quote) {
        if (next === quote) {
          output += next
          i++
        } else {
          quote = null
        }
      }
      continue
    }

    if ((char === '-' && next === '-') || char === '#') {
      output += char
      if (char === '-') {
        output += next
        i++
      }
      lineComment = true
      continue
    }
    if (char === '/' && next === '*') {
      output += char + next
      i++
      blockComment = true
      continue
    }
    if (/\s/.test(char)) {
      output += char
      continue
    }
    if (char === ';') {
      output += char
      statementStart = true
      continue
    }
    if (statementStart) {
      const setAssignment = /^(SET)(\s+)([A-Za-z_][A-Za-z0-9_$]*)(?=\s*=)/i.exec(input.slice(i))
      if (setAssignment && referencedVariables.has(setAssignment[3].toLowerCase())) {
        output += `${setAssignment[1]}${setAssignment[2]}@${setAssignment[3]}`
        i += setAssignment[0].length - 1
        statementStart = false
        continue
      }
      if (/^@[A-Za-z_][A-Za-z0-9_$]*\s*=/.test(input.slice(i))) output += 'SET '
      statementStart = false
    }
    if (char === "'" || char === '"' || char === '`') quote = char
    output += char
  }

  return output
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function parseMongoCommands(input: string): MongoCommandInput[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch (error) {
    throw new Error(`MongoDB 命令必须是 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  const values = Array.isArray(parsed) ? parsed : [parsed]
  if (!values.length) throw new Error('MongoDB 命令不能为空')
  return values.map((value) => {
    const command = recordValue(value)
    if (!command || Object.keys(command).length === 0) throw new Error('MongoDB 命令必须是非空 JSON 对象')
    return { raw: JSON.stringify(value), command }
  })
}

/** 解析一行 Redis CLI 语法，支持单/双引号和反斜杠转义。 */
function parseRedisLine(line: string): string[] {
  const args: string[] = []
  let value = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  let started = false
  for (const char of line) {
    if (escaped) {
      value += char === 'n' ? '\n' : char === 'r' ? '\r' : char === 't' ? '\t' : char
      escaped = false
      started = true
      continue
    }
    if (char === '\\') {
      escaped = true
      started = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      else value += char
      started = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) {
        args.push(value)
        value = ''
        started = false
      }
    } else {
      value += char
      started = true
    }
  }
  if (escaped) value += '\\'
  if (quote) throw new Error('Redis 命令存在未闭合的引号')
  if (started) args.push(value)
  return args
}

export function parseRedisCommands(input: string): RedisCommandInput[] {
  const commands: RedisCommandInput[] = []
  for (const rawLine of input.split(/\r?\n/)) {
    const raw = rawLine.trim()
    if (!raw || raw.startsWith('#')) continue
    const args = parseRedisLine(raw)
    if (args.length) commands.push({ raw, args })
  }
  if (!commands.length) throw new Error('Redis 命令不能为空')
  return commands
}

const MONGO_READ = new Set([
  'aggregate', 'buildinfo', 'collstats', 'count', 'dbstats', 'distinct', 'explain', 'find',
  'getmore', 'hello', 'listcollections', 'listdatabases', 'listindexes', 'ping', 'serverstatus'
])
const MONGO_DDL = new Set([
  'collmod', 'converttoCapped'.toLowerCase(), 'create', 'createindexes', 'drop', 'dropdatabase',
  'dropindexes', 'renamecollection'
])

export function classifyMongoCommand(command: Record<string, unknown>): SqlKind {
  const name = Object.keys(command)[0]?.toLowerCase() ?? ''
  if (name === 'aggregate') {
    const pipeline = Array.isArray(command.pipeline) ? command.pipeline : []
    if (pipeline.some((stage) => {
      const value = recordValue(stage)
      return value ? ('$out' in value || '$merge' in value) : false
    })) return 'WRITE'
  }
  if (MONGO_READ.has(name)) return 'READ'
  if (MONGO_DDL.has(name)) return 'DDL'
  return 'WRITE'
}

const REDIS_READ = new Set([
  'BITCOUNT', 'BITFIELD_RO', 'BITPOS', 'DBSIZE', 'DUMP', 'ECHO', 'EXISTS', 'EXPIRETIME', 'GEODIST',
  'GEOHASH', 'GEOPOS', 'GEORADIUS_RO', 'GEORADIUSBYMEMBER_RO', 'GEOSEARCH', 'GET', 'GETBIT', 'GETRANGE',
  'HEXISTS', 'HGET', 'HGETALL', 'HKEYS', 'HLEN', 'HMGET', 'HRANDFIELD', 'HSCAN', 'HSTRLEN', 'HVALS',
  'INFO', 'KEYS', 'LINDEX', 'LLEN', 'LPOS', 'LRANGE', 'MGET', 'OBJECT', 'PING', 'PTTL', 'RANDOMKEY',
  'SCAN', 'SCARD', 'SDIFF', 'SINTER', 'SISMEMBER', 'SMEMBERS', 'SMISMEMBER', 'SRANDMEMBER', 'SSCAN',
  'STRLEN', 'SUNION', 'TIME', 'TTL', 'TYPE', 'XINFO', 'XLEN', 'XPENDING', 'XRANGE', 'XREAD', 'XREVRANGE',
  'ZCARD', 'ZCOUNT', 'ZDIFF', 'ZINTER', 'ZLEXCOUNT', 'ZMSCORE', 'ZRANDMEMBER', 'ZRANGE', 'ZRANGEBYLEX',
  'ZRANGEBYSCORE', 'ZRANK', 'ZREVRANGE', 'ZREVRANGEBYLEX', 'ZREVRANGEBYSCORE', 'ZREVRANK', 'ZSCAN',
  'ZSCORE', 'ZUNION'
])
const REDIS_DDL = new Set(['FLUSHALL', 'FLUSHDB'])

export function classifyRedisCommand(args: string[]): SqlKind {
  const name = args[0]?.toUpperCase() ?? ''
  if (REDIS_READ.has(name)) return 'READ'
  if (REDIS_DDL.has(name)) return 'DDL'
  return 'WRITE'
}

const SEVERITY: Record<SqlKind, number> = { READ: 0, OTHER: 1, WRITE: 2, DDL: 3 }

function combine(statements: ClassifiedSql['statements']): ClassifiedSql {
  return {
    kind: statements.reduce<SqlKind>((current, item) => SEVERITY[item.kind] > SEVERITY[current] ? item.kind : current, 'READ'),
    statements
  }
}

export function classifyDatabaseInput(type: DbType, input: string): ClassifiedSql {
  if (type === 'mongodb') {
    return combine(parseMongoCommands(input).map((item) => ({ sql: item.raw, kind: classifyMongoCommand(item.command) })))
  }
  if (type === 'redis') {
    return combine(parseRedisCommands(input).map((item) => ({ sql: item.raw, kind: classifyRedisCommand(item.args) })))
  }
  if (type === 'mysql') return classifySql(normalizeMysqlSessionVariables(input))
  return classifySql(input)
}
