import { contextBridge, ipcRenderer } from 'electron'
import type {
  Api,
  AgentApprovalRequest,
  AuditFilter,
  ConnectionConfig,
  ExportOptions,
  SavedQueryInput,
  TableDataQuery
} from '../shared/types'

const api: Api = {
  // 窗口
  openNewWindow: () => ipcRenderer.invoke('window:new'),
  onDataChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, resource: 'connections' | 'queries' | 'all') => listener(resource)
    ipcRenderer.on('data:changed', handler)
    return () => ipcRenderer.removeListener('data:changed', handler)
  },
  onAgentApprovalRequested: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, request: AgentApprovalRequest) => listener(request)
    ipcRenderer.on('agent:approvalRequested', handler)
    return () => ipcRenderer.removeListener('agent:approvalRequested', handler)
  },

  // 连接管理
  listConnections: () => ipcRenderer.invoke('connections:list'),
  saveConnection: (cfg: ConnectionConfig) => ipcRenderer.invoke('connections:save', cfg),
  duplicateConnection: (id: string, name: string) => ipcRenderer.invoke('connections:duplicate', id, name),
  deleteConnection: (id: string) => ipcRenderer.invoke('connections:delete', id),
  testConnection: (cfg: ConnectionConfig) => ipcRenderer.invoke('connections:test', cfg),
  exportConnections: () => ipcRenderer.invoke('connections:export'),
  importConnections: () => ipcRenderer.invoke('connections:import'),
  pickSqliteFile: () => ipcRenderer.invoke('connections:pickSqliteFile'),
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

  // SQL 执行
  executeSql: (id: string, sql: string, database?: string) =>
    ipcRenderer.invoke('exec:sql', id, sql, database),
  confirmExecute: (token: string) => ipcRenderer.invoke('exec:confirm', token),
  rejectExecute: (token: string) => ipcRenderer.invoke('exec:reject', token),

  // 审计
  queryAudit: (filter: AuditFilter) => ipcRenderer.invoke('audit:query', filter),

  // 导出
  exportData: (opts: ExportOptions) => ipcRenderer.invoke('export:save', opts)
}

contextBridge.exposeInMainWorld('api', api)
