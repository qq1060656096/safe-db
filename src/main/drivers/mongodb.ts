import { BSON, MongoClient, type ClientSession, type Db, type Document } from 'mongodb'
import type {
  ColumnInfo,
  CheckConstraintInfo,
  ForeignKeyInfo,
  IndexInfo,
  QueryResult,
  RoutineInfo,
  TableInfo
} from '../../shared/types'
import { classifyMongoCommand, parseMongoCommands } from '../core/nativeCommand'
import type { DbDriver, TableDataQuery, TableDataResult } from './base'

function displayValue(value: unknown): unknown {
  if (value === null || value === undefined) return null
  const serialized = BSON.EJSON.serialize(value, { relaxed: true })
  if (serialized !== null && typeof serialized === 'object') return JSON.stringify(serialized)
  return serialized
}

function displayDocument(document: Document): Record<string, unknown> {
  return Object.fromEntries(Object.entries(document).map(([key, value]) => [key, displayValue(value)]))
}

function bsonType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (value instanceof Date) return 'date'
  if (value && typeof value === 'object') {
    const name = (value as { _bsontype?: string })._bsontype
    return name ? name.toLowerCase() : 'object'
  }
  return typeof value
}

function parseFilterValue(value: string | undefined): unknown {
  const raw = value ?? ''
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export class MongoDriver implements DbDriver {
  private client: MongoClient | null = null

  constructor(
    private cfg: {
      host: string
      port: number
      user?: string
      password?: string
      database?: string
      authDatabase?: string
      tls?: boolean
    }
  ) {}

  private uri(): string {
    const auth = this.cfg.user
      ? `${encodeURIComponent(this.cfg.user)}:${encodeURIComponent(this.cfg.password ?? '')}@`
      : ''
    const params = new URLSearchParams()
    if (this.cfg.user) params.set('authSource', this.cfg.authDatabase || this.cfg.database || 'admin')
    if (this.cfg.tls) params.set('tls', 'true')
    const query = params.size ? `?${params.toString()}` : ''
    return `mongodb://${auth}${this.cfg.host}:${this.cfg.port}/${query}`
  }

  async connect(): Promise<void> {
    if (this.client) return
    const client = new MongoClient(this.uri(), { serverSelectionTimeoutMS: 10000 })
    await client.connect()
    this.client = client
  }

  async disconnect(): Promise<void> {
    await this.client?.close().catch(() => {})
    this.client = null
  }

  async cancel(): Promise<void> {
    // MongoClient.close() 会关闭正在等待服务端响应的连接并中止活跃事务。
    await this.disconnect()
  }

  async test(): Promise<void> {
    const client = new MongoClient(this.uri(), { serverSelectionTimeoutMS: 10000 })
    try {
      await client.connect()
      await client.db(this.cfg.database || 'admin').command({ ping: 1 })
    } finally {
      await client.close()
    }
  }

  private requireClient(): MongoClient {
    if (!this.client) throw new Error('连接未建立')
    return this.client
  }

  private db(database?: string): Db {
    const name = database || this.cfg.database
    if (!name) throw new Error('未指定 MongoDB 数据库')
    return this.requireClient().db(name)
  }

  async listDatabases(): Promise<string[]> {
    const result = await this.requireClient().db('admin').admin().listDatabases({ nameOnly: true })
    return result.databases.map((database) => database.name).sort()
  }

  async listTables(database?: string, includeStats = false): Promise<TableInfo[]> {
    const db = this.db(database)
    const collections = await db.listCollections({}, { nameOnly: false }).toArray()
    return Promise.all(collections.map(async (collection) => {
      let rowCount: number | undefined
      if (includeStats && collection.type !== 'view') {
        rowCount = await db.collection(collection.name).estimatedDocumentCount().catch(() => undefined)
      }
      return {
        name: collection.name,
        type: collection.type === 'view' ? 'view' : 'table',
        comment: collection.type === 'view' ? 'MongoDB view' : 'MongoDB collection',
        rowCount
      }
    }))
  }

  async listRoutines(): Promise<RoutineInfo[]> {
    return []
  }

  async listColumns(database: string | undefined, table: string): Promise<ColumnInfo[]> {
    const documents = await this.db(database).collection(table).find({}).limit(100).toArray()
    const fields = new Map<string, { types: Set<string>; present: number; ordinal: number }>()
    for (const document of documents) {
      for (const [name, value] of Object.entries(document)) {
        const current = fields.get(name) ?? { types: new Set<string>(), present: 0, ordinal: fields.size }
        current.types.add(bsonType(value))
        current.present += 1
        fields.set(name, current)
      }
    }
    if (!fields.size) fields.set('_id', { types: new Set(['objectid']), present: 0, ordinal: 0 })
    return [...fields].map(([name, value]) => ({
      name,
      dataType: [...value.types].sort().join(' | '),
      nullable: value.present < documents.length || value.types.has('null'),
      isPrimaryKey: name === '_id',
      defaultValue: null,
      extra: 'sampled schema',
      ordinal: value.ordinal
    }))
  }

  async listIndexes(database: string | undefined, table: string): Promise<IndexInfo[]> {
    const indexes = await this.db(database).collection(table).indexes().catch(() => [])
    return indexes.map((index) => ({
      name: String(index.name),
      columns: Object.keys(index.key),
      unique: index.unique === true || index.name === '_id_',
      primary: index.name === '_id_'
    }))
  }

  async listForeignKeys(): Promise<ForeignKeyInfo[]> {
    return []
  }

  async listCheckConstraints(database: string | undefined, table: string): Promise<CheckConstraintInfo[]> {
    const info = await this.db(database).listCollections({ name: table }, { nameOnly: false }).next()
    const validator = info?.options?.validator
    return validator ? [{ name: 'validator', expression: BSON.EJSON.stringify(validator, undefined, 2) }] : []
  }

  async getObjectDdl(database: string | undefined, table: string): Promise<string> {
    const db = this.db(database)
    const info = await db.listCollections({ name: table }, { nameOnly: false }).next()
    if (!info) throw new Error('MongoDB collection 不存在')
    const indexes = info.type === 'view' ? [] : await db.collection(table).indexes()
    const commands: Document[] = [{ create: table, ...info.options }]
    for (const index of indexes.filter((item) => item.name !== '_id_')) {
      const { v: _v, ns: _ns, ...spec } = index
      commands.push({ createIndexes: table, indexes: [spec] })
    }
    return BSON.EJSON.stringify(commands, undefined, 2, { relaxed: true })
  }

  async getRoutineDefinition(): Promise<string> {
    throw new Error('MongoDB 不支持 SQL 函数或存储过程')
  }

  private filter(query: TableDataQuery): Document {
    const clauses: Document[] = []
    for (const item of query.filters ?? []) {
      if (item.op === 'null') clauses.push({ [item.column]: null })
      else if (item.op === 'notnull') clauses.push({ [item.column]: { $ne: null } })
      else if (item.op === 'like' || item.op === 'notlike') {
        const regex = { $regex: escapeRegex(item.value ?? ''), $options: 'i' }
        clauses.push({ [item.column]: item.op === 'like' ? regex : { $not: regex } })
      } else {
        const operators: Record<string, string> = { '=': '$eq', '!=': '$ne', '>': '$gt', '>=': '$gte', '<': '$lt', '<=': '$lte' }
        clauses.push({ [item.column]: { [operators[item.op]]: parseFilterValue(item.value) } })
      }
    }
    return clauses.length > 1 ? { $and: clauses } : clauses[0] ?? {}
  }

  async getTableData(query: TableDataQuery): Promise<TableDataResult> {
    const collection = this.db(query.database).collection(query.table)
    const filter = this.filter(query)
    let cursor = collection.find(filter)
    if (query.orderBy?.length) {
      cursor = cursor.sort(Object.fromEntries(query.orderBy.map((item) => [item.column, item.direction === 'desc' ? -1 : 1])))
    }
    const [columns, documents, total] = await Promise.all([
      this.listColumns(query.database, query.table),
      cursor.skip((query.page - 1) * query.pageSize).limit(query.pageSize).toArray(),
      collection.countDocuments(filter)
    ])
    return {
      columns,
      rows: documents.map(displayDocument),
      total,
      editable: false,
      keyColumns: ['_id']
    }
  }

  private responseResult(command: Document, response: Document): QueryResult {
    const kind = classifyMongoCommand(command)
    if (kind === 'READ') {
      const cursor = response.cursor as { firstBatch?: Document[]; nextBatch?: Document[] } | undefined
      const batch = cursor?.firstBatch ?? cursor?.nextBatch
      if (Array.isArray(batch)) {
        const rows = batch.map(displayDocument)
        return { kind: 'rows', columns: Object.keys(rows[0] ?? {}).map((name) => ({ name })), rows }
      }
      if (Array.isArray(response.values)) {
        const rows = response.values.map((value) => ({ value: displayValue(value) }))
        return { kind: 'rows', columns: [{ name: 'value' }], rows }
      }
      const row = displayDocument(response)
      return { kind: 'rows', columns: Object.keys(row).map((name) => ({ name })), rows: [row] }
    }
    const affected = Number(response.nModified ?? response.n ?? response.deletedCount ?? response.modifiedCount ?? 0)
    return { kind: 'exec', affectedRows: Number.isFinite(affected) ? affected : 0 }
  }

  private async executeOne(raw: string, database?: string, session?: ClientSession): Promise<QueryResult> {
    const parsed = BSON.EJSON.parse(raw, { relaxed: true }) as Document
    const response = await this.db(database).command(parsed, session ? { session } : undefined)
    return this.responseResult(parsed, response)
  }

  async run(input: string, database?: string): Promise<QueryResult[]> {
    const commands = parseMongoCommands(input)
    const results: QueryResult[] = []
    for (const command of commands) results.push(await this.executeOne(command.raw, database))
    return results
  }

  async runInTransaction(inputs: string[], database?: string): Promise<QueryResult[]> {
    const commands = inputs.flatMap(parseMongoCommands)
    if (commands.length <= 1 || commands.some((item) => classifyMongoCommand(item.command) === 'DDL')) {
      const results: QueryResult[] = []
      for (const command of commands) results.push(await this.executeOne(command.raw, database))
      return results
    }
    const session = this.requireClient().startSession()
    const results: QueryResult[] = []
    try {
      await session.withTransaction(async () => {
        for (const command of commands) results.push(await this.executeOne(command.raw, database, session))
      })
      return results
    } finally {
      await session.endSession()
    }
  }
}
