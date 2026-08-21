import { app } from 'electron'
import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AuditEntry,
  AuditFilter,
  AuditPage,
  ApprovalStatus,
  DbType,
  PermissionMode,
  SqlKind
} from '../../shared/types'

type AuditDb = InstanceType<typeof Database>

export interface AuditInsert {
  connectionId: string
  connectionName: string
  connectionType: DbType | null
  databaseName?: string | null
  sqlText: string
  sqlKind: SqlKind
  permissionMode: PermissionMode
  approvalStatus: ApprovalStatus
  status: 'success' | 'error' | 'blocked'
  affectedRows?: number | null
  error?: string | null
  durationMs: number
}

/** 审计日志存储:userData/audit.db(SQLite) */
export class AuditStore {
  private db: AuditDb

  constructor() {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.db = new Database(join(dir, 'audit.db'))
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id TEXT NOT NULL,
        connection_name TEXT NOT NULL,
        connection_type TEXT,
        database_name TEXT,
        sql_text TEXT NOT NULL,
        sql_kind TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        approval_status TEXT NOT NULL,
        status TEXT NOT NULL,
        affected_rows INTEGER,
        error TEXT,
        duration_ms INTEGER NOT NULL,
        executed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(executed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_conn ON audit_log(connection_id);
    `)
    const columns = this.db.pragma('table_info(audit_log)') as { name: string }[]
    if (!columns.some((column) => column.name === 'connection_type')) {
      this.db.exec('ALTER TABLE audit_log ADD COLUMN connection_type TEXT')
    }
  }

  insert(e: AuditInsert): void {
    this.db
      .prepare(
        `INSERT INTO audit_log
         (connection_id, connection_name, connection_type, database_name, sql_text, sql_kind, permission_mode,
          approval_status, status, affected_rows, error, duration_ms, executed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        e.connectionId,
        e.connectionName,
        e.connectionType,
        e.databaseName ?? null,
        e.sqlText,
        e.sqlKind,
        e.permissionMode,
        e.approvalStatus,
        e.status,
        e.affectedRows ?? null,
        e.error ?? null,
        e.durationMs,
        new Date().toISOString()
      )
  }

  query(f: AuditFilter): AuditPage {
    const where: string[] = []
    const params: unknown[] = []
    if (f.connectionId) {
      where.push('connection_id = ?')
      params.push(f.connectionId)
    }
    if (f.sqlKind) {
      where.push('sql_kind = ?')
      params.push(f.sqlKind)
    }
    if (f.status) {
      where.push('status = ?')
      params.push(f.status)
    }
    if (f.approvalStatus) {
      where.push('approval_status = ?')
      params.push(f.approvalStatus)
    }
    if (f.keyword) {
      where.push('sql_text LIKE ?')
      params.push(`%${f.keyword}%`)
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${whereSql}`).get(...params) as {
        n: number
      }
    ).n
    const rows = this.db
      .prepare(
        `SELECT * FROM audit_log ${whereSql}
         ORDER BY id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, f.pageSize, (f.page - 1) * f.pageSize) as Record<string, unknown>[]

    return {
      total,
      rows: rows.map((r) => ({
        id: r.id as number,
        connectionId: r.connection_id as string,
        connectionName: r.connection_name as string,
        connectionType: r.connection_type === 'mysql' || r.connection_type === 'postgres' || r.connection_type === 'sqlite'
          || r.connection_type === 'sqlserver' || r.connection_type === 'mongodb' || r.connection_type === 'redis'
          || r.connection_type === 'qdrant'
          ? r.connection_type
          : null,
        databaseName: r.database_name as string | null,
        sqlText: r.sql_text as string,
        sqlKind: r.sql_kind as SqlKind,
        permissionMode: r.permission_mode as PermissionMode,
        approvalStatus: r.approval_status as ApprovalStatus,
        status: r.status as AuditEntry['status'],
        affectedRows: r.affected_rows as number | null,
        error: r.error as string | null,
        durationMs: r.duration_ms as number,
        executedAt: r.executed_at as string
      }))
    }
  }
}
