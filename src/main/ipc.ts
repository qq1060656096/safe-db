import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { constants as fsConstants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { access, open, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import type {
  ApprovalLogFilter,
  AuditFilter,
  ConnectionConfig,
  DatabaseOperation,
  ExecuteResponse,
  ExportOptions,
  OperationLogFilter,
  SavedQueryInput,
  TableDataQuery
} from '../shared/types'
import { DriverManager, createDriver } from './drivers/manager'
import { establishTunnel, type TunnelHandle } from './ssh/tunnel'
import { Executor } from './core/executor'
import { runWithOperationContext } from './audit/trace'
import type { AuditStore, OperationLogInsert } from './store/audit'
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

  function assertSensitiveAuditAccess(event: IpcMainInvokeEvent): void {
    const url = event.senderFrame?.url ?? event.sender.getURL()
    const trusted = url.startsWith('file://') || url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:')
    if (!trusted || event.sender.isDestroyed()) throw new Error('当前调用方没有敏感审计明细查看权限')
  }

  function notifyOtherWindows(event: IpcMainInvokeEvent, resource: 'connections' | 'queries' | 'all'): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.webContents.id !== event.sender.id && !window.webContents.isDestroyed()) {
        window.webContents.send('data:changed', resource)
      }
    }
  }

  function connectionContext(id?: string): Pick<OperationLogInsert,
    'connectionId' | 'connectionName' | 'connectionType' | 'permissionMode'> {
    const cfg = id ? connections.get(id) : undefined
    return {
      connectionId: id ?? null,
      connectionName: cfg?.name ?? null,
      connectionType: cfg?.type ?? null,
      permissionMode: cfg?.permissionMode ?? null
    }
  }

  async function audited<T>(
    entry: Omit<OperationLogInsert, 'status' | 'durationMs' | 'error'>,
    operation: () => T | Promise<T>,
    classify?: (result: T) => { status: OperationLogInsert['status']; error?: string | null }
  ): Promise<T> {
    const operationId = randomUUID()
    return runWithOperationContext(operationId, async () => {
      const started = Date.now()
      let result: T
      try {
        result = await operation()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        try {
          audit.recordOperation({
            ...entry,
            eventId: operationId,
            status: 'error',
            error: message,
            durationMs: Date.now() - started
          })
        } catch (auditError) {
          console.error('记录失败操作日志时发生错误', auditError)
        }
        throw error
      }
      // 成功日志写入失败时让调用方感知审计故障，不把它伪装成业务执行失败并重复写日志。
      const outcome = classify?.(result) ?? { status: 'success' as const }
      audit.recordOperation({
        ...entry,
        eventId: operationId,
        status: outcome.status,
        error: outcome.error,
        durationMs: Date.now() - started
      })
      return result
    })
  }

  function classifyExecutionResponse(result: ExecuteResponse): {
    status: OperationLogInsert['status']
    error?: string | null
  } {
    if (result.status === 'denied') return { status: 'blocked', error: result.error }
    if (result.status === 'error') return { status: 'error', error: result.error }
    return { status: 'success' }
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
    const existing = connections.get(cfg.id)
    return audited({
      category: 'configuration',
      action: existing ? 'UPDATE_CONNECTION' : 'CREATE_CONNECTION',
      connectionId: cfg.id,
      connectionName: cfg.name,
      connectionType: cfg.type,
      permissionMode: cfg.permissionMode,
      targetType: 'connection',
      targetId: cfg.id,
      targetName: cfg.name,
      summary: existing ? '修改数据库连接配置' : '创建数据库连接配置'
    }, async () => {
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
  })

  ipcMain.handle('connections:duplicate', (event, id: string, name: string) =>
    audited({
      category: 'configuration', action: 'DUPLICATE_CONNECTION', ...connectionContext(id),
      targetType: 'connection', targetId: id, targetName: name, summary: '复制数据库连接配置'
    }, () => {
      const meta = connections.duplicate(id, name)
      notifyOtherWindows(event, 'connections')
      return meta
    })
  )

  ipcMain.handle('connections:delete', (event, id: string) => {
    const context = connectionContext(id)
    return audited({
      category: 'configuration', action: 'DELETE_CONNECTION', ...context,
      targetType: 'connection', targetId: id, targetName: context.connectionName, summary: '删除数据库连接配置'
    }, () => {
      connections.delete(id)
      queries.deleteByConnection(id)
      // 删除本地配置不等待远程连接优雅关闭；后台清理只作用于被删除的连接。
      const disconnecting = drivers.invalidate(id)
      notifyOtherWindows(event, 'all')
      void disconnecting.catch(() => {})
    })
  })

  // ---- 保存的查询 ----
  ipcMain.handle('queries:list', () => queries.list())
  ipcMain.handle('queries:save', (event, query: SavedQueryInput) => audited({
    category: 'configuration', action: 'SAVE_QUERY', ...connectionContext(query.connectionId),
    databaseName: query.database, targetType: 'saved-query', targetId: query.id,
    targetName: query.name, summary: '保存查询'
  }, () => {
    const saved = queries.save(query)
    notifyOtherWindows(event, 'queries')
    return saved
  }))
  ipcMain.handle('queries:delete', (event, id: string) => audited({
    category: 'configuration', action: 'DELETE_SAVED_QUERY',
    targetType: 'saved-query', targetId: id, summary: '删除保存的查询'
  }, () => {
    queries.delete(id)
    notifyOtherWindows(event, 'queries')
  }))

  ipcMain.handle('connections:test', async (_e, cfg: ConnectionConfig) => {
    try {
      return await audited({
        category: 'connection', action: 'TEST_CONNECTION',
        connectionId: cfg.id, connectionName: cfg.name, connectionType: cfg.type,
        permissionMode: cfg.permissionMode, databaseName: cfg.database,
        targetType: 'connection', targetId: cfg.id, targetName: cfg.name,
        summary: '测试数据库连接'
      }, async () => {
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
        } finally {
          await tunnel?.close().catch(() => {})
        }
      })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
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
    return audited({
      category: 'export', action: 'EXPORT_CONNECTIONS', summary: '导出连接配置',
      targetType: 'file', targetName: basename(res.filePath),
      details: { connections: exportedConnections.length, queries: payload.queries.length }
    }, async () => {
      await writeFile(res.filePath!, JSON.stringify(payload, null, 2), 'utf-8')
      return res.filePath!
    })
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
    return audited({
      category: 'configuration', action: 'IMPORT_CONNECTIONS', summary: '导入连接配置',
      targetType: 'file', targetName: basename(res.filePaths[0])
    }, async () => {
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
      return await audited({
        category: 'connection', action: 'CONNECT_DATABASE', ...connectionContext(id),
        targetType: 'connection', targetId: id, summary: '连接数据库'
      }, async () => {
        await drivers.get(id)
        return { ok: true }
      })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('db:disconnect', async (_e, id: string) => audited({
    category: 'connection', action: 'DISCONNECT_DATABASE', ...connectionContext(id),
    targetType: 'connection', targetId: id, summary: '断开数据库连接'
  }, () => drivers.invalidate(id)))

  ipcMain.handle('db:databases', async (_e, id: string) => audited({
    category: 'metadata', action: 'REFRESH_DATABASES', ...connectionContext(id),
    targetType: 'connection', targetId: id, summary: '刷新数据库列表'
  }, async () => (await drivers.get(id)).listDatabases()))

  ipcMain.handle('db:tables', async (_e, id: string, database?: string, includeStats?: boolean) =>
    audited({
      category: 'metadata', action: 'REFRESH_OBJECTS', ...connectionContext(id),
      databaseName: database, targetType: 'database', targetId: database, targetName: database,
      summary: '刷新数据库对象列表', details: { includeStats: Boolean(includeStats) }
    }, async () => (await drivers.get(id)).listTables(database, includeStats))
  )

  ipcMain.handle('db:routines', async (_e, id: string, database?: string) =>
    audited({
      category: 'metadata', action: 'REFRESH_ROUTINES', ...connectionContext(id),
      databaseName: database, targetType: 'database', targetId: database, targetName: database,
      summary: '刷新函数和存储过程列表'
    }, async () => (await drivers.get(id)).listRoutines(database))
  )

  ipcMain.handle(
    'db:columns',
    async (_e, id: string, database: string | undefined, table: string, schema?: string) => audited({
      category: 'metadata', action: 'REFRESH_COLUMNS', ...connectionContext(id),
      databaseName: database, targetType: 'object', targetId: table, targetName: table,
      summary: '刷新字段列表', details: { schema }
    }, async () => (await drivers.get(id)).listColumns(database, table, schema))
  )

  ipcMain.handle(
    'db:indexes',
    async (_e, id: string, database: string | undefined, table: string, schema?: string) => audited({
      category: 'metadata', action: 'REFRESH_INDEXES', ...connectionContext(id),
      databaseName: database, targetType: 'object', targetId: table, targetName: table,
      summary: '刷新索引列表', details: { schema }
    }, async () => (await drivers.get(id)).listIndexes(database, table, schema))
  )

  ipcMain.handle(
    'db:ddl',
    async (_e, id: string, database: string | undefined, table: string, schema?: string) => audited({
      category: 'metadata', action: 'VIEW_OBJECT_DEFINITION', ...connectionContext(id),
      databaseName: database, targetType: 'object', targetId: table, targetName: table,
      summary: '查看对象定义', details: { schema }
    }, async () => (await drivers.get(id)).getObjectDdl(database, table, schema))
  )

  ipcMain.handle(
    'db:routineDefinition',
    async (_e, id: string, database: string | undefined, routine: string, type: 'function' | 'procedure', schema?: string, argumentsSignature?: string) => audited({
      category: 'metadata', action: 'VIEW_ROUTINE_DEFINITION', ...connectionContext(id),
      databaseName: database, targetType: type, targetId: routine, targetName: routine,
      summary: '查看函数或存储过程定义', details: { schema, argumentsSignature }
    }, async () => (await drivers.get(id)).getRoutineDefinition(database, routine, type, schema, argumentsSignature))
  )

  ipcMain.handle('db:tableData', async (_e, id: string, q: TableDataQuery) => audited({
    category: 'data', action: 'REFRESH_DATA', ...connectionContext(id),
    databaseName: q.database, targetType: 'object', targetId: q.table, targetName: q.table,
    summary: q.nativeQuery?.type === 'qdrant' && q.nativeQuery.vector ? '执行向量检索' : '刷新数据',
    details: { schema: q.schema, page: q.page, pageSize: q.pageSize, hasFilters: Boolean(q.filters?.length) }
  }, async () => (await drivers.get(id)).getTableData(q)))

  ipcMain.handle('db:capabilities', (_e, id: string) => drivers.capabilities(id))

  // ---- SQL 执行(权限管道)----
  ipcMain.handle('exec:sql', (_e, id: string, sql: string, database?: string) =>
    audited({
      category: 'query', action: 'EXECUTE_QUERY', ...connectionContext(id),
      databaseName: database, targetType: 'database', targetId: database,
      summary: '执行数据库语句'
    }, () => executor.execute(id, sql, database), classifyExecutionResponse)
  )

  ipcMain.handle('exec:operation', (_e, id: string, operation: DatabaseOperation) =>
    audited({
      category: 'query', action: 'EXECUTE_CHANGE', ...connectionContext(id),
      targetType: 'database-operation', targetId: operation.kind, summary: '执行结构化数据库操作'
    }, () => executor.executeOperation(id, operation), classifyExecutionResponse)
  )

  ipcMain.handle('exec:cancel', (_e, id: string) => audited({
    category: 'query', action: 'CANCEL_QUERY', ...connectionContext(id),
    targetType: 'connection', targetId: id, summary: '取消正在执行的查询'
  }, () => drivers.cancel(id)))

  ipcMain.handle('exec:confirm', (_e, token: string) => audited({
    category: 'query', action: 'APPROVE_AND_EXECUTE', summary: '审批通过并执行数据库操作',
    targetType: 'approval'
  }, () => executor.confirmExecute(token), classifyExecutionResponse))

  ipcMain.handle('exec:reject', (_e, token: string) => audited({
    category: 'query', action: 'REJECT_APPROVAL', summary: '拒绝数据库操作审批',
    targetType: 'approval'
  }, () => executor.rejectExecute(token)))

  // ---- 审计 ----
  ipcMain.handle('audit:query', (_e, filter: AuditFilter) => audit.query(filter))
  ipcMain.handle('audit:operations', (_e, filter: OperationLogFilter) => audited({
    category: 'system', action: 'VIEW_OPERATION_LOG', summary: '查看操作日志',
    targetType: 'audit-log', targetId: 'operation'
  }, () => audit.queryOperations(filter)))
  ipcMain.handle('audit:approvals', (_e, filter: ApprovalLogFilter) => audited({
    category: 'system', action: 'VIEW_APPROVAL_LOG', summary: '查看审批日志',
    targetType: 'audit-log', targetId: 'approval'
  }, () => audit.queryApprovals(filter)))
  ipcMain.handle('audit:executionTraces', (_e, operationId: string) => audited({
    category: 'system', action: 'VIEW_EXECUTION_TRACES', summary: '查看底层执行明细列表',
    targetType: 'operation', targetId: operationId
  }, () => audit.listExecutionTraces(operationId)))
  ipcMain.handle('audit:revealExecutionTrace', (event, id: string) => {
    assertSensitiveAuditAccess(event)
    return audited({
      category: 'system', action: 'DECRYPT_EXECUTION_DETAIL', summary: '解密敏感执行明细',
      targetType: 'execution-trace', targetId: id
    }, () => {
      const detail = audit.revealExecutionTrace(id)
      audit.recordOperation({
        category: 'system', action: 'VIEW_EXECUTION_DETAIL', summary: '查看敏感执行明细',
        targetType: 'execution-trace', targetId: id, status: 'success'
      })
      return detail
    })
  })
  ipcMain.handle('audit:sensitiveAction', (event, action: 'copy' | 'export', traceId: string) => {
    assertSensitiveAuditAccess(event)
    audit.recordOperation({
      category: 'system',
      action: action === 'copy' ? 'COPY_EXECUTION_DETAIL' : 'EXPORT_EXECUTION_DETAIL',
      targetType: 'execution-trace', targetId: traceId,
      summary: action === 'copy' ? '复制敏感执行明细' : '导出敏感执行明细',
      status: 'success'
    })
  })
  ipcMain.handle('audit:verifyIntegrity', (event) => {
    assertSensitiveAuditAccess(event)
    return audited({
      category: 'system', action: 'VERIFY_AUDIT_INTEGRITY', summary: '校验审计日志完整性',
      targetType: 'audit-log', targetId: 'execution-trace'
    }, () => audit.verifyIntegrity())
  })
  ipcMain.handle('audit:rotateKey', (event) => {
    assertSensitiveAuditAccess(event)
    return audited({
      category: 'system', action: 'ROTATE_AUDIT_KEY', summary: '轮换审计日志加密密钥',
      targetType: 'audit-key'
    }, () => audit.rotateEncryptionKey())
  })
  ipcMain.handle('audit:purge', (event, retentionDays: number) => {
    assertSensitiveAuditAccess(event)
    return audited({
      category: 'system', action: 'PURGE_AUDIT_LOG', summary: '按保留期限安全删除审计日志',
      targetType: 'audit-log', details: { retentionDays }
    }, () => audit.purgeExpired(retentionDays))
  })

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
    return audited({
      category: 'export', action: 'EXPORT_DATA', summary: '导出数据',
      targetType: 'file', targetName: basename(res.filePath),
      details: { bytes: Buffer.byteLength(opts.content, 'utf-8') }
    }, async () => {
      await writeFile(res.filePath!, opts.content, 'utf-8')
      return res.filePath!
    })
  })
}
