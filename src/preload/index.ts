import { contextBridge, ipcRenderer } from 'electron'
import type {
  Api,
  AgentApprovalRequest,
  ApprovalLogFilter,
  AuditFilter,
  ConnectionConfig,
  DatabaseOperation,
  ExportOptions,
  DatabaseExportOptions,
  OperationLogFilter,
  SavedQueryInput,
  TableDataQuery
} from '../shared/types'

const api: Api = {
  // 窗口
  openNewWindow: () => ipcRenderer.invoke('window:new'),
  getWindowMode: () => ipcRenderer.invoke('window:mode'),
  onWindowModeChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, mode: import('../shared/types').WindowMode) => listener(mode)
    ipcRenderer.on('window:modeChanged', handler)
    return () => ipcRenderer.removeListener('window:modeChanged', handler)
  },
  onDataChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, resource: 'connections' | 'queries' | 'all') => listener(resource)
    ipcRenderer.on('data:changed', handler)
    return () => ipcRenderer.removeListener('data:changed', handler)
  },
  onMetadataChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, connectionId: string, droppedDatabase?: string) => listener(connectionId, droppedDatabase)
    ipcRenderer.on('metadata:changed', handler)
    return () => ipcRenderer.removeListener('metadata:changed', handler)
  },
  onAgentApprovalRequested: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, request: AgentApprovalRequest) => listener(request)
    ipcRenderer.on('agent:approvalRequested', handler)
    return () => ipcRenderer.removeListener('agent:approvalRequested', handler)
  },

  // 连接管理
  listConnections: () => ipcRenderer.invoke('connections:list'),
  reorderConnections: (ids: string[]) => ipcRenderer.invoke('connections:reorder', ids),
  saveConnection: (cfg: ConnectionConfig) => ipcRenderer.invoke('connections:save', cfg),
  duplicateConnection: (id: string, name: string) => ipcRenderer.invoke('connections:duplicate', id, name),
  deleteConnection: (id: string) => ipcRenderer.invoke('connections:delete', id),
  testConnection: (cfg: ConnectionConfig) => ipcRenderer.invoke('connections:test', cfg),
  exportConnections: () => ipcRenderer.invoke('connections:export'),
  importConnections: () => ipcRenderer.invoke('connections:import'),
  pickSqlitePath: () => ipcRenderer.invoke('connections:pickSqlitePath'),
  pickFile: (opts?: { title?: string; filters?: { name: string; extensions: string[] }[] }) =>
    ipcRenderer.invoke('connections:pickFile', opts),
  pickDataFile: () => ipcRenderer.invoke('data:pickImportFile'),

  // 保存的查询
  listSavedQueries: () => ipcRenderer.invoke('queries:list'),
  saveQuery: (query: SavedQueryInput) => ipcRenderer.invoke('queries:save', query),
  deleteSavedQuery: (id: string) => ipcRenderer.invoke('queries:delete', id),

  // 连接与浏览
  connect: (id: string) => ipcRenderer.invoke('db:connect', id),
  disconnect: (id: string) => ipcRenderer.invoke('db:disconnect', id),
  listDatabases: (id: string) => ipcRenderer.invoke('db:databases', id),
  listTables: (id: string, database?: string, includeStats?: boolean) => ipcRenderer.invoke('db:tables', id, database, includeStats),
  listRoutines: (id: string, database?: string) => ipcRenderer.invoke('db:routines', id, database),
  listColumns: (id: string, database: string | undefined, table: string, schema?: string) =>
    ipcRenderer.invoke('db:columns', id, database, table, schema),
  listIndexes: (id: string, database: string | undefined, table: string, schema?: string) =>
    ipcRenderer.invoke('db:indexes', id, database, table, schema),
  getObjectDdl: (id: string, database: string | undefined, table: string, schema?: string) =>
    ipcRenderer.invoke('db:ddl', id, database, table, schema),
  getRoutineDefinition: (id, database, routine, type, schema, argumentsSignature) =>
    ipcRenderer.invoke('db:routineDefinition', id, database, routine, type, schema, argumentsSignature),
  getTableData: (id: string, q: TableDataQuery) => ipcRenderer.invoke('db:tableData', id, q),
  getDriverCapabilities: (id: string) => ipcRenderer.invoke('db:capabilities', id),

  // SQL 执行
  executeSql: (id: string, sql: string, database?: string) =>
    ipcRenderer.invoke('exec:sql', id, sql, database),
  executeOperation: (id: string, operation: DatabaseOperation) =>
    ipcRenderer.invoke('exec:operation', id, operation),
  cancelSql: (id: string) => ipcRenderer.invoke('exec:cancel', id),
  confirmExecute: (token: string) => ipcRenderer.invoke('exec:confirm', token),
  rejectExecute: (token: string) => ipcRenderer.invoke('exec:reject', token),

  // 审计
  queryAudit: (filter: AuditFilter) => ipcRenderer.invoke('audit:query', filter),
  queryOperationLogs: (filter: OperationLogFilter) => ipcRenderer.invoke('audit:operations', filter),
  queryApprovalLogs: (filter: ApprovalLogFilter) => ipcRenderer.invoke('audit:approvals', filter),
  listExecutionTraces: (operationId: string) => ipcRenderer.invoke('audit:executionTraces', operationId),
  revealExecutionTrace: (id: string) => ipcRenderer.invoke('audit:revealExecutionTrace', id),
  recordSensitiveAuditAction: (action: 'copy' | 'export', traceId: string) =>
    ipcRenderer.invoke('audit:sensitiveAction', action, traceId),
  verifyAuditIntegrity: () => ipcRenderer.invoke('audit:verifyIntegrity'),
  rotateAuditEncryptionKey: () => ipcRenderer.invoke('audit:rotateKey'),
  purgeAuditLogs: (retentionDays: number) => ipcRenderer.invoke('audit:purge', retentionDays),

  // 导出
  exportData: (opts: ExportOptions) => ipcRenderer.invoke('export:save', opts),
  exportDatabase: (opts: DatabaseExportOptions) => ipcRenderer.invoke('export:database', opts)
}

contextBridge.exposeInMainWorld('api', api)
