import sql, { type IResult } from 'mssql'
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
  type DbDriver,
  type DriverOperationResult,
  type TableDataQuery,
  type TableDataResult
} from './base'
import { capabilitiesForType } from './capabilities'
import {
  compileDefaultExpression,
  compileRelationalOperation,
  quoteRelationalIdentifier,
  relationalTable,
  type ParameterizedCommand
} from './relationalOperation'
import { traceExecution } from '../audit/trace'

function quoteIdent(name: string): string {
  return `[${name.replace(/]/g, ']]')}]`
}

type QueryOutput = IResult<unknown>
const tracedRequest = Symbol('safeDbTracedRequest')

export class SqlServerDriver implements DbDriver {
  readonly capabilities = capabilitiesForType('sqlserver')
  private pools = new Map<string, sql.ConnectionPool>()
  private activeRequests = new Set<sql.Request>()

  constructor(
    private cfg: {
      host: string
      port: number
      user: string
      password?: string
      database?: string
      encrypt?: boolean
      trustServerCertificate?: boolean
    }
  ) {}

  private config(database?: string): sql.config {
    return {
      server: this.cfg.host,
      port: this.cfg.port,
      user: this.cfg.user,
      password: this.cfg.password,
      database: database || this.cfg.database || 'master',
      connectionTimeout: 10000,
      requestTimeout: 60000,
      pool: { min: 0, max: 4, idleTimeoutMillis: 30000 },
      options: {
        encrypt: this.cfg.encrypt === true,
        trustServerCertificate: this.cfg.trustServerCertificate !== false,
        enableArithAbort: true
      }
    }
  }

  private poolKey(database?: string): string {
    return database || this.cfg.database || 'master'
  }

  private instrumentRequest(request: sql.Request, database?: string): sql.Request {
    const mutable = request as unknown as {
      [tracedRequest]?: boolean
      query: (command: string) => Promise<QueryOutput>
      parameters?: Record<string, { value?: unknown; type?: unknown }>
    }
    if (mutable[tracedRequest]) return request
    mutable[tracedRequest] = true
    const original = mutable.query.bind(request)
    mutable.query = (statement: string) => {
      const parameters = Object.entries(mutable.parameters ?? {}).map(([name, value]) => ({
        name, type: String(value.type ?? ''), value: value.value
      }))
      return traceExecution({
        protocol: 'sql', driverType: 'sqlserver', commandName: 'QUERY',
        databaseName: database ?? this.cfg.database ?? 'master',
        sensitive: { statement, parameters }
      }, () => original(statement), (result) => ({
        returnedRows: (result.recordsets ?? []).reduce((sum, rows) => sum + rows.length, 0),
        affectedRows: (result.rowsAffected ?? []).reduce((sum, count) => sum + count, 0)
      }))
    }
    return request
  }

  private instrumentPool(pool: sql.ConnectionPool, database?: string): sql.ConnectionPool {
    const mutable = pool as unknown as { request: () => sql.Request; __safeDbTraced?: boolean }
    if (mutable.__safeDbTraced) return pool
    mutable.__safeDbTraced = true
    const original = mutable.request.bind(pool)
    mutable.request = () => this.instrumentRequest(original(), database)
    return pool
  }

  private connectPool(database?: string): Promise<sql.ConnectionPool> {
    const name = this.poolKey(database)
    return traceExecution({
      protocol: 'driver', driverType: 'sqlserver', commandName: 'CONNECT', databaseName: name,
      sensitive: { command: { action: 'connect' } }
    }, () => new sql.ConnectionPool(this.config(name)).connect())
  }

  private async poolFor(database?: string): Promise<sql.ConnectionPool> {
    const key = this.poolKey(database)
    const existing = this.pools.get(key)
    if (existing?.connected) return existing
    if (existing) await existing.close().catch(() => {})
    const pool = this.instrumentPool(await this.connectPool(key), key)
    this.pools.set(key, pool)
    return pool
  }

  async connect(): Promise<void> {
    await this.poolFor(this.cfg.database)
  }

  async disconnect(): Promise<void> {
    await Promise.all([...this.pools.values()].map((pool) => pool.close().catch(() => {})))
    this.pools.clear()
  }

  async cancel(): Promise<void> {
    for (const request of this.activeRequests) request.cancel()
    await this.disconnect()
  }

  async test(): Promise<void> {
    const pool = this.instrumentPool(await this.connectPool(), this.poolKey())
    try {
      await pool.request().query('SELECT 1 AS ok')
    } finally {
      await pool.close()
    }
  }

  async listDatabases(): Promise<string[]> {
    const result = await (await this.poolFor()).request().query(
      `SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' ORDER BY name`
    )
    return result.recordset.map((row) => String(row.name))
  }

  async listTables(database?: string, includeStats = false): Promise<TableInfo[]> {
    const result = await (await this.poolFor(database)).request().query(
      `SELECT s.name AS [schema], o.name, o.type,
              ${includeStats ? 'SUM(CASE WHEN p.index_id IN (0, 1) THEN p.rows ELSE 0 END)' : 'NULL'} AS rowCount,
              o.create_date AS createdAt, o.modify_date AS updatedAt, o.object_id AS objectId,
              CAST(ep.value AS nvarchar(4000)) AS comment
       FROM sys.objects o
       JOIN sys.schemas s ON s.schema_id = o.schema_id
       LEFT JOIN sys.partitions p ON p.object_id = o.object_id
       LEFT JOIN sys.extended_properties ep ON ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
       WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
       GROUP BY s.name, o.name, o.type, o.create_date, o.modify_date, o.object_id, CAST(ep.value AS nvarchar(4000))
       ORDER BY s.name, o.type, o.name`
    )
    return result.recordset.map((row) => ({
      schema: String(row.schema),
      name: String(row.name),
      type: row.type === 'V' ? 'view' : 'table',
      rowCount: row.rowCount === null || row.rowCount === undefined ? undefined : Number(row.rowCount),
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : undefined,
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : undefined,
      objectId: Number(row.objectId),
      comment: row.comment ? String(row.comment) : undefined
    }))
  }

  async listRoutines(database?: string): Promise<RoutineInfo[]> {
    const result = await (await this.poolFor(database)).request().query(
      `SELECT s.name AS [schema], o.name, o.type, o.object_id AS objectId,
              o.create_date AS createdAt, o.modify_date AS updatedAt
       FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE o.type IN ('P', 'PC', 'FN', 'FS', 'FT', 'IF', 'TF') AND o.is_ms_shipped = 0
       ORDER BY s.name, o.type, o.name`
    )
    return result.recordset.map((row) => ({
      schema: String(row.schema),
      name: String(row.name),
      type: row.type === 'P' || row.type === 'PC' ? 'procedure' : 'function',
      objectId: Number(row.objectId),
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : undefined,
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : undefined
    }))
  }

  async listColumns(database: string | undefined, table: string, schema = 'dbo'): Promise<ColumnInfo[]> {
    const request = (await this.poolFor(database)).request()
    request.input('schema', sql.NVarChar, schema)
    request.input('table', sql.NVarChar, table)
    const result = await request.query(
      `SELECT c.name, t.name AS baseType, c.max_length AS maxLength, c.precision, c.scale,
              c.is_nullable AS nullable, c.is_identity AS isIdentity, c.is_computed AS isComputed,
              dc.definition AS defaultValue, c.column_id AS ordinal,
              CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END AS isPrimaryKey,
              CAST(ep.value AS nvarchar(4000)) AS comment
       FROM sys.columns c
       JOIN sys.objects o ON o.object_id = c.object_id
       JOIN sys.schemas s ON s.schema_id = o.schema_id
       JOIN sys.types t ON t.user_type_id = c.user_type_id
       LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
       LEFT JOIN (
         SELECT ic.object_id, ic.column_id
         FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         WHERE i.is_primary_key = 1
       ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
       LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
       WHERE s.name = @schema AND o.name = @table AND o.type IN ('U', 'V')
       ORDER BY c.column_id`
    )
    return result.recordset.map((row) => {
      let dataType = String(row.baseType)
      if (/^(varchar|char|varbinary|binary)$/i.test(dataType)) dataType += `(${Number(row.maxLength) === -1 ? 'max' : Number(row.maxLength)})`
      else if (/^(nvarchar|nchar)$/i.test(dataType)) dataType += `(${Number(row.maxLength) === -1 ? 'max' : Number(row.maxLength) / 2})`
      else if (/^(decimal|numeric)$/i.test(dataType)) dataType += `(${Number(row.precision)},${Number(row.scale)})`
      else if (/^(datetime2|datetimeoffset|time)$/i.test(dataType) && Number(row.scale) !== 7) dataType += `(${Number(row.scale)})`
      return {
        name: String(row.name),
        dataType,
        nullable: Boolean(row.nullable),
        isPrimaryKey: Boolean(row.isPrimaryKey),
        defaultValue: row.defaultValue === null || row.defaultValue === undefined ? null : String(row.defaultValue),
        extra: [row.isIdentity ? 'identity' : '', row.isComputed ? 'generated' : ''].filter(Boolean).join(' ') || undefined,
        comment: row.comment ? String(row.comment) : undefined,
        ordinal: Number(row.ordinal)
      }
    })
  }

  async listIndexes(database: string | undefined, table: string, schema = 'dbo'): Promise<IndexInfo[]> {
    const request = (await this.poolFor(database)).request()
    request.input('schema', sql.NVarChar, schema)
    request.input('table', sql.NVarChar, table)
    const result = await request.query(
      `SELECT i.name, i.is_unique AS isUnique, i.is_primary_key AS isPrimary,
              c.name AS columnName, ic.key_ordinal
       FROM sys.indexes i
       JOIN sys.objects o ON o.object_id = i.object_id
       JOIN sys.schemas s ON s.schema_id = o.schema_id
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal > 0
       JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       WHERE s.name = @schema AND o.name = @table AND i.name IS NOT NULL
       ORDER BY i.name, ic.key_ordinal`
    )
    const indexes = new Map<string, IndexInfo>()
    for (const row of result.recordset) {
      const name = String(row.name)
      const current = indexes.get(name)
      if (current) current.columns.push(String(row.columnName))
      else indexes.set(name, {
        name,
        columns: [String(row.columnName)],
        unique: Boolean(row.isUnique),
        primary: Boolean(row.isPrimary)
      })
    }
    return [...indexes.values()]
  }

  async listForeignKeys(database: string | undefined, table: string, schema = 'dbo'): Promise<ForeignKeyInfo[]> {
    const request = (await this.poolFor(database)).request()
    request.input('schema', sql.NVarChar, schema)
    request.input('table', sql.NVarChar, table)
    const result = await request.query(
      `SELECT fk.name, pc.name AS columnName, rs.name AS referencedSchema, ro.name AS referencedTable,
              rc.name AS referencedColumn, fkc.constraint_column_id,
              fk.update_referential_action_desc AS onUpdate, fk.delete_referential_action_desc AS onDelete
       FROM sys.foreign_keys fk
       JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
       JOIN sys.objects po ON po.object_id = fk.parent_object_id
       JOIN sys.schemas ps ON ps.schema_id = po.schema_id
       JOIN sys.columns pc ON pc.object_id = po.object_id AND pc.column_id = fkc.parent_column_id
       JOIN sys.objects ro ON ro.object_id = fk.referenced_object_id
       JOIN sys.schemas rs ON rs.schema_id = ro.schema_id
       JOIN sys.columns rc ON rc.object_id = ro.object_id AND rc.column_id = fkc.referenced_column_id
       WHERE ps.name = @schema AND po.name = @table
       ORDER BY fk.name, fkc.constraint_column_id`
    )
    const foreignKeys = new Map<string, ForeignKeyInfo>()
    for (const row of result.recordset) {
      const name = String(row.name)
      const current = foreignKeys.get(name)
      if (current) {
        current.columns.push(String(row.columnName))
        current.referencedColumns.push(String(row.referencedColumn))
      } else {
        foreignKeys.set(name, {
          name,
          columns: [String(row.columnName)],
          referencedSchema: String(row.referencedSchema),
          referencedTable: String(row.referencedTable),
          referencedColumns: [String(row.referencedColumn)],
          onUpdate: String(row.onUpdate).replaceAll('_', ' '),
          onDelete: String(row.onDelete).replaceAll('_', ' ')
        })
      }
    }
    return [...foreignKeys.values()]
  }

  async listCheckConstraints(database: string | undefined, table: string, schema = 'dbo'): Promise<CheckConstraintInfo[]> {
    const request = (await this.poolFor(database)).request()
    request.input('schema', sql.NVarChar, schema)
    request.input('table', sql.NVarChar, table)
    const result = await request.query(
      `SELECT cc.name, cc.definition AS expression
       FROM sys.check_constraints cc
       JOIN sys.objects o ON o.object_id = cc.parent_object_id
       JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE s.name = @schema AND o.name = @table ORDER BY cc.name`
    )
    return result.recordset.map((row) => ({ name: String(row.name), expression: String(row.expression) }))
  }

  async getObjectDdl(database: string | undefined, table: string, schema = 'dbo'): Promise<string> {
    const pool = await this.poolFor(database)
    const request = pool.request()
    request.input('schema', sql.NVarChar, schema)
    request.input('table', sql.NVarChar, table)
    const object = await request.query(
      `SELECT o.type, OBJECT_DEFINITION(o.object_id) AS definition
       FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE s.name = @schema AND o.name = @table AND o.type IN ('U', 'V')`
    )
    const row = object.recordset[0]
    if (!row) throw new Error('数据库对象不存在')
    if (row.type === 'V' && row.definition) return `${String(row.definition).trim().replace(/;\s*$/, '')};`

    const [columns, indexes, foreignKeys, checks] = await Promise.all([
      this.listColumns(database, table, schema),
      this.listIndexes(database, table, schema),
      this.listForeignKeys(database, table, schema),
      this.listCheckConstraints(database, table, schema)
    ])
    const definitions = columns.map((column) => {
      let definition = `${quoteIdent(column.name)} ${column.dataType}`
      if (column.extra?.includes('identity')) definition += ' IDENTITY(1,1)'
      if (column.defaultValue) definition += ` DEFAULT ${column.defaultValue}`
      definition += column.nullable ? ' NULL' : ' NOT NULL'
      return definition
    })
    const primary = indexes.find((index) => index.primary)
    if (primary) definitions.push(`CONSTRAINT ${quoteIdent(primary.name)} PRIMARY KEY (${primary.columns.map(quoteIdent).join(', ')})`)
    for (const foreignKey of foreignKeys) {
      definitions.push(
        `CONSTRAINT ${quoteIdent(foreignKey.name)} FOREIGN KEY (${foreignKey.columns.map(quoteIdent).join(', ')}) ` +
        `REFERENCES ${quoteIdent(foreignKey.referencedSchema ?? 'dbo')}.${quoteIdent(foreignKey.referencedTable)} (${foreignKey.referencedColumns.map(quoteIdent).join(', ')})`
      )
    }
    for (const check of checks) definitions.push(`CONSTRAINT ${quoteIdent(check.name)} CHECK ${check.expression}`)
    const qualified = `${quoteIdent(schema)}.${quoteIdent(table)}`
    const create = `CREATE TABLE ${qualified} (\n  ${definitions.join(',\n  ')}\n);`
    const indexDdl = indexes.filter((index) => !index.primary).map((index) =>
      `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(index.name)} ON ${qualified} (${index.columns.map(quoteIdent).join(', ')});`
    )
    return [create, ...indexDdl].join('\n\n')
  }

  async getRoutineDefinition(
    database: string | undefined,
    routine: string,
    type: RoutineInfo['type'],
    schema = 'dbo'
  ): Promise<string> {
    const request = (await this.poolFor(database)).request()
    request.input('schema', sql.NVarChar, schema)
    request.input('routine', sql.NVarChar, routine)
    request.input('kind', sql.Char, type === 'procedure' ? 'P' : 'F')
    const result = await request.query(
      `SELECT OBJECT_DEFINITION(o.object_id) AS definition
       FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE s.name = @schema AND o.name = @routine
         AND ((@kind = 'P' AND o.type IN ('P','PC')) OR (@kind = 'F' AND o.type IN ('FN','FS','FT','IF','TF')))`
    )
    const definition = result.recordset[0]?.definition
    if (!definition) throw new Error('无法读取函数或存储过程定义')
    return String(definition).trim()
  }

  async getTableData(q: TableDataQuery): Promise<TableDataResult> {
    const schema = q.schema ?? 'dbo'
    const pool = await this.poolFor(q.database)
    const columns = await this.listColumns(q.database, q.table, schema)
    const indexes = await this.listIndexes(q.database, q.table, schema)
    const primary = indexes.find((index) => index.primary)?.columns ?? []
    const qualified = `${quoteIdent(schema)}.${quoteIdent(q.table)}`
    const where = buildWhereClause(q.filters, quoteIdent, (index) => `@p${index}`, (expression) => `CAST(${expression} AS nvarchar(max))`)
    const bind = (request: sql.Request): void => {
      where.params.forEach((value, index) => request.input(`p${index}`, sql.NVarChar, String(value)))
    }
    const request = pool.request()
    bind(request)
    request.input('offset', sql.Int, (q.page - 1) * q.pageSize)
    request.input('limit', sql.Int, q.pageSize)
    const order = q.orderBy?.length
      ? q.orderBy.map((item) => `${quoteIdent(item.column)} ${item.direction === 'desc' ? 'DESC' : 'ASC'}`).join(', ')
      : primary.length ? primary.map(quoteIdent).join(', ') : '(SELECT NULL)'
    const result = await request.query(
      `SELECT * FROM ${qualified}${where.sql} ORDER BY ${order} OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`
    )
    const countRequest = pool.request()
    bind(countRequest)
    const count = await countRequest.query(`SELECT COUNT_BIG(*) AS total FROM ${qualified}${where.sql}`)
    return {
      columns,
      rows: sanitizeRows(result.recordset as Record<string, unknown>[]),
      total: Number(count.recordset[0]?.total ?? 0),
      editable: primary.length > 0,
      keyColumns: primary
    }
  }

  private toResults(output: QueryOutput): QueryResult[] {
    const results: QueryResult[] = []
    for (const recordset of output.recordsets ?? []) {
      const rows = recordset as Record<string, unknown>[]
      const metadata = (recordset as unknown as { columns?: Record<string, unknown> }).columns
      results.push({
        kind: 'rows',
        columns: Object.keys(metadata ?? rows[0] ?? {}).map((name) => ({ name })),
        rows: sanitizeRows(rows)
      })
    }
    const affectedRows = (output.rowsAffected ?? []).reduce((sum, count) => sum + count, 0)
    if (results.length === 0) results.push({ kind: 'exec', affectedRows })
    return results
  }

  private async runRequest(request: sql.Request, command: string): Promise<QueryOutput> {
    this.activeRequests.add(request)
    try {
      return await this.instrumentRequest(request).query(command)
    } finally {
      this.activeRequests.delete(request)
    }
  }

  private bindOperationRequest(request: sql.Request, command: ParameterizedCommand): void {
    command.params.forEach((value, index) => request.input(`p${index}`, value as never))
  }

  async executeOperation(operation: DatabaseOperation): Promise<DriverOperationResult> {
    const database = 'target' in operation
      ? operation.target.database
      : 'source' in operation ? operation.source.database
        : operation.database
    let commands = compileRelationalOperation(operation, 'sqlserver', this.cfg.database)
    if (operation.kind === 'object.create' && operation.objectType === 'database') {
      const request = (await this.poolFor()).request()
      const output = await this.runRequest(request, commands[0].sql)
      const affectedRows = (output.rowsAffected ?? []).reduce((sum, count) => sum + count, 0)
      return {
        results: [{ kind: 'exec', affectedRows }], atomicity: 'single-request', succeeded: 1, failed: 0
      }
    }
    const pool = await this.poolFor(database)
    if (operation.kind === 'object.alter') {
      const drops: ParameterizedCommand[] = []
      const additions: ParameterizedCommand[] = []
      const schema = operation.target.schema ?? 'dbo'
      const table = relationalTable('sqlserver', operation.target, this.cfg.database)
      for (const change of operation.changes) {
        if (change.kind === 'add') continue
        const columnName = change.kind === 'drop' ? change.name : change.previousName
        const request = pool.request()
        request.input('schema', sql.NVarChar, schema)
        request.input('table', sql.NVarChar, operation.target.name)
        request.input('column', sql.NVarChar, columnName)
        const current = await request.query(
          `SELECT dc.name FROM sys.default_constraints dc
           JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
           JOIN sys.tables t ON t.object_id = c.object_id
           JOIN sys.schemas s ON s.schema_id = t.schema_id
           WHERE s.name = @schema AND t.name = @table AND c.name = @column`
        )
        const constraint = current.recordset[0]?.name
        if (constraint) drops.push({ sql: `ALTER TABLE ${table} DROP CONSTRAINT ${quoteRelationalIdentifier('sqlserver', String(constraint))}`, params: [] })
        if (change.kind === 'alter') {
          const value = compileDefaultExpression(change.column.defaultValue)
          if (value !== null) additions.push({
            sql: `ALTER TABLE ${table} ADD DEFAULT ${value} FOR ${quoteRelationalIdentifier('sqlserver', change.column.name)}`,
            params: []
          })
        }
      }
      commands = [...drops, ...commands, ...additions]
    }
    const transaction = new sql.Transaction(pool)
    await transaction.begin()
    let affectedRows = 0
    try {
      for (const command of commands) {
        const request = new sql.Request(transaction)
        this.bindOperationRequest(request, command)
        const output = await this.runRequest(request, command.sql)
        affectedRows += (output.rowsAffected ?? []).reduce((sum, count) => sum + count, 0)
      }
      await transaction.commit()
    } catch (error) {
      await transaction.rollback().catch(() => {})
      throw error
    }
    return {
      results: [{ kind: 'exec', affectedRows }], atomicity: 'transaction',
      succeeded: operation.kind === 'records.mutate' ? operation.mutations.length : 1, failed: 0
    }
  }

  async run(command: string, database?: string): Promise<QueryResult[]> {
    const request = (await this.poolFor(database)).request()
    request.multiple = true
    return this.toResults(await this.runRequest(request, command))
  }

  async runInTransaction(commands: string[], database?: string): Promise<QueryResult[]> {
    const transaction = new sql.Transaction(await this.poolFor(database))
    await transaction.begin()
    try {
      const results: QueryResult[] = []
      for (const command of commands) {
        const request = new sql.Request(transaction)
        request.multiple = true
        results.push(...this.toResults(await this.runRequest(request, command)))
      }
      await transaction.commit()
      return results
    } catch (error) {
      await transaction.rollback().catch(() => {})
      throw error
    }
  }
}
