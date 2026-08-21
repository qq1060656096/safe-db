import Database from 'better-sqlite3'
import type {
  DatabaseObjectRef,
  DatabaseOperation,
  ColumnInfo,
  CheckConstraintInfo,
  ForeignKeyInfo,
  IndexInfo,
  QueryResult,
  RoutineInfo,
  TableInfo
} from '../../shared/types'
import { sanitizeRows, buildWhereClause, type DbDriver, type DriverOperationResult, type TableDataQuery, type TableDataResult } from './base'
import { splitSqlStatements } from '../core/sqlSplit'
import { capabilitiesForType } from './capabilities'
import { compileRelationalOperation } from './relationalOperation'

type SqliteDb = InstanceType<typeof Database>

/** 双引号包裹标识符 */
function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"'
}

export class SqliteDriver implements DbDriver {
  readonly capabilities = capabilitiesForType('sqlite')
  private db: SqliteDb | null = null

  constructor(private filePath: string) {}

  async connect(): Promise<void> {
    if (this.db) return
    // 连接配置只能指向已存在的数据库。新建数据库由保存连接流程显式完成，
    // 避免路径错误时 better-sqlite3 静默创建空文件。
    this.db = new Database(this.filePath, { fileMustExist: true })
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
  }

  async disconnect(): Promise<void> {
    this.db?.close()
    this.db = null
  }

  async test(): Promise<void> {
    const d = new Database(this.filePath, { readonly: true, fileMustExist: true })
    // 读取 schema 才能识别“普通文件伪装成 SQLite”的情况；SELECT 1 不会访问数据库页。
    d.pragma('schema_version', { simple: true })
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

  async listTables(database = 'main', includeStats = false): Promise<TableInfo[]> {
    const d = this.requireDb()
    const rows = d
      .prepare(
        `SELECT name, type, rootpage FROM ${quoteIdent(database)}.sqlite_master
         WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
         ORDER BY type, name`
      )
      .all() as { name: string; type: string; rootpage: number }[]
    return rows.map((r) => {
      let rowCount: number | undefined
      if (includeStats) {
        const count = d.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(database)}.${quoteIdent(r.name)}`).get() as { n: number }
        rowCount = count.n
      }
      return { name: r.name, type: r.type as 'table' | 'view', rowCount, objectId: r.rootpage || undefined }
    })
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

  async listForeignKeys(database: string | undefined, table: string): Promise<ForeignKeyInfo[]> {
    const dbName = database ?? 'main'
    const rows = this.requireDb()
      .prepare(`SELECT * FROM ${quoteIdent(dbName)}.pragma_foreign_key_list(?) ORDER BY id, seq`)
      .all(table) as {
      id: number
      seq: number
      table: string
      from: string
      to: string
      on_update: string
      on_delete: string
    }[]
    const result = new Map<number, ForeignKeyInfo>()
    for (const row of rows) {
      const existing = result.get(row.id)
      if (existing) {
        existing.columns.push(row.from)
        existing.referencedColumns.push(row.to)
      } else {
        result.set(row.id, {
          name: `fk_${table}_${row.id}`,
          columns: [row.from],
          referencedTable: row.table,
          referencedColumns: [row.to],
          onUpdate: row.on_update,
          onDelete: row.on_delete
        })
      }
    }
    return [...result.values()]
  }

  async listCheckConstraints(_database: string | undefined, _table: string): Promise<CheckConstraintInfo[]> {
    // SQLite 不提供结构化 CHECK 元数据；完整表达式仍可通过 object ddl 获取。
    return []
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

  private operationTable(target: DatabaseObjectRef): string {
    if (target.kind !== 'table') throw new Error('SQLite 结构化操作只支持表对象')
    return `${quoteIdent(target.database ?? 'main')}.${quoteIdent(target.name)}`
  }

  private operationColumn(name: string): string {
    return quoteIdent(name === '__rowid__' ? 'rowid' : name)
  }

  /** SQLite 网格写入全部参数绑定，并在一个本地事务中原子执行。 */
  async executeOperation(operation: DatabaseOperation): Promise<DriverOperationResult> {
    const d = this.requireDb()
    if (operation.kind === 'records.mutate') {
      const table = this.operationTable(operation.target)
      let affectedRows = 0
      const execute = d.transaction(() => {
        for (const mutation of operation.mutations) {
          if (mutation.kind === 'insert') {
            const entries = Object.entries(mutation.values)
            const columns = entries.map(([name]) => this.operationColumn(name)).join(', ')
            const placeholders = entries.map(() => '?').join(', ')
            affectedRows += d.prepare(`INSERT INTO ${table} (${columns}) VALUES (${placeholders})`).run(...entries.map(([, value]) => value)).changes
            continue
          }
          const keys = Object.entries(mutation.key)
          const where = keys.map(([name]) => `${this.operationColumn(name)} IS ?`).join(' AND ')
          if (mutation.kind === 'delete') {
            affectedRows += d.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...keys.map(([, value]) => value)).changes
            continue
          }
          const changes = Object.entries(mutation.changes)
          const set = changes.map(([name]) => `${this.operationColumn(name)} = ?`).join(', ')
          affectedRows += d.prepare(`UPDATE ${table} SET ${set} WHERE ${where}`).run(
            ...changes.map(([, value]) => value),
            ...keys.map(([, value]) => value)
          ).changes
        }
      })
      execute()
      return {
        results: [{ kind: 'exec', affectedRows }], atomicity: 'transaction',
        succeeded: operation.mutations.length, failed: 0
      }
    }
    if (operation.kind === 'records.clear') {
      const affectedRows = d.prepare(`DELETE FROM ${this.operationTable(operation.target)}`).run().changes
      return { results: [{ kind: 'exec', affectedRows }], atomicity: 'transaction', succeeded: affectedRows, failed: 0 }
    }
    if (operation.kind === 'object.drop') {
      d.exec(`DROP TABLE ${this.operationTable(operation.target)}`)
      return { results: [{ kind: 'exec', affectedRows: 1 }], atomicity: 'transaction', succeeded: 1, failed: 0 }
    }
    if (operation.kind === 'object.copy') {
      if (operation.source.kind !== 'table') throw new Error('SQLite 只能复制表对象')
      const ddl = await this.getObjectDdl(operation.source.database, operation.source.name)
      const prefix = /^(\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]+\]|[^\s(]+)/i
      if (!prefix.test(ddl)) throw new Error('无法解析 SQLite 建表定义')
      const target = this.operationTable({ ...operation.source, name: operation.targetName })
      const create = ddl.replace(prefix, `$1${target}`).replace(/;\s*$/, '')
      const source = this.operationTable(operation.source)
      const execute = d.transaction(() => {
        d.exec(create)
        if (operation.withData) d.exec(`INSERT INTO ${target} SELECT * FROM ${source}`)
      })
      execute()
      return { results: [{ kind: 'exec', affectedRows: 1 }], atomicity: 'transaction', succeeded: 1, failed: 0 }
    }
    const commands = compileRelationalOperation(operation, 'sqlite')
    let affectedRows = 0
    const execute = d.transaction(() => {
      for (const command of commands) {
        affectedRows += d.prepare(command.sql).run(...command.params).changes
      }
    })
    execute()
    return {
      results: [{ kind: 'exec', affectedRows }], atomicity: 'transaction',
      succeeded: 1, failed: 0
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
