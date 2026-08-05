import type { ConnectionConfig } from '../../shared/types'
import { SshTunnelManager } from '../ssh/tunnel'
import type { DbDriver } from './base'
import { MysqlDriver } from './mysql'
import { PostgresDriver } from './postgres'
import { SqliteDriver } from './sqlite'

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
      await d.disconnect().catch(() => {})
      this.drivers.delete(id)
    }
    await this.tunnels.close(id)
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
