import type { ConnectionConfig, DriverCapabilities } from '../../shared/types'
import { SshTunnelManager } from '../ssh/tunnel'
import type { DbDriver } from './base'
import { MysqlDriver } from './mysql'
import { PostgresDriver } from './postgres'
import { SqliteDriver } from './sqlite'
import { SqlServerDriver } from './sqlserver'
import { MongoDriver } from './mongodb'
import { RedisDriver } from './redis'
import { QdrantDriver } from './qdrant'
import { capabilitiesForType } from './capabilities'

/** 数据库实际接入点;启用 SSH 隧道时为 127.0.0.1:本地转发端口 */
export interface DbEndpoint {
  host: string
  port: number
}

export function createDriver(cfg: ConnectionConfig, endpoint?: DbEndpoint): DbDriver {
  switch (cfg.type) {
    case 'mysql':
      return new MysqlDriver({
        host: endpoint?.host ?? cfg.host ?? '127.0.0.1',
        port: endpoint?.port ?? cfg.port ?? 3306,
        user: cfg.user ?? 'root',
        password: cfg.password,
        database: cfg.database
      })
    case 'postgres':
      return new PostgresDriver({
        host: endpoint?.host ?? cfg.host ?? '127.0.0.1',
        port: endpoint?.port ?? cfg.port ?? 5432,
        user: cfg.user ?? 'postgres',
        password: cfg.password,
        database: cfg.database
      })
    case 'sqlite':
      if (!cfg.filePath) throw new Error('SQLite 连接缺少文件路径')
      return new SqliteDriver(cfg.filePath)
    case 'sqlserver':
      return new SqlServerDriver({
        host: endpoint?.host ?? cfg.host ?? '127.0.0.1',
        port: endpoint?.port ?? cfg.port ?? 1433,
        user: cfg.user ?? 'sa',
        password: cfg.password,
        database: cfg.database,
        encrypt: cfg.encrypt,
        trustServerCertificate: cfg.trustServerCertificate
      })
    case 'mongodb':
      return new MongoDriver({
        host: endpoint?.host ?? cfg.host ?? '127.0.0.1',
        port: endpoint?.port ?? cfg.port ?? 27017,
        user: cfg.user,
        password: cfg.password,
        database: cfg.database,
        authDatabase: cfg.authDatabase,
        tls: cfg.tls
      })
    case 'redis':
      return new RedisDriver({
        host: endpoint?.host ?? cfg.host ?? '127.0.0.1',
        port: endpoint?.port ?? cfg.port ?? 6379,
        user: cfg.user,
        password: cfg.password,
        database: cfg.database,
        tls: cfg.tls
      })
    case 'qdrant':
      return new QdrantDriver({
        host: endpoint?.host ?? cfg.host ?? '127.0.0.1',
        port: endpoint?.port ?? cfg.port ?? 6333,
        apiKey: cfg.apiKey,
        // SSH 只做 TCP 转发，不得静默降级用户选择的 HTTPS。
        tls: cfg.tls,
        timeoutMs: cfg.timeoutMs
      })
    default:
      throw new Error(`不支持的数据库类型：${String((cfg as { type?: unknown }).type ?? '未指定')}`)
  }
}

/** 连接 id → 活跃驱动 + 该连接的 SSH 隧道。配置变更(保存)后需调用 invalidate 重建。 */
export class DriverManager {
  private drivers = new Map<string, DbDriver>()
  /** 连接建立中的 Promise。避免双击/多窗口同时请求时为同一配置创建多个驱动。 */
  private connecting = new Map<string, Promise<DbDriver>>()
  /** 连接关闭期间阻止新的 get 复用正在退出的驱动。 */
  private invalidating = new Map<string, Promise<void>>()
  private tunnels = new SshTunnelManager()

  constructor(
    private getConfig: (id: string) => ConnectionConfig | undefined,
    private driverFactory: typeof createDriver = createDriver
  ) {}

  async get(id: string): Promise<DbDriver> {
    const invalidating = this.invalidating.get(id)
    if (invalidating) {
      await invalidating
      return this.get(id)
    }

    const connecting = this.connecting.get(id)
    if (connecting) return connecting

    const existing = this.drivers.get(id)
    if (existing) {
      // 驱动仍在缓存中不代表底层会话仍可用（例如 MySQL 空闲超时后会进入 closed state）。
      // connect 对各驱动均为幂等操作，并会在需要时恢复底层连接。
      return this.reconnectDriver(id, existing)
    }

    const cfg = this.getConfig(id)
    if (!cfg) throw new Error('连接不存在')

    const connection = (async (): Promise<DbDriver> => {
      // 启用 SSH 隧道时,先建立隧道,再让驱动连本地转发端口
      let endpoint: DbEndpoint | undefined
      if (cfg.type !== 'sqlite' && cfg.ssh?.enabled) {
        const t = await this.tunnels.ensure(cfg)
        endpoint = { host: '127.0.0.1', port: t.localPort }
      }
      const driver = this.driverFactory(cfg, endpoint)
      try {
        await driver.connect()
      } catch (e) {
        // 建库连接失败时把刚起的隧道也收掉,避免悬挂
        if (endpoint) await this.tunnels.close(id)
        throw e
      }
      this.drivers.set(id, driver)
      return driver
    })()
    this.connecting.set(id, connection)
    try {
      return await connection
    } finally {
      if (this.connecting.get(id) === connection) this.connecting.delete(id)
    }
  }

  private async reconnectDriver(id: string, driver: DbDriver): Promise<DbDriver> {
    const connection = (async (): Promise<DbDriver> => {
      try {
        await driver.connect()
        return driver
      } catch (error) {
        if (this.drivers.get(id) === driver) this.drivers.delete(id)
        await driver.disconnect().catch(() => {})
        await this.tunnels.close(id)
        throw error
      }
    })()
    this.connecting.set(id, connection)
    try {
      return await connection
    } finally {
      if (this.connecting.get(id) === connection) this.connecting.delete(id)
    }
  }

  /** 断开单个连接:关驱动,并连带关掉它自己的 SSH 隧道(不影响其它连接) */
  async invalidate(id: string): Promise<void> {
    const current = this.invalidating.get(id)
    if (current) return current

    const invalidation = (async (): Promise<void> => {
      // 连接若还在建立中，等它落入 drivers 后一并关闭，避免断开后又被异步写回缓存。
      await this.connecting.get(id)?.catch(() => {})
      const d = this.drivers.get(id)
      if (d) {
        // 先从可用驱动中摘除，避免关闭期间新请求继续进入这条连接的队列。
        this.drivers.delete(id)
        await d.disconnect().catch(() => {})
      }
      await this.tunnels.close(id)
    })()
    this.invalidating.set(id, invalidation)
    try {
      await invalidation
    } finally {
      if (this.invalidating.get(id) === invalidation) this.invalidating.delete(id)
    }
  }

  /** 停止当前连接正在执行的查询，只摘除这一条连接，不影响其它连接。 */
  async cancel(id: string): Promise<boolean> {
    const driver = this.drivers.get(id)
    if (!driver) return false
    this.drivers.delete(id)
    if (driver.cancel) await driver.cancel().catch(() => {})
    else await driver.disconnect().catch(() => {})
    await this.tunnels.close(id)
    return true
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.connecting.values()].map((connection) => connection.catch(() => undefined)))
    await Promise.all([...this.drivers.values()].map((d) => d.disconnect().catch(() => {})))
    this.drivers.clear()
    this.connecting.clear()
    await this.tunnels.closeAll()
  }

  isConnected(id: string): boolean {
    return this.drivers.has(id)
  }

  /** 获取能力不建立远程连接，菜单和空状态也能稳定按能力渲染。 */
  capabilities(id: string): DriverCapabilities {
    const cfg = this.getConfig(id)
    if (!cfg) throw new Error('连接不存在')
    return this.drivers.get(id)?.capabilities ?? capabilitiesForType(cfg.type)
  }
}
