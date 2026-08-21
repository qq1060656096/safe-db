import type {
  DatabaseOperation,
  DriverCapabilities,
  ExecutionAtomicity,
  ColumnFilter,
  ColumnInfo,
  CheckConstraintInfo,
  ForeignKeyInfo,
  IndexInfo,
  QueryResult,
  RoutineInfo,
  TableDataQuery,
  TableDataResult,
  TableInfo
} from '../../shared/types'

export type { TableDataQuery, TableDataResult }

export interface DriverOperationResult {
  results: QueryResult[]
  atomicity: ExecutionAtomicity
  succeeded: number
  failed: number
}

/**
 * 数据库驱动抽象。每个应用内连接对应一个驱动实例,
 * 持有一条到底层库的连接(桌面单用户场景,无需连接池)。
 */
export interface DbDriver {
  /** 每个驱动必须显式声明能力；缺失能力声明属于驱动契约错误。 */
  readonly capabilities: DriverCapabilities
  connect(): Promise<void>
  disconnect(): Promise<void>
  /** 立即终止当前查询；允许通过断开底层会话实现，后续操作会自动重连。 */
  cancel?(): Promise<void>
  test(): Promise<void>
  listDatabases(): Promise<string[]>
  listTables(database?: string, includeStats?: boolean): Promise<TableInfo[]>
  listRoutines(database?: string): Promise<RoutineInfo[]>
  listColumns(database: string | undefined, table: string, schema?: string): Promise<ColumnInfo[]>
  listIndexes(database: string | undefined, table: string, schema?: string): Promise<IndexInfo[]>
  listForeignKeys(database: string | undefined, table: string, schema?: string): Promise<ForeignKeyInfo[]>
  listCheckConstraints(database: string | undefined, table: string, schema?: string): Promise<CheckConstraintInfo[]>
  getObjectDdl(database: string | undefined, table: string, schema?: string): Promise<string>
  getRoutineDefinition(database: string | undefined, routine: string, type: RoutineInfo['type'], schema?: string, argumentsSignature?: string): Promise<string>
  getTableData(q: TableDataQuery): Promise<TableDataResult>
  /** 执行任意 SQL,每条语句一个 QueryResult */
  run(sql: string, database?: string): Promise<QueryResult[]>
  /**
   * 查询编辑器的原生命令批处理入口。驱动仅在底层真正支持时使用事务；
   * 产品内置的数据与结构写入应优先走 executeOperation 并读取其实际 atomicity。
   */
  runInTransaction(sqls: string[], database?: string): Promise<QueryResult[]>
  /** 参数化结构化操作。所有内置驱动必须实现；不支持项由 capabilities 明确拒绝。 */
  executeOperation(operation: DatabaseOperation): Promise<DriverOperationResult>
}

/** 把驱动返回的行值转成可安全 IPC 序列化、且适合网格展示的值 */
export function sanitizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (Buffer.isBuffer(v)) {
    return v.length <= 32 ? `<bin ${v.toString('hex')}>` : `<blob ${v.length} bytes>`
  }
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Date) return v.toISOString()
  return v
}

export function sanitizeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) => {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(r)) out[k] = sanitizeValue(r[k])
    return out
  })
}

const FILTER_OPS = new Set(['=', '!=', '>', '>=', '<', '<='])

/**
 * 由结构化筛选条件构建 WHERE 子句。列名经 quoteIdent 包裹、值一律参数绑定,
 * 因此即使用户在筛选框里输入 SQL 片段也无法注入(对开了 multipleStatements 的
 * MySQL 尤其重要)。
 *
 * @param placeholder 第 i 个(0 起)参数占位的写法:MySQL/SQLite 用 `?`,PG 用 `$1..`
 * @param castForLike LIKE 时给列表达式包一层类型转换(PG 对非文本列需要 CAST)
 */
export function buildWhereClause(
  filters: ColumnFilter[] | undefined,
  quoteIdent: (n: string) => string,
  placeholder: (i: number) => string,
  castForLike: (expr: string) => string = (e) => e
): { sql: string; params: unknown[] } {
  const params: unknown[] = []
  const parts: string[] = []
  for (const f of filters ?? []) {
    const col = quoteIdent(f.column)
    if (f.op === 'null') {
      parts.push(`${col} IS NULL`)
    } else if (f.op === 'notnull') {
      parts.push(`${col} IS NOT NULL`)
    } else if (f.op === 'like' || f.op === 'notlike') {
      const kw = f.op === 'like' ? 'LIKE' : 'NOT LIKE'
      params.push(`%${f.value ?? ''}%`)
      parts.push(`${castForLike(col)} ${kw} ${placeholder(params.length - 1)}`)
    } else if (FILTER_OPS.has(f.op)) {
      params.push(f.value ?? '')
      parts.push(`${col} ${f.op} ${placeholder(params.length - 1)}`)
    }
  }
  return { sql: parts.length ? ' WHERE ' + parts.join(' AND ') : '', params }
}
