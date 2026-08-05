// 主进程与渲染进程共享的类型契约

export type DbType = 'mysql' | 'postgres' | 'sqlite'

/** 权限模式:只读 / 审批(本地二次确认)/ 完全访问 */
export type PermissionMode = 'readonly' | 'approval' | 'full'

/** SQL 语句风险分类 */
export type SqlKind = 'READ' | 'WRITE' | 'DDL' | 'OTHER'

/** SSH 隧道配置(仅 mysql / postgres;经跳板机转发到目标库) */
export interface SshConfig {
  enabled: boolean
  host: string
  port: number
  user: string
  authType: 'password' | 'privateKey'
  /** 密码认证时使用;保存时留空表示保持不变 */
  password?: string
  /** 私钥认证时使用 */
  privateKeyPath?: string
  /** 私钥口令(可选);保存时留空表示保持不变 */
  passphrase?: string
}

export interface ConnectionConfig {
  id: string
  name: string
  type: DbType
  permissionMode: PermissionMode
  /** 锁定后必须先显式解除锁定，才能修改权限模式 */
  permissionModeLocked?: boolean
  /** 连接标记色(Navicat 风格) */
  color?: string
  // mysql / postgres
  host?: string
  port?: number
  user?: string
  /** 保存时留空表示保持不变(编辑已有连接时) */
  password?: string
  /** 默认数据库(可选) */
  database?: string
  // sqlite
  filePath?: string
  /** SSH 隧道(仅 mysql / postgres) */
  ssh?: SshConfig
}

/** 列表展示用的连接信息(不含密码;SSH 的密码/私钥口令同样脱敏) */
export type ConnectionMeta = Omit<ConnectionConfig, 'password' | 'ssh'> & {
  ssh?: Omit<SshConfig, 'password' | 'passphrase'>
}

export interface ConnectionImportResult {
  imported: number
  skipped: number
  queriesImported: number
  queriesSkipped: number
  canceled: boolean
}

export interface TableInfo {
  name: string
  type: 'table' | 'view'
  /** PG 的 schema;MySQL/SQLite 为空 */
  schema?: string
  comment?: string
}

export interface RoutineInfo {
  name: string
  type: 'function' | 'procedure'
  /** PostgreSQL 的 schema；MySQL/SQLite 为空 */
  schema?: string
  /** PostgreSQL 重载函数的参数签名 */
  arguments?: string
}

export interface SavedQuery {
  id: string
  name: string
  connectionId: string
  /** 为空时保存在连接级；有值时保存在对应数据库级。 */
  database?: string
  sql: string
  createdAt: string
  updatedAt: string
}

export interface SavedQueryInput {
  id?: string
  name: string
  connectionId: string
  database?: string
  sql: string
}

export interface ColumnInfo {
  name: string
  dataType: string
  nullable: boolean
  isPrimaryKey: boolean
  defaultValue: string | null
  extra?: string
  comment?: string
  ordinal: number
}

export interface IndexInfo {
  name: string
  columns: string[]
  unique: boolean
  primary: boolean
}

export interface QueryResult {
  kind: 'rows' | 'exec'
  columns?: { name: string; dataType?: string }[]
  rows?: Record<string, unknown>[]
  affectedRows?: number
}

export type ExecuteStatus = 'ok' | 'error' | 'denied' | 'needsApproval'

export interface ExecuteResponse {
  status: ExecuteStatus
  results?: QueryResult[]
  error?: string
  sqlKind?: SqlKind
  /** needsApproval 时返回,确认执行时凭此一次性 token */
  approvalToken?: string
  durationMs?: number
}

export type ApprovalStatus = 'not_required' | 'approved' | 'rejected'

export interface AuditEntry {
  id: number
  connectionId: string
  connectionName: string
  /** 历史日志在字段迁移前可能没有连接类型。 */
  connectionType: DbType | null
  databaseName: string | null
  sqlText: string
  sqlKind: SqlKind
  permissionMode: PermissionMode
  approvalStatus: ApprovalStatus
  status: 'success' | 'error' | 'blocked'
  affectedRows: number | null
  error: string | null
  durationMs: number
  executedAt: string
}

export interface AuditFilter {
  connectionId?: string
  sqlKind?: SqlKind
  status?: 'success' | 'error' | 'blocked'
  approvalStatus?: ApprovalStatus
  keyword?: string
  page: number
  pageSize: number
}

export interface AuditPage {
  rows: AuditEntry[]
  total: number
}

/** 数据网格结构化筛选条件(值一律走参数绑定,杜绝注入) */
export interface ColumnFilter {
  column: string
  op: '=' | '!=' | '>' | '>=' | '<' | '<=' | 'like' | 'notlike' | 'null' | 'notnull'
  /** like / 比较运算的右值;null / notnull 不需要 */
  value?: string
}

export interface TableDataQuery {
  database?: string
  schema?: string
  table: string
  page: number
  pageSize: number
  orderBy?: { column: string; direction: 'asc' | 'desc' }[]
  filters?: ColumnFilter[]
}

export interface TableDataResult {
  columns: ColumnInfo[]
  rows: Record<string, unknown>[]
  total: number
  /** 是否存在可用于编辑定位的键(主键或 rowid) */
  editable: boolean
  keyColumns: string[]
}

/** preload 暴露给渲染进程的 API 形状(见 src/preload/index.ts) */
export interface Api {
  // 连接管理
  listConnections(): Promise<ConnectionMeta[]>
  saveConnection(cfg: ConnectionConfig): Promise<ConnectionMeta>
  deleteConnection(id: string): Promise<void>
  testConnection(cfg: ConnectionConfig): Promise<{ ok: boolean; error?: string }>
  /** 导出脱敏后的连接配置及其保存的查询；不会包含数据库或 SSH 密码 */
  exportConnections(): Promise<string | null>
  /** 导入连接配置及其保存的查询；密码字段会被忽略 */
  importConnections(): Promise<ConnectionImportResult>
  pickSqliteFile(): Promise<string | null>
  /** 通用文件选择(如 SSH 私钥) */
  pickFile(opts?: { title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>

  // 保存的查询
  listSavedQueries(): Promise<SavedQuery[]>
  saveQuery(query: SavedQueryInput): Promise<SavedQuery>
  deleteSavedQuery(id: string): Promise<void>

  // 连接与浏览
  connect(id: string): Promise<{ ok: boolean; error?: string }>
  disconnect(id: string): Promise<void>
  listDatabases(id: string): Promise<string[]>
  listTables(id: string, database?: string): Promise<TableInfo[]>
  listRoutines(id: string, database?: string): Promise<RoutineInfo[]>
  listColumns(id: string, database: string | undefined, table: string, schema?: string): Promise<ColumnInfo[]>
  listIndexes(id: string, database: string | undefined, table: string, schema?: string): Promise<IndexInfo[]>
  /** 只读查看对象 DDL，不进入写操作或 DDL 执行权限流程 */
  getObjectDdl(id: string, database: string | undefined, table: string, schema?: string): Promise<string>
  /** 只读查看函数或存储过程定义 */
  getRoutineDefinition(id: string, database: string | undefined, routine: string, type: RoutineInfo['type'], schema?: string, argumentsSignature?: string): Promise<string>
  getTableData(id: string, q: TableDataQuery): Promise<TableDataResult>

  // SQL 执行(统一权限管道)
  executeSql(id: string, sql: string, database?: string): Promise<ExecuteResponse>
  confirmExecute(token: string): Promise<ExecuteResponse>
  rejectExecute(token: string): Promise<void>

  // 审计
  queryAudit(filter: AuditFilter): Promise<AuditPage>

  // 导出:弹保存对话框并把内容写盘,返回保存路径(取消返回 null)
  exportData(opts: ExportOptions): Promise<string | null>
}

export interface ExportOptions {
  /** 默认文件名(含扩展名) */
  defaultName: string
  /** 文件内容(UTF-8) */
  content: string
  /** 保存对话框过滤器,如 [{ name: 'CSV', extensions: ['csv'] }] */
  fileTypes?: { name: string; extensions: string[] }[]
}
