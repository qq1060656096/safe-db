import { createClient } from 'redis'
import type {
  DatabaseOperation,
  ColumnInfo,
  CheckConstraintInfo,
  ForeignKeyInfo,
  IndexInfo,
  QueryResult,
  RoutineInfo,
  TableInfo
} from '../../shared/types'
import { classifyRedisCommand, parseRedisCommands, type RedisCommandInput } from '../core/nativeCommand'
import type { DbDriver, DriverOperationResult, TableDataQuery, TableDataResult } from './base'
import { capabilitiesForType } from './capabilities'
import { traceExecution } from '../audit/trace'

function newRedisClient(url: string, database: number) {
  return createClient({ url, database })
}

type RedisClient = ReturnType<typeof newRedisClient>

const REDIS_WRITE_COMMANDS = new Set([
  'SET', 'DEL', 'HSET', 'HDEL', 'LPUSH', 'RPUSH', 'LSET', 'LREM', 'SADD', 'SREM',
  'ZADD', 'ZREM', 'XADD', 'XDEL', 'RESTORE', 'EXPIRE', 'PEXPIRE', 'EVAL'
])

function redisMetrics(commandName: string, result: unknown): { returnedRows?: number; affectedRows?: number } {
  if (REDIS_WRITE_COMMANDS.has(commandName)) {
    return { affectedRows: typeof result === 'number' || typeof result === 'bigint' ? Number(result) : result === null ? 0 : 1 }
  }
  if (Array.isArray(result)) return { returnedRows: result.length }
  if (result && typeof result === 'object') return { returnedRows: Object.keys(result).length }
  return { returnedRows: result === null || result === undefined ? 0 : 1 }
}

function traceRedisMulti(multi: object, database: number): object {
  const commands: unknown[][] = []
  let proxy: object
  proxy = new Proxy(multi, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function' || typeof property !== 'string') return value
      if (property === 'exec' || property === 'execAsPipeline') {
        return (...args: unknown[]) => traceExecution({
          protocol: 'redis', driverType: 'redis',
          commandName: property === 'exec' ? 'MULTI' : 'PIPELINE', databaseName: String(database),
          sensitive: { command: commands }
        }, () => value.apply(target, args), (result) => ({ returnedRows: Array.isArray(result) ? result.length : null }))
      }
      return (...args: unknown[]) => {
        const command = property === 'sendCommand' && Array.isArray(args[0])
          ? args[0] as unknown[]
          : [property.toUpperCase(), ...args]
        commands.push(command)
        value.apply(target, args)
        return proxy
      }
    }
  })
  return proxy
}

function traceRedisClient(client: RedisClient, database: number): RedisClient {
  const excluded = new Set(['on', 'connect', 'close', 'destroy', 'quit', 'duplicate'])
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function' || typeof property !== 'string') return value
      if (excluded.has(property)) return value.bind(target)
      if (property === 'multi') return (...args: unknown[]) => traceRedisMulti(value.apply(target, args), database)
      return (...args: unknown[]) => {
        const command = property === 'sendCommand' && Array.isArray(args[0])
          ? args[0] as unknown[]
          : [property.toUpperCase(), ...args]
        const commandName = String(command[0] ?? property).toUpperCase()
        return traceExecution({
          protocol: 'redis', driverType: 'redis', commandName, databaseName: String(database),
          sensitive: { command }
        }, () => value.apply(target, args), (result) => redisMetrics(commandName, result))
      }
    }
  }) as RedisClient
}

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

function redisScalar(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function streamFields(value: unknown): string[] {
  let document = value
  if (typeof value === 'string') {
    try { document = JSON.parse(value) } catch { document = { value } }
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) document = { value: document }
  const fields = Object.entries(document as Record<string, unknown>).flatMap(([name, item]) => [name, redisScalar(item)])
  if (!fields.length) throw new Error('Redis Stream 记录至少需要一个字段')
  return fields
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
  readonly capabilities = capabilitiesForType('redis')
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
    const client = traceRedisClient(newRedisClient(this.url(), db), db)
    client.on('error', () => {})
    await traceExecution({
      protocol: 'driver', driverType: 'redis', commandName: 'CONNECT', databaseName: String(db),
      sensitive: { command: { action: 'connect' } }
    }, () => client.connect())
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
    const database = databaseNumber(this.cfg.database)
    const client = traceRedisClient(newRedisClient(this.url(), database), database)
    client.on('error', () => {})
    try {
      await traceExecution({
        protocol: 'driver', driverType: 'redis', commandName: 'CONNECT', databaseName: String(database),
        sensitive: { command: { action: 'connect' } }
      }, () => client.connect())
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
    return [...new Set(keys)].slice(0, limit).sort()
  }

  async listTables(database?: string, includeStats = false, options?: { forExport?: boolean }): Promise<TableInfo[]> {
    const client = await this.clientFor(database)
    const keys = await this.scanKeys(database, options?.forExport ? Infinity : 5000)
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
    if (type === 'string') return [{ __key__: key, value: await client.get(key) }]
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
      columns: type === 'string'
        ? [{ name: '__key__', dataType: 'key', nullable: false, isPrimaryKey: true, defaultValue: null, ordinal: 0 },
          { name: 'value', dataType: 'string', nullable: false, isPrimaryKey: false, defaultValue: null, ordinal: 1 }]
        : this.columnsForType(type),
      rows,
      total,
      editable: true,
      keyColumns: type === 'string' ? ['__key__']
        : type === 'hash' ? ['field']
          : type === 'list' ? ['index']
            : type === 'set' || type === 'zset' ? ['member']
              : type === 'stream' ? ['id'] : [],
      recordOperations: type === 'stream'
        ? { insert: true, update: false, delete: true }
        : { insert: true, update: true, delete: true }
    }
  }

  private inferRedisType(values: Record<string, unknown>): string {
    if (Object.hasOwn(values, 'field')) return 'hash'
    if (Object.hasOwn(values, 'score')) return 'zset'
    if (Object.hasOwn(values, 'member')) return 'set'
    if (Object.hasOwn(values, 'id')) return 'stream'
    return 'string'
  }

  private mutationCommands(type: string, key: string, operation: Extract<DatabaseOperation, { kind: 'records.mutate' }>): string[][] {
    const commands: string[][] = []
    for (const mutation of operation.mutations) {
      if (type === 'string') {
        if (mutation.kind === 'delete') commands.push(['DEL', key])
        else commands.push(['SET', key, redisScalar(mutation.kind === 'insert' ? mutation.values.value : mutation.changes.value)])
        continue
      }
      if (type === 'hash') {
        if (mutation.kind === 'insert') commands.push(['HSET', key, redisScalar(mutation.values.field), redisScalar(mutation.values.value)])
        else if (mutation.kind === 'delete') commands.push(['HDEL', key, redisScalar(mutation.key.field)])
        else {
          const oldField = redisScalar(mutation.key.field)
          const field = redisScalar(mutation.changes.field ?? oldField)
          const value = redisScalar(mutation.changes.value)
          if (field !== oldField) commands.push(['HDEL', key, oldField])
          commands.push(['HSET', key, field, value])
        }
        continue
      }
      if (type === 'list') {
        if (mutation.kind === 'insert') commands.push(['RPUSH', key, redisScalar(mutation.values.value)])
        else if (mutation.kind === 'update') commands.push(['LSET', key, redisScalar(mutation.key.index), redisScalar(mutation.changes.value)])
        else {
          const marker = `__safe_db_delete__:${crypto.randomUUID()}`
          commands.push(['EVAL', "redis.call('LSET', KEYS[1], ARGV[1], ARGV[2]); return redis.call('LREM', KEYS[1], 1, ARGV[2])", '1', key, redisScalar(mutation.key.index), marker])
        }
        continue
      }
      if (type === 'set') {
        if (mutation.kind === 'insert') commands.push(['SADD', key, redisScalar(mutation.values.member)])
        else if (mutation.kind === 'delete') commands.push(['SREM', key, redisScalar(mutation.key.member)])
        else {
          const oldMember = redisScalar(mutation.key.member)
          const member = redisScalar(mutation.changes.member ?? oldMember)
          if (member !== oldMember) commands.push(['SREM', key, oldMember], ['SADD', key, member])
        }
        continue
      }
      if (type === 'zset') {
        if (mutation.kind === 'delete') commands.push(['ZREM', key, redisScalar(mutation.key.member)])
        else {
          const previous = mutation.kind === 'update' ? redisScalar(mutation.key.member) : ''
          const member = redisScalar(mutation.kind === 'insert' ? mutation.values.member : mutation.changes.member ?? previous)
          const score = redisScalar(mutation.kind === 'insert' ? mutation.values.score : mutation.changes.score)
          if (!Number.isFinite(Number(score))) throw new Error('Redis ZSet score 必须是数字')
          if (previous && previous !== member) commands.push(['ZREM', key, previous])
          commands.push(['ZADD', key, score, member])
        }
        continue
      }
      if (type === 'stream') {
        if (mutation.kind === 'update') throw new Error('Redis Stream 记录不可原地修改，请新增记录后删除旧记录')
        if (mutation.kind === 'delete') commands.push(['XDEL', key, redisScalar(mutation.key.id)])
        else commands.push(['XADD', key, redisScalar(mutation.values.id ?? '*'), ...streamFields(mutation.values.value)])
        continue
      }
      throw new Error(`不支持编辑 Redis ${type} 类型`)
    }
    return commands
  }

  async executeOperation(operation: DatabaseOperation): Promise<DriverOperationResult> {
    const database = 'target' in operation
      ? operation.target.database
      : 'source' in operation ? operation.source.database
        : operation.database
    const client = await this.clientFor(database)
    if (operation.kind === 'records.mutate') {
      if (operation.target.kind !== 'key') throw new Error('Redis 结构化操作目标必须是 Key')
      let type = await client.type(operation.target.name)
      if (type === 'none') {
        const first = operation.mutations[0]
        if (first.kind !== 'insert') throw new Error('Redis Key 不存在，只能通过新增记录创建')
        type = this.inferRedisType(first.values)
      }
      const commands = this.mutationCommands(type, operation.target.name, operation)
      const transaction = client.multi()
      for (const command of commands) transaction.sendCommand(command)
      await transaction.exec()
      return {
        results: [{ kind: 'exec', affectedRows: operation.mutations.length }],
        atomicity: commands.length === 1 ? 'single-request' : 'best-effort',
        succeeded: operation.mutations.length, failed: 0
      }
    }
    if (operation.kind === 'records.clear') {
      throw new Error('Redis 不存在可保留结构的空 Key；请删除 Key 或逐条删除成员')
    }
    if (operation.kind === 'object.drop') {
      const target = operation.target
      if (target.kind !== 'key') throw new Error('Redis 删除目标必须是 Key')
      const deleted = await client.del(target.name)
      return { results: [{ kind: 'exec', affectedRows: deleted }], atomicity: 'single-request', succeeded: deleted, failed: 0 }
    }
    if (operation.kind === 'object.create') {
      if (operation.objectType !== 'key') throw new Error('Redis 只能创建 Key')
      const type = String(operation.definition.type ?? 'string').toLocaleLowerCase()
      const target = { kind: 'records.mutate' as const, target: { kind: 'key' as const, name: operation.name, database }, mutations: [] as Extract<DatabaseOperation, { kind: 'records.mutate' }>['mutations'] }
      if (type === 'string') target.mutations.push({ kind: 'insert', values: { value: operation.definition.value ?? '' } })
      else if (type === 'hash') target.mutations.push({ kind: 'insert', values: { field: operation.definition.field ?? 'field', value: operation.definition.value ?? '' } })
      else if (type === 'list') target.mutations.push({ kind: 'insert', values: { value: operation.definition.value ?? '' } })
      else if (type === 'set') target.mutations.push({ kind: 'insert', values: { member: operation.definition.member ?? 'member' } })
      else if (type === 'zset') target.mutations.push({ kind: 'insert', values: { member: operation.definition.member ?? 'member', score: operation.definition.score ?? 0 } })
      else if (type === 'stream') target.mutations.push({ kind: 'insert', values: { id: '*', value: operation.definition.value ?? { value: '' } } })
      else throw new Error(`不支持创建 Redis ${type} 类型`)
      return this.executeOperation(target)
    }
    if (operation.kind === 'object.copy') {
      if (operation.source.kind !== 'key') throw new Error('Redis 只能复制 Key')
      const dump = await client.DUMP(operation.source.name)
      if (dump === null) throw new Error('Redis Key 不存在')
      const ttl = await client.pTTL(operation.source.name)
      await client.RESTORE(operation.targetName, ttl > 0 ? ttl : 0, dump)
      return { results: [{ kind: 'exec', affectedRows: 1 }], atomicity: 'best-effort', succeeded: 1, failed: 0 }
    }
    throw new Error(`Redis 尚未接入结构化操作：${operation.kind}`)
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
