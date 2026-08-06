import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import type { AgentService } from './service'
import { AgentServiceError } from './service'
import {
  AGENT_PROTOCOL_VERSION,
  type AgentMethod,
  type AgentRequestEnvelope,
  type AgentResponseEnvelope
} from './types'

const MAX_REQUEST_BYTES = 2 * 1024 * 1024

export function agentSocketPath(userDataPath: string): string {
  if (process.env.SAFE_DB_AGENT_SOCKET) return process.env.SAFE_DB_AGENT_SOCKET
  return process.platform === 'win32' ? '\\\\.\\pipe\\safe-db-agent' : join(userDataPath, 'agent.sock')
}

function errorResponse(requestId: string, error: unknown): AgentResponseEnvelope {
  const known = error instanceof AgentServiceError
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    requestId,
    status: 'error',
    error: {
      code: known ? error.code : 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : String(error),
      retryable: known ? error.retryable : false,
      details: known ? error.details : undefined
    }
  }
}

export class AgentServer {
  private server: Server | null = null
  private readonly socketPath: string

  constructor(userDataPath: string, private service: AgentService) {
    this.socketPath = agentSocketPath(userDataPath)
  }

  async start(): Promise<void> {
    if (this.server) return
    if (process.platform !== 'win32' && existsSync(this.socketPath)) unlinkSync(this.socketPath)
    this.server = createServer((socket) => this.handleSocket(socket))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.socketPath, () => {
        this.server!.off('error', reject)
        resolve()
      })
    })
    if (process.platform !== 'win32') chmodSync(this.socketPath, 0o600)
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    if (process.platform !== 'win32' && existsSync(this.socketPath)) unlinkSync(this.socketPath)
  }

  private handleSocket(socket: Socket): void {
    socket.setEncoding('utf8')
    let input = ''
    socket.on('data', (chunk: string) => {
      input += chunk
      if (Buffer.byteLength(input, 'utf8') > MAX_REQUEST_BYTES) {
        this.write(socket, errorResponse('unknown', new AgentServiceError('REQUEST_TOO_LARGE', '请求不能超过 2 MB')))
        return
      }
      const newline = input.indexOf('\n')
      if (newline < 0) return
      const line = input.slice(0, newline)
      input = ''
      void this.handleLine(socket, line)
    })
    socket.on('error', () => {})
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let requestId = 'unknown'
    try {
      const value = JSON.parse(line) as Partial<AgentRequestEnvelope>
      if (typeof value.requestId === 'string') requestId = value.requestId
      if (value.protocolVersion !== AGENT_PROTOCOL_VERSION) {
        throw new AgentServiceError('PROTOCOL_VERSION_MISMATCH', 'CLI 与 safe db 协议版本不兼容')
      }
      if (typeof value.method !== 'string' || !value.params || typeof value.params !== 'object') {
        throw new AgentServiceError('INVALID_REQUEST', '请求格式无效')
      }
      const result = await this.service.handle(value.method as AgentMethod, value.params as Record<string, unknown>)
      this.write(socket, {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        requestId,
        status: result.status,
        data: result.data,
        warnings: result.warnings
      })
    } catch (error) {
      this.write(socket, errorResponse(requestId, error))
    }
  }

  private write(socket: Socket, response: AgentResponseEnvelope): void {
    socket.end(JSON.stringify(response) + '\n')
  }
}
