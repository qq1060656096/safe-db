import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { DriverManager } from './drivers/manager'
import { Executor } from './core/executor'
import { registerIpcHandlers } from './ipc'
import { AuditStore } from './store/audit'
import { ConnectionStore } from './store/connections'
import { QueryStore } from './store/queries'

// 开发模式下固定开启 CDP 调试端口:electron-vite 在主进程改动后重启时会丢失
// 命令行传入的 --remote-debugging-port,这里直接写进 app,保证每次 (重)启都可用。
if (process.env.ELECTRON_RENDERER_URL) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

let mainWindow: BrowserWindow | null = null
let drivers: DriverManager | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 560,
    title: 'safe-db',
    backgroundColor: '#1f1f1f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  })

  // 外链交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(() => {
    const connections = new ConnectionStore()
    const queries = new QueryStore()
    const audit = new AuditStore()
    drivers = new DriverManager((id) => connections.get(id))
    const executor = new Executor(connections, drivers, audit)
    registerIpcHandlers({ connections, queries, audit, drivers, executor }, () => mainWindow)

    createWindow()

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
    if (d) {
      drivers = null
      e.preventDefault()
      void d.disconnectAll().finally(() => app.exit(0))
    }
  })
}
