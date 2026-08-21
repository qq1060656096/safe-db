import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { constants as fsConstants } from 'node:fs'
import { access, open, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import type {
  AuditFilter,
  ConnectionConfig,
  DatabaseOperation,
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

function normalizedSqliteDatabaseName(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('请输入数据库名称')
  if (trimmed === '.' || trimmed === '..' || trimmed.includes('\0') || /[\\/]/.test(trimmed)) {
    throw new Error('数据库名称不能包含路径或路径分隔符')
  }
  if (/(?:-wal|-shm|-journal)$/i.test(trimmed)) {
    throw new Error('不能将 SQLite 伴随文件作为数据库名称')
  }
  return extname(trimmed) ? trimmed : `${trimmed}.db`
}

async function assertExistingSqliteFile(filePath: string): Promise<void> {
  const info = await stat(filePath).catch(() => null)
  if (!info?.isFile()) throw new Error('所选 SQLite 数据库文件不存在或不是普通文件')
  const db = new Database(filePath, { readonly: true, fileMustExist: true })
  try {
    db.pragma('schema_version', { simple: true })
  } finally {
    db.close()
  }
}

async function sqliteConfigForSave(
  cfg: ConnectionConfig
): Promise<{ config: ConnectionConfig; createdFile: string | null }> {
  const { sqliteCreate, ...persistentConfig } = cfg
  if (cfg.type !== 'sqlite') return { config: persistentConfig, createdFile: null }

  if (!sqliteCreate) {
    const filePath = cfg.filePath?.trim()
    if (!filePath) throw new Error('请选择 SQLite 数据库文件')
    await assertExistingSqliteFile(filePath)
    return { config: { ...persistentConfig, filePath }, createdFile: null }
  }

  const rawDirectory = sqliteCreate.directory.trim()
  if (!rawDirectory) throw new Error('请选择数据库目录')
  const directory = resolve(rawDirectory)
  const directoryInfo = await stat(directory).catch(() => null)
  if (!directoryInfo?.isDirectory()) throw new Error('所选数据库目录不存在或不是目录')
  await access(directory, fsConstants.W_OK)

  const databaseName = normalizedSqliteDatabaseName(sqliteCreate.databaseName)
  const filePath = join(directory, databaseName)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let createdByThisCall = false
  try {
    // wx 原子地拒绝同名文件，避免“检查后到创建前”被其他进程抢占而发生覆盖。
    handle = await open(filePath, 'wx')
    createdByThisCall = true
    await handle.close()
    handle = undefined
    const db = new Database(filePath, { fileMustExist: true })
    try {
      // 显式初始化数据库页，使新文件立即成为可验证的 SQLite 数据库。
      db.exec('VACUUM')
    } finally {
      db.close()
    }
  } catch (error) {
    await handle?.close().catch(() => {})
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`数据库文件“${databaseName}”已存在，请选择该文件连接或修改数据库名称`)
    }
    // 仅清理由本次流程刚刚创建、但未能初始化成功的文件。
    if (createdByThisCall) await unlink(filePath).catch(() => {})
    throw error
  }

  return {
    config: { ...persistentConfig, filePath },
    createdFile: filePath
  }
}

async function testSqliteConfig(cfg: ConnectionConfig): Promise<void> {
  if (!cfg.sqliteCreate) {
    const filePath = cfg.filePath?.trim()
    if (!filePath) throw new Error('请选择 SQLite 数据库文件')
    await assertExistingSqliteFile(filePath)
    return
  }
  const rawDirectory = cfg.sqliteCreate.directory.trim()
  if (!rawDirectory) throw new Error('请选择数据库目录')
  const directory = resolve(rawDirectory)
  const directoryInfo = await stat(directory).catch(() => null)
  if (!directoryInfo?.isDirectory()) throw new Error('所选数据库目录不存在或不是目录')
  await access(directory, fsConstants.W_OK)
  const databaseName = normalizedSqliteDatabaseName(cfg.sqliteCreate.databaseName)
  const filePath = join(directory, databaseName)
  const targetInfo = await stat(filePath).catch(() => null)
  if (targetInfo) throw new Error(`数据库文件“${databaseName}”已存在，请选择该文件连接或修改数据库名称`)
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
  ipcMain.handle('window:mode', (event) => {
    const window = senderWindow(event)
    if (!window) return 'normal'
    if (window.isFullScreen()) return 'fullscreen'
    return window.isMaximized() ? 'maximized' : 'normal'
  })

  // ---- 连接管理 ----
  ipcMain.handle('connections:list', () => connections.list())

  ipcMain.handle('connections:save', async (event, cfg: ConnectionConfig) => {
    const { config, createdFile } = await sqliteConfigForSave(cfg)
    let meta
    try {
      meta = connections.save(config)
    } catch (error) {
      // 配置持久化失败时回滚本次新建的数据库，不遗留一个用户未保存的空库。
      if (createdFile) await unlink(createdFile).catch(() => {})
      throw error
    }
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

  ipcMain.handle('connections:delete', (event, id: string) => {
    connections.delete(id)
    queries.deleteByConnection(id)
    // 删除本地配置不等待远程连接优雅关闭；后台清理只作用于被删除的连接。
    const disconnecting = drivers.invalidate(id)
    notifyOtherWindows(event, 'all')
    void disconnecting.catch(() => {})
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
      if (merged.type === 'sqlite') {
        await testSqliteConfig(merged)
        return { ok: true }
      }
      // SSH 隧道:先起一条临时隧道,测试完即关
      let endpoint: { host: string; port: number } | undefined
      if (merged.ssh?.enabled) {
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

  ipcMain.handle('connections:pickSqlitePath', async (event) => {
    const win = senderWindow(event)
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: '选择 SQLite 数据库文件或目录',
      properties: ['openFile', 'openDirectory', 'createDirectory'],
      filters: [
        { name: 'SQLite 数据库', extensions: ['db', 'sqlite', 'sqlite3'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    const selectedPath = res.filePaths[0]
    if (res.canceled || !selectedPath) return null
    const selectedInfo = await stat(selectedPath)
    if (!selectedInfo.isFile() && !selectedInfo.isDirectory()) {
      throw new Error('请选择 SQLite 数据库文件或目录')
    }
    return { path: selectedPath, kind: selectedInfo.isDirectory() ? 'directory' : 'file' }
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

  ipcMain.handle('db:capabilities', (_e, id: string) => drivers.capabilities(id))

  // ---- SQL 执行(权限管道)----
  ipcMain.handle('exec:sql', (_e, id: string, sql: string, database?: string) =>
    executor.execute(id, sql, database)
  )

  ipcMain.handle('exec:operation', (_e, id: string, operation: DatabaseOperation) =>
    executor.executeOperation(id, operation)
  )

  ipcMain.handle('exec:cancel', (_e, id: string) => drivers.cancel(id))

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
