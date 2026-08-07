import type { ConnectionConfig } from '../../shared/types'
import { SshTunnelManager } from '../ssh/tunnel'
import type { DbDriver } from './base'
import { MysqlDriver } from './mysql'
import { PostgresDriver } from './postgres'
import { SqliteDriver } from './sqlite'
import { SqlServerDriver } from './sqlserver'
import { MongoDriver } from './mongodb'
import { RedisDriver } from './redis'

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
    default:
      throw new Error(`不支持的数据库类型：${String((cfg as { type?: unknown }).type ?? '未指定')}`)
  }
}

/** 连接 id → 活跃驱动 + 该连接的 SSH 隧道。配置变更(保存)后需调用 invalidate 重建。 */
export class DriverManager {
  private drivers = new Map<string, DbDriver>()
  private tunnels = new SshTunnelManager()

  constructor(private getConfig: (id: string) => ConnectionConfig | undefined) {}

  async get(id: string): Promise<DbDriver> {
    const existing = this.drivers.get(id)
    if (existing) return existing
    const cfg = this.getConfig(id)
    if (!cfg) throw new Error('连接不存在')
    // 启用 SSH 隧道时,先建立隧道,再让驱动连本地转发端口
    let endpoint: DbEndpoint | undefined
    if (cfg.type !== 'sqlite' && cfg.ssh?.enabled) {
      const t = await this.tunnels.ensure(cfg)
      endpoint = { host: '127.0.0.1', port: t.localPort }
    }
    const driver = createDriver(cfg, endpoint)
    try {
      await driver.connect()
    } catch (e) {
      // 建库连接失败时把刚起的隧道也收掉,避免悬挂
      if (endpoint) await this.tunnels.close(id)
      throw e
    }
    this.drivers.set(id, driver)
    return driver
  }

  /** 断开单个连接:关驱动,并连带关掉它自己的 SSH 隧道(不影响其它连接) */
  async invalidate(id: string): Promise<void> {
    const d = this.drivers.get(id)
    if (d) {
      // 先从可用驱动中摘除，避免关闭期间新请求继续进入这条连接的队列。
      this.drivers.delete(id)
      await d.disconnect().catch(() => {})
    }
    await this.tunnels.close(id)
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
    await Promise.all([...this.drivers.values()].map((d) => d.disconnect().catch(() => {})))
    this.drivers.clear()
    await this.tunnels.closeAll()
  }

  isConnected(id: string): boolean {
    return this.drivers.has(id)
  }
}
