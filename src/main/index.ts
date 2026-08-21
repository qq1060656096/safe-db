import { app, BrowserWindow, Menu, screen, shell, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import { DriverManager } from './drivers/manager'
import { Executor } from './core/executor'
import { registerIpcHandlers } from './ipc'
import { AuditStore } from './store/audit'
import { ConnectionStore } from './store/connections'
import { QueryStore } from './store/queries'
import { WindowStateStore, type WindowBounds } from './store/windowState'
import { AgentServer } from './agent/server'
import { AgentService } from './agent/service'
import type { AgentApprovalRequest, WindowMode } from '../shared/types'

const PRODUCT_NAME = 'safe db'

// Electron 开发模式默认显示为“Electron”，显式设置产品名称以统一菜单栏与窗口名称。
app.setName(PRODUCT_NAME)

// 开发模式下固定开启 CDP 调试端口:electron-vite 在主进程改动后重启时会丢失
// 命令行传入的 --remote-debugging-port,这里直接写进 app,保证每次 (重)启都可用。
if (process.env.ELECTRON_RENDERER_URL) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

const windows = new Set<BrowserWindow>()
const windowStateTimers = new Map<number, ReturnType<typeof setTimeout>>()
let drivers: DriverManager | null = null
let agentServer: AgentServer | null = null
let agentService: AgentService | null = null
let windowStateStore: WindowStateStore | null = null

const MIN_WINDOW_WIDTH = 720
const MIN_WINDOW_HEIGHT = 560

function windowMode(window: BrowserWindow): WindowMode {
  if (window.isFullScreen()) return 'fullscreen'
  return window.isMaximized() ? 'maximized' : 'normal'
}

function restoredWindowBounds(): WindowBounds | undefined {
  const saved = windowStateStore?.get()
  const bounds = saved?.normalBounds
  if (!bounds) return undefined
  const displays = screen.getAllDisplays()
  const display = displays.find((item) => item.id === saved.displayId)
    ?? screen.getDisplayMatching(bounds)
    ?? screen.getPrimaryDisplay()
  const area = display.workArea
  const width = Math.min(area.width, Math.max(MIN_WINDOW_WIDTH, Math.round(bounds.width)))
  const height = Math.min(area.height, Math.max(MIN_WINDOW_HEIGHT, Math.round(bounds.height)))
  return {
    width,
    height,
    x: Math.min(area.x + area.width - width, Math.max(area.x, Math.round(bounds.x))),
    y: Math.min(area.y + area.height - height, Math.max(area.y, Math.round(bounds.y)))
  }
}

function persistWindowState(window: BrowserWindow): void {
  if (!windowStateStore || window.isDestroyed()) return
  const mode = windowMode(window)
  const display = screen.getDisplayMatching(window.getBounds())
  windowStateStore.update({
    lastMode: mode,
    displayId: display.id,
    ...(mode === 'normal' ? { normalBounds: window.getBounds() } : {})
  })
}

function scheduleWindowStatePersist(window: BrowserWindow): void {
  if (window.isDestroyed() || windowMode(window) !== 'normal') return
  const id = window.id
  const current = windowStateTimers.get(id)
  if (current) clearTimeout(current)
  windowStateTimers.set(id, setTimeout(() => {
    windowStateTimers.delete(id)
    persistWindowState(window)
  }, 250))
}

function notifyWindowMode(window: BrowserWindow): void {
  if (!window.webContents.isDestroyed()) window.webContents.send('window:modeChanged', windowMode(window))
}

function sendPendingAgentApprovals(window: BrowserWindow): void {
  if (!agentService || window.webContents.isDestroyed()) return
  for (const request of agentService.pendingApprovals()) {
    window.webContents.send('agent:approvalRequested', request)
  }
}

function installEditableContextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (_event, params) => {
    // Electron 不会为 CodeMirror 等可编辑区域自动提供右键菜单。
    // 仅处理可编辑控件，避免覆盖结果表格、侧边栏和标签页的自定义菜单。
    if (!params.isEditable) return

    const { editFlags } = params
    const menu = Menu.buildFromTemplate([
      { role: 'undo', enabled: editFlags.canUndo },
      { role: 'redo', enabled: editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: editFlags.canCut },
      { role: 'copy', enabled: editFlags.canCopy },
      { role: 'paste', enabled: editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: editFlags.canSelectAll }
    ])
    menu.popup({ window })
  })
}

function createWindow(sourceWindow?: BrowserWindow): BrowserWindow {
  const sourceBounds = sourceWindow?.getNormalBounds()
  const displayBounds = sourceBounds ? screen.getDisplayMatching(sourceBounds).workArea : undefined
  const restoredBounds = sourceWindow ? undefined : restoredWindowBounds()
  const x = sourceBounds && displayBounds
    ? Math.max(displayBounds.x, Math.min(sourceBounds.x + 28, displayBounds.x + displayBounds.width - sourceBounds.width))
    : restoredBounds?.x
  const y = sourceBounds && displayBounds
    ? Math.max(displayBounds.y, Math.min(sourceBounds.y + 28, displayBounds.y + displayBounds.height - sourceBounds.height))
    : restoredBounds?.y
  const restoreMode = sourceWindow ? 'normal' : windowStateStore?.get().lastMode ?? 'normal'
  const window = new BrowserWindow({
    width: sourceBounds?.width ?? restoredBounds?.width ?? 1440,
    height: sourceBounds?.height ?? restoredBounds?.height ?? 900,
    x,
    y,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
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
  installEditableContextMenu(window)
  window.webContents.on('did-finish-load', () => {
    sendPendingAgentApprovals(window)
    notifyWindowMode(window)
  })
  window.once('ready-to-show', () => {
    if (restoreMode === 'maximized') window.maximize()
    else if (restoreMode === 'fullscreen') window.setFullScreen(true)
    window.show()
  })

  const handleWindowModeChange = (): void => {
    persistWindowState(window)
    notifyWindowMode(window)
  }
  window.on('move', () => scheduleWindowStatePersist(window))
  window.on('resize', () => scheduleWindowStatePersist(window))
  window.on('maximize', handleWindowModeChange)
  window.on('unmaximize', handleWindowModeChange)
  window.on('enter-full-screen', handleWindowModeChange)
  window.on('leave-full-screen', handleWindowModeChange)

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

  window.on('close', () => {
    const timer = windowStateTimers.get(window.id)
    if (timer) clearTimeout(timer)
    windowStateTimers.delete(window.id)
    persistWindowState(window)
  })
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
    windowStateStore = new WindowStateStore()
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
