import mysql from 'mysql2/promise'
import { normalizeMysqlSessionVariables } from '../core/nativeCommand'
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
import {
  buildWhereClause,
  sanitizeRows,
  rowsResultFromArrays,
  type DbDriver,
  type DriverOperationResult,
  type TableDataQuery,
  type TableDataResult
} from './base'
import { capabilitiesForType } from './capabilities'
import { compileRelationalOperation } from './relationalOperation'
import { traceExecution } from '../audit/trace'

const QUERY_CANCELED_MESSAGE = '查询已取消'
const CONNECTION_CLOSED_MESSAGE = '数据库连接已断开，执行已中断'
/**
 * 多语句事务按批发送，避免几百条语句逐条往返（经 SSH 隧道访问云数据库时每条约百毫秒）。
 * 单批上限远低于 MySQL 5.7 默认 max_allowed_packet（4MB）。
 */
const MAX_BATCH_BYTES = 1024 * 1024

/**
 * 把已切分的语句重新组合为多语句批次。分隔符前加换行，防止语句末尾残留的
 * `#` 行注释吞掉分号；DELIMITER 定义的存储过程体由服务端解析器按复合语句处理。
 */
export function batchMysqlStatements(sqls: string[], maxBytes = MAX_BATCH_BYTES): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let size = 0
  for (const sql of sqls) {
    const bytes = Buffer.byteLength(sql) + 3
    if (current.length && size + bytes > maxBytes) {
      batches.push(current)
      current = []
      size = 0
    }
    current.push(sql)
    size += bytes
  }
  if (current.length) batches.push(current)
  return batches
}

/** 反引号包裹标识符 */
function quoteIdent(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`'
}

export class MysqlDriver implements DbDriver {
  readonly capabilities = capabilitiesForType('mysql')
  private conn: mysql.Connection | null = null
  private interrupts = new WeakMap<mysql.Connection, (error: Error) => void>()

  constructor(
    private cfg: {
      host: string
      port: number
      user: string
      password?: string
      database?: string
    }
  ) {}

  private options(): mysql.ConnectionOptions {
    return {
      host: this.cfg.host,
      port: this.cfg.port,
      user: this.cfg.user,
      password: this.cfg.password,
      database: this.cfg.database || undefined,
      multipleStatements: true,
      charset: 'utf8mb4',
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      connectTimeout: 10000
    }
  }

  private instrument(connection: mysql.Connection): mysql.Connection {
    const mutable = connection as unknown as Record<
      'query' | 'execute' | 'beginTransaction' | 'commit' | 'rollback' | 'end',
      (...args: unknown[]) => Promise<unknown>
    >
    // mysql2 在 end()/destroy() 后会把连接标记为 closing；此后底层流被关闭（例如 SSH
    // 隧道随取消一起关闭）时，它不会再回调任何在途命令，导致 Promise 永远挂起、
    // 执行界面一直转圈且没有审计结果。这里为每条连接维护一个中断信号，取消、
    // 断开或传输层关闭时让所有在途和后续调用立即失败。
    let interrupt!: (error: Error) => void
    const interrupted = new Promise<never>((_, reject) => { interrupt = reject })
    interrupted.catch(() => {})
    this.interrupts.set(connection, interrupt)
    const core = (connection as unknown as { connection?: { stream?: { once?: (event: string, listener: () => void) => void } } }).connection
    core?.stream?.once?.('close', () => interrupt(new Error(CONNECTION_CLOSED_MESSAGE)))
    const guard = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, interrupted])

    for (const method of ['beginTransaction', 'commit', 'rollback', 'end'] as const) {
      const original = mutable[method].bind(connection)
      mutable[method] = (...args: unknown[]) => guard(original(...args))
    }
    for (const method of ['query', 'execute'] as const) {
      const original = mutable[method].bind(connection)
      mutable[method] = (...args: unknown[]) => guard((() => {
        const source = args[0]
        const statement = typeof source === 'string'
          ? source
          : source && typeof source === 'object' && 'sql' in source
            ? String((source as { sql: unknown }).sql)
            : String(source)
        const parameters = Array.isArray(args[1]) ? args[1] : []
        return traceExecution({
          protocol: 'sql', driverType: 'mysql', commandName: method.toUpperCase(),
          databaseName: this.cfg.database, sensitive: { statement, parameters }
        }, () => original(...args), (result) => {
          const raw = Array.isArray(result) ? result[0] : result
          if (Array.isArray(raw)) return { returnedRows: raw.length }
          if (raw && typeof raw === 'object' && 'affectedRows' in raw) {
            return { affectedRows: Number((raw as { affectedRows: unknown }).affectedRows) }
          }
          return {}
        })
      })())
    }
    return connection
  }

  private openConnection(): Promise<mysql.Connection> {
    return traceExecution({
      protocol: 'driver', driverType: 'mysql', commandName: 'CONNECT',
      databaseName: this.cfg.database, sensitive: { command: { action: 'connect' } }
    }, () => mysql.createConnection(this.options()))
  }

  async connect(): Promise<void> {
    if (this.conn?.state === 'authenticated') return
    // mysql2 在空闲超时/网络断开后会保留 PromiseConnection 对象，但其内部
    // 已进入 closed state；先丢弃该对象，再建立新会话。
    this.conn?.destroy()
    this.conn = null
    this.conn = this.instrument(await this.openConnection())
  }

  async disconnect(): Promise<void> {
    const connection = this.conn
    // 必须先置空；end() 将连接切换为 closing，期间若有并发请求不能再拿到它。
    this.conn = null
    if (!connection) return
    if (connection.state === 'authenticated' || connection.state === 'connected') {
      // end() 会等在途命令完成后再 QUIT；若传输层先断开，instrument 中的中断信号会让它结束。
      await connection.end().catch(() => {})
    } else {
      connection.destroy()
    }
    this.interrupts.get(connection)?.(new Error(CONNECTION_CLOSED_MESSAGE))
  }

  async cancel(): Promise<void> {
    const connection = this.conn
    this.conn = null
    if (!connection) return
    // 先让在途调用立即失败，再关闭连接；mysql2 不会为已 destroy 的连接回调在途命令。
    this.interrupts.get(connection)?.(new Error(QUERY_CANCELED_MESSAGE))
    connection.destroy()
  }

  async test(): Promise<void> {
    const c = this.instrument(await this.openConnection())
    await c.query('SELECT 1')
    await c.end()
  }

  private requireConn(): mysql.Connection {
    if (!this.conn) throw new Error('连接未建立')
    return this.conn
  }

  async listDatabases(): Promise<string[]> {
    const [rows] = await this.requireConn().query('SHOW DATABASES')
    return (rows as Record<string, unknown>[]).map((r) => String(Object.values(r)[0]))
  }

  async listTables(database?: string, _includeStats = false): Promise<TableInfo[]> {
    const db = database || this.cfg.database
    if (!db) throw new Error('未指定数据库')
    const [rows] = await this.requireConn().query(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_COMMENT AS comment,
              TABLE_ROWS AS rowCount, CREATE_TIME AS createdAt, UPDATE_TIME AS updatedAt
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_TYPE, TABLE_NAME`,
      [db]
    )
    return (rows as Record<string, unknown>[]).map((r) => {
      const dateValue = (value: unknown): string | undefined => value instanceof Date ? value.toISOString() : value ? String(value) : undefined
      return {
        name: String(r.name),
        type: r.type === 'VIEW' ? 'view' : 'table',
        comment: r.comment ? String(r.comment) : undefined,
        rowCount: r.rowCount === null || r.rowCount === undefined ? undefined : Number(r.rowCount),
        createdAt: dateValue(r.createdAt),
        updatedAt: dateValue(r.updatedAt)
      }
    })
  }

  async listRoutines(database?: string): Promise<RoutineInfo[]> {
    const db = database || this.cfg.database
    if (!db) throw new Error('未指定数据库')
    const [rows] = await this.requireConn().query(
      `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type, CREATED AS createdAt, LAST_ALTERED AS updatedAt
       FROM information_schema.ROUTINES
       WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME`,
      [db]
    )
    return (rows as Record<string, unknown>[]).map((row) => ({
      name: String(row.name),
      type: row.type === 'PROCEDURE' ? 'procedure' : 'function',
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt ? String(row.createdAt) : undefined,
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt ? String(row.updatedAt) : undefined
    }))
  }

  async listColumns(database: string | undefined, table: string): Promise<ColumnInfo[]> {
    const db = database || this.cfg.database
    const [rows] = await this.requireConn().query(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS dataType, IS_NULLABLE AS nullable,
              COLUMN_KEY AS colKey, COLUMN_DEFAULT AS defaultValue, EXTRA AS extra,
              COLUMN_COMMENT AS comment, ORDINAL_POSITION AS ordinal
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [db, table]
    )
    return (rows as Record<string, unknown>[]).map((r) => ({
      name: String(r.name),
      dataType: String(r.dataType),
      nullable: r.nullable === 'YES',
      isPrimaryKey: r.colKey === 'PRI',
      defaultValue: r.defaultValue === null || r.defaultValue === undefined ? null : String(r.defaultValue),
      extra: r.extra ? String(r.extra) : undefined,
      comment: r.comment ? String(r.comment) : undefined,
      ordinal: Number(r.ordinal)
    }))
  }

  async listIndexes(database: string | undefined, table: string): Promise<IndexInfo[]> {
    const db = database || this.cfg.database
    const [rows] = await this.requireConn().query(
      `SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, COLUMN_NAME AS col, SEQ_IN_INDEX AS seq
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [db, table]
    )
    const map = new Map<string, IndexInfo>()
    for (const r of rows as { name: string; nonUnique: number; col: string }[]) {
      const existing = map.get(r.name)
      if (existing) {
        existing.columns.push(r.col)
      } else {
        map.set(r.name, {
          name: r.name,
          columns: [r.col],
          unique: r.nonUnique === 0,
          primary: r.name === 'PRIMARY'
        })
      }
    }
    return [...map.values()]
  }

  async listForeignKeys(database: string | undefined, table: string): Promise<ForeignKeyInfo[]> {
    const db = database || this.cfg.database
    if (!db) throw new Error('未指定数据库')
    const [rows] = await this.requireConn().query(
      `SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col,
              k.REFERENCED_TABLE_SCHEMA AS referencedSchema,
              k.REFERENCED_TABLE_NAME AS referencedTable,
              k.REFERENCED_COLUMN_NAME AS referencedColumn,
              k.ORDINAL_POSITION AS ordinal,
              r.UPDATE_RULE AS onUpdate, r.DELETE_RULE AS onDelete
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
        AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
       WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ?
         AND k.REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [db, table]
    )
    const result = new Map<string, ForeignKeyInfo>()
    for (const row of rows as Record<string, unknown>[]) {
      const name = String(row.name)
      const existing = result.get(name)
      if (existing) {
        existing.columns.push(String(row.col))
        existing.referencedColumns.push(String(row.referencedColumn))
      } else {
        result.set(name, {
          name,
          columns: [String(row.col)],
          referencedSchema: row.referencedSchema ? String(row.referencedSchema) : undefined,
          referencedTable: String(row.referencedTable),
          referencedColumns: [String(row.referencedColumn)],
          onUpdate: row.onUpdate ? String(row.onUpdate) : undefined,
          onDelete: row.onDelete ? String(row.onDelete) : undefined
        })
      }
    }
    return [...result.values()]
  }

  async listCheckConstraints(database: string | undefined, table: string): Promise<CheckConstraintInfo[]> {
    const db = database || this.cfg.database
    if (!db) throw new Error('未指定数据库')
    try {
      const [rows] = await this.requireConn().query(
        `SELECT tc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS expression
         FROM information_schema.TABLE_CONSTRAINTS tc
         JOIN information_schema.CHECK_CONSTRAINTS cc
           ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
          AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
         WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ?
           AND tc.CONSTRAINT_TYPE = 'CHECK'
         ORDER BY tc.CONSTRAINT_NAME`,
        [db, table]
      )
      return (rows as Record<string, unknown>[]).map((row) => ({
        name: String(row.name),
        expression: String(row.expression)
      }))
    } catch {
      // MySQL 5.7 没有 CHECK_CONSTRAINTS 元数据表。
      return []
    }
  }

  async getObjectDdl(database: string | undefined, table: string): Promise<string> {
    const db = database || this.cfg.database
    if (!db) throw new Error('未指定数据库')
    const [rows] = await this.requireConn().query(
      `SHOW CREATE TABLE ${quoteIdent(db)}.${quoteIdent(table)}`
    )
    const row = (rows as Record<string, unknown>[])[0]
    const ddl = row?.['Create Table'] ?? row?.['Create View'] ?? (row ? Object.values(row)[1] : undefined)
    if (typeof ddl !== 'string' || !ddl.trim()) throw new Error('无法读取对象 DDL')
    return `${ddl.trim().replace(/;\s*$/, '')};`
  }

  async getRoutineDefinition(database: string | undefined, routine: string, type: RoutineInfo['type']): Promise<string> {
    const db = database || this.cfg.database
    if (!db) throw new Error('未指定数据库')
    const keyword = type === 'procedure' ? 'PROCEDURE' : 'FUNCTION'
    const [rows] = await this.requireConn().query(`SHOW CREATE ${keyword} ${quoteIdent(db)}.${quoteIdent(routine)}`)
    const row = (rows as Record<string, unknown>[])[0]
    const definition = row?.[`Create ${type === 'procedure' ? 'Procedure' : 'Function'}`]
    if (typeof definition !== 'string' || !definition.trim()) throw new Error('无法读取方法定义')
    const normalized = definition.trim()
    return /;\s*$/.test(normalized) ? normalized : `${normalized};`
  }

  private async primaryKey(database: string | undefined, table: string): Promise<string[]> {
    const cols = await this.listColumns(database, table)
    return cols.filter((c) => c.isPrimaryKey).map((c) => c.name)
  }

  async getTableData(qd: TableDataQuery, options?: { rawValues?: boolean }): Promise<TableDataResult> {
    const db = qd.database || this.cfg.database
    if (!db) throw new Error('未指定数据库')
    const columns = await this.listColumns(db, qd.table)
    const keyCols = await this.primaryKey(db, qd.table)
    const qualified = `${quoteIdent(db)}.${quoteIdent(qd.table)}`
    const where = buildWhereClause(qd.filters, quoteIdent, () => '?')
    let sql = `SELECT * FROM ${qualified}${where.sql}`
    if (qd.orderBy?.length) {
      sql +=
        ' ORDER BY ' +
        qd.orderBy
          .map((o) => `${quoteIdent(o.column)} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`)
          .join(', ')
    }
    sql += ' LIMIT ? OFFSET ?'
    const [rows] = await this.requireConn().query(sql, [
      ...where.params,
      qd.pageSize,
      (qd.page - 1) * qd.pageSize
    ])
    const [countRows] = await this.requireConn().query(
      `SELECT COUNT(*) AS n FROM ${qualified}${where.sql}`,
      where.params as never[]
    )
    const total = Number((countRows as { n: number | string }[])[0].n)
    return {
      columns,
      rows: options?.rawValues ? rows as Record<string, unknown>[] : sanitizeRows(rows as Record<string, unknown>[]),
      total,
      editable: keyCols.length > 0,
      keyColumns: keyCols
    }
  }

  /**
   * mysql2 结果归一化(查询以 rowsAsArray 执行):单语句返回 rows[][] 或 ResultSetHeader;
   * 多语句返回两者混合的数组。数组行模式下单语句 SELECT 的 raw[0] 也是数组,
   * 因此用 fields 区分:单语句 fields 是 FieldPacket[],多语句是 (FieldPacket[] | undefined)[]。
   */
  private normalize(raw: unknown, fields: unknown): QueryResult[] {
    const isResultHeader = (v: unknown): boolean =>
      typeof v === 'object' &&
      v !== null &&
      !Array.isArray(v) &&
      'affectedRows' in v &&
      'insertId' in v

    const multi = Array.isArray(raw) && raw.length > 0 && (
      isResultHeader(raw[0]) ||
      (Array.isArray(fields) && fields.length > 0 && (Array.isArray(fields[0]) || fields[0] === undefined || fields[0] === null))
    )
    if (multi) {
      const items = raw as unknown[]
      const fieldArr = Array.isArray(fields) ? fields : []
      return items.map((item, i) => this.singleResult(item, fieldArr[i]))
    }
    return [this.singleResult(raw, fields)]
  }

  private singleResult(raw: unknown, fields: unknown): QueryResult {
    if (Array.isArray(raw)) {
      const names = Array.isArray(fields)
        ? (fields as { name?: string }[]).map((f) => f?.name ?? '')
        : []
      return rowsResultFromArrays(names, raw as unknown[][])
    }
    const info = raw as { affectedRows?: number } | null | undefined
    return { kind: 'exec', affectedRows: info?.affectedRows ?? 0 }
  }

  async executeOperation(operation: DatabaseOperation): Promise<DriverOperationResult> {
    const commands = compileRelationalOperation(operation, 'mysql', this.cfg.database)
    const conn = this.requireConn()
    const transactional = operation.kind === 'records.mutate' || operation.kind === 'records.clear'
    if (transactional) await conn.beginTransaction()
    let affectedRows = 0
    try {
      for (const command of commands) {
        const [raw] = await conn.execute(command.sql, command.params as never[])
        affectedRows += Number((raw as { affectedRows?: number }).affectedRows ?? 0)
      }
      if (transactional) await conn.commit()
    } catch (error) {
      if (transactional) await conn.rollback().catch(() => {})
      throw error
    }
    const succeeded = operation.kind === 'records.mutate' ? operation.mutations.length : 1
    return {
      results: [{ kind: 'exec', affectedRows }],
      atomicity: transactional ? 'transaction' : commands.length === 1 ? 'single-request' : 'best-effort',
      succeeded,
      failed: 0
    }
  }

  async run(sql: string, database?: string): Promise<QueryResult[]> {
    const conn = this.requireConn()
    if (database) await conn.query(`USE ${quoteIdent(database)}`)
    const [raw, fields] = await conn.query({ sql: normalizeMysqlSessionVariables(sql), rowsAsArray: true })
    return this.normalize(raw, fields)
  }

  async runInTransaction(sqls: string[], database?: string): Promise<QueryResult[]> {
    const conn = this.requireConn()
    if (database) await conn.query(`USE ${quoteIdent(database)}`)
    await conn.beginTransaction()
    try {
      const results: QueryResult[] = []
      for (const batch of batchMysqlStatements(sqls)) {
        const [raw, fields] = await conn.query({ sql: normalizeMysqlSessionVariables(batch.join('\n;\n')), rowsAsArray: true })
        if (batch.length === 1) {
          results.push(...this.normalize(raw, fields))
        } else {
          // 多语句结果与语句一一对应（CALL 会额外返回结果集），不能依赖单语句启发式判断。
          const items = Array.isArray(raw) ? raw : [raw]
          const fieldArr = Array.isArray(fields) ? fields : []
          results.push(...items.map((item, i) => this.singleResult(item, fieldArr[i])))
        }
      }
      await conn.commit()
      return results
    } catch (e) {
      await conn.rollback().catch(() => {})
      throw e
    }
  }
}
