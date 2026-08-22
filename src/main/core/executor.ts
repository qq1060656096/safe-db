import { randomUUID } from 'node:crypto'
import type { DatabaseOperation, ExecuteResponse, SqlKind } from '../../shared/types'
import type { DriverManager } from '../drivers/manager'
import type { AuditStore } from '../store/audit'
import type { ConnectionStore } from '../store/connections'
import { classifyDatabaseInput } from './nativeCommand'
import { decide } from './permission'
import { assertDatabaseOperation, databaseOperationKind, databaseOperationPreview, operationSupports } from './databaseOperation'
import { currentOperationId, runWithOperationContext } from '../audit/trace'

interface PendingApproval {
  /** 审计关联 ID 与可执行 token 分离，审批日志绝不能泄露可执行凭证。 */
  approvalId: string
  connectionId: string
  sql: string
  database?: string
  sqlKind: SqlKind
  createdAt: number
  operation?: DatabaseOperation
}

export interface ApprovalResolvedEvent {
  token: string
  response: ExecuteResponse
}

const APPROVAL_TTL_MS = 5 * 60 * 1000

/**
 * 统一执行管道：所有 SQL 和原生命令（编辑器 / 网格编辑 / 结构变更）都经过
 * 分类 → 权限判定 →（审批）→ 事务或受控执行 → 审计。
 */
export class Executor {
  private pending = new Map<string, PendingApproval>()
  private approvalListeners = new Set<(event: ApprovalResolvedEvent) => void>()
  private metadataListeners = new Set<(connectionId: string) => void>()

  constructor(
    private connections: ConnectionStore,
    private drivers: DriverManager,
    private audit: AuditStore
  ) {}

  private gcPending(): void {
    const now = Date.now()
    for (const [token, p] of this.pending) {
      if (now - p.createdAt > APPROVAL_TTL_MS) {
        this.pending.delete(token)
        this.recordApproval(p, 'expired', '审批已过期')
      }
    }
  }

  private recordApproval(
    pending: PendingApproval,
    action: 'requested' | 'approved' | 'rejected' | 'expired',
    message?: string
  ): void {
    const cfg = this.connections.get(pending.connectionId)
    this.audit.recordApproval({
      approvalId: pending.approvalId,
      action,
      connectionId: pending.connectionId,
      connectionName: cfg?.name ?? '?',
      connectionType: cfg?.type ?? null,
      databaseName: pending.database ?? cfg?.database,
      sqlText: pending.sql,
      sqlKind: pending.sqlKind,
      permissionMode: cfg?.permissionMode ?? 'approval',
      message
    })
  }

  private addPendingApproval(token: string, pending: PendingApproval): void {
    this.pending.set(token, pending)
    try {
      this.recordApproval(pending, 'requested')
    } catch (error) {
      this.pending.delete(token)
      throw error
    }
  }

  onApprovalResolved(listener: (event: ApprovalResolvedEvent) => void): () => void {
    this.approvalListeners.add(listener)
    return () => this.approvalListeners.delete(listener)
  }

  onMetadataChanged(listener: (connectionId: string) => void): () => void {
    this.metadataListeners.add(listener)
    return () => this.metadataListeners.delete(listener)
  }

  private emitMetadataChanged(connectionId: string): void {
    for (const listener of this.metadataListeners) listener(connectionId)
  }

  private emitApprovalResolved(token: string, response: ExecuteResponse): void {
    for (const listener of this.approvalListeners) listener({ token, response })
  }

  async execute(connectionId: string, sql: string, database?: string): Promise<ExecuteResponse> {
    if (!currentOperationId()) {
      return runWithOperationContext(randomUUID(), () => this.execute(connectionId, sql, database))
    }
    const cfg = this.connections.get(connectionId)
    if (!cfg) return { status: 'error', error: '连接不存在' }
    if (!sql.trim()) return { status: 'ok', results: [] }

    let kind: SqlKind
    try {
      kind = classifyDatabaseInput(cfg.type, sql).kind
    } catch (error) {
      return { status: 'error', error: error instanceof Error ? error.message : String(error) }
    }
    const decision = decide(cfg.permissionMode, kind)

    if (decision === 'deny') {
      this.audit.insert({
        connectionId,
        connectionName: cfg.name,
        connectionType: cfg.type,
        databaseName: database ?? cfg.database,
        sqlText: sql,
        sqlKind: kind,
        permissionMode: cfg.permissionMode,
        approvalStatus: 'not_required',
        status: 'blocked',
        error: '当前连接为只读模式,已阻止写操作',
        durationMs: 0
      })
      return { status: 'denied', sqlKind: kind, error: '当前连接为只读模式,写操作已被阻止' }
    }

    if (decision === 'needsApproval') {
      this.gcPending()
      const token = randomUUID()
      const pending = { approvalId: randomUUID(), connectionId, sql, database, sqlKind: kind, createdAt: Date.now() }
      this.addPendingApproval(token, pending)
      return { status: 'needsApproval', sqlKind: kind, approvalToken: token }
    }

    return this.doExecute(connectionId, sql, database, kind, 'not_required')
  }

  /** 结构化操作与原生 SQL/REST 共用权限、审批、审计和元数据失效链路。 */
  async executeOperation(connectionId: string, input: unknown): Promise<ExecuteResponse> {
    if (!currentOperationId()) {
      return runWithOperationContext(randomUUID(), () => this.executeOperation(connectionId, input))
    }
    const cfg = this.connections.get(connectionId)
    if (!cfg) return { status: 'error', error: '连接不存在' }
    let operation: DatabaseOperation
    try {
      assertDatabaseOperation(input)
      operation = input
      const capabilities = this.drivers.capabilities(connectionId)
      const unsupported = operationSupports(capabilities, operation).find((item) => !item.supported)
      if (unsupported && !unsupported.supported) throw new Error(unsupported.reason)
    } catch (error) {
      return { status: 'error', error: error instanceof Error ? error.message : String(error) }
    }

    const kind = databaseOperationKind(operation)
    const preview = databaseOperationPreview(operation)
    const database = 'target' in operation
      ? operation.target.database
      : 'source' in operation ? operation.source.database
        : operation.database
    const decision = decide(cfg.permissionMode, kind)
    if (decision === 'deny') {
      this.audit.insert({
        connectionId, connectionName: cfg.name, connectionType: cfg.type,
        databaseName: database ?? cfg.database, sqlText: preview, sqlKind: kind,
        permissionMode: cfg.permissionMode, approvalStatus: 'not_required', status: 'blocked',
        error: '当前连接为只读模式,已阻止写操作', durationMs: 0
      })
      return { status: 'denied', sqlKind: kind, error: '当前连接为只读模式,写操作已被阻止', preview }
    }
    if (decision === 'needsApproval') {
      this.gcPending()
      const token = randomUUID()
      this.addPendingApproval(token, {
        approvalId: randomUUID(), connectionId, sql: preview, database, sqlKind: kind, createdAt: Date.now(), operation
      })
      return { status: 'needsApproval', sqlKind: kind, approvalToken: token, preview }
    }
    return this.doExecuteOperation(connectionId, operation, kind, 'not_required')
  }

  async confirmExecute(token: string): Promise<ExecuteResponse> {
    if (!currentOperationId()) {
      return runWithOperationContext(randomUUID(), () => this.confirmExecute(token))
    }
    const p = this.pending.get(token)
    this.pending.delete(token) // 一次性,无论成败都消费掉
    if (p && Date.now() - p.createdAt > APPROVAL_TTL_MS) {
      this.recordApproval(p, 'expired', '审批已过期')
      const response: ExecuteResponse = { status: 'error', error: '审批已过期,请重新执行' }
      this.emitApprovalResolved(token, response)
      return response
    }
    if (!p) {
      const response: ExecuteResponse = { status: 'error', error: '审批已过期或已被处理,请重新执行' }
      this.emitApprovalResolved(token, response)
      return response
    }
    this.recordApproval(p, 'approved')
    const response = p.operation
      ? await this.doExecuteOperation(p.connectionId, p.operation, p.sqlKind, 'approved', p.approvalId)
      : await this.doExecute(p.connectionId, p.sql, p.database, p.sqlKind, 'approved', p.approvalId)
    this.emitApprovalResolved(token, response)
    return response
  }

  async rejectExecute(token: string): Promise<void> {
    if (!currentOperationId()) {
      return runWithOperationContext(randomUUID(), () => this.rejectExecute(token))
    }
    const p = this.pending.get(token)
    this.pending.delete(token)
    if (!p) return
    if (Date.now() - p.createdAt > APPROVAL_TTL_MS) {
      this.recordApproval(p, 'expired', '审批已过期')
      this.emitApprovalResolved(token, {
        status: 'denied', sqlKind: p.sqlKind, error: '审批已过期'
      })
      return
    }
    const cfg = this.connections.get(p.connectionId)
    this.recordApproval(p, 'rejected', '用户拒绝了审批')
    this.audit.insert({
      connectionId: p.connectionId,
      connectionName: cfg?.name ?? '?',
      connectionType: cfg?.type ?? null,
      databaseName: p.database ?? cfg?.database,
      sqlText: p.sql,
      sqlKind: p.sqlKind,
      permissionMode: cfg?.permissionMode ?? 'approval',
      approvalStatus: 'rejected',
      approvalId: p.approvalId,
      status: 'blocked',
      error: '用户取消了审批',
      durationMs: 0
    })
    this.emitApprovalResolved(token, {
      status: 'denied',
      sqlKind: p.sqlKind,
      error: '用户取消了审批'
    })
  }

  private async doExecute(
    connectionId: string,
    sql: string,
    database: string | undefined,
    kind: SqlKind,
    approvalStatus: 'not_required' | 'approved',
    approvalId?: string
  ): Promise<ExecuteResponse> {
    const cfg = this.connections.get(connectionId)
    if (!cfg) return { status: 'error', error: '连接不存在' }
    const started = Date.now()
    try {
      const driver = await this.drivers.get(connectionId)
      const { statements } = classifyDatabaseInput(cfg.type, sql)
      const isWrite = kind === 'WRITE' || kind === 'DDL'
      // PostgreSQL 明确禁止在事务中执行 CREATE DATABASE；MySQL / SQL Server
      // 的建库语句也属于连接级操作。侧边栏建库只会生成一条语句，因此在保留
      // 原有分类、审批和审计流程的同时，单独绕开表结构变更使用的事务包装。
      const createsDatabase = statements.length === 1
        && (cfg.type === 'mysql' || cfg.type === 'postgres' || cfg.type === 'sqlserver')
        && /^\s*CREATE\s+DATABASE\b/i.test(statements[0].sql)
      const results = isWrite
        ? createsDatabase
          ? await driver.run(statements[0].sql, database)
          : await driver.runInTransaction(
              statements.map((s) => s.sql),
              database
            )
        : await driver.run(sql, database)
      const durationMs = Date.now() - started
      const affectedRows = results.reduce((sum, r) => sum + (r.affectedRows ?? 0), 0)
      this.audit.insert({
        connectionId,
        connectionName: cfg.name,
        connectionType: cfg.type,
        databaseName: database ?? cfg.database,
        sqlText: sql,
        sqlKind: kind,
        permissionMode: cfg.permissionMode,
        approvalStatus,
        approvalId,
        status: 'success',
        affectedRows: isWrite ? affectedRows : null,
        durationMs
      })
      // Redis 写命令会增删 key，MongoDB 可能隐式创建集合，Qdrant payload 字段也可能变化。
      const capabilities = driver.capabilities
      if (kind === 'DDL' || (kind === 'WRITE' && capabilities.recordModel !== 'row')) {
        this.emitMetadataChanged(connectionId)
      }
      return { status: 'ok', results, sqlKind: kind, durationMs }
    } catch (e) {
      const durationMs = Date.now() - started
      const message = e instanceof Error ? e.message : String(e)
      this.audit.insert({
        connectionId,
        connectionName: cfg.name,
        connectionType: cfg.type,
        databaseName: database ?? cfg.database,
        sqlText: sql,
        sqlKind: kind,
        permissionMode: cfg.permissionMode,
        approvalStatus,
        approvalId,
        status: 'error',
        error: message,
        durationMs
      })
      return { status: 'error', error: message, sqlKind: kind, durationMs }
    }
  }

  private async doExecuteOperation(
    connectionId: string,
    operation: DatabaseOperation,
    kind: SqlKind,
    approvalStatus: 'not_required' | 'approved',
    approvalId?: string
  ): Promise<ExecuteResponse> {
    const cfg = this.connections.get(connectionId)
    if (!cfg) return { status: 'error', error: '连接不存在' }
    const preview = databaseOperationPreview(operation)
    const database = 'target' in operation
      ? operation.target.database
      : 'source' in operation ? operation.source.database
        : operation.database
    const started = Date.now()
    try {
      const driver = await this.drivers.get(connectionId)
      const outcome = await driver.executeOperation(operation)
      const durationMs = Date.now() - started
      const affectedRows = outcome.results.reduce((sum, result) => sum + (result.affectedRows ?? 0), 0)
      this.audit.insert({
        connectionId, connectionName: cfg.name, connectionType: cfg.type,
        databaseName: database ?? cfg.database, sqlText: preview, sqlKind: kind,
        permissionMode: cfg.permissionMode, approvalStatus, status: 'success',
        approvalId,
        affectedRows, durationMs
      })
      if (kind === 'DDL' || (kind === 'WRITE' && driver.capabilities.recordModel !== 'row')) {
        this.emitMetadataChanged(connectionId)
      }
      return {
        status: 'ok', results: outcome.results, sqlKind: kind, durationMs,
        atomicity: outcome.atomicity, succeeded: outcome.succeeded, failed: outcome.failed,
        preview
      }
    } catch (error) {
      const durationMs = Date.now() - started
      const message = error instanceof Error ? error.message : String(error)
      this.audit.insert({
        connectionId, connectionName: cfg.name, connectionType: cfg.type,
        databaseName: database ?? cfg.database, sqlText: preview, sqlKind: kind,
        permissionMode: cfg.permissionMode, approvalStatus, status: 'error', error: message,
        approvalId,
        durationMs
      })
      return { status: 'error', error: message, sqlKind: kind, durationMs, preview }
    }
  }
}
