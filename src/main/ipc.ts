import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type {
  AuditFilter,
  ConnectionConfig,
  ExportOptions,
  SavedQueryInput,
  TableDataQuery
} from '../shared/types'
import { DriverManager, createDriver } from './drivers/manager'
import { establishTunnel, type TunnelHandle } from './ssh/tunnel'
import { Executor } from './core/executor'
import type { AuditStore } from './store/audit'
import type { ConnectionStore } from './store/connections'
import type { QueryStore } from './store/queries'

export interface IpcDeps {
  connections: ConnectionStore
  queries: QueryStore
  audit: AuditStore
  drivers: DriverManager
  executor: Executor
}

export function registerIpcHandlers(
  deps: IpcDeps,
  createWindow: (sourceWindow?: BrowserWindow) => BrowserWindow
): void {
  const { connections, queries, audit, drivers, executor } = deps

  function senderWindow(event: IpcMainInvokeEvent): BrowserWindow | undefined {
    return BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
  }

  function notifyOtherWindows(event: IpcMainInvokeEvent, resource: 'connections' | 'queries' | 'all'): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.webContents.id !== event.sender.id && !window.webContents.isDestroyed()) {
        window.webContents.send('data:changed', resource)
      }
    }
  }

  // ---- 窗口 ----
  ipcMain.handle('window:new', (event) => {
    createWindow(senderWindow(event))
  })

  // ---- 连接管理 ----
  ipcMain.handle('connections:list', () => connections.list())

  ipcMain.handle('connections:save', async (event, cfg: ConnectionConfig) => {
    const meta = connections.save(cfg)
    // 配置可能已变化,重建驱动
    await drivers.invalidate(meta.id)
    notifyOtherWindows(event, 'connections')
    return meta
  })

  ipcMain.handle('connections:duplicate', (event, id: string, name: string) => {
    const meta = connections.duplicate(id, name)
    notifyOtherWindows(event, 'connections')
    return meta
  })

  ipcMain.handle('connections:delete', async (event, id: string) => {
    await drivers.invalidate(id)
    connections.delete(id)
    queries.deleteByConnection(id)
    notifyOtherWindows(event, 'all')
  })

  // ---- 保存的查询 ----
  ipcMain.handle('queries:list', () => queries.list())
  ipcMain.handle('queries:save', (event, query: SavedQueryInput) => {
    const saved = queries.save(query)
    notifyOtherWindows(event, 'queries')
    return saved
  })
  ipcMain.handle('queries:delete', (event, id: string) => {
    queries.delete(id)
    notifyOtherWindows(event, 'queries')
  })

  ipcMain.handle('connections:test', async (_e, cfg: ConnectionConfig) => {
    let tunnel: TunnelHandle | null = null
    try {
      const merged = connections.mergePasswordForTest(cfg)
      // SSH 隧道:先起一条临时隧道,测试完即关
      let endpoint: { host: string; port: number } | undefined
      if (merged.type !== 'sqlite' && merged.ssh?.enabled) {
        tunnel = await establishTunnel(merged)
        endpoint = { host: '127.0.0.1', port: tunnel.localPort }
      }
      const driver = createDriver(merged, endpoint)
      await driver.test()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      await tunnel?.close().catch(() => {})
    }
  })

  ipcMain.handle('connections:export', async (event) => {
    const win = senderWindow(event)
    if (!win) return null
    const date = new Date().toISOString().slice(0, 10)
    const res = await dialog.showSaveDialog(win, {
      title: '导出连接',
      defaultPath: `safe-db-connections-${date}.json`,
      filters: [{ name: 'safe-db 连接配置', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return null
    const exportedConnections = connections.listEncrypted()
    const exportedConnectionIds = new Set(exportedConnections.map((connection) => connection.id))
    const payload = {
      format: 'safe-db-connections',
      version: 3,
      exportedAt: new Date().toISOString(),
      secretsIncluded: true,
      secretProtection: 'electron-safe-storage',
      connections: exportedConnections,
      queries: queries.list().filter((query) => exportedConnectionIds.has(query.connectionId))
    }
    await writeFile(res.filePath, JSON.stringify(payload, null, 2), 'utf-8')
    return res.filePath
  })

  ipcMain.handle('connections:import', async (event) => {
    const win = senderWindow(event)
    if (!win) return { imported: 0, skipped: 0, queriesImported: 0, queriesSkipped: 0, canceled: true }
    const res = await dialog.showOpenDialog(win, {
      title: '导入连接',
      properties: ['openFile'],
      filters: [{ name: 'safe-db 连接配置', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePaths[0]) return { imported: 0, skipped: 0, queriesImported: 0, queriesSkipped: 0, canceled: true }
    const raw = await readFile(res.filePaths[0], 'utf-8')
    const value = JSON.parse(raw) as unknown
    const record = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
    const includesEncryptedSecrets = record?.format === 'safe-db-connections'
      && record.version === 3
      && record.secretsIncluded === true
      && record.secretProtection === 'electron-safe-storage'
    const { connectionIdMap, ...connectionResult } = connections.importPortable(value, includesEncryptedSecrets)
    const queryResult = queries.importPortable(value, connectionIdMap)
    if (connectionResult.imported > 0 || queryResult.queriesImported > 0) notifyOtherWindows(event, 'all')
    return { ...connectionResult, ...queryResult, canceled: false }
  })

  ipcMain.handle('connections:pickSqliteFile', async (event) => {
    const win = senderWindow(event)
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: '选择 SQLite 数据库文件',
      properties: ['openFile', 'createDirectory'],
      filters: [
        { name: 'SQLite 数据库', extensions: ['db', 'sqlite', 'sqlite3'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })

  ipcMain.handle(
    'connections:pickFile',
    async (event, opts?: { title?: string; filters?: { name: string; extensions: string[] }[] }) => {
      const win = senderWindow(event)
      if (!win) return null
      const res = await dialog.showOpenDialog(win, {
        title: opts?.title ?? '选择文件',
        properties: ['openFile'],
        filters: opts?.filters
      })
      return res.canceled ? null : (res.filePaths[0] ?? null)
    }
  )

  ipcMain.handle('data:pickImportFile', async (event) => {
    const win = senderWindow(event)
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: '导入表数据',
      properties: ['openFile'],
      filters: [
        { name: '数据文件', extensions: ['csv', 'tsv', 'json'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    const filePath = res.filePaths[0]
    if (res.canceled || !filePath) return null
    const extension = extname(filePath).toLowerCase()
    if (!['.csv', '.tsv', '.json'].includes(extension)) throw new Error('仅支持 CSV、TSV 或 JSON 文件')
    const content = await readFile(filePath, 'utf-8')
    if (Buffer.byteLength(content, 'utf-8') > 25 * 1024 * 1024) throw new Error('导入文件不能超过 25 MB')
    return { name: basename(filePath), content }
  })

  // ---- 连接与浏览 ----
  ipcMain.handle('db:connect', async (_e, id: string) => {
    try {
      await drivers.get(id)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('db:disconnect', async (_e, id: string) => drivers.invalidate(id))

  ipcMain.handle('db:databases', async (_e, id: string) => (await drivers.get(id)).listDatabases())

  ipcMain.handle('db:tables', async (_e, id: string, database?: string, includeStats?: boolean) =>
    (await drivers.get(id)).listTables(database, includeStats)
  )

  ipcMain.handle('db:routines', async (_e, id: string, database?: string) =>
    (await drivers.get(id)).listRoutines(database)
  )

  ipcMain.handle(
    'db:columns',
    async (_e, id: string, database: string | undefined, table: string, schema?: string) =>
      (await drivers.get(id)).listColumns(database, table, schema)
  )

  ipcMain.handle(
    'db:indexes',
    async (_e, id: string, database: string | undefined, table: string, schema?: string) =>
      (await drivers.get(id)).listIndexes(database, table, schema)
  )

  ipcMain.handle(
    'db:ddl',
    async (_e, id: string, database: string | undefined, table: string, schema?: string) =>
      (await drivers.get(id)).getObjectDdl(database, table, schema)
  )

  ipcMain.handle(
    'db:routineDefinition',
    async (_e, id: string, database: string | undefined, routine: string, type: 'function' | 'procedure', schema?: string, argumentsSignature?: string) =>
      (await drivers.get(id)).getRoutineDefinition(database, routine, type, schema, argumentsSignature)
  )

  ipcMain.handle('db:tableData', async (_e, id: string, q: TableDataQuery) =>
    (await drivers.get(id)).getTableData(q)
  )

  // ---- SQL 执行(权限管道)----
  ipcMain.handle('exec:sql', (_e, id: string, sql: string, database?: string) =>
    executor.execute(id, sql, database)
  )

  ipcMain.handle('exec:confirm', (_e, token: string) => executor.confirmExecute(token))

  ipcMain.handle('exec:reject', (_e, token: string) => executor.rejectExecute(token))

  // ---- 审计 ----
  ipcMain.handle('audit:query', (_e, filter: AuditFilter) => audit.query(filter))

  // ---- 导出:保存对话框 + 写盘 ----
  ipcMain.handle('export:save', async (event, opts: ExportOptions) => {
    const win = senderWindow(event)
    if (!win) return null
    const res = await dialog.showSaveDialog(win, {
      title: '导出数据',
      defaultPath: opts.defaultName,
      filters: opts.fileTypes
    })
    if (res.canceled || !res.filePath) return null
    await writeFile(res.filePath, opts.content, 'utf-8')
    return res.filePath
  })
}
