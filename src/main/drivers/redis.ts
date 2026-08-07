import { createClient } from 'redis'
import type {
  ColumnInfo,
  CheckConstraintInfo,
  ForeignKeyInfo,
  IndexInfo,
  QueryResult,
  RoutineInfo,
  TableInfo
} from '../../shared/types'
import { classifyRedisCommand, parseRedisCommands, type RedisCommandInput } from '../core/nativeCommand'
import type { DbDriver, TableDataQuery, TableDataResult } from './base'

function newRedisClient(url: string, database: number) {
  return createClient({ url, database })
}

type RedisClient = ReturnType<typeof newRedisClient>

const FORBIDDEN_COMMANDS = new Set([
  'AUTH', 'CLIENT', 'CLUSTER', 'DISCARD', 'EXEC', 'HELLO', 'MONITOR', 'MULTI', 'PSYNC', 'QUIT',
  'READONLY', 'READWRITE', 'REPLCONF', 'REPLICAOF', 'SELECT', 'SHUTDOWN', 'SLAVEOF', 'SYNC', 'UNWATCH', 'WATCH'
])

function databaseNumber(value?: string): number {
  if (!value) return 0
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error('Redis 数据库必须是非负整数')
  return parsed
}

function displayValue(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}

function matchesFilters(row: Record<string, unknown>, query: TableDataQuery): boolean {
  return (query.filters ?? []).every((filter) => {
    const value = row[filter.column]
    const text = value === null || value === undefined ? '' : String(value)
    const target = filter.value ?? ''
    if (filter.op === 'null') return value === null || value === undefined
    if (filter.op === 'notnull') return value !== null && value !== undefined
    if (filter.op === 'like') return text.toLocaleLowerCase().includes(target.toLocaleLowerCase())
    if (filter.op === 'notlike') return !text.toLocaleLowerCase().includes(target.toLocaleLowerCase())
    const leftNumber = Number(text)
    const rightNumber = Number(target)
    const [left, right] = Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
      ? [leftNumber, rightNumber]
      : [text, target]
    if (filter.op === '=') return left === right
    if (filter.op === '!=') return left !== right
    if (filter.op === '>') return left > right
    if (filter.op === '>=') return left >= right
    if (filter.op === '<') return left < right
    return left <= right
  })
}

export class RedisDriver implements DbDriver {
  private clients = new Map<number, RedisClient>()

  constructor(
    private cfg: {
      host: string
      port: number
      user?: string
      password?: string
      database?: string
      tls?: boolean
    }
  ) {}

  private url(): string {
    const protocol = this.cfg.tls ? 'rediss' : 'redis'
    const auth = this.cfg.user
      ? `${encodeURIComponent(this.cfg.user)}:${encodeURIComponent(this.cfg.password ?? '')}@`
      : this.cfg.password ? `:${encodeURIComponent(this.cfg.password)}@` : ''
    return `${protocol}://${auth}${this.cfg.host}:${this.cfg.port}`
  }

  private async clientFor(database?: string): Promise<RedisClient> {
    const db = databaseNumber(database ?? this.cfg.database)
    const existing = this.clients.get(db)
    if (existing?.isReady) return existing
    if (existing) await existing.close().catch(() => {})
    const client = newRedisClient(this.url(), db)
    client.on('error', () => {})
    await client.connect()
    this.clients.set(db, client)
    return client
  }

  async connect(): Promise<void> {
    await this.clientFor(this.cfg.database)
  }

  async disconnect(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.close().catch(() => {})))
    this.clients.clear()
  }

  async cancel(): Promise<void> {
    // close() 会等待命令队列排空；停止查询需要直接销毁 socket。
    for (const client of this.clients.values()) client.destroy()
    this.clients.clear()
  }

  async test(): Promise<void> {
    const client = newRedisClient(this.url(), databaseNumber(this.cfg.database))
    client.on('error', () => {})
    try {
      await client.connect()
      await client.ping()
    } finally {
      await client.close().catch(() => {})
    }
  }

  async listDatabases(): Promise<string[]> {
    const client = await this.clientFor(this.cfg.database)
    const active = databaseNumber(this.cfg.database)
    let count = 0
    try {
      const reply = await client.sendCommand(['CONFIG', 'GET', 'databases'])
      if (Array.isArray(reply)) count = Number(reply[1] ?? 0)
      else if (reply && typeof reply === 'object') count = Number((reply as unknown as Record<string, unknown>).databases ?? 0)
    } catch {
      // 托管 Redis 常禁用 CONFIG，下面从 INFO keyspace 补齐可见库。
    }
    const databases = new Set<number>([active])
    try {
      const info = await client.info('keyspace')
      for (const match of info.matchAll(/^db(\d+):/gm)) databases.add(Number(match[1]))
    } catch {}
    if (count > 0 && count <= 256) for (let index = 0; index < count; index += 1) databases.add(index)
    return [...databases].sort((left, right) => left - right).map(String)
  }

  private async scanKeys(database?: string, limit = 5000): Promise<string[]> {
    const client = await this.clientFor(database)
    const keys: string[] = []
    let cursor = '0'
    do {
      const response = await client.scan(cursor, { COUNT: Math.min(500, limit - keys.length) })
      cursor = response.cursor
      keys.push(...response.keys)
    } while (cursor !== '0' && keys.length < limit)
    return keys.slice(0, limit).sort()
  }

  async listTables(database?: string, includeStats = false): Promise<TableInfo[]> {
    const client = await this.clientFor(database)
    const keys = await this.scanKeys(database)
    const pipeline = client.multi()
    for (const key of keys) pipeline.sendCommand(['TYPE', key])
    const types = keys.length ? await pipeline.execAsPipeline() : []
    const tables = keys.map((key, index): TableInfo => ({
      name: key,
      type: 'table',
      comment: `Redis ${String(types[index] ?? 'unknown')}`
    }))
    if (includeStats) {
      const stats = client.multi()
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]
        switch (String(types[index])) {
          case 'hash': stats.sendCommand(['HLEN', key]); break
          case 'list': stats.sendCommand(['LLEN', key]); break
          case 'set': stats.sendCommand(['SCARD', key]); break
          case 'zset': stats.sendCommand(['ZCARD', key]); break
          case 'stream': stats.sendCommand(['XLEN', key]); break
          default: stats.sendCommand(['EXISTS', key])
        }
      }
      const counts = keys.length ? await stats.execAsPipeline() : []
      tables.forEach((table, index) => { table.rowCount = Number(counts[index] ?? 0) })
    }
    return tables
  }

  async listRoutines(): Promise<RoutineInfo[]> {
    return []
  }

  private columnsForType(type: string): ColumnInfo[] {
    const names = type === 'string' ? ['value']
      : type === 'hash' ? ['field', 'value']
        : type === 'list' ? ['index', 'value']
          : type === 'set' ? ['member']
            : type === 'zset' ? ['member', 'score']
              : type === 'stream' ? ['id', 'value'] : ['value']
    return names.map((name, ordinal) => ({
      name,
      dataType: name === 'score' ? 'number' : name === 'index' ? 'integer' : 'string',
      nullable: false,
      isPrimaryKey: name === 'field' || name === 'index' || name === 'member' || name === 'id',
      defaultValue: null,
      ordinal
    }))
  }

  async listColumns(database: string | undefined, table: string): Promise<ColumnInfo[]> {
    const type = await (await this.clientFor(database)).type(table)
    if (type === 'none') throw new Error('Redis key 不存在')
    return this.columnsForType(type)
  }

  async listIndexes(): Promise<IndexInfo[]> {
    return []
  }

  async listForeignKeys(): Promise<ForeignKeyInfo[]> {
    return []
  }

  async listCheckConstraints(): Promise<CheckConstraintInfo[]> {
    return []
  }

  async getObjectDdl(database: string | undefined, table: string): Promise<string> {
    const client = await this.clientFor(database)
    const [type, ttl] = await Promise.all([client.type(table), client.ttl(table)])
    if (type === 'none') throw new Error('Redis key 不存在')
    return `# Redis key metadata\nTYPE ${JSON.stringify(table)}\nTTL ${JSON.stringify(table)}\n# type=${type}, ttl=${ttl}`
  }

  async getRoutineDefinition(): Promise<string> {
    throw new Error('Redis 不支持 SQL 函数或存储过程')
  }

  private async keyRows(database: string | undefined, key: string, type: string): Promise<Record<string, unknown>[]> {
    const client = await this.clientFor(database)
    if (type === 'string') return [{ value: await client.get(key) }]
    if (type === 'hash') {
      const values = await client.hGetAll(key)
      return Object.entries(values).map(([field, value]) => ({ field, value }))
    }
    if (type === 'list') return (await client.lRange(key, 0, -1)).map((value, index) => ({ index, value }))
    if (type === 'set') return (await client.sMembers(key)).map((member) => ({ member }))
    if (type === 'zset') return (await client.zRangeWithScores(key, 0, -1)).map((item) => ({ member: item.value, score: item.score }))
    if (type === 'stream') {
      const response = await client.sendCommand(['XRANGE', key, '-', '+'])
      if (!Array.isArray(response)) return []
      return response.map((item) => {
        if (!Array.isArray(item)) return { value: displayValue(item) }
        const values = Array.isArray(item[1]) ? item[1] : []
        const fields: Record<string, unknown> = {}
        for (let index = 0; index < values.length; index += 2) fields[String(values[index])] = displayValue(values[index + 1])
        return { id: String(item[0]), value: JSON.stringify(fields) }
      })
    }
    return [{ value: displayValue(await client.sendCommand(['DUMP', key])) }]
  }

  async getTableData(query: TableDataQuery): Promise<TableDataResult> {
    const client = await this.clientFor(query.database)
    const type = await client.type(query.table)
    if (type === 'none') throw new Error('Redis key 不存在')
    let rows = (await this.keyRows(query.database, query.table, type)).filter((row) => matchesFilters(row, query))
    if (query.orderBy?.length) {
      rows.sort((left, right) => {
        for (const order of query.orderBy ?? []) {
          const comparison = String(left[order.column] ?? '').localeCompare(String(right[order.column] ?? ''), undefined, { numeric: true })
          if (comparison) return order.direction === 'desc' ? -comparison : comparison
        }
        return 0
      })
    }
    const total = rows.length
    rows = rows.slice((query.page - 1) * query.pageSize, query.page * query.pageSize)
    return {
      columns: this.columnsForType(type),
      rows,
      total,
      editable: false,
      keyColumns: []
    }
  }

  private validateCommand(command: RedisCommandInput): void {
    const name = command.args[0]?.toUpperCase() ?? ''
    if (FORBIDDEN_COMMANDS.has(name)) {
      throw new Error(`不允许在查询编辑器执行 ${name}，请使用连接配置或数据库下拉框`)
    }
  }

  private result(command: RedisCommandInput, value: unknown): QueryResult {
    if (classifyRedisCommand(command.args) !== 'READ') {
      const affected = typeof value === 'number' || typeof value === 'bigint' ? Number(value) : value === null ? 0 : 1
      return { kind: 'exec', affectedRows: affected }
    }
    let rows: Record<string, unknown>[]
    if (Array.isArray(value)) {
      rows = value.map((item, index) => Array.isArray(item)
        ? { index, value: JSON.stringify(item.map(displayValue)) }
        : { index, value: displayValue(item) })
    } else if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
      rows = Object.entries(value as Record<string, unknown>).map(([key, item]) => ({ key, value: displayValue(item) }))
    } else rows = [{ result: displayValue(value) }]
    return { kind: 'rows', columns: Object.keys(rows[0] ?? {}).map((name) => ({ name })), rows }
  }

  async run(input: string, database?: string): Promise<QueryResult[]> {
    const client = await this.clientFor(database)
    const commands = parseRedisCommands(input)
    const results: QueryResult[] = []
    for (const command of commands) {
      this.validateCommand(command)
      results.push(this.result(command, await client.sendCommand(command.args)))
    }
    return results
  }

  async runInTransaction(inputs: string[], database?: string): Promise<QueryResult[]> {
    const client = await this.clientFor(database)
    const commands = inputs.flatMap(parseRedisCommands)
    const transaction = client.multi()
    for (const command of commands) {
      this.validateCommand(command)
      transaction.sendCommand(command.args)
    }
    const values = await transaction.exec()
    return commands.map((command, index) => this.result(command, values[index]))
  }
}
