// 主进程与渲染进程共享的类型契约

export type DbType = 'mysql' | 'postgres' | 'sqlite' | 'sqlserver' | 'mongodb' | 'redis' | 'qdrant'

/** 驱动向产品层公开的真实领域对象，而不是把所有对象都伪装成 SQL 表。 */
export type DatabaseObjectKind =
  | 'database'
  | 'schema'
  | 'table'
  | 'view'
  | 'routine'
  | 'collection'
  | 'key'
  | 'payloadIndex'

export type OperationSupport =
  | { supported: false; reason: string }
  | {
      supported: true
      /** native 为后端原生能力；emulated 表示需要多步模拟，不能暗示原子性。 */
      mode: 'native' | 'emulated'
      maxBatchSize?: number
      requiresKey?: boolean
    }

export type ExecutionAtomicity = 'transaction' | 'single-request' | 'best-effort'

/** UI 只消费能力，不再通过 `type === ...` 推断功能。 */
export interface DriverCapabilities {
  /** 数据网格所编辑的领域模型和目标类型，供 UI 选择交互而不是猜测 DbType。 */
  recordModel: 'row' | 'document' | 'key-entry' | 'point'
  recordTargetKind: 'table' | 'collection' | 'key'
  databases: {
    create: OperationSupport
  }
  objectKinds: DatabaseObjectKind[]
  records: {
    read: OperationSupport
    insert: OperationSupport
    update: OperationSupport
    delete: OperationSupport
    clear: OperationSupport
    bulkImport: OperationSupport
    pagination: 'offset' | 'cursor'
  }
  objects: {
    create: OperationSupport
    drop: OperationSupport
    copy: OperationSupport
  }
  definition: {
    read: OperationSupport
    update: OperationSupport
  }
  indexes: {
    list: OperationSupport
    create: OperationSupport
    drop: OperationSupport
  }
  atomicity: ExecutionAtomicity
  /** 是否支持主进程参数化的结构化操作；false 时仍使用现有原生命令执行链路。 */
  structuredOperations: boolean
}

export interface DatabaseObjectRef {
  /** 当前可被数据/结构操作直接定位的主对象；数据库创建使用独立的 object.create 分支。 */
  kind: 'table' | 'collection' | 'key'
  name: string
  database?: string
  schema?: string
}

export interface TableColumnDefinition {
  name: string
  dataType: string
  nullable: boolean
  primaryKey?: boolean
  autoIncrement?: boolean
  defaultValue?: string
  comment?: string
}

export type TableColumnChange =
  | { kind: 'add'; column: TableColumnDefinition }
  | { kind: 'drop'; name: string }
  | { kind: 'alter'; previousName: string; column: TableColumnDefinition }

export type RecordMutation =
  | { kind: 'insert'; values: Record<string, unknown> }
  | { kind: 'update'; key: Record<string, unknown>; changes: Record<string, unknown> }
  | { kind: 'delete'; key: Record<string, unknown> }

/** 渲染进程只表达意图；标识符转义、参数绑定和 REST 构造全部留在主进程。 */
export type DatabaseOperation =
  | { kind: 'records.mutate'; target: DatabaseObjectRef; mutations: RecordMutation[] }
  | { kind: 'records.clear'; target: DatabaseObjectRef }
  | {
      kind: 'object.create'
      objectType: 'database' | 'table' | 'collection' | 'key'
      name: string
      database?: string
      schema?: string
      definition: Record<string, unknown>
    }
  | { kind: 'object.alter'; target: DatabaseObjectRef; changes: TableColumnChange[] }
  | { kind: 'object.copy'; source: DatabaseObjectRef; targetName: string; withData: boolean }
  | { kind: 'object.drop'; target: DatabaseObjectRef }
  | { kind: 'index.create'; target: DatabaseObjectRef; name: string; definition: Record<string, unknown> }
  | { kind: 'index.drop'; target: DatabaseObjectRef; name: string }

/** Electron 窗口状态；最大化与系统全屏必须分别保存。 */
export type WindowMode = 'normal' | 'maximized' | 'fullscreen'

/** 权限模式:只读 / 审批(本地二次确认)/ 完全访问 */
export type PermissionMode = 'readonly' | 'approval' | 'full'

/** SQL 语句风险分类 */
export type SqlKind = 'READ' | 'WRITE' | 'DDL' | 'OTHER'

/** SSH 隧道配置(适用于所有 TCP 数据库连接) */
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
  // TCP 数据库
  host?: string
  port?: number
  user?: string
  /** 保存时留空表示保持不变(编辑已有连接时) */
  password?: string
  /** 默认数据库(可选) */
  database?: string
  /** MongoDB 验证库，默认与 database 相同 */
  authDatabase?: string
  /** MongoDB / Redis TLS，或 Qdrant HTTPS。 */
  tls?: boolean
  /** Qdrant API Key；保存时留空表示保持不变。 */
  apiKey?: string
  /** Qdrant HTTP 请求超时，单位毫秒。 */
  timeoutMs?: number
  /** SQL Server 传输加密 */
  encrypt?: boolean
  /** SQL Server 是否信任服务器证书 */
  trustServerCertificate?: boolean
  // sqlite
  filePath?: string
  /**
   * 仅在保存“选择目录后新建 SQLite 数据库”的表单时使用，不持久化。
   * 主进程会校验目录和文件名，并据此生成最终 filePath。
   */
  sqliteCreate?: {
    directory: string
    databaseName: string
  }
  /** SSH 隧道(除 SQLite 外) */
  ssh?: SshConfig
}

export interface SqlitePathSelection {
  path: string
  kind: 'file' | 'directory'
}

/** 列表展示用的连接信息（不含密码/API Key；SSH 密码与私钥口令同样脱敏）。 */
export type ConnectionMeta = Omit<ConnectionConfig, 'password' | 'apiKey' | 'ssh'> & {
  ssh?: Omit<SshConfig, 'password' | 'passphrase'>
}

export interface ConnectionImportResult {
  imported: number
  skipped: number
  queriesImported: number
  queriesSkipped: number
  canceled: boolean
}

export interface DataImportFile {
  name: string
  content: string
}

export interface TableInfo {
  name: string
  type: 'table' | 'view'
  /** PG 的 schema;MySQL/SQLite 为空 */
  schema?: string
  comment?: string
  /** 数据行数；部分数据库返回估算值。 */
  rowCount?: number
  createdAt?: string
  updatedAt?: string
  objectId?: string | number
}

export interface RoutineInfo {
  name: string
  type: 'function' | 'procedure'
  /** PostgreSQL 的 schema；MySQL/SQLite 为空 */
  schema?: string
  /** PostgreSQL 重载函数的参数签名 */
  arguments?: string
  createdAt?: string
  updatedAt?: string
  objectId?: string | number
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

export interface ForeignKeyInfo {
  name: string
  columns: string[]
  referencedSchema?: string
  referencedTable: string
  referencedColumns: string[]
  onUpdate?: string
  onDelete?: string
}

export interface CheckConstraintInfo {
  name: string
  expression: string
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
  /** 结构化操作的实际原子性；不能把多请求操作伪装成事务。 */
  atomicity?: ExecutionAtomicity
  succeeded?: number
  failed?: number
  /** 审批弹窗展示的不可执行预览文本。 */
  preview?: string
}

/** 由 Agent CLI 发起、必须在桌面端人工处理的审批请求。 */
export interface AgentApprovalRequest {
  requestId: string
  approvalToken: string
  connectionId: string
  connectionName: string
  database?: string
  sql: string
  sqlKind: SqlKind
  expiresAt: string
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
  /** 游标型数据库的下一页起点（如 Qdrant point id）。 */
  cursor?: string | number
  /** 是否返回大体积向量字段；Qdrant 默认关闭。 */
  includeVectors?: boolean
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
  /** 对具体对象进一步收窄连接级能力，例如 Redis Stream 不支持原地更新。 */
  recordOperations?: { insert: boolean; update: boolean; delete: boolean }
  /** 游标分页结果；未设置时沿用页码/偏移量分页。 */
  paginationMode?: 'cursor'
  nextCursor?: string | number
}

/** preload 暴露给渲染进程的 API 形状(见 src/preload/index.ts) */
export interface Api {
  // 窗口
  openNewWindow(): Promise<void>
  getWindowMode(): Promise<WindowMode>
  /** 窗口完成普通、最大化或全屏切换后通知渲染进程。 */
  onWindowModeChanged(listener: (mode: WindowMode) => void): () => void
  /** 其他窗口修改共享数据时通知当前窗口刷新；返回取消监听函数。 */
  onDataChanged(listener: (resource: 'connections' | 'queries' | 'all') => void): () => void
  /** 任一窗口或 Agent 成功改变数据库元数据后，通知所有窗口失效对应连接的缓存。 */
  onMetadataChanged(listener: (connectionId: string) => void): () => void
  /** Agent CLI 发起写操作时通知桌面端显示人工审批。 */
  onAgentApprovalRequested(listener: (request: AgentApprovalRequest) => void): () => void

  // 连接管理
  listConnections(): Promise<ConnectionMeta[]>
  saveConnection(cfg: ConnectionConfig): Promise<ConnectionMeta>
  /** 复制完整连接配置；凭据在主进程内保持加密，不暴露给渲染进程。 */
  duplicateConnection(id: string, name: string): Promise<ConnectionMeta>
  deleteConnection(id: string): Promise<void>
  testConnection(cfg: ConnectionConfig): Promise<{ ok: boolean; error?: string }>
  /** 导出完整连接配置及查询；密码保持为 Electron safeStorage 密文。 */
  exportConnections(): Promise<string | null>
  /** 导入连接配置；仅恢复当前系统账户能够解密的 safeStorage 密码。 */
  importConnections(): Promise<ConnectionImportResult>
  /** 选择已有 SQLite 文件或用于新建数据库的目录。 */
  pickSqlitePath(): Promise<SqlitePathSelection | null>
  /** 通用文件选择(如 SSH 私钥) */
  pickFile(opts?: { title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>
  /** 选择 CSV / JSON 数据文件并读取 UTF-8 文本；取消返回 null。 */
  pickDataFile(): Promise<DataImportFile | null>

  // 保存的查询
  listSavedQueries(): Promise<SavedQuery[]>
  saveQuery(query: SavedQueryInput): Promise<SavedQuery>
  deleteSavedQuery(id: string): Promise<void>

  // 连接与浏览
  connect(id: string): Promise<{ ok: boolean; error?: string }>
  disconnect(id: string): Promise<void>
  listDatabases(id: string): Promise<string[]>
  listTables(id: string, database?: string, includeStats?: boolean): Promise<TableInfo[]>
  listRoutines(id: string, database?: string): Promise<RoutineInfo[]>
  listColumns(id: string, database: string | undefined, table: string, schema?: string): Promise<ColumnInfo[]>
  listIndexes(id: string, database: string | undefined, table: string, schema?: string): Promise<IndexInfo[]>
  /** 只读查看对象 DDL，不进入写操作或 DDL 执行权限流程 */
  getObjectDdl(id: string, database: string | undefined, table: string, schema?: string): Promise<string>
  /** 只读查看函数或存储过程定义 */
  getRoutineDefinition(id: string, database: string | undefined, routine: string, type: RoutineInfo['type'], schema?: string, argumentsSignature?: string): Promise<string>
  getTableData(id: string, q: TableDataQuery): Promise<TableDataResult>
  /** 驱动能力由主进程提供，UI 不再按数据库类型猜测。 */
  getDriverCapabilities(id: string): Promise<DriverCapabilities>

  // SQL 执行(统一权限管道)
  executeSql(id: string, sql: string, database?: string): Promise<ExecuteResponse>
  executeOperation(id: string, operation: DatabaseOperation): Promise<ExecuteResponse>
  /** 停止该连接当前正在执行的查询；只影响指定连接。 */
  cancelSql(id: string): Promise<boolean>
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
