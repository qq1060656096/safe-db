import { randomUUID, createHash } from 'node:crypto'
import type { AgentApprovalRequest, ConnectionMeta, TableInfo } from '../../shared/types'
import { classifyDatabaseInput } from '../core/nativeCommand'
import type { Executor } from '../core/executor'
import type { DriverManager } from '../drivers/manager'
import type { ConnectionStore } from '../store/connections'
import type {
  AgentMethod,
  AgentServiceResult,
  StoredAgentRequest
} from './types'

const MAX_TABLES_PER_REQUEST = 20
const APPROVAL_TTL_MS = 5 * 60 * 1000
const MAX_WAIT_MS = 60_000

export class AgentServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details?: unknown
  ) {
    super(message)
  }
}

type ApprovalNotifier = (request: AgentApprovalRequest) => void

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentServiceError('INVALID_ARGUMENT', `缺少参数 ${key}`)
  }
  return value.trim()
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function defaultDatabase(connection: ConnectionMeta): string | undefined {
  return connection.database ?? (connection.type === 'sqlite' ? 'main' : connection.type === 'redis' ? '0' : undefined)
}

export class AgentService {
  private requests = new Map<string, StoredAgentRequest>()
  private tokenToRequestId = new Map<string, string>()
  private waiters = new Map<string, Set<() => void>>()

  constructor(
    private connections: ConnectionStore,
    private drivers: DriverManager,
    private executor: Executor,
    private notifyApproval: ApprovalNotifier
  ) {
    this.executor.onApprovalResolved(({ token, response }) => {
      const requestId = this.tokenToRequestId.get(token)
      if (!requestId) return
      const request = this.requests.get(requestId)
      if (!request) return
      request.status = response.status === 'denied' ? 'denied' : 'completed'
      request.result = response
      this.tokenToRequestId.delete(token)
      for (const wake of this.waiters.get(requestId) ?? []) wake()
      this.waiters.delete(requestId)
    })
  }

  pendingApprovals(): AgentApprovalRequest[] {
    this.expireRequests()
    return [...this.requests.values()]
      .filter((request) => request.status === 'pending')
      .map((request) => ({
        requestId: request.requestId,
        approvalToken: request.approvalToken,
        connectionId: request.connectionId,
        connectionName: request.connectionName,
        database: request.database,
        sql: request.sql,
        sqlKind: request.sqlKind,
        expiresAt: request.expiresAt
      }))
  }

  async handle(method: AgentMethod, params: Record<string, unknown>): Promise<AgentServiceResult> {
    switch (method) {
      case 'capabilities':
        return this.capabilities()
      case 'connection.list':
        return this.listConnections()
      case 'database.list':
        return this.listDatabases(params)
      case 'object.list':
        return this.listObjects(params)
      case 'object.ddl':
        return this.getObjectDdl(params)
      case 'table.describe':
        return this.describeTables(params)
      case 'sql.check':
        return this.checkSql(params)
      case 'sql.run':
        return this.runSql(params)
      case 'request.get':
        return this.getRequest(params)
      case 'request.wait':
        return this.waitRequest(params)
      default:
        throw new AgentServiceError('METHOD_NOT_FOUND', '不支持的 Agent CLI 方法')
    }
  }

  private capabilities(): AgentServiceResult {
    return {
      status: 'ok',
      data: {
        protocolVersion: '1',
        databases: ['mysql', 'postgres', 'sqlite', 'sqlserver', 'mongodb', 'redis', 'qdrant'],
        methods: [
          'connection.list',
          'database.list',
          'object.list',
          'object.ddl',
          'table.describe',
          'sql.check',
          'sql.run',
          'request.get',
          'request.wait'
        ],
        sqlInput: ['stdin', 'file'],
        maxTablesPerDescribe: MAX_TABLES_PER_REQUEST
      }
    }
  }

  private listConnections(): AgentServiceResult {
    const items = this.connections.list().map((connection) => ({
      id: connection.id,
      name: connection.name,
      type: connection.type,
      defaultDatabase: defaultDatabase(connection),
      permissionMode: connection.permissionMode,
      permissionModeLocked: connection.permissionModeLocked === true,
      sshEnabled: connection.ssh?.enabled === true
    }))
    return { status: 'ok', data: { connections: items } }
  }

  private resolveConnection(selector: string): ConnectionMeta {
    const connections = this.connections.list()
    const byId = connections.find((connection) => connection.id === selector)
    if (byId) return byId
    const byName = connections.filter((connection) => connection.name === selector)
    if (byName.length === 0) throw new AgentServiceError('CONNECTION_NOT_FOUND', '连接不存在')
    if (byName.length > 1) {
      throw new AgentServiceError(
        'AMBIGUOUS_CONNECTION',
        '存在多个同名连接，请使用连接 ID',
        false,
        { connectionIds: byName.map((connection) => connection.id) }
      )
    }
    return byName[0]
  }

  private async listDatabases(params: Record<string, unknown>): Promise<AgentServiceResult> {
    const connection = this.resolveConnection(requiredString(params, 'connection'))
    const names = await (await this.drivers.get(connection.id)).listDatabases()
    return {
      status: 'ok',
      data: {
        connection: { id: connection.id, name: connection.name, type: connection.type },
        databases: names.map((name) => ({
          name,
          isDefault: name === defaultDatabase(connection)
        }))
      }
    }
  }

  private async listObjects(params: Record<string, unknown>): Promise<AgentServiceResult> {
    const connection = this.resolveConnection(requiredString(params, 'connection'))
    const database = optionalString(params, 'database') ?? defaultDatabase(connection)
    const driver = await this.drivers.get(connection.id)
    const [tables, routines] = await Promise.all([
      driver.listTables(database),
      driver.listRoutines(database)
    ])
    return {
      status: 'ok',
      data: {
        connection: { id: connection.id, name: connection.name, type: connection.type },
        database,
        objects: [
          ...tables.map((object) => ({
            schema: object.schema,
            name: object.name,
            type: object.type,
            comment: object.comment
          })),
          ...routines.map((object) => ({
            schema: object.schema,
            name: object.name,
            type: object.type,
            arguments: object.arguments
          }))
        ]
      }
    }
  }

  private async getObjectDdl(params: Record<string, unknown>): Promise<AgentServiceResult> {
    const connection = this.resolveConnection(requiredString(params, 'connection'))
    const database = optionalString(params, 'database') ?? defaultDatabase(connection)
    const name = requiredString(params, 'name')
    const schema = optionalString(params, 'schema')
    const ddl = await (await this.drivers.get(connection.id)).getObjectDdl(database, name, schema)
    return { status: 'ok', data: { database, schema, name, ddl } }
  }

  private parseTableRefs(params: Record<string, unknown>): { name: string; schema?: string }[] {
    if (!Array.isArray(params.tables) || params.tables.length === 0) {
      throw new AgentServiceError('INVALID_ARGUMENT', '至少需要一个 table 参数')
    }
    const defaultSchema = optionalString(params, 'schema')
    const seen = new Set<string>()
    const result: { name: string; schema?: string }[] = []
    for (const value of params.tables) {
      if (typeof value !== 'string' || !value.trim()) {
        throw new AgentServiceError('INVALID_ARGUMENT', 'table 参数不能为空')
      }
      const raw = value.trim()
      const dot = raw.indexOf('.')
      const ref = dot > 0
        ? { schema: raw.slice(0, dot), name: raw.slice(dot + 1) }
        : { schema: defaultSchema, name: raw }
      const key = `${ref.schema ?? ''}\u0000${ref.name}`
      if (!seen.has(key)) {
        seen.add(key)
        result.push(ref)
      }
    }
    if (result.length > MAX_TABLES_PER_REQUEST) {
      throw new AgentServiceError('TOO_MANY_TABLES', `单次最多查询 ${MAX_TABLES_PER_REQUEST} 张表`)
    }
    return result
  }

  private resolveTable(connection: ConnectionMeta, objects: TableInfo[], ref: { name: string; schema?: string }): TableInfo {
    const matches = objects.filter((object) =>
      object.name === ref.name && (!ref.schema || object.schema === ref.schema)
    )
    if (matches.length === 0) throw new AgentServiceError('TABLE_NOT_FOUND', '表不存在')
    if (matches.length > 1 && (connection.type === 'postgres' || connection.type === 'sqlserver')) {
      throw new AgentServiceError('AMBIGUOUS_TABLE', '多个 Schema 中存在同名表，请指定 Schema')
    }
    return matches[0]
  }

  private async describeTables(params: Record<string, unknown>): Promise<AgentServiceResult> {
    const connection = this.resolveConnection(requiredString(params, 'connection'))
    const database = optionalString(params, 'database') ?? defaultDatabase(connection)
    const refs = this.parseTableRefs(params)
    const driver = await this.drivers.get(connection.id)
    const objects = await driver.listTables(database)
    const tables = []
    let failed = 0

    for (const ref of refs) {
      try {
        const object = this.resolveTable(connection, objects, ref)
        const schema = object.schema ?? ref.schema
        const [columns, indexes, foreignKeys, checks] = await Promise.all([
          driver.listColumns(database, object.name, schema),
          driver.listIndexes(database, object.name, schema),
          driver.listForeignKeys(database, object.name, schema),
          driver.listCheckConstraints(database, object.name, schema)
        ])
        const primaryIndex = indexes.find((index) => index.primary)
        tables.push({
          status: 'ok',
          database,
          schema,
          name: object.name,
          type: object.type,
          comment: object.comment,
          columns: columns.map((column) => ({
            name: column.name,
            dataType: column.dataType,
            nullable: column.nullable,
            defaultValue: column.defaultValue,
            primaryKey: column.isPrimaryKey,
            autoIncrement: Boolean(
              column.extra?.toLowerCase().includes('auto_increment') ||
              column.extra?.toLowerCase().includes('identity') ||
              (connection.type === 'sqlite' && column.isPrimaryKey && column.dataType.toUpperCase() === 'INTEGER')
            ),
            generated: Boolean(column.extra?.toLowerCase().includes('generated')),
            comment: column.comment,
            ordinal: column.ordinal
          })),
          primaryKey: primaryIndex
            ? { name: primaryIndex.name, columns: primaryIndex.columns }
            : { name: null, columns: columns.filter((column) => column.isPrimaryKey).map((column) => column.name) },
          indexes,
          foreignKeys,
          uniqueConstraints: indexes
            .filter((index) => index.unique && !index.primary)
            .map((index) => ({ name: index.name, columns: index.columns })),
          checks,
          metadataLimitations: connection.type === 'sqlite'
            ? ['SQLite 不提供结构化 CHECK 约束元数据，请使用 object ddl 查看完整定义']
            : connection.type === 'mongodb'
              ? ['MongoDB 字段结构由最多 100 条文档推断']
              : connection.type === 'redis'
                ? ['Redis key 根据数据类型映射为只读表格']
                : connection.type === 'qdrant'
                  ? ['Qdrant collection 映射为只读 Point 表格；payload 字段由索引和样本推断，向量默认不返回']
                : []
        })
      } catch (error) {
        failed += 1
        tables.push({
          status: 'error',
          schema: ref.schema,
          name: ref.name,
          error: this.errorBody(error)
        })
      }
    }

    if (failed === refs.length) {
      throw new AgentServiceError('TABLES_NOT_FOUND', '请求的表均无法读取', false, { tables })
    }
    return {
      status: failed > 0 ? 'partial' : 'ok',
      data: {
        summary: { requested: refs.length, succeeded: refs.length - failed, failed },
        tables
      }
    }
  }

  private checkSql(params: Record<string, unknown>): AgentServiceResult {
    const connection = this.resolveConnection(requiredString(params, 'connection'))
    const database = optionalString(params, 'database') ?? defaultDatabase(connection)
    const sql = requiredString(params, 'sql')
    const classified = classifyDatabaseInput(connection.type, sql)
    return {
      status: 'ok',
      data: {
        connection: { id: connection.id, name: connection.name, permissionMode: connection.permissionMode },
        database,
        classification: classified.kind,
        statementCount: classified.statements.length,
        statements: classified.statements.map((statement) => ({ kind: statement.kind })),
        decision: classified.kind === 'READ' || classified.kind === 'OTHER'
          ? 'allow'
          : connection.permissionMode === 'readonly'
            ? 'deny'
            : connection.permissionMode === 'approval'
              ? 'approval_required'
              : 'allow',
        sqlHash: `sha256:${createHash('sha256').update(sql).digest('hex')}`
      }
    }
  }

  private async runSql(params: Record<string, unknown>): Promise<AgentServiceResult> {
    const connection = this.resolveConnection(requiredString(params, 'connection'))
    const database = optionalString(params, 'database') ?? defaultDatabase(connection)
    const sql = requiredString(params, 'sql')
    const response = await this.executor.execute(connection.id, sql, database)
    if (response.status === 'needsApproval' && response.approvalToken) {
      const approvalSql = response.preview ?? sql
      const requestId = `req_${randomUUID()}`
      const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString()
      const stored: StoredAgentRequest = {
        requestId,
        approvalToken: response.approvalToken,
        connectionId: connection.id,
        connectionName: connection.name,
        database,
        sql: approvalSql,
        sqlKind: response.sqlKind ?? 'WRITE',
        expiresAt,
        status: 'pending'
      }
      this.requests.set(requestId, stored)
      this.tokenToRequestId.set(response.approvalToken, requestId)
      this.notifyApproval(stored)
      return {
        status: 'approval_required',
        data: { requestId, sqlKind: stored.sqlKind, expiresAt }
      }
    }
    if (response.status === 'denied') {
      return {
        status: 'denied',
        data: { sqlKind: response.sqlKind },
        warnings: response.error ? [{ code: 'PERMISSION_DENIED', message: response.error }] : undefined
      }
    }
    if (response.status === 'error') {
      throw new AgentServiceError('SQL_EXECUTION_FAILED', response.error ?? 'SQL 执行失败', true)
    }
    return { status: 'ok', data: response }
  }

  private expireRequests(): void {
    const now = Date.now()
    for (const request of this.requests.values()) {
      if (request.status === 'pending' && Date.parse(request.expiresAt) <= now) {
        request.status = 'expired'
        this.tokenToRequestId.delete(request.approvalToken)
        for (const wake of this.waiters.get(request.requestId) ?? []) wake()
        this.waiters.delete(request.requestId)
      }
    }
  }

  private requestResult(request: StoredAgentRequest): AgentServiceResult {
    if (request.status === 'pending') {
      return { status: 'pending', data: { requestId: request.requestId, expiresAt: request.expiresAt } }
    }
    if (request.status === 'expired') {
      throw new AgentServiceError('REQUEST_EXPIRED', '审批请求已过期')
    }
    return {
      status: request.status === 'denied' ? 'denied' : 'completed',
      data: { requestId: request.requestId, result: request.result }
    }
  }

  private getRequest(params: Record<string, unknown>): AgentServiceResult {
    this.expireRequests()
    const requestId = requiredString(params, 'requestId')
    const request = this.requests.get(requestId)
    if (!request) throw new AgentServiceError('REQUEST_NOT_FOUND', '审批请求不存在')
    return this.requestResult(request)
  }

  private async waitRequest(params: Record<string, unknown>): Promise<AgentServiceResult> {
    this.expireRequests()
    const requestId = requiredString(params, 'requestId')
    const request = this.requests.get(requestId)
    if (!request) throw new AgentServiceError('REQUEST_NOT_FOUND', '审批请求不存在')
    if (request.status !== 'pending') return this.requestResult(request)
    const requestedTimeout = typeof params.timeoutMs === 'number' ? params.timeoutMs : 30_000
    const timeoutMs = Math.max(0, Math.min(MAX_WAIT_MS, requestedTimeout))
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.waiters.get(requestId)?.delete(wake)
        resolve()
      }, timeoutMs)
      const wake = (): void => {
        clearTimeout(timeout)
        resolve()
      }
      const current = this.waiters.get(requestId) ?? new Set<() => void>()
      current.add(wake)
      this.waiters.set(requestId, current)
    })
    this.expireRequests()
    return this.requestResult(request)
  }

  private errorBody(error: unknown): { code: string; message: string; retryable: boolean; details?: unknown } {
    if (error instanceof AgentServiceError) {
      return { code: error.code, message: error.message, retryable: error.retryable, details: error.details }
    }
    return {
      code: 'DATABASE_ERROR',
      message: error instanceof Error ? error.message : String(error),
      retryable: true
    }
  }
}
