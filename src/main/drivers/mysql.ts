import mysql from 'mysql2/promise'
import type {
  ColumnInfo,
  IndexInfo,
  QueryResult,
  RoutineInfo,
  TableInfo
} from '../../shared/types'
import {
  buildWhereClause,
  sanitizeRows,
  type DbDriver,
  type TableDataQuery,
  type TableDataResult
} from './base'

/** 反引号包裹标识符 */
function quoteIdent(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`'
}

export class MysqlDriver implements DbDriver {
  private conn: mysql.Connection | null = null

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

  async connect(): Promise<void> {
    if (this.conn) return
    this.conn = await mysql.createConnection(this.options())
  }

  async disconnect(): Promise<void> {
    await this.conn?.end().catch(() => {})
    this.conn = null
  }

  async test(): Promise<void> {
    const c = await mysql.createConnection(this.options())
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

  async listTables(database?: string): Promise<TableInfo[]> {
    const db = database || this.cfg.database
    if (!db) throw new Error('未指定数据库')
    const [rows] = await this.requireConn().query(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_COMMENT AS comment
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_TYPE, TABLE_NAME`,
      [db]
    )
    return (rows as { name: string; type: string; comment: string }[]).map((r) => ({
      name: r.name,
      type: r.type === 'VIEW' ? 'view' : 'table',
      comment: r.comment || undefined
    }))
  }

  async listRoutines(database?: string): Promise<RoutineInfo[]> {
    const db = database || this.cfg.database
    if (!db) throw new Error('未指定数据库')
    const [rows] = await this.requireConn().query(
      `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type
       FROM information_schema.ROUTINES
       WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME`,
      [db]
    )
    return (rows as { name: string; type: string }[]).map((row) => ({
      name: row.name,
      type: row.type === 'PROCEDURE' ? 'procedure' : 'function'
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

  async getTableData(qd: TableDataQuery): Promise<TableDataResult> {
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
      rows: sanitizeRows(rows as Record<string, unknown>[]),
      total,
      editable: keyCols.length > 0,
      keyColumns: keyCols
    }
  }

  /** mysql2 结果归一化:单语句返回 rows[] 或 ResultSetHeader;多语句返回两者混合的数组 */
  private normalize(raw: unknown, fields: unknown): QueryResult[] {
    const isResultHeader = (v: unknown): boolean =>
      typeof v === 'object' &&
      v !== null &&
      !Array.isArray(v) &&
      'affectedRows' in v &&
      'insertId' in v

    // 多语句:raw 的每个元素是 rows[] 或 ResultSetHeader,fields 同位对应
    if (
      Array.isArray(raw) &&
      raw.length > 0 &&
      (Array.isArray(raw[0]) || isResultHeader(raw[0]))
    ) {
      const fieldArr = Array.isArray(fields) ? fields : []
      return raw.map((item, i) => this.singleResult(item, fieldArr[i]))
    }
    return [this.singleResult(raw, fields)]
  }

  private singleResult(raw: unknown, fields: unknown): QueryResult {
    if (Array.isArray(raw)) {
      const cols = Array.isArray(fields)
        ? (fields as { name?: string }[]).map((f) => ({ name: f?.name ?? '' }))
        : []
      return { kind: 'rows', columns: cols, rows: sanitizeRows(raw as Record<string, unknown>[]) }
    }
    const info = raw as { affectedRows?: number } | null | undefined
    return { kind: 'exec', affectedRows: info?.affectedRows ?? 0 }
  }

  async run(sql: string, database?: string): Promise<QueryResult[]> {
    const conn = this.requireConn()
    if (database) await conn.query(`USE ${quoteIdent(database)}`)
    const [raw, fields] = await conn.query(sql)
    return this.normalize(raw, fields)
  }

  async runInTransaction(sqls: string[], database?: string): Promise<QueryResult[]> {
    const conn = this.requireConn()
    if (database) await conn.query(`USE ${quoteIdent(database)}`)
    await conn.beginTransaction()
    try {
      const results: QueryResult[] = []
      for (const s of sqls) {
        const [raw, fields] = await conn.query(s)
        results.push(...this.normalize(raw, fields))
      }
      await conn.commit()
      return results
    } catch (e) {
      await conn.rollback().catch(() => {})
      throw e
    }
  }
}
