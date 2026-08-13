import { defineStore } from 'pinia'
import type { AgentApprovalRequest, ConnectionConfig, ConnectionMeta, ExecuteResponse, PermissionMode, SavedQuery, SavedQueryInput, SqlKind, TableDataQuery, TableDataResult } from '../../../shared/types'
import { i18n } from '../i18n'
import { invalidateConnectionMetadata } from '../metadataCache'

export type ObjectGroup = 'tables' | 'views' | 'routines' | 'queries'
export type TabType = 'query' | 'table' | 'structure' | 'objects' | 'audit'

export interface AppTab {
  id: string
  type: TabType
  title: string
  connectionId?: string
  database?: string
  schema?: string
  table?: string
  routine?: string
  routineType?: 'function' | 'procedure'
  routineArguments?: string
  objectGroup?: ObjectGroup
  sql?: string
  savedQueryId?: string
  /** 查询内容与最近一次保存的版本不一致。 */
  dirty?: boolean
}

export interface PendingApproval {
  token: string
  connectionId: string
  sql: string
  sqlKind: SqlKind
  connectionName: string
  database?: string
}

let approvalResolver: ((response: ExecuteResponse) => void) | null = null
let stopAgentApprovalListener: (() => void) | null = null
const queuedAgentApprovals: AgentApprovalRequest[] = []

export const useAppStore = defineStore('app', {
  state: () => ({
    connections: [] as ConnectionMeta[],
    connectedIds: {} as Record<string, boolean>,
    tabs: [] as AppTab[],
    savedQueries: [] as SavedQuery[],
    activeTabId: null as string | null,
    pendingApproval: null as PendingApproval | null
  }),
  actions: {
    listenForAgentApprovals(): void {
      if (stopAgentApprovalListener) return
      stopAgentApprovalListener = window.api.onAgentApprovalRequested((request) => {
        if (this.pendingApproval?.token === request.approvalToken || queuedAgentApprovals.some((item) => item.approvalToken === request.approvalToken)) return
        queuedAgentApprovals.push(request)
        this.showNextAgentApproval()
      })
    },
    showNextAgentApproval(): void {
      if (this.pendingApproval || queuedAgentApprovals.length === 0) return
      const request = queuedAgentApprovals.shift()!
      this.pendingApproval = {
        token: request.approvalToken,
        connectionId: request.connectionId,
        sql: request.sql,
        sqlKind: request.sqlKind,
        connectionName: request.connectionName,
        database: request.database
      }
    },
    async loadConnections(): Promise<void> {
      const previous = new Map(this.connections.map((connection) => [connection.id, connection]))
      const nextConnections = await window.api.listConnections()
      const next = new Map(nextConnections.map((connection) => [connection.id, connection]))
      // 只失效被删除或配置发生变化的连接，其他连接的缓存与进行中操作保持不动。
      for (const [id, connection] of previous) {
        const current = next.get(id)
        if (!current || JSON.stringify(current) !== JSON.stringify(connection)) invalidateConnectionMetadata(id)
      }
      // 未变化的连接保留对象引用，避免其查询页 watcher 因数组刷新而重新加载元数据。
      this.connections = nextConnections.map((connection) => {
        const existing = previous.get(connection.id)
        return existing && JSON.stringify(existing) === JSON.stringify(connection) ? existing : connection
      })
      const connectionIds = new Set(this.connections.map((connection) => connection.id))
      this.tabs = this.tabs.filter((tab) => !tab.connectionId || connectionIds.has(tab.connectionId))
      if (this.activeTabId && !this.tabs.some((tab) => tab.id === this.activeTabId)) {
        this.activeTabId = this.tabs.at(-1)?.id ?? null
      }
      for (const id of Object.keys(this.connectedIds)) {
        if (!connectionIds.has(id)) delete this.connectedIds[id]
      }
    },
    async loadSavedQueries(): Promise<void> {
      this.savedQueries = await window.api.listSavedQueries()
      const queryIds = new Set(this.savedQueries.map((query) => query.id))
      for (const tab of this.tabs) {
        if (tab.savedQueryId && !queryIds.has(tab.savedQueryId)) tab.savedQueryId = undefined
      }
    },
    async saveQuery(input: SavedQueryInput): Promise<SavedQuery> {
      const saved = await window.api.saveQuery(input)
      const index = this.savedQueries.findIndex((query) => query.id === saved.id)
      if (index >= 0) this.savedQueries[index] = saved
      else this.savedQueries.push(saved)
      return saved
    },
    async deleteSavedQuery(id: string): Promise<void> {
      await window.api.deleteSavedQuery(id)
      this.savedQueries = this.savedQueries.filter((query) => query.id !== id)
      for (const tab of this.tabs) if (tab.savedQueryId === id) tab.savedQueryId = undefined
    },
    async saveConnection(config: ConnectionConfig): Promise<void> {
      const saved = await window.api.saveConnection(config)
      invalidateConnectionMetadata(saved.id)
      await this.loadConnections()
    },
    async duplicateConnection(id: string, name: string): Promise<ConnectionMeta> {
      const copied = await window.api.duplicateConnection(id, name)
      await this.loadConnections()
      return copied
    },
    async updateConnectionPermissionMode(id: string, permissionMode: PermissionMode): Promise<ConnectionMeta | undefined> {
      const connection = this.connections.find((item) => item.id === id)
      if (!connection || connection.permissionModeLocked || connection.permissionMode === permissionMode) return connection
      const saved = await window.api.saveConnection({ ...connection, permissionMode })
      const index = this.connections.findIndex((item) => item.id === id)
      if (index >= 0) this.connections[index] = saved
      return saved
    },
    async removeConnection(id: string): Promise<void> {
      await window.api.deleteConnection(id)
      const activeBelongsToConnection = this.tabs.find((tab) => tab.id === this.activeTabId)?.connectionId === id
      this.tabs = this.tabs.filter((tab) => tab.connectionId !== id)
      if (activeBelongsToConnection) this.activeTabId = this.tabs.at(-1)?.id ?? null
      delete this.connectedIds[id]
      this.savedQueries = this.savedQueries.filter((query) => query.connectionId !== id)
      this.connections = this.connections.filter((connection) => connection.id !== id)
      invalidateConnectionMetadata(id)
    },
    setConnected(id: string, connected: boolean): void {
      this.connectedIds[id] = connected
      if (!connected) invalidateConnectionMetadata(id)
    },
    openTab(tab: Omit<AppTab, 'id'>): string {
      const id = crypto.randomUUID()
      this.tabs.push({ ...tab, id })
      this.activeTabId = id
      return id
    },
    openSavedQuery(query: SavedQuery): string {
      const existing = this.tabs.find((tab) => tab.type === 'query' && tab.savedQueryId === query.id)
      if (existing) {
        this.activeTabId = existing.id
        return existing.id
      }
      return this.openTab({
        type: 'query',
        title: query.name,
        connectionId: query.connectionId,
        database: query.database,
        sql: query.sql,
        savedQueryId: query.id
      })
    },
    closeTab(id: string): void {
      const index = this.tabs.findIndex((tab) => tab.id === id)
      this.tabs = this.tabs.filter((tab) => tab.id !== id)
      if (this.activeTabId === id) this.activeTabId = this.tabs[Math.max(0, index - 1)]?.id ?? null
    },
    closeTabs(ids: string[]): void {
      const removing = new Set(ids)
      if (removing.size === 0) return
      const activeIndex = this.tabs.findIndex((tab) => tab.id === this.activeTabId)
      const activeRemoved = this.activeTabId !== null && removing.has(this.activeTabId)
      this.tabs = this.tabs.filter((tab) => !removing.has(tab.id))
      if (activeRemoved) this.activeTabId = this.tabs[Math.min(Math.max(0, activeIndex), this.tabs.length - 1)]?.id ?? null
    },
    closeTabsLeft(id: string): void {
      const index = this.tabs.findIndex((tab) => tab.id === id)
      if (index > 0) this.closeTabs(this.tabs.slice(0, index).map((tab) => tab.id))
    },
    closeTabsRight(id: string): void {
      const index = this.tabs.findIndex((tab) => tab.id === id)
      if (index >= 0) this.closeTabs(this.tabs.slice(index + 1).map((tab) => tab.id))
    },
    closeOtherTabs(id: string): void {
      if (!this.tabs.some((tab) => tab.id === id)) return
      this.closeTabs(this.tabs.filter((tab) => tab.id !== id).map((tab) => tab.id))
      this.activeTabId = id
    },
    closeOtherSavedQueryTabs(id: string): void {
      this.closeTabs(this.tabs
        .filter((tab) => tab.id !== id && tab.type === 'query' && Boolean(tab.savedQueryId) && !tab.dirty)
        .map((tab) => tab.id))
    },
    closeUnmodifiedQueryTabs(): void {
      this.closeTabs(this.tabs
        .filter((tab) => tab.type === 'query' && !tab.dirty)
        .map((tab) => tab.id))
    },
    closeAllTabs(): void {
      this.tabs = []
      this.activeTabId = null
    },
    setActiveTab(id: string): void {
      if (this.tabs.some((tab) => tab.id === id)) this.activeTabId = id
    },
    setTabDatabase(id: string, database?: string): void {
      const tab = this.tabs.find((item) => item.id === id)
      if (!tab || tab.type !== 'query') return
      tab.database = database
      tab.schema = undefined
      tab.routine = undefined
      tab.routineType = undefined
      tab.routineArguments = undefined
    },
    setTabDirty(id: string, dirty: boolean): void {
      const tab = this.tabs.find((item) => item.id === id)
      if (!tab || tab.type !== 'query' || Boolean(tab.dirty) === dirty) return
      tab.dirty = dirty || undefined
    },
    bindSavedQuery(id: string, query: SavedQuery): void {
      const tab = this.tabs.find((item) => item.id === id)
      if (!tab || tab.type !== 'query') return
      tab.title = query.name
      tab.savedQueryId = query.id
      tab.connectionId = query.connectionId
      tab.database = query.database
      tab.sql = query.sql
      tab.dirty = undefined
      tab.schema = undefined
      tab.routine = undefined
      tab.routineType = undefined
      tab.routineArguments = undefined
    },
    async executeWithApproval(connectionId: string, sql: string, database?: string): Promise<ExecuteResponse> {
      const response = await window.api.executeSql(connectionId, sql, database)
      if (response.status !== 'needsApproval') return response
      const connectionName = this.connections.find((connection) => connection.id === connectionId)?.name ?? ''
      return new Promise<ExecuteResponse>((resolve) => {
        approvalResolver = resolve
        this.pendingApproval = {
          token: response.approvalToken!,
          connectionId,
          sql,
          sqlKind: response.sqlKind ?? 'WRITE',
          connectionName,
          database
        }
      })
    },
    async cancelPendingQueryApproval(connectionId: string): Promise<boolean> {
      if (!approvalResolver || this.pendingApproval?.connectionId !== connectionId) return false
      await this.resolveApproval(false)
      return true
    },
    async resolveApproval(accept: boolean): Promise<void> {
      const pending = this.pendingApproval
      this.pendingApproval = null
      if (!pending) {
        approvalResolver = null
        this.showNextAgentApproval()
        return
      }
      if (accept) {
        approvalResolver?.(await window.api.confirmExecute(pending.token))
      } else {
        await window.api.rejectExecute(pending.token)
        approvalResolver?.({ status: 'error', error: i18n.global.t('query.canceled') })
      }
      approvalResolver = null
      this.showNextAgentApproval()
    },
    getTableData(connectionId: string, query: TableDataQuery): Promise<TableDataResult> {
      // Vue 会把数组与对象包装成 Proxy；IPC 的结构化克隆不能直接传递 Proxy。
      const payload: TableDataQuery = {
        ...query,
        orderBy: query.orderBy?.map((item) => ({ ...item })),
        filters: query.filters?.map((item) => ({ ...item }))
      }
      return window.api.getTableData(connectionId, payload)
    }
  }
})
