import { app, BrowserWindow, Menu, screen, shell, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import { DriverManager } from './drivers/manager'
import { Executor } from './core/executor'
import { registerIpcHandlers } from './ipc'
import { AuditStore } from './store/audit'
import { ConnectionStore } from './store/connections'
import { QueryStore } from './store/queries'
import { AgentServer } from './agent/server'
import { AgentService } from './agent/service'
import type { AgentApprovalRequest } from '../shared/types'

const PRODUCT_NAME = 'safe db'

// Electron 开发模式默认显示为“Electron”，显式设置产品名称以统一菜单栏与窗口名称。
app.setName(PRODUCT_NAME)

// 开发模式下固定开启 CDP 调试端口:electron-vite 在主进程改动后重启时会丢失
// 命令行传入的 --remote-debugging-port,这里直接写进 app,保证每次 (重)启都可用。
if (process.env.ELECTRON_RENDERER_URL) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

const windows = new Set<BrowserWindow>()
let drivers: DriverManager | null = null
let agentServer: AgentServer | null = null
let agentService: AgentService | null = null

function sendPendingAgentApprovals(window: BrowserWindow): void {
  if (!agentService || window.webContents.isDestroyed()) return
  for (const request of agentService.pendingApprovals()) {
    window.webContents.send('agent:approvalRequested', request)
  }
}

function createWindow(sourceWindow?: BrowserWindow): BrowserWindow {
  const sourceBounds = sourceWindow?.getNormalBounds()
  const displayBounds = sourceBounds ? screen.getDisplayMatching(sourceBounds).workArea : undefined
  const x = sourceBounds && displayBounds
    ? Math.max(displayBounds.x, Math.min(sourceBounds.x + 28, displayBounds.x + displayBounds.width - sourceBounds.width))
    : undefined
  const y = sourceBounds && displayBounds
    ? Math.max(displayBounds.y, Math.min(sourceBounds.y + 28, displayBounds.y + displayBounds.height - sourceBounds.height))
    : undefined
  const window = new BrowserWindow({
    width: sourceBounds?.width ?? 1440,
    height: sourceBounds?.height ?? 900,
    x,
    y,
    minWidth: 720,
    minHeight: 560,
    title: PRODUCT_NAME,
    backgroundColor: '#1f1f1f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  })
  windows.add(window)
  window.webContents.on('did-finish-load', () => sendPendingAgentApprovals(window))

  // 外链交给系统浏览器
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
    window.webContents.openDevTools({ mode: 'detach' })
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  window.on('closed', () => windows.delete(window))
  return window
}

function notifyAgentApproval(request: AgentApprovalRequest): void {
  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (target && !target.webContents.isDestroyed()) {
    target.webContents.send('agent:approvalRequested', request)
    return
  }
  // 后台服务收到写操作时打开桌面窗口，确保审批必须由用户完成。
  createWindow()
}

function installApplicationMenu(): void {
  const useChinese = app.getLocale().toLowerCase().startsWith('zh')
  const template: MenuItemConstructorOptions[] = []

  if (process.platform === 'darwin') {
    template.push({
      // 开发模式的应用包仍叫 Electron，菜单名称必须显式指定产品名。
      label: PRODUCT_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }

  template.push(
    {
      label: useChinese ? '文件' : 'File',
      submenu: [
        {
          label: useChinese ? '新建窗口' : 'New Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => createWindow(BrowserWindow.getFocusedWindow() ?? undefined)
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  )

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (app.isReady()) createWindow(BrowserWindow.getFocusedWindow() ?? undefined)
    else void app.whenReady().then(() => createWindow())
  })

  void app.whenReady().then(async () => {
    // app ready 时再设置一次，避免开发模式的 Electron bundle 覆盖名称。
    app.setName(PRODUCT_NAME)
    const connections = new ConnectionStore()
    const queries = new QueryStore()
    const audit = new AuditStore()
    drivers = new DriverManager((id) => connections.get(id))
    const executor = new Executor(connections, drivers, audit)
    executor.onMetadataChanged((connectionId) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.webContents.isDestroyed()) window.webContents.send('metadata:changed', connectionId)
      }
    })
    agentService = new AgentService(connections, drivers, executor, notifyAgentApproval)
    agentServer = new AgentServer(app.getPath('userData'), agentService)
    await agentServer.start()
    registerIpcHandlers(
      { connections, queries, audit, drivers, executor },
      (sourceWindow) => createWindow(sourceWindow)
    )

    installApplicationMenu()
    if (!process.argv.includes('--agent-headless')) createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', (e) => {
    // 退出前优雅关闭所有数据库连接(MySQL 结束会话、PG 断开 client、SQLite close)。
    // 先摘出引用并置空避免二次触发,disconnectAll 完成后直接 exit。
    const d = drivers
    const server = agentServer
    if (d || server) {
      drivers = null
      agentServer = null
      agentService = null
      e.preventDefault()
      void Promise.all([
        d?.disconnectAll() ?? Promise.resolve(),
        server?.close() ?? Promise.resolve()
      ]).finally(() => app.exit(0))
    }
  })
}
