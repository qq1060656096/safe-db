import { app, safeStorage } from 'electron'
import Database from 'better-sqlite3'
import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { currentOperationId, sanitizeSensitiveContent, type ExecutionTraceRecord } from '../audit/trace'
import type {
  ApprovalLogAction,
  ApprovalLogEntry,
  ApprovalLogFilter,
  ApprovalLogPage,
  ApprovalStatus,
  AuditFilter,
  AuditPage,
  DbType,
  ExecutionTraceDetail,
  ExecutionTraceSummary,
  AuditIntegrityResult,
  OperationCategory,
  OperationLogEntry,
  OperationLogFilter,
  OperationLogPage,
  OperationLogStatus,
  PermissionMode,
  SqlKind
} from '../../shared/types'

type AuditDb = InstanceType<typeof Database>

/** 兼容执行器原有 SQL 审计入口；最终统一写入 operation_log。 */
export interface AuditInsert {
  connectionId: string
  connectionName: string
  connectionType: DbType | null
  databaseName?: string | null
  sqlText: string
  sqlKind: SqlKind
  permissionMode: PermissionMode
  approvalStatus: ApprovalStatus
  approvalId?: string | null
  status: 'success' | 'error' | 'blocked'
  affectedRows?: number | null
  error?: string | null
  durationMs: number
}

export interface OperationLogInsert {
  eventId?: string
  category: OperationCategory
  action: string
  connectionId?: string | null
  connectionName?: string | null
  connectionType?: DbType | null
  databaseName?: string | null
  targetType?: string | null
  targetId?: string | null
  targetName?: string | null
  summary: string
  sqlText?: string | null
  sqlKind?: SqlKind | null
  permissionMode?: PermissionMode | null
  approvalId?: string | null
  status: OperationLogStatus
  affectedRows?: number | null
  error?: string | null
  durationMs?: number
  details?: Record<string, unknown> | null
  occurredAt?: string
}

export interface ApprovalLogInsert {
  approvalId: string
  action: ApprovalLogAction
  connectionId: string
  connectionName: string
  connectionType: DbType | null
  databaseName?: string | null
  sqlText: string
  sqlKind: SqlKind
  permissionMode: PermissionMode
  message?: string | null
  occurredAt?: string
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const parsed = JSON.parse(value) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function dbType(value: unknown): DbType | null {
  return value === 'mysql' || value === 'postgres' || value === 'sqlite' || value === 'sqlserver'
    || value === 'mongodb' || value === 'redis' || value === 'qdrant'
    ? value
    : null
}

interface StoredAuditKeyFile {
  version: 1
  activeKeyId: string
  keys: Record<string, string>
}

interface EncryptedPayload {
  keyId: string
  iv: string
  authTag: string
  ciphertext: string
}

/**
 * 审计存储。两种日志独立建模：
 * - operation_log：Safe DB 中具有审计价值的服务端行为；
 * - approval_log：审批请求及其不可变状态流转历史。
 */
export class AuditStore {
  private db: AuditDb
  private keyFile: string
  private keys = new Map<string, Buffer>()
  private activeKeyId = ''

  constructor(databasePath?: string) {
    const path = databasePath ?? join(app.getPath('userData'), 'audit.db')
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.keyFile = join(dir, 'audit-keys.json')
    this.loadOrCreateKeys(databasePath !== undefined)
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('secure_delete = ON')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        legacy_audit_id INTEGER UNIQUE,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        connection_id TEXT,
        connection_name TEXT,
        connection_type TEXT,
        database_name TEXT,
        target_type TEXT,
        target_id TEXT,
        target_name TEXT,
        summary TEXT NOT NULL,
        sql_text TEXT,
        sql_kind TEXT,
        permission_mode TEXT,
        approval_id TEXT,
        status TEXT NOT NULL,
        affected_rows INTEGER,
        error TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        details_json TEXT,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_operation_time ON operation_log(occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_operation_conn ON operation_log(connection_id);
      CREATE INDEX IF NOT EXISTS idx_operation_category ON operation_log(category, action);
      CREATE INDEX IF NOT EXISTS idx_operation_approval ON operation_log(approval_id);

      CREATE TABLE IF NOT EXISTS approval_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        approval_id TEXT NOT NULL,
        action TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        connection_name TEXT NOT NULL,
        connection_type TEXT,
        database_name TEXT,
        sql_text TEXT NOT NULL,
        sql_kind TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        message TEXT,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_approval_time ON approval_log(occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_approval_id ON approval_log(approval_id, id);
      CREATE INDEX IF NOT EXISTS idx_approval_conn ON approval_log(connection_id);

      CREATE TABLE IF NOT EXISTS execution_trace (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        span_id TEXT NOT NULL,
        parent_span_id TEXT,
        sequence INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        protocol TEXT NOT NULL,
        driver_type TEXT NOT NULL,
        command_name TEXT NOT NULL,
        database_name TEXT,
        status TEXT NOT NULL,
        returned_rows INTEGER,
        matched_rows INTEGER,
        affected_rows INTEGER,
        response_bytes INTEGER,
        error_code TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        key_id TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        content_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trace_operation ON execution_trace(operation_id, sequence, started_at);
      CREATE INDEX IF NOT EXISTS idx_trace_time ON execution_trace(started_at DESC);
      CREATE TABLE IF NOT EXISTS audit_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
    this.ensureColumn('approval_log', 'sensitive_key_id', 'TEXT')
    this.ensureColumn('approval_log', 'sensitive_iv', 'TEXT')
    this.ensureColumn('approval_log', 'sensitive_auth_tag', 'TEXT')
    this.ensureColumn('approval_log', 'sensitive_ciphertext', 'TEXT')
    this.migrateLegacyAuditLog()
    this.encryptLegacyPlaintext()
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.pragma(`table_info(${table})`) as { name: string }[]
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }

  private loadOrCreateKeys(testMode: boolean): void {
    // 契约测试运行在 ELECTRON_RUN_AS_NODE 环境，没有 safeStorage；只有显式传入
    // 测试数据库路径时才允许稳定测试密钥，产品运行绝不降级为明文密钥。
    if (!safeStorage?.isEncryptionAvailable?.()) {
      if (!testMode) throw new Error('系统安全存储不可用，无法初始化敏感审计日志加密密钥')
      const key = createHash('sha256').update(this.keyFile).digest()
      this.activeKeyId = 'test-key-v1'
      this.keys.set(this.activeKeyId, key)
      return
    }
    if (existsSync(this.keyFile)) {
      const stored = JSON.parse(readFileSync(this.keyFile, 'utf-8')) as StoredAuditKeyFile
      if (stored.version !== 1 || !stored.activeKeyId || !stored.keys) throw new Error('审计密钥文件格式无效')
      for (const [id, encrypted] of Object.entries(stored.keys)) {
        const raw = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
        const key = Buffer.from(raw, 'base64')
        if (key.length !== 32) throw new Error(`审计密钥 ${id} 长度无效`)
        this.keys.set(id, key)
      }
      if (!this.keys.has(stored.activeKeyId)) throw new Error('审计活动密钥不存在')
      this.activeKeyId = stored.activeKeyId
      return
    }
    this.rotateEncryptionKey()
  }

  private persistKeys(): void {
    if (!safeStorage?.isEncryptionAvailable?.()) return
    const keys = Object.fromEntries([...this.keys].map(([id, key]) => [
      id,
      safeStorage.encryptString(key.toString('base64')).toString('base64')
    ]))
    const payload: StoredAuditKeyFile = { version: 1, activeKeyId: this.activeKeyId, keys }
    writeFileSync(this.keyFile, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600 })
  }

  rotateEncryptionKey(): string {
    const id = `key-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
    this.keys.set(id, randomBytes(32))
    this.activeKeyId = id
    this.persistKeys()
    return id
  }

  private encrypt(value: unknown): EncryptedPayload {
    const key = this.keys.get(this.activeKeyId)
    if (!key) throw new Error('审计活动加密密钥不可用')
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf-8'), cipher.final()])
    return {
      keyId: this.activeKeyId,
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64')
    }
  }

  private decrypt(payload: EncryptedPayload): unknown {
    const key = this.keys.get(payload.keyId)
    if (!key) throw new Error(`审计密钥 ${payload.keyId} 不可用`)
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'))
    const plain = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, 'base64')),
      decipher.final()
    ])
    return JSON.parse(plain.toString('utf-8')) as unknown
  }

  private migrateLegacyAuditLog(): void {
    const legacy = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'"
    ).get()
    if (!legacy) return
    const columns = this.db.pragma('table_info(audit_log)') as { name: string }[]
    const connectionType = columns.some((column) => column.name === 'connection_type')
      ? 'connection_type'
      : 'NULL'
    this.db.exec(`
      INSERT OR IGNORE INTO operation_log (
        event_id, legacy_audit_id, category, action, connection_id, connection_name,
        connection_type, database_name, summary, sql_kind, permission_mode,
        status, affected_rows, error, duration_ms, occurred_at
      )
      SELECT
        'legacy-audit-' || id, id, 'query', 'EXECUTE_SQL', connection_id, connection_name,
        ${connectionType}, database_name, '执行数据库语句', sql_kind, permission_mode,
        status, affected_rows, error, duration_ms, executed_at
      FROM audit_log
    `)
    const rows = this.db.prepare(`SELECT id, ${connectionType} AS connection_type,
      database_name, sql_text, sql_kind, status, affected_rows, error, duration_ms, executed_at
      FROM audit_log ORDER BY id`).all() as Record<string, unknown>[]
    for (const row of rows) {
      const operationId = `legacy-audit-${String(row.id)}`
      const exists = this.db.prepare('SELECT 1 FROM execution_trace WHERE operation_id = ? LIMIT 1').get(operationId)
      if (exists) continue
      this.recordExecutionTrace({
        id: randomUUID(), operationId, spanId: randomUUID(), parentSpanId: null,
        sequence: 1, attempt: 1, protocol: 'sql',
        driverType: String(row.connection_type ?? 'legacy'),
        commandName: String(row.sql_kind ?? 'EXECUTE_SQL'),
        databaseName: row.database_name as string | null,
        status: row.status === 'success' ? 'success' : 'error',
        returnedRows: null, matchedRows: null, affectedRows: row.affected_rows as number | null,
        responseBytes: null, errorCode: null, errorMessage: row.error as string | null,
        startedAt: String(row.executed_at), finishedAt: String(row.executed_at),
        durationMs: Number(row.duration_ms ?? 0),
        sensitive: { statement: String(row.sql_text ?? '') }
      })
    }
    // 旧表含明文 SQL；全部迁移并校验写入成功后立即移除。
    this.db.exec('DROP TABLE audit_log')
  }

  private encryptLegacyPlaintext(): void {
    const operations = this.db.prepare(`
      SELECT event_id, connection_type, database_name, sql_text, sql_kind, status,
             affected_rows, error, duration_ms, occurred_at
      FROM operation_log WHERE sql_text IS NOT NULL AND sql_text <> ''
    `).all() as Record<string, unknown>[]
    for (const row of operations) {
      const exists = this.db.prepare('SELECT 1 FROM execution_trace WHERE operation_id = ? LIMIT 1')
        .get(row.event_id)
      if (!exists) {
        this.recordExecutionTrace({
          id: randomUUID(),
          operationId: String(row.event_id),
          spanId: randomUUID(),
          parentSpanId: null,
          sequence: 1,
          attempt: 1,
          protocol: 'sql',
          driverType: String(row.connection_type ?? 'legacy'),
          commandName: String(row.sql_kind ?? 'EXECUTE_SQL'),
          databaseName: row.database_name as string | null,
          status: row.status === 'success' ? 'success' : 'error',
          returnedRows: null,
          matchedRows: null,
          affectedRows: row.affected_rows as number | null,
          responseBytes: null,
          errorCode: null,
          errorMessage: row.error as string | null,
          startedAt: String(row.occurred_at),
          finishedAt: String(row.occurred_at),
          durationMs: Number(row.duration_ms ?? 0),
          sensitive: { statement: String(row.sql_text) }
        })
      }
    }
    // 安全迁移完成后清除所有历史明文 SQL 和可能回显数据的错误详情。
    this.db.prepare(`UPDATE operation_log SET sql_text = NULL,
      error = CASE WHEN error IS NULL THEN NULL ELSE '操作失败，查看执行明细' END
      WHERE sql_text IS NOT NULL OR error IS NOT NULL`).run()

    const approvals = this.db.prepare(`
      SELECT id, sql_text, message FROM approval_log
      WHERE sensitive_ciphertext IS NULL AND sql_text <> '[已加密]'
    `).all() as { id: number; sql_text: string; message: string | null }[]
    const update = this.db.prepare(`UPDATE approval_log SET sql_text = '[已加密]', message = NULL,
      sensitive_key_id = ?, sensitive_iv = ?, sensitive_auth_tag = ?, sensitive_ciphertext = ? WHERE id = ?`)
    for (const row of approvals) {
      const encrypted = this.encrypt({ sqlText: row.sql_text, message: row.message })
      update.run(encrypted.keyId, encrypted.iv, encrypted.authTag, encrypted.ciphertext, row.id)
    }
  }

  private traceHash(
    keyId: string,
    previousHash: string,
    metadata: Record<string, unknown>,
    encrypted: EncryptedPayload
  ): string {
    const key = this.keys.get(keyId)
    if (!key) throw new Error(`审计完整性密钥 ${keyId} 不可用`)
    return createHmac('sha256', key)
      .update(previousHash)
      .update(JSON.stringify(metadata))
      .update(encrypted.iv)
      .update(encrypted.authTag)
      .update(encrypted.ciphertext)
      .digest('hex')
  }

  recordExecutionTrace(record: ExecutionTraceRecord): void {
    const encrypted = this.encrypt({
      ...sanitizeSensitiveContent(record.sensitive),
      // 驱动错误经常回显连接串或认证上下文；状态与错误码足以审计，原始消息不落盘。
      errorMessage: record.errorMessage ? '底层执行失败（原始错误消息未记录）' : null
    })
    const metadata = {
      id: record.id, operationId: record.operationId, spanId: record.spanId,
      parentSpanId: record.parentSpanId ?? null, sequence: record.sequence, attempt: record.attempt,
      protocol: record.protocol, driverType: record.driverType, commandName: record.commandName,
      databaseName: record.databaseName ?? null, status: record.status,
      returnedRows: record.returnedRows ?? null, matchedRows: record.matchedRows ?? null,
      affectedRows: record.affectedRows ?? null, responseBytes: record.responseBytes ?? null,
      errorCode: record.errorCode ?? null, startedAt: record.startedAt,
      finishedAt: record.finishedAt, durationMs: record.durationMs
    }
    const transaction = this.db.transaction(() => {
      const previous = this.db.prepare('SELECT content_hash FROM execution_trace ORDER BY rowid DESC LIMIT 1')
        .get() as { content_hash?: string } | undefined
      const anchor = this.db.prepare("SELECT value FROM audit_settings WHERE key = 'chain_anchor'")
        .get() as { value?: string } | undefined
      const previousHash = previous?.content_hash ?? anchor?.value ?? 'GENESIS'
      const contentHash = this.traceHash(encrypted.keyId, previousHash, metadata, encrypted)
      this.db.prepare(`
        INSERT INTO execution_trace (
          id, operation_id, span_id, parent_span_id, sequence, attempt, protocol, driver_type,
          command_name, database_name, status, returned_rows, matched_rows, affected_rows,
          response_bytes, error_code, started_at, finished_at, duration_ms, key_id, iv,
          auth_tag, ciphertext, previous_hash, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id, record.operationId, record.spanId, record.parentSpanId ?? null,
        record.sequence, record.attempt, record.protocol, record.driverType, record.commandName,
        record.databaseName ?? null, record.status, record.returnedRows ?? null,
        record.matchedRows ?? null, record.affectedRows ?? null, record.responseBytes ?? null,
        record.errorCode ?? null, record.startedAt, record.finishedAt, record.durationMs,
        encrypted.keyId, encrypted.iv, encrypted.authTag, encrypted.ciphertext,
        previousHash, contentHash
      )
    })
    transaction()
  }

  listExecutionTraces(operationId: string): ExecutionTraceSummary[] {
    const rows = this.db.prepare(`SELECT * FROM execution_trace WHERE operation_id = ?
      ORDER BY sequence, started_at, rowid`).all(operationId) as Record<string, unknown>[]
    return rows.map((row) => this.mapExecutionSummary(row))
  }

  revealExecutionTrace(id: string): ExecutionTraceDetail {
    const row = this.db.prepare('SELECT rowid AS chain_rowid, * FROM execution_trace WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) throw new Error('执行明细不存在')
    const payload = {
      keyId: String(row.key_id), iv: String(row.iv), authTag: String(row.auth_tag), ciphertext: String(row.ciphertext)
    }
    const integrityValid = this.verifyTraceRow(row)
    if (!integrityValid) throw new Error('执行明细完整性校验失败，内容可能已被篡改')
    const sensitive = this.decrypt(payload) as ExecutionTraceDetail['sensitive']
    return { ...this.mapExecutionSummary(row), sensitive, integrityValid }
  }

  private mapExecutionSummary(row: Record<string, unknown>): ExecutionTraceSummary {
    return {
      id: String(row.id), operationId: String(row.operation_id), spanId: String(row.span_id),
      parentSpanId: row.parent_span_id as string | null, sequence: Number(row.sequence),
      attempt: Number(row.attempt), protocol: row.protocol as ExecutionTraceSummary['protocol'],
      driverType: String(row.driver_type), commandName: String(row.command_name),
      databaseName: row.database_name as string | null,
      status: row.status as ExecutionTraceSummary['status'],
      returnedRows: row.returned_rows as number | null, matchedRows: row.matched_rows as number | null,
      affectedRows: row.affected_rows as number | null, responseBytes: row.response_bytes as number | null,
      errorCode: row.error_code as string | null, startedAt: String(row.started_at),
      finishedAt: String(row.finished_at), durationMs: Number(row.duration_ms),
      keyId: String(row.key_id), contentHash: String(row.content_hash)
    }
  }

  private verifyTraceRow(row: Record<string, unknown>): boolean {
    const metadata = {
      id: row.id, operationId: row.operation_id, spanId: row.span_id,
      parentSpanId: row.parent_span_id ?? null, sequence: Number(row.sequence), attempt: Number(row.attempt),
      protocol: row.protocol, driverType: row.driver_type, commandName: row.command_name,
      databaseName: row.database_name ?? null, status: row.status,
      returnedRows: row.returned_rows ?? null, matchedRows: row.matched_rows ?? null,
      affectedRows: row.affected_rows ?? null, responseBytes: row.response_bytes ?? null,
      errorCode: row.error_code ?? null, startedAt: row.started_at,
      finishedAt: row.finished_at, durationMs: Number(row.duration_ms)
    }
    const expected = this.traceHash(String(row.key_id), String(row.previous_hash), metadata, {
      keyId: String(row.key_id), iv: String(row.iv), authTag: String(row.auth_tag), ciphertext: String(row.ciphertext)
    })
    const actualBuffer = Buffer.from(String(row.content_hash), 'hex')
    const expectedBuffer = Buffer.from(expected, 'hex')
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return false
    const previous = this.db.prepare('SELECT content_hash FROM execution_trace WHERE rowid < ? ORDER BY rowid DESC LIMIT 1')
      .get(row.chain_rowid ?? row.rowid) as { content_hash?: string } | undefined
    const anchor = this.db.prepare("SELECT value FROM audit_settings WHERE key = 'chain_anchor'")
      .get() as { value?: string } | undefined
    return String(row.previous_hash) === (previous?.content_hash ?? anchor?.value ?? 'GENESIS')
  }

  verifyIntegrity(): AuditIntegrityResult {
    const rows = this.db.prepare('SELECT rowid AS chain_rowid, * FROM execution_trace ORDER BY rowid')
      .all() as Record<string, unknown>[]
    for (let index = 0; index < rows.length; index += 1) {
      if (!this.verifyTraceRow(rows[index])) {
        return { valid: false, checked: index + 1, failedTraceId: String(rows[index].id) }
      }
    }
    return { valid: true, checked: rows.length, failedTraceId: null }
  }

  purgeExpired(retentionDays: number): number {
    if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error('日志保留天数必须是正整数')
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString()
    // 只清理哈希链的连续前缀，避免系统时钟回拨时删除链中间节点。
    const firstRetained = this.db.prepare('SELECT rowid FROM execution_trace WHERE started_at >= ? ORDER BY rowid LIMIT 1')
      .get(cutoff) as { rowid: number } | undefined
    const last = this.db.prepare(`SELECT rowid, content_hash FROM execution_trace
      WHERE rowid < ? ORDER BY rowid DESC LIMIT 1`)
      .get(firstRetained?.rowid ?? Number.MAX_SAFE_INTEGER) as { rowid: number; content_hash: string } | undefined
    const transaction = this.db.transaction(() => {
      if (last) this.db.prepare(`INSERT INTO audit_settings(key, value) VALUES('chain_anchor', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(last.content_hash)
      const traces = last
        ? this.db.prepare('DELETE FROM execution_trace WHERE rowid <= ?').run(last.rowid).changes
        : 0
      this.db.prepare('DELETE FROM operation_log WHERE occurred_at < ?').run(cutoff)
      this.db.prepare('DELETE FROM approval_log WHERE occurred_at < ?').run(cutoff)
      return traces
    })
    const removed = transaction()
    this.db.pragma('wal_checkpoint(TRUNCATE)')
    this.db.exec('VACUUM')
    return removed
  }

  close(): void {
    this.db.close()
  }

  recordOperation(entry: OperationLogInsert): string {
    const eventId = entry.eventId ?? currentOperationId() ?? randomUUID()
    this.db.prepare(`
      INSERT OR IGNORE INTO operation_log (
        event_id, category, action, connection_id, connection_name, connection_type,
        database_name, target_type, target_id, target_name, summary, sql_text, sql_kind,
        permission_mode, approval_id, status, affected_rows, error, duration_ms,
        details_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      entry.category,
      entry.action,
      entry.connectionId ?? null,
      entry.connectionName ?? null,
      entry.connectionType ?? null,
      entry.databaseName ?? null,
      entry.targetType ?? null,
      entry.targetId ?? null,
      entry.targetName ?? null,
      entry.summary,
      null,
      entry.sqlKind ?? null,
      entry.permissionMode ?? null,
      entry.approvalId ?? null,
      entry.status,
      entry.affectedRows ?? null,
      entry.error ? '操作失败，查看执行明细' : null,
      entry.durationMs ?? 0,
      entry.details ? JSON.stringify(entry.details) : null,
      entry.occurredAt ?? new Date().toISOString()
    )
    return eventId
  }

  recordApproval(entry: ApprovalLogInsert): string {
    const eventId = randomUUID()
    const safe = sanitizeSensitiveContent({ statement: entry.sqlText, command: { message: entry.message ?? null } })
    const encrypted = this.encrypt({
      sqlText: safe.statement ?? '',
      message: (safe.command as { message?: string | null } | undefined)?.message ?? null
    })
    this.db.prepare(`
      INSERT INTO approval_log (
        event_id, approval_id, action, connection_id, connection_name, connection_type,
        database_name, sql_text, sql_kind, permission_mode, message, occurred_at,
        sensitive_key_id, sensitive_iv, sensitive_auth_tag, sensitive_ciphertext
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      entry.approvalId,
      entry.action,
      entry.connectionId,
      entry.connectionName,
      entry.connectionType,
      entry.databaseName ?? null,
      '[已加密]',
      entry.sqlKind,
      entry.permissionMode,
      null,
      entry.occurredAt ?? new Date().toISOString(),
      encrypted.keyId,
      encrypted.iv,
      encrypted.authTag,
      encrypted.ciphertext
    )
    return eventId
  }

  /** SQL/原生命令执行日志的兼容入口。 */
  insert(entry: AuditInsert): void {
    const operationId = currentOperationId()
    if (operationId) {
      const hasTrace = this.db.prepare('SELECT 1 FROM execution_trace WHERE operation_id = ? LIMIT 1').get(operationId)
      if (!hasTrace) {
        const now = new Date().toISOString()
        this.recordExecutionTrace({
          id: randomUUID(), operationId, spanId: randomUUID(), parentSpanId: null,
          sequence: 1, attempt: 1, protocol: 'sql', driverType: entry.connectionType ?? 'unknown',
          commandName: entry.sqlKind, databaseName: entry.databaseName ?? null,
          status: entry.status === 'success' ? 'success' : 'error', returnedRows: null,
          matchedRows: null, affectedRows: entry.affectedRows ?? null, responseBytes: null,
          errorCode: null, errorMessage: entry.error ?? null, startedAt: now, finishedAt: now,
          durationMs: entry.durationMs, sensitive: { statement: entry.sqlText }
        })
      }
    }
    this.recordOperation({
      category: 'query',
      action: entry.sqlKind === 'READ' ? 'EXECUTE_QUERY' : 'EXECUTE_CHANGE',
      connectionId: entry.connectionId,
      connectionName: entry.connectionName,
      connectionType: entry.connectionType,
      databaseName: entry.databaseName,
      targetType: 'database',
      targetId: entry.databaseName,
      targetName: entry.databaseName,
      summary: entry.sqlKind === 'READ' ? '执行查询' : '执行数据变更',
      sqlText: entry.sqlText,
      sqlKind: entry.sqlKind,
      permissionMode: entry.permissionMode,
      approvalId: entry.approvalId,
      status: entry.status,
      affectedRows: entry.affectedRows,
      error: entry.error,
      durationMs: entry.durationMs,
      details: { approvalStatus: entry.approvalStatus }
    })
  }

  queryOperations(filter: OperationLogFilter): OperationLogPage {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.connectionId) { where.push('connection_id = ?'); params.push(filter.connectionId) }
    if (filter.category) { where.push('category = ?'); params.push(filter.category) }
    if (filter.status) { where.push('status = ?'); params.push(filter.status) }
    if (filter.keyword) {
      where.push('(summary LIKE ? OR action LIKE ? OR sql_text LIKE ? OR target_name LIKE ? OR approval_id LIKE ? OR error LIKE ?)')
      const keyword = `%${filter.keyword}%`
      params.push(keyword, keyword, keyword, keyword, keyword, keyword)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM operation_log ${whereSql}`).get(...params) as { n: number }).n
    const rows = this.db.prepare(`
      SELECT * FROM operation_log ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(...params, filter.pageSize, (filter.page - 1) * filter.pageSize) as Record<string, unknown>[]
    return { total, rows: rows.map((row) => this.mapOperation(row)) }
  }

  queryApprovals(filter: ApprovalLogFilter): ApprovalLogPage {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.connectionId) { where.push('connection_id = ?'); params.push(filter.connectionId) }
    if (filter.action) { where.push('action = ?'); params.push(filter.action) }
    if (filter.keyword) {
      where.push('(sql_text LIKE ? OR approval_id LIKE ? OR message LIKE ?)')
      const keyword = `%${filter.keyword}%`
      params.push(keyword, keyword, keyword)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM approval_log ${whereSql}`).get(...params) as { n: number }).n
    const rows = this.db.prepare(`
      SELECT * FROM approval_log ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(...params, filter.pageSize, (filter.page - 1) * filter.pageSize) as Record<string, unknown>[]
    return {
      total,
      rows: rows.map((row): ApprovalLogEntry => ({
        id: row.id as number,
        eventId: row.event_id as string,
        approvalId: row.approval_id as string,
        action: row.action as ApprovalLogAction,
        connectionId: row.connection_id as string,
        connectionName: row.connection_name as string,
        connectionType: dbType(row.connection_type),
        databaseName: row.database_name as string | null,
        sqlText: row.sql_text as string,
        sqlKind: row.sql_kind as SqlKind,
        permissionMode: row.permission_mode as PermissionMode,
        message: row.message as string | null,
        occurredAt: row.occurred_at as string
      }))
    }
  }

  private mapOperation(row: Record<string, unknown>): OperationLogEntry {
    return {
      id: row.id as number,
      eventId: row.event_id as string,
      category: row.category as OperationCategory,
      action: row.action as string,
      connectionId: row.connection_id as string | null,
      connectionName: row.connection_name as string | null,
      connectionType: dbType(row.connection_type),
      databaseName: row.database_name as string | null,
      targetType: row.target_type as string | null,
      targetId: row.target_id as string | null,
      targetName: row.target_name as string | null,
      summary: row.summary as string,
      sqlText: row.sql_text as string | null,
      sqlKind: row.sql_kind as SqlKind | null,
      permissionMode: row.permission_mode as PermissionMode | null,
      approvalId: row.approval_id as string | null,
      status: row.status as OperationLogStatus,
      affectedRows: row.affected_rows as number | null,
      error: row.error as string | null,
      durationMs: row.duration_ms as number,
      details: parseJson(row.details_json),
      occurredAt: row.occurred_at as string
    }
  }

  /** @deprecated 兼容旧版渲染进程；新版界面使用 queryOperations。 */
  query(filter: AuditFilter): AuditPage {
    const page = this.queryOperations({
      connectionId: filter.connectionId,
      status: filter.status,
      keyword: filter.keyword,
      page: filter.page,
      pageSize: filter.pageSize
    })
    const rows = page.rows
      .filter((row) => (!filter.sqlKind || row.sqlKind === filter.sqlKind)
        && (!filter.approvalStatus || row.details?.approvalStatus === filter.approvalStatus))
      .map((row) => ({
        id: row.id,
        connectionId: row.connectionId ?? '',
        connectionName: row.connectionName ?? '',
        connectionType: row.connectionType,
        databaseName: row.databaseName,
        sqlText: row.sqlText ?? row.summary,
        sqlKind: row.sqlKind ?? 'OTHER' as SqlKind,
        permissionMode: row.permissionMode ?? 'full' as PermissionMode,
        approvalStatus: (row.details?.approvalStatus ?? 'not_required') as ApprovalStatus,
        status: row.status === 'canceled' ? 'blocked' as const : row.status,
        affectedRows: row.affectedRows,
        error: row.error,
        durationMs: row.durationMs,
        executedAt: row.occurredAt
      }))
    return { total: filter.sqlKind || filter.approvalStatus ? rows.length : page.total, rows }
  }
}
