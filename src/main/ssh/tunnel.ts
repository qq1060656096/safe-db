import { readFileSync } from 'node:fs'
import net from 'node:net'
import { Client } from 'ssh2'
import type { ConnectionConfig } from '../../shared/types'

export interface TunnelHandle {
  /** 本地转发端口(127.0.0.1:localPort → 目标库) */
  localPort: number
  /** SSH 会话和本地监听仍可用 */
  isActive(): boolean
  close(): Promise<void>
}

/**
 * 建立一条 SSH 隧道:本地 127.0.0.1 上的临时端口监听,
 * 每个进入的连接都经 SSH forwardOut 转发到「SSH 服务器视角下的」目标库 host:port。
 * 目标库的地址(cfg.host/cfg.port)由跳板机解析,因此可以连到本机直连不到的内网库。
 */
export function establishTunnel(cfg: ConnectionConfig): Promise<TunnelHandle> {
  const ssh = cfg.ssh
  if (!ssh?.enabled) return Promise.reject(new Error('该连接未启用 SSH 隧道'))
  if (!ssh.host) return Promise.reject(new Error('请填写 SSH 主机'))

  return new Promise<TunnelHandle>((resolve, reject) => {
    const client = new Client()
    let server: net.Server | null = null
    let settled = false
    let sshConnected = false
    let active = false
    let closePromise: Promise<void> | null = null
    const sockets = new Set<net.Socket>()

    const stopLocalForwarding = (): void => {
      active = false
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      if (server?.listening) server.close()
    }

    const close = (): Promise<void> => {
      if (closePromise) return closePromise
      active = false
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      closePromise = new Promise<void>((res) => {
        if (!server?.listening) {
          res()
          return
        }
        server.close(() => res())
      })
      client.end()
      return closePromise
    }

    const fail = (msg: string): void => {
      if (settled) return
      settled = true
      stopLocalForwarding()
      client.end()
      reject(new Error(msg))
    }

    client.on('ready', () => {
      sshConnected = true
      server = net.createServer((socket) => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
        if (!active) {
          socket.destroy()
          return
        }

        try {
          client.forwardOut(
            socket.remoteAddress ?? '127.0.0.1',
            socket.remotePort ?? 0,
            cfg.host ?? '127.0.0.1',
            cfg.port ?? ({ mysql: 3306, postgres: 5432, sqlite: 0, sqlserver: 1433, mongodb: 27017, redis: 6379, qdrant: 6333 }[cfg.type] ?? 0),
            (err, stream) => {
              if (err || !active) {
                stream?.destroy()
                socket.destroy()
                return
              }
              socket.once('close', () => stream.destroy())
              stream.once('close', () => socket.destroy())
              socket.pipe(stream).pipe(socket)
              socket.on('error', () => stream.destroy())
              stream.on('error', () => socket.destroy())
            }
          )
        } catch {
          // ssh2 在会话已断开时会同步抛出 "Not connected"，
          // 这里必须把它收敛为本地 socket 失败，不能让 Electron 主进程崩溃。
          socket.destroy()
        }
      })
      server.on('error', (e) => {
        if (!settled) fail(`隧道本地监听失败:${e.message}`)
        else stopLocalForwarding()
      })
      // 端口 0 = 让操作系统分配空闲端口
      server.listen(0, '127.0.0.1', () => {
        const addr = server?.address()
        if (!addr || typeof addr === 'string') {
          fail('隧道本地端口分配失败')
          return
        }
        if (!sshConnected) {
          fail('SSH 连接在隧道建立前已断开')
          return
        }
        active = true
        settled = true
        resolve({
          localPort: addr.port,
          isActive: () => active,
          close
        })
      })
    })
    client.on('error', (e) => {
      sshConnected = false
      if (!settled) fail(`SSH 连接失败:${e.message}`)
      else stopLocalForwarding()
    })
    const handleDisconnect = (): void => {
      sshConnected = false
      if (!settled) fail('SSH 连接在隧道建立前已断开')
      else stopLocalForwarding()
    }
    client.on('end', handleDisconnect)
    client.on('close', handleDisconnect)

    // 认证方式:密码 / 私钥(可选口令)
    const auth: Parameters<Client['connect']>[0] = {
      host: ssh.host,
      port: ssh.port || 22,
      username: ssh.user,
      readyTimeout: 15000,
      // 定期探测 SSH 会话，避免隧道在空闲或网络切换后长期处于半断开状态。
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3
    }
    if (ssh.authType === 'privateKey') {
      if (!ssh.privateKeyPath) {
        fail('请选择 SSH 私钥文件')
        return
      }
      try {
        auth.privateKey = readFileSync(ssh.privateKeyPath)
      } catch (e) {
        fail(`读取私钥失败:${e instanceof Error ? e.message : String(e)}`)
        return
      }
      if (ssh.passphrase) auth.passphrase = ssh.passphrase
    } else {
      auth.password = ssh.password ?? ''
    }
    client.connect(auth)
  })
}

/** 连接 id → 该连接的活跃 SSH 隧道;断开单个连接时只关它自己的隧道 */
export class SshTunnelManager {
  private tunnels = new Map<string, TunnelHandle>()

  /** 复用或新建隧道 */
  async ensure(cfg: ConnectionConfig): Promise<TunnelHandle> {
    const existing = this.tunnels.get(cfg.id)
    if (existing?.isActive()) return existing
    if (existing) {
      this.tunnels.delete(cfg.id)
      await existing.close().catch(() => {})
    }
    const t = await establishTunnel(cfg)
    this.tunnels.set(cfg.id, t)
    return t
  }

  isActive(id: string): boolean {
    return this.tunnels.get(id)?.isActive() === true
  }

  async close(id: string): Promise<void> {
    const t = this.tunnels.get(id)
    if (t) {
      await t.close().catch(() => {})
      this.tunnels.delete(id)
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.tunnels.values()].map((t) => t.close().catch(() => {})))
    this.tunnels.clear()
  }
}
