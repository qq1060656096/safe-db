import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

export type ExecutionProtocol = 'sql' | 'mongodb' | 'redis' | 'http' | 'driver'
export type ExecutionTraceStatus = 'success' | 'error' | 'canceled' | 'timeout'

export interface ExecutionTraceSensitiveContent {
  statement?: string
  parameters?: unknown[]
  parameterTypes?: string[]
  command?: unknown
  httpMethod?: string
  requestPath?: string
  requestBody?: unknown
}

export interface ExecutionTraceRecord {
  id: string
  operationId: string
  spanId: string
  parentSpanId?: string | null
  sequence: number
  attempt: number
  protocol: ExecutionProtocol
  driverType: string
  commandName: string
  databaseName?: string | null
  status: ExecutionTraceStatus
  returnedRows?: number | null
  matchedRows?: number | null
  affectedRows?: number | null
  responseBytes?: number | null
  errorCode?: string | null
  errorMessage?: string | null
  startedAt: string
  finishedAt: string
  durationMs: number
  sensitive: ExecutionTraceSensitiveContent
}

export interface ExecutionTraceRecorder {
  recordExecutionTrace(record: ExecutionTraceRecord): void
}

interface OperationContext {
  operationId: string
  nextSequence: number
}

export interface ExecutionMetrics {
  returnedRows?: number | null
  matchedRows?: number | null
  affectedRows?: number | null
  responseBytes?: number | null
}

export interface ExecutionTraceInput {
  protocol: ExecutionProtocol
  driverType: string
  commandName: string
  databaseName?: string | null
  attempt?: number
  parentSpanId?: string | null
  sensitive: ExecutionTraceSensitiveContent
}

export interface ExternalExecutionHandle {
  record: Omit<ExecutionTraceRecord, 'status' | 'finishedAt' | 'durationMs' | 'returnedRows' | 'matchedRows' | 'affectedRows' | 'responseBytes' | 'errorCode' | 'errorMessage'>
  started: number
}

const storage = new AsyncLocalStorage<OperationContext>()
let recorder: ExecutionTraceRecorder | null = null

const CREDENTIAL_KEYS = /^(?:(?:db|database|ssh|user)?[-_]?password|passwd|pwd|passphrase|(?:x[-_])?api[-_]?key|authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|(?:access|refresh|session|id)?[-_]?token|private[-_]?key|client[-_]?secret|speculative[-_]?authenticate|sasl[-_]?payload)$/i

function parameterType(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Buffer.isBuffer(value)) return 'buffer'
  if (value instanceof Date) return 'date'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function serializable(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value ?? null
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'object') return value
  if (Buffer.isBuffer(value)) return { type: 'Buffer', base64: value.toString('base64') }
  if (value instanceof Date) return value.toISOString()
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) {
    const result = value.map((item) => serializable(item, seen))
    seen.delete(value)
    return result
  }
  const result = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    CREDENTIAL_KEYS.test(key) ? '[REDACTED]' : serializable(item, seen)
  ]))
  seen.delete(value)
  return result
}

function scrubPath(value: string | undefined): string | undefined {
  if (!value || !value.includes('?')) return value
  try {
    const url = new URL(value, 'http://safe-db.local')
    if (url.username) url.username = '[REDACTED]'
    if (url.password) url.password = '[REDACTED]'
    for (const key of [...url.searchParams.keys()]) {
      if (CREDENTIAL_KEYS.test(key)) url.searchParams.set(key, '[REDACTED]')
    }
    url.pathname = url.pathname.replace(
      /\/(api[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?token|authorization|private[-_]?key)\/[^/]+/gi,
      '/$1/[REDACTED]'
    )
    return value.startsWith('http://') || value.startsWith('https://')
      ? url.toString()
      : `${url.pathname}${url.search}`
  } catch {
    return value
  }
}

function scrubStatement(value: string | undefined): { statement?: string; containsCredential: boolean } {
  if (value === undefined) return { containsCredential: false }
  const marker = /\b(?:PASSWORD|PASSWD|IDENTIFIED\s+BY|AUTHENTICATE|LOGIN|API[_ -]?KEY|AUTHORIZATION|ACCESS[_ -]?TOKEN|REFRESH[_ -]?TOKEN|SESSION[_ -]?TOKEN|PRIVATE[_ -]?KEY|CLIENT[_ -]?SECRET|CREDENTIALS?)\b/i
  if (!marker.test(value)) return { statement: value, containsCredential: false }
  const statement = value.replace(
    /(\b(?:PASSWORD|PASSWD|IDENTIFIED\s+BY|AUTHENTICATE|LOGIN|API[_ -]?KEY|AUTHORIZATION|ACCESS[_ -]?TOKEN|REFRESH[_ -]?TOKEN|SESSION[_ -]?TOKEN|PRIVATE[_ -]?KEY|CLIENT[_ -]?SECRET|CREDENTIALS?)\b\s*(?:(?:=|TO)\s*)?)('(?:''|[^'])*'|"(?:""|[^"])*"|[^\s,;)]+)/gi,
    (_match, prefix: string, candidate: string) => /^[?$@:][\w$]*$/.test(candidate)
      ? `${prefix}${candidate}`
      : `${prefix}[REDACTED]`
  )
  return { statement, containsCredential: true }
}

/** 认证凭据永不进入持久化层；其他业务敏感数据保留原值并由存储层加密。 */
export function sanitizeSensitiveContent(content: ExecutionTraceSensitiveContent): ExecutionTraceSensitiveContent {
  const statement = scrubStatement(content.statement)
  const rawCommand = serializable(content.command)
  const command = Array.isArray(rawCommand) && /^(?:AUTH|HELLO)$/i.test(String(rawCommand[0] ?? ''))
    ? [rawCommand[0], '[REDACTED]']
    : rawCommand
  return {
    ...(statement.statement === undefined ? {} : { statement: statement.statement }),
    ...(content.parameters === undefined
      ? {}
      : { parameters: statement.containsCredential
          ? content.parameters.map(() => '[REDACTED]')
          : serializable(content.parameters) as unknown[] }),
    ...(content.parameters === undefined && content.parameterTypes === undefined
      ? {}
      : { parameterTypes: content.parameterTypes ?? content.parameters?.map(parameterType) ?? [] }),
    ...(command === undefined ? {} : { command }),
    ...(content.httpMethod === undefined ? {} : { httpMethod: content.httpMethod }),
    ...(content.requestPath === undefined ? {} : { requestPath: scrubPath(content.requestPath) }),
    ...(content.requestBody === undefined ? {} : { requestBody: serializable(content.requestBody) })
  }
}

export function configureExecutionTraceRecorder(value: ExecutionTraceRecorder | null): void {
  recorder = value
}

export function currentOperationId(): string | undefined {
  return storage.getStore()?.operationId
}

export function runWithOperationContext<T>(operationId: string, operation: () => T): T {
  return storage.run({ operationId, nextSequence: 0 }, operation)
}

export function beginExternalExecution(input: ExecutionTraceInput): ExternalExecutionHandle | null {
  const context = storage.getStore()
  if (!context || !recorder) return null
  const started = Date.now()
  return {
    started,
    record: {
      id: randomUUID(),
      operationId: context.operationId,
      spanId: randomUUID(),
      parentSpanId: input.parentSpanId ?? null,
      sequence: ++context.nextSequence,
      attempt: input.attempt ?? 1,
      protocol: input.protocol,
      driverType: input.driverType,
      commandName: input.commandName,
      databaseName: input.databaseName ?? null,
      startedAt: new Date(started).toISOString(),
      sensitive: sanitizeSensitiveContent(input.sensitive)
    }
  }
}

export function finishExternalExecution(
  handle: ExternalExecutionHandle | null,
  status: ExecutionTraceStatus,
  metrics: ExecutionMetrics = {},
  error?: unknown
): void {
  if (!handle || !recorder) return
  const finished = Date.now()
  const value = error as { code?: unknown; message?: unknown } | undefined
  recorder.recordExecutionTrace({
    ...handle.record,
    status,
    returnedRows: metrics.returnedRows ?? null,
    matchedRows: metrics.matchedRows ?? null,
    affectedRows: metrics.affectedRows ?? null,
    responseBytes: metrics.responseBytes ?? null,
    errorCode: value?.code === undefined ? null : String(value.code),
    errorMessage: value?.message === undefined ? error === undefined ? null : String(error) : String(value.message),
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - handle.started
  })
}

export async function traceExecution<T>(
  input: ExecutionTraceInput,
  operation: () => T | Promise<T>,
  metrics?: (result: T) => ExecutionMetrics
): Promise<T> {
  const handle = beginExternalExecution(input)
  try {
    const result = await operation()
    finishExternalExecution(handle, 'success', metrics?.(result) ?? {})
    return result
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    finishExternalExecution(handle, name === 'AbortError' ? 'canceled' : 'error', {}, error)
    throw error
  }
}

/** 同步 SQLite 执行路径。 */
export function traceExecutionSync<T>(
  input: ExecutionTraceInput,
  operation: () => T,
  metrics?: (result: T) => ExecutionMetrics
): T {
  const handle = beginExternalExecution(input)
  try {
    const result = operation()
    finishExternalExecution(handle, 'success', metrics?.(result) ?? {})
    return result
  } catch (error) {
    finishExternalExecution(handle, 'error', {}, error)
    throw error
  }
}
