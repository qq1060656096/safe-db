import type {
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

/**
 * 数据库驱动抽象。每个应用内连接对应一个驱动实例,
 * 持有一条到底层库的连接(桌面单用户场景,无需连接池)。
 */
export interface DbDriver {
  connect(): Promise<void>
  disconnect(): Promise<void>
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
  /** 写操作在事务中执行,任一失败整体回滚 */
  runInTransaction(sqls: string[], database?: string): Promise<QueryResult[]>
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
