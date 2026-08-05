import Database from 'better-sqlite3'
import type {
  ColumnInfo,
  IndexInfo,
  QueryResult,
  RoutineInfo,
  TableInfo
} from '../../shared/types'
import { sanitizeRows, buildWhereClause, type DbDriver, type TableDataQuery, type TableDataResult } from './base'
import { splitSqlStatements } from '../core/sqlSplit'

type SqliteDb = InstanceType<typeof Database>

/** 双引号包裹标识符 */
function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"'
}

export class SqliteDriver implements DbDriver {
  private db: SqliteDb | null = null

  constructor(private filePath: string) {}

  async connect(): Promise<void> {
    if (this.db) return
    this.db = new Database(this.filePath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
  }

  async disconnect(): Promise<void> {
    this.db?.close()
    this.db = null
  }

  async test(): Promise<void> {
    const d = new Database(this.filePath, { readonly: true, fileMustExist: false })
    d.prepare('SELECT 1').get()
    d.close()
  }

  private requireDb(): SqliteDb {
    if (!this.db) throw new Error('连接未建立')
    return this.db
  }

  async listDatabases(): Promise<string[]> {
    const d = this.requireDb()
    const rows = d.prepare(`SELECT name FROM pragma_database_list`).all() as { name: string }[]
    return rows.map((r) => r.name)
  }

  async listTables(database = 'main'): Promise<TableInfo[]> {
    const d = this.requireDb()
    const rows = d
      .prepare(
        `SELECT name, type FROM ${quoteIdent(database)}.sqlite_master
         WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
         ORDER BY type, name`
      )
      .all() as { name: string; type: string }[]
    return rows.map((r) => ({ name: r.name, type: r.type as 'table' | 'view' }))
  }

  async listRoutines(_database?: string): Promise<RoutineInfo[]> {
    return []
  }

  async listColumns(database: string | undefined, table: string): Promise<ColumnInfo[]> {
    const d = this.requireDb()
    const rows = d
      .prepare(`SELECT * FROM ${quoteIdent(database ?? 'main')}.pragma_table_info(?)`)
      .all(table) as {
      name: string
      type: string
      notnull: number
      dflt_value: string | null
      pk: number
      cid: number
    }[]
    return rows.map((r) => ({
      name: r.name,
      dataType: r.type || '',
      nullable: r.notnull === 0 && r.pk === 0,
      isPrimaryKey: r.pk > 0,
      defaultValue: r.dflt_value,
      ordinal: r.cid
    }))
  }

  async listIndexes(database: string | undefined, table: string): Promise<IndexInfo[]> {
    const d = this.requireDb()
    const dbName = database ?? 'main'
    const indexList = d
      .prepare(`SELECT * FROM ${quoteIdent(dbName)}.pragma_index_list(?)`)
      .all(table) as { name: string; unique: number; origin: string }[]
    const result: IndexInfo[] = []
    for (const idx of indexList) {
      const cols = d
        .prepare(`SELECT name FROM ${quoteIdent(dbName)}.pragma_index_info(?) ORDER BY seqno`)
        .all(idx.name) as { name: string }[]
      result.push({
        name: idx.name,
        columns: cols.map((c) => c.name),
        unique: idx.unique === 1,
        primary: idx.origin === 'pk'
      })
    }
    return result
  }

  async getObjectDdl(database: string | undefined, table: string): Promise<string> {
    const dbName = database ?? 'main'
    const row = this.requireDb()
      .prepare(
        `SELECT sql FROM ${quoteIdent(dbName)}.sqlite_master WHERE name = ? AND type IN ('table', 'view')`
      )
      .get(table) as { sql: string | null } | undefined
    if (!row?.sql?.trim()) throw new Error('无法读取对象 DDL')
    return `${row.sql.trim().replace(/;\s*$/, '')};`
  }

  async getRoutineDefinition(): Promise<string> {
    throw new Error('SQLite 不支持函数或存储过程定义')
  }

  /** 表的编辑定位键:有主键用主键;rowid 表用 rowid */
  private async keyColumns(database: string | undefined, table: string): Promise<string[]> {
    const cols = await this.listColumns(database, table)
    const pk = cols.filter((c) => c.isPrimaryKey).map((c) => c.name)
    if (pk.length > 0) return pk
    const d = this.requireDb()
    const row = d
      .prepare(
        `SELECT sql FROM ${quoteIdent(database ?? 'main')}.sqlite_master WHERE type='table' AND name=?`
      )
      .get(table) as { sql: string } | undefined
    const withoutRowid = row?.sql?.toUpperCase().includes('WITHOUT ROWID') ?? false
    return withoutRowid ? [] : ['rowid']
  }

  async getTableData(qd: TableDataQuery): Promise<TableDataResult> {
    const d = this.requireDb()
    const dbName = qd.database ?? 'main'
    // 视图没有 rowid,不可编辑
    const obj = d
      .prepare(
        `SELECT type FROM ${quoteIdent(dbName)}.sqlite_master WHERE name = ? AND type IN ('table','view')`
      )
      .get(qd.table) as { type: string } | undefined
    const isView = obj?.type === 'view'
    const columns = await this.listColumns(dbName, qd.table)
    const keyCols = isView ? [] : await this.keyColumns(dbName, qd.table)
    const qualified = `${quoteIdent(dbName)}.${quoteIdent(qd.table)}`

    // rowid 作为定位键时一并查出
    const selectCols =
      keyCols.length === 1 && keyCols[0] === 'rowid' ? `rowid AS "__rowid__", *` : '*'
    const where = buildWhereClause(qd.filters, quoteIdent, () => '?')
    let sql = `SELECT ${selectCols} FROM ${qualified}${where.sql}`
    if (qd.orderBy?.length) {
      sql +=
        ' ORDER BY ' +
        qd.orderBy
          .map((o) => `${quoteIdent(o.column)} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`)
          .join(', ')
    }
    sql += ' LIMIT ? OFFSET ?'
    const rows = d
      .prepare(sql)
      .all(...where.params, qd.pageSize, (qd.page - 1) * qd.pageSize) as Record<
      string,
      unknown
    >[]
    const totalRow = d
      .prepare(`SELECT COUNT(*) AS n FROM ${qualified}${where.sql}`)
      .get(...where.params) as { n: number }
    return {
      columns,
      rows: sanitizeRows(rows),
      total: totalRow.n,
      editable: keyCols.length > 0,
      keyColumns: keyCols[0] === 'rowid' ? ['__rowid__'] : keyCols
    }
  }

  async run(sql: string): Promise<QueryResult[]> {
    const d = this.requireDb()
    const stmts = splitSqlStatements(sql)
    const results: QueryResult[] = []
    for (const s of stmts) {
      const stmt = d.prepare(s)
      if (stmt.reader) {
        const rows = stmt.all() as Record<string, unknown>[]
        const columns = stmt.columns().map((c) => ({ name: c.name }))
        results.push({ kind: 'rows', columns, rows: sanitizeRows(rows) })
      } else {
        const info = stmt.run()
        results.push({ kind: 'exec', affectedRows: info.changes })
      }
    }
    return results
  }

  async runInTransaction(sqls: string[]): Promise<QueryResult[]> {
    const d = this.requireDb()
    const results: QueryResult[] = []
    const tx = d.transaction(() => {
      for (const s of sqls) {
        const stmt = d.prepare(s)
        if (stmt.reader) {
          const rows = stmt.all() as Record<string, unknown>[]
          results.push({
            kind: 'rows',
            columns: stmt.columns().map((c) => ({ name: c.name })),
            rows: sanitizeRows(rows)
          })
        } else {
          const info = stmt.run()
          results.push({ kind: 'exec', affectedRows: info.changes })
        }
      }
    })
    tx()
    return results
  }
}
