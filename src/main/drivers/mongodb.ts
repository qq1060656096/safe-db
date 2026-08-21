import { BSON, MongoClient, type ClientSession, type Db, type Document } from 'mongodb'
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
import { classifyMongoCommand, parseMongoCommands } from '../core/nativeCommand'
import type { DbDriver, DriverOperationResult, TableDataQuery, TableDataResult } from './base'
import { capabilitiesForType } from './capabilities'

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

function structuredBsonValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const source = value.trim()
    if (/^\{\s*"\$(?:oid|date|numberLong|numberDecimal|binary|timestamp)"/.test(source)) {
      try { return BSON.EJSON.parse(source, { relaxed: true }) } catch {}
    }
    return value
  }
  if (Array.isArray(value)) return value.map(structuredBsonValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, structuredBsonValue(item)]))
  }
  return value
}

function structuredDocument(value: Record<string, unknown>): Document {
  return structuredBsonValue(value) as Document
}

export class MongoDriver implements DbDriver {
  readonly capabilities = capabilitiesForType('mongodb')
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
      editable: true,
      keyColumns: ['_id']
    }
  }

  async executeOperation(operation: DatabaseOperation): Promise<DriverOperationResult> {
    const database = 'target' in operation
      ? operation.target.database
      : 'source' in operation ? operation.source.database
        : operation.database
    const db = this.db(database)
    if (operation.kind === 'records.mutate') {
      if (operation.target.kind !== 'collection') throw new Error('MongoDB 结构化操作目标必须是 Collection')
      const writes = operation.mutations.map((mutation) => {
        if (mutation.kind === 'insert') return { insertOne: { document: structuredDocument(mutation.values) } }
        if (mutation.kind === 'delete') return { deleteOne: { filter: structuredDocument(mutation.key) } }
        const changes = structuredDocument(mutation.changes)
        if (Object.hasOwn(changes, '_id')) throw new Error('MongoDB 不允许修改 _id')
        return { updateOne: { filter: structuredDocument(mutation.key), update: { $set: changes } } }
      })
      const result = await db.collection(operation.target.name).bulkWrite(writes, { ordered: true })
      const affectedRows = result.insertedCount + result.modifiedCount + result.deletedCount + result.upsertedCount
      return {
        results: [{ kind: 'exec', affectedRows }],
        atomicity: operation.mutations.length === 1 ? 'single-request' : 'best-effort',
        succeeded: operation.mutations.length,
        failed: 0
      }
    }
    if (operation.kind === 'records.clear') {
      if (operation.target.kind !== 'collection') throw new Error('MongoDB 清空目标必须是 Collection')
      const result = await db.collection(operation.target.name).deleteMany({})
      return {
        results: [{ kind: 'exec', affectedRows: result.deletedCount }],
        atomicity: 'single-request', succeeded: result.deletedCount, failed: 0
      }
    }
    if (operation.kind === 'object.create') {
      if (operation.objectType !== 'collection') throw new Error('MongoDB 只能创建 Collection')
      await db.createCollection(operation.name, operation.definition)
      return { results: [{ kind: 'exec', affectedRows: 1 }], atomicity: 'single-request', succeeded: 1, failed: 0 }
    }
    if (operation.kind === 'object.drop') {
      if (operation.target.kind !== 'collection') throw new Error('MongoDB 删除目标必须是 Collection')
      await db.collection(operation.target.name).drop()
      return { results: [{ kind: 'exec', affectedRows: 1 }], atomicity: 'single-request', succeeded: 1, failed: 0 }
    }
    if (operation.kind === 'object.copy') {
      if (operation.source.kind !== 'collection') throw new Error('MongoDB 只能复制 Collection')
      const source = db.collection(operation.source.name)
      const info = await db.listCollections({ name: operation.source.name }, { nameOnly: false }).next()
      await db.createCollection(operation.targetName, info?.options ?? {})
      const sourceIndexes = await source.indexes()
      const copiedIndexes = sourceIndexes.filter((index) => index.name !== '_id_').map((index) => {
        const { v: _v, ns: _ns, ...definition } = index
        return definition
      })
      if (copiedIndexes.length) await db.command({ createIndexes: operation.targetName, indexes: copiedIndexes })
      let copied = 0
      if (operation.withData) {
        const target = db.collection(operation.targetName)
        let batch: Document[] = []
        for await (const document of source.find({})) {
          batch.push(document)
          if (batch.length === 1_000) {
            await target.insertMany(batch, { ordered: true })
            copied += batch.length
            batch = []
          }
        }
        if (batch.length) {
          await target.insertMany(batch, { ordered: true })
          copied += batch.length
        }
      }
      return {
        results: [{ kind: 'exec', affectedRows: copied }], atomicity: 'best-effort', succeeded: 1, failed: 0
      }
    }
    if (operation.kind === 'index.create') {
      if (operation.target.kind !== 'collection') throw new Error('MongoDB 索引目标必须是 Collection')
      const rawKeys = operation.definition.keys
      const columns = operation.definition.columns
      const keys: Record<string, 1 | -1 | 'text'> = rawKeys && typeof rawKeys === 'object' && !Array.isArray(rawKeys)
        ? rawKeys as Record<string, 1 | -1 | 'text'>
        : Array.isArray(columns)
          ? Object.fromEntries(columns.map((column) => [String(column), 1]))
          : {}
      if (!Object.keys(keys).length) throw new Error('MongoDB 索引定义必须包含 keys 或 columns')
      await db.collection(operation.target.name).createIndex(keys, {
        name: operation.name,
        unique: operation.definition.unique === true,
        sparse: operation.definition.sparse === true
      })
      return { results: [{ kind: 'exec', affectedRows: 1 }], atomicity: 'single-request', succeeded: 1, failed: 0 }
    }
    if (operation.kind === 'index.drop') {
      if (operation.target.kind !== 'collection') throw new Error('MongoDB 索引目标必须是 Collection')
      if (operation.name === '_id_') throw new Error('MongoDB 主键索引不能删除')
      await db.collection(operation.target.name).dropIndex(operation.name)
      return { results: [{ kind: 'exec', affectedRows: 1 }], atomicity: 'single-request', succeeded: 1, failed: 0 }
    }
    throw new Error(`MongoDB 尚未接入结构化操作：${operation.kind}`)
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
