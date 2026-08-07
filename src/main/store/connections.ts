import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConnectionConfig, ConnectionImportResult, ConnectionMeta, DbType, PermissionMode, SshConfig } from '../../shared/types'

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function portValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535 ? value : fallback
}

function isDbType(value: unknown): value is DbType {
  return value === 'mysql' || value === 'postgres' || value === 'sqlite' || value === 'sqlserver'
    || value === 'mongodb' || value === 'redis'
}

const DEFAULT_PORTS: Record<Exclude<DbType, 'sqlite'>, number> = {
  mysql: 3306,
  postgres: 5432,
  sqlserver: 1433,
  mongodb: 27017,
  redis: 6379
}

const DEFAULT_USERS: Record<Exclude<DbType, 'sqlite'>, string> = {
  mysql: 'root',
  postgres: 'postgres',
  sqlserver: 'sa',
  mongodb: '',
  redis: ''
}

/**
 * 连接配置持久化:userData/connections.json
 * 密码用 Electron safeStorage(macOS Keychain / Windows DPAPI)加密后 base64 存储。
 */
export class ConnectionStore {
  private file: string
  private connections: ConnectionConfig[] = []

  constructor() {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'connections.json')
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) {
      this.connections = []
      return
    }
    try {
      this.connections = JSON.parse(readFileSync(this.file, 'utf-8')) as ConnectionConfig[]
    } catch {
      this.connections = []
    }
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.connections, null, 2), 'utf-8')
  }

  private encrypt(plain: string): string {
    if (!plain) return ''
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(plain).toString('base64')
    }
    throw new Error('系统安全存储不可用，无法安全保存密码')
  }

  private decrypt(stored: string): string {
    if (!stored) return ''
    if (stored.startsWith('enc:')) {
      try {
        return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
      } catch {
        return ''
      }
    }
    if (stored.startsWith('plain:')) return stored.slice(6)
    // 历史数据无前缀,按明文处理
    return stored
  }

  /** 新值非空则加密;为空(编辑留空)则保留已存值 */
  private resolveSecret(incoming: string | undefined, stored: string | undefined): string {
    if (incoming) return this.encrypt(incoming)
    return stored ?? ''
  }

  /** 脱敏后的列表项:去掉 DB 密码与 SSH 的密码/私钥口令 */
  private toMeta(c: ConnectionConfig): ConnectionMeta {
    const { password: _pw, ssh, ...rest } = c
    const meta: ConnectionMeta = { ...rest }
    if (ssh) {
      const { password: _sp, passphrase: _spp, ...sshMeta } = ssh
      meta.ssh = sshMeta
    }
    return meta
  }

  list(): ConnectionMeta[] {
    return this.connections.map((c) => this.toMeta(c))
  }

  /** 仅供导出使用：返回完整连接信息，凭据保持为 safeStorage 密文。 */
  listEncrypted(): ConnectionConfig[] {
    return this.connections.map((connection) => ({
      ...connection,
      ssh: connection.ssh ? { ...connection.ssh } : undefined
    }))
  }

  /** 只接受当前系统账户能够解密的 safeStorage 密文，绝不从导入文件接收明文凭据。 */
  private importedEncryptedSecret(value: unknown): string {
    if (typeof value !== 'string' || !value.startsWith('enc:')) return ''
    return this.decrypt(value) ? value : ''
  }

  /**
   * 导入 safe db 连接配置，也兼容直接以连接数组为根节点的旧版 JSON。
   * 只有当前系统账户能够解密的 safeStorage 密文才会恢复；明文密码始终被忽略。
   */
  importPortable(
    value: unknown,
    includeEncryptedSecrets = false
  ): Pick<ConnectionImportResult, 'imported' | 'skipped'> & { connectionIdMap: Map<string, string> } {
    const source = Array.isArray(value)
      ? value
      : isRecord(value) && Array.isArray(value.connections)
        ? value.connections
        : null
    if (!source) throw new Error('连接文件格式无效')

    const existingById = new Map(this.connections.map((connection) => [connection.id, connection]))
    const existingBySignature = new Map(this.connections.map((connection) => [this.connectionSignature(connection), connection]))
    const connectionIdMap = new Map<string, string>()
    let imported = 0
    let skipped = 0

    for (const item of source) {
      const connection = this.normalizeImportedConnection(item, includeEncryptedSecrets)
      if (!connection) {
        skipped += 1
        continue
      }
      const sourceId = isRecord(item) ? textValue(item.id) : undefined
      const signature = this.connectionSignature(connection)
      const sameId = existingById.get(connection.id)
      if (sameId) {
        if (this.connectionSignature(sameId) === signature && sourceId) connectionIdMap.set(sourceId, sameId.id)
        skipped += 1
        continue
      }
      const sameSignature = existingBySignature.get(signature)
      if (sameSignature) {
        if (sourceId) connectionIdMap.set(sourceId, sameSignature.id)
        skipped += 1
        continue
      }
      this.connections.push(connection)
      existingById.set(connection.id, connection)
      existingBySignature.set(signature, connection)
      connectionIdMap.set(sourceId ?? connection.id, connection.id)
      imported += 1
    }

    if (imported) this.persist()
    return { imported, skipped, connectionIdMap }
  }

  private connectionSignature(connection: ConnectionConfig): string {
    return JSON.stringify([
      connection.type,
      connection.name,
      connection.host ?? '',
      connection.port ?? '',
      connection.user ?? '',
      connection.database ?? '',
      connection.filePath ?? '',
      connection.authDatabase ?? '',
      connection.tls === true,
      connection.encrypt === true,
      connection.trustServerCertificate !== false
    ])
  }

  private normalizeImportedConnection(value: unknown, includeEncryptedSecrets: boolean): ConnectionConfig | null {
    if (!isRecord(value)) return null
    const type: DbType | undefined = isDbType(value.type) ? value.type : undefined
    const name = textValue(value.name)
    if (!type || !name) return null

    const permissionMode: PermissionMode = value.permissionMode === 'approval' || value.permissionMode === 'full'
      ? value.permissionMode
      : 'readonly'
    const permissionModeLocked = value.permissionModeLocked === true
    const id = textValue(value.id) ?? randomUUID()
    const color = textValue(value.color)

    if (type === 'sqlite') {
      const filePath = textValue(value.filePath)
      if (!filePath) return null
      return { id, name, type, permissionMode, permissionModeLocked, color, filePath, password: '' }
    }

    const defaultPort = DEFAULT_PORTS[type]
    const ssh = this.normalizeImportedSsh(value.ssh, includeEncryptedSecrets)
    return {
      id,
      name,
      type,
      permissionMode,
      permissionModeLocked,
      color,
      host: textValue(value.host) ?? '127.0.0.1',
      port: portValue(value.port, defaultPort),
      user: textValue(value.user) ?? DEFAULT_USERS[type],
      password: includeEncryptedSecrets ? this.importedEncryptedSecret(value.password) : '',
      database: textValue(value.database),
      authDatabase: type === 'mongodb' ? textValue(value.authDatabase) : undefined,
      tls: (type === 'mongodb' || type === 'redis') ? value.tls === true : undefined,
      encrypt: type === 'sqlserver' ? value.encrypt === true : undefined,
      trustServerCertificate: type === 'sqlserver' ? value.trustServerCertificate !== false : undefined,
      ssh
    }
  }

  private normalizeImportedSsh(value: unknown, includeEncryptedSecrets: boolean): SshConfig | undefined {
    if (!isRecord(value) || value.enabled !== true) return undefined
    const host = textValue(value.host)
    const user = textValue(value.user)
    if (!host || !user) return undefined
    const authType = value.authType === 'privateKey' ? 'privateKey' : 'password'
    return {
      enabled: true,
      host,
      port: portValue(value.port, 22),
      user,
      authType,
      privateKeyPath: authType === 'privateKey' ? textValue(value.privateKeyPath) : undefined,
      password: includeEncryptedSecrets ? this.importedEncryptedSecret(value.password) : '',
      passphrase: includeEncryptedSecrets ? this.importedEncryptedSecret(value.passphrase) : ''
    }
  }

  get(id: string): ConnectionConfig | undefined {
    const c = this.connections.find((x) => x.id === id)
    if (!c) return undefined
    return {
      ...c,
      password: this.decrypt(c.password ?? ''),
      ssh: c.ssh
        ? {
            ...c.ssh,
            password: this.decrypt(c.ssh.password ?? ''),
            passphrase: this.decrypt(c.ssh.passphrase ?? '')
          }
        : undefined
    }
  }

  /**
   * 保存连接。编辑已有连接且 password 为空字符串时,保留原密码;
   * SSH 的密码 / 私钥口令同理。
   */
  save(cfg: ConnectionConfig): ConnectionMeta {
    const existing = this.connections.find((x) => x.id === cfg.id)
    const permissionModeLocked = cfg.permissionModeLocked ?? existing?.permissionModeLocked ?? false
    const permissionMode = existing?.permissionModeLocked && permissionModeLocked
      ? existing.permissionMode
      : cfg.permissionMode
    const record: ConnectionConfig = {
      ...cfg,
      id: cfg.id || randomUUID(),
      permissionMode,
      permissionModeLocked,
      password: this.resolveSecret(cfg.password, existing?.password),
      ssh: cfg.ssh
        ? {
            ...cfg.ssh,
            password: this.resolveSecret(cfg.ssh.password, existing?.ssh?.password),
            passphrase: this.resolveSecret(cfg.ssh.passphrase, existing?.ssh?.passphrase)
          }
        : undefined
    }
    if (existing) {
      Object.assign(existing, record)
    } else {
      this.connections.push(record)
    }
    this.persist()
    return this.toMeta(record)
  }

  /**
   * 复制连接时直接复用已加密的凭据，避免将密码暴露给渲染进程。
   * 新连接使用独立 id，后续编辑不会影响原连接。
   */
  duplicate(id: string, name: string): ConnectionMeta {
    const source = this.connections.find((connection) => connection.id === id)
    if (!source) throw new Error('连接不存在或已被删除')
    const copiedName = name.trim()
    if (!copiedName) throw new Error('连接名称不能为空')
    const record: ConnectionConfig = {
      ...source,
      id: randomUUID(),
      name: copiedName,
      ssh: source.ssh ? { ...source.ssh } : undefined
    }
    this.connections.push(record)
    this.persist()
    return this.toMeta(record)
  }

  /** 测试连接时合并已存密码与 SSH 密钥(编辑场景下留空) */
  mergePasswordForTest(cfg: ConnectionConfig): ConnectionConfig {
    const existing = cfg.id ? this.connections.find((x) => x.id === cfg.id) : undefined
    if (!existing) return cfg
    return {
      ...cfg,
      password: cfg.password || this.decrypt(existing.password ?? ''),
      ssh: cfg.ssh
        ? {
            ...cfg.ssh,
            password: cfg.ssh.password || this.decrypt(existing.ssh?.password ?? ''),
            passphrase: cfg.ssh.passphrase || this.decrypt(existing.ssh?.passphrase ?? '')
          }
        : undefined
    }
  }

  delete(id: string): void {
    this.connections = this.connections.filter((x) => x.id !== id)
    this.persist()
  }
}
