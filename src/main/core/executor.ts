import { randomUUID } from 'node:crypto'
import type { ExecuteResponse, SqlKind } from '../../shared/types'
import type { DriverManager } from '../drivers/manager'
import type { AuditStore } from '../store/audit'
import type { ConnectionStore } from '../store/connections'
import { classifySql } from './sqlClassify'
import { decide } from './permission'

interface PendingApproval {
  connectionId: string
  sql: string
  database?: string
  sqlKind: SqlKind
  createdAt: number
}

export interface ApprovalResolvedEvent {
  token: string
  response: ExecuteResponse
}

const APPROVAL_TTL_MS = 5 * 60 * 1000

/**
 * 统一执行管道:所有 SQL(编辑器 / 网格编辑 / 结构变更)都经过
 * 分类 → 权限判定 → (审批)→ 事务执行 → 审计。
 */
export class Executor {
  private pending = new Map<string, PendingApproval>()
  private approvalListeners = new Set<(event: ApprovalResolvedEvent) => void>()

  constructor(
    private connections: ConnectionStore,
    private drivers: DriverManager,
    private audit: AuditStore
  ) {}

  private gcPending(): void {
    const now = Date.now()
    for (const [token, p] of this.pending) {
      if (now - p.createdAt > APPROVAL_TTL_MS) this.pending.delete(token)
    }
  }

  onApprovalResolved(listener: (event: ApprovalResolvedEvent) => void): () => void {
    this.approvalListeners.add(listener)
    return () => this.approvalListeners.delete(listener)
  }

  private emitApprovalResolved(token: string, response: ExecuteResponse): void {
    for (const listener of this.approvalListeners) listener({ token, response })
  }

  async execute(connectionId: string, sql: string, database?: string): Promise<ExecuteResponse> {
    const cfg = this.connections.get(connectionId)
    if (!cfg) return { status: 'error', error: '连接不存在' }
    if (!sql.trim()) return { status: 'ok', results: [] }

    const { kind } = classifySql(sql)
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
      this.pending.set(token, { connectionId, sql, database, sqlKind: kind, createdAt: Date.now() })
      return { status: 'needsApproval', sqlKind: kind, approvalToken: token }
    }

    return this.doExecute(connectionId, sql, database, kind, 'not_required')
  }

  async confirmExecute(token: string): Promise<ExecuteResponse> {
    const p = this.pending.get(token)
    this.pending.delete(token) // 一次性,无论成败都消费掉
    if (!p) {
      const response: ExecuteResponse = { status: 'error', error: '审批已过期或已被处理,请重新执行' }
      this.emitApprovalResolved(token, response)
      return response
    }
    const response = await this.doExecute(p.connectionId, p.sql, p.database, p.sqlKind, 'approved')
    this.emitApprovalResolved(token, response)
    return response
  }

  async rejectExecute(token: string): Promise<void> {
    const p = this.pending.get(token)
    this.pending.delete(token)
    if (!p) return
    const cfg = this.connections.get(p.connectionId)
    this.audit.insert({
      connectionId: p.connectionId,
      connectionName: cfg?.name ?? '?',
      connectionType: cfg?.type ?? null,
      databaseName: p.database ?? cfg?.database,
      sqlText: p.sql,
      sqlKind: p.sqlKind,
      permissionMode: cfg?.permissionMode ?? 'approval',
      approvalStatus: 'rejected',
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
    approvalStatus: 'not_required' | 'approved'
  ): Promise<ExecuteResponse> {
    const cfg = this.connections.get(connectionId)
    if (!cfg) return { status: 'error', error: '连接不存在' }
    const started = Date.now()
    try {
      const driver = await this.drivers.get(connectionId)
      const { statements } = classifySql(sql)
      const isWrite = kind === 'WRITE' || kind === 'DDL'
      const results = isWrite
        ? await driver.runInTransaction(
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
        status: 'success',
        affectedRows: isWrite ? affectedRows : null,
        durationMs
      })
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
        status: 'error',
        error: message,
        durationMs
      })
      return { status: 'error', error: message, sqlKind: kind, durationMs }
    }
  }
}
