import pg from 'pg'
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

/** 双引号包裹标识符 */
function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"'
}

export class PostgresDriver implements DbDriver {
  /** database → 该库的连接(PG 连接绑定库,跨库查询需另起连接) */
  private clients = new Map<string, pg.Client>()

  constructor(
    private cfg: {
      host: string
      port: number
      user: string
      password?: string
      database?: string
    }
  ) {}

  private options(database: string): pg.ClientConfig {
    return {
      host: this.cfg.host,
      port: this.cfg.port,
      user: this.cfg.user,
      password: this.cfg.password,
      database,
      connectionTimeoutMillis: 10000
    }
  }

  /** 连接默认库(未指定时 postgres) */
  private defaultDb(): string {
    return this.cfg.database || 'postgres'
  }

  /** 取某库的连接,没有则新建并接入缓存 */
  private async clientFor(database?: string): Promise<pg.Client> {
    const db = database || this.defaultDb()
    const existing = this.clients.get(db)
    if (existing) return existing
    const client = new pg.Client(this.options(db))
    await client.connect()
    this.clients.set(db, client)
    return client
  }

  async connect(): Promise<void> {
    await this.clientFor()
  }

  async disconnect(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.end().catch(() => {})))
    this.clients.clear()
  }

  async test(): Promise<void> {
    const c = new pg.Client(this.options(this.defaultDb()))
    await c.connect()
    await c.query('SELECT 1')
    await c.end()
  }

  async listDatabases(): Promise<string[]> {
    const client = await this.clientFor()
    const res = await client.query(
      `SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname`
    )
    return res.rows.map((r) => r.datname as string)
  }

  /** PG 的 listTables 返回某库所有非系统 schema 下的表/视图,schema 字段用于树的第三级 */
  async listTables(database?: string): Promise<TableInfo[]> {
    const client = await this.clientFor(database)
    const res = await client.query(
      `SELECT table_schema AS schema, table_name AS name, table_type AS type
       FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_schema, table_type, table_name`
    )
    return res.rows.map((r) => ({
      schema: r.schema as string,
      name: r.name as string,
      type: (r.type as string) === 'VIEW' ? 'view' : 'table'
    }))
  }

  async listRoutines(database?: string): Promise<RoutineInfo[]> {
    const client = await this.clientFor(database)
    const res = await client.query(
      `SELECT n.nspname AS schema, p.proname AS name, p.prokind AS kind,
              pg_get_function_identity_arguments(p.oid) AS arguments
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND p.prokind IN ('f', 'p')
       ORDER BY n.nspname, p.prokind, p.proname, arguments`
    )
    return res.rows.map((row) => ({
      schema: row.schema as string,
      name: row.name as string,
      type: row.kind === 'p' ? 'procedure' : 'function',
      arguments: row.arguments ? String(row.arguments) : undefined
    }))
  }

  async listColumns(database: string | undefined, table: string, schema = 'public'): Promise<ColumnInfo[]> {
    const client = await this.clientFor(database)
    const res = await client.query(
      `SELECT c.column_name AS name,
              c.data_type AS "dataType",
              c.is_nullable AS nullable,
              c.column_default AS "defaultValue",
              c.ordinal_position AS ordinal,
              CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS "isPrimaryKey"
       FROM information_schema.columns c
       LEFT JOIN (
         SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2
       ) pk ON pk.column_name = c.column_name
       WHERE c.table_schema = $1 AND c.table_name = $2
       ORDER BY c.ordinal_position`,
      [schema, table]
    )
    return res.rows.map((r) => ({
      name: r.name as string,
      dataType: r.dataType as string,
      nullable: r.nullable === 'YES',
      isPrimaryKey: Boolean(r.isPrimaryKey),
      defaultValue: r.defaultValue === null || r.defaultValue === undefined ? null : String(r.defaultValue),
      ordinal: Number(r.ordinal)
    }))
  }

  async listIndexes(database: string | undefined, table: string, schema = 'public'): Promise<IndexInfo[]> {
    const client = await this.clientFor(database)
    const res = await client.query(
      `SELECT i.relname AS name, ix.indisunique AS unique, ix.indisprimary AS primary,
              array_agg(a.attname ORDER BY u.ord) AS columns
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN unnest(ix.indkey) WITH ORDINALITY AS u(attnum, ord) ON true
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = u.attnum
       WHERE n.nspname = $1 AND t.relname = $2
       GROUP BY i.relname, ix.indisunique, ix.indisprimary`,
      [schema, table]
    )
    return res.rows.map((r) => ({
      name: r.name as string,
      columns: r.columns as string[],
      unique: Boolean(r.unique),
      primary: Boolean(r.primary)
    }))
  }

  async getObjectDdl(database: string | undefined, table: string, schema = 'public'): Promise<string> {
    const client = await this.clientFor(database)
    const objectResult = await client.query(
      `SELECT c.oid, c.relkind,
              CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END AS "viewDefinition"
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm')`,
      [schema, table]
    )
    const object = objectResult.rows[0] as { oid: number; relkind: string; viewDefinition: string | null } | undefined
    if (!object) throw new Error('数据库对象不存在')
    const qualified = `${quoteIdent(schema)}.${quoteIdent(table)}`
    if (object.relkind === 'v' || object.relkind === 'm') {
      const keyword = object.relkind === 'm' ? 'MATERIALIZED VIEW' : 'VIEW'
      const definition = object.viewDefinition?.trim().replace(/;\s*$/, '')
      if (!definition) throw new Error('无法读取视图 DDL')
      return `CREATE ${keyword} ${qualified} AS\n${definition};`
    }

    const [columnResult, constraintResult, indexResult] = await Promise.all([
      client.query(
        `SELECT a.attname AS name,
                pg_catalog.format_type(a.atttypid, a.atttypmod) AS "dataType",
                a.attnotnull AS "notNull",
                pg_get_expr(ad.adbin, ad.adrelid) AS "defaultValue",
                a.attidentity AS identity,
                a.attgenerated AS generated
         FROM pg_attribute a
         LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
         WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum`,
        [object.oid]
      ),
      client.query(
        `SELECT conname AS name, pg_get_constraintdef(oid, true) AS definition
         FROM pg_constraint WHERE conrelid = $1 ORDER BY conname`,
        [object.oid]
      ),
      client.query(
        `SELECT pg_get_indexdef(i.indexrelid) AS definition
         FROM pg_index i
         LEFT JOIN pg_constraint c ON c.conindid = i.indexrelid
         WHERE i.indrelid = $1 AND c.oid IS NULL
         ORDER BY i.indexrelid::regclass::text`,
        [object.oid]
      )
    ])
    const definitions = columnResult.rows.map((row) => {
      const column = row as { name: string; dataType: string; notNull: boolean; defaultValue: string | null; identity: string; generated: string }
      let definition = `${quoteIdent(column.name)} ${column.dataType}`
      if (column.generated) definition += ` GENERATED ALWAYS AS (${column.defaultValue ?? ''}) STORED`
      else if (column.identity === 'a') definition += ' GENERATED ALWAYS AS IDENTITY'
      else if (column.identity === 'd') definition += ' GENERATED BY DEFAULT AS IDENTITY'
      else if (column.defaultValue) definition += ` DEFAULT ${column.defaultValue}`
      if (column.notNull) definition += ' NOT NULL'
      return definition
    })
    definitions.push(...constraintResult.rows.map((row) => {
      const constraint = row as { name: string; definition: string }
      return `CONSTRAINT ${quoteIdent(constraint.name)} ${constraint.definition}`
    }))
    const createTable = `CREATE TABLE ${qualified} (\n  ${definitions.join(',\n  ')}\n);`
    const indexes = indexResult.rows
      .map((row) => String(row.definition).trim().replace(/;\s*$/, '') + ';')
      .join('\n')
    return indexes ? `${createTable}\n\n${indexes}` : createTable
  }

  async getRoutineDefinition(
    database: string | undefined,
    routine: string,
    type: RoutineInfo['type'],
    schema = 'public',
    argumentsSignature?: string
  ): Promise<string> {
    const client = await this.clientFor(database)
    const result = await client.query(
      `SELECT pg_get_functiondef(p.oid) AS definition
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = $3
         AND ($4::text IS NULL OR pg_get_function_identity_arguments(p.oid) = $4)
       ORDER BY p.oid LIMIT 1`,
      [schema, routine, type === 'procedure' ? 'p' : 'f', argumentsSignature ?? null]
    )
    const definition = result.rows[0]?.definition
    if (typeof definition !== 'string' || !definition.trim()) throw new Error('无法读取方法定义')
    return definition.trim()
  }

  async getTableData(qd: TableDataQuery): Promise<TableDataResult> {
    const client = await this.clientFor(qd.database)
    const schema = qd.schema ?? 'public'
    const columns = await this.listColumns(qd.database, qd.table, schema)
    const keyCols = columns.filter((c) => c.isPrimaryKey).map((c) => c.name)
    const qualified = `${quoteIdent(schema)}.${quoteIdent(qd.table)}`
    // LIKE 对非文本列需 CAST,否则 PG 报类型错误
    const where = buildWhereClause(qd.filters, quoteIdent, (i) => `$${i + 1}`, (e) => `CAST(${e} AS TEXT)`)
    let sql = `SELECT * FROM ${qualified}${where.sql}`
    if (qd.orderBy?.length) {
      sql +=
        ' ORDER BY ' +
        qd.orderBy
          .map((o) => `${quoteIdent(o.column)} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`)
          .join(', ')
    }
    const limitIdx = where.params.length
    sql += ` LIMIT $${limitIdx + 1} OFFSET $${limitIdx + 2}`
    const res = await client.query(sql, [...where.params, qd.pageSize, (qd.page - 1) * qd.pageSize])
    const countRes = await client.query(`SELECT COUNT(*) AS n FROM ${qualified}${where.sql}`, where.params)
    return {
      columns,
      rows: sanitizeRows(res.rows),
      total: Number(countRes.rows[0].n),
      editable: keyCols.length > 0,
      keyColumns: keyCols
    }
  }

  private toResults(raw: pg.QueryResult | pg.QueryResult[]): QueryResult[] {
    const arr = Array.isArray(raw) ? raw : [raw]
    return arr.map((r) => {
      if (r.command === 'SELECT' || (r.fields && r.fields.length > 0)) {
        return {
          kind: 'rows',
          columns: r.fields.map((f) => ({ name: f.name })),
          rows: sanitizeRows(r.rows)
        } as QueryResult
      }
      return { kind: 'exec', affectedRows: r.rowCount ?? 0 } as QueryResult
    })
  }

  async run(sql: string, database?: string): Promise<QueryResult[]> {
    const client = await this.clientFor(database)
    const res = await client.query(sql)
    return this.toResults(res)
  }

  async runInTransaction(sqls: string[], database?: string): Promise<QueryResult[]> {
    const client = await this.clientFor(database)
    await client.query('BEGIN')
    try {
      const results: QueryResult[] = []
      for (const s of sqls) {
        const res = await client.query(s)
        results.push(...this.toResults(res))
      }
      await client.query('COMMIT')
      return results
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    }
  }
}
