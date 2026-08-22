import { QdrantClient } from '@qdrant/js-client-rest'
import type {
  CheckConstraintInfo,
  ColumnFilter,
  ColumnInfo,
  DatabaseOperation,
  ForeignKeyInfo,
  IndexInfo,
  QdrantFilterCondition,
  QdrantVectorFieldInfo,
  QdrantVectorQuery,
  QueryResult,
  RoutineInfo,
  SqlKind,
  TableInfo
} from '../../shared/types'
import { classifyQdrantRequest, parseQdrantRequests, type QdrantRequestInput } from '../core/nativeCommand'
import type { DbDriver, DriverOperationResult, TableDataQuery, TableDataResult } from './base'
import { capabilitiesForType } from './capabilities'
import { traceExecution } from '../audit/trace'

type CollectionInfo = Awaited<ReturnType<QdrantClient['getCollection']>>
type ScrollPoint = Awaited<ReturnType<QdrantClient['scroll']>>['points'][number]
type PointLike = Pick<ScrollPoint, 'id' | 'payload' | 'vector'> & { score?: number }

function qdrantSdkRequest(name: string, args: unknown[]): {
  method: string
  path: string
  body?: unknown
} {
  const collection = typeof args[0] === 'string' ? encodeURIComponent(args[0]) : ''
  if (name === 'getCollections') return { method: 'GET', path: '/collections' }
  if (name === 'getCollection') return { method: 'GET', path: `/collections/${collection}` }
  if (name === 'scroll') return { method: 'POST', path: `/collections/${collection}/points/scroll`, body: args[1] }
  if (name === 'count') return { method: 'POST', path: `/collections/${collection}/points/count`, body: args[1] }
  if (name === 'query') return { method: 'POST', path: `/collections/${collection}/points/query`, body: args[1] }
  return { method: 'SDK', path: `/${name}`, body: args }
}

function qdrantMetrics(value: unknown): { returnedRows?: number; matchedRows?: number; affectedRows?: number } {
  if (!value || typeof value !== 'object') return {}
  const object = value as Record<string, unknown>
  if (Array.isArray(object.points)) return { returnedRows: object.points.length }
  if (Array.isArray(object.collections)) return { returnedRows: object.collections.length }
  if (typeof object.count === 'number') return { matchedRows: object.count }
  return { returnedRows: 1 }
}

function jsonValue(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function inferredType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'float'
  return typeof value
}

function payloadColumn(name: string): string {
  return `payload.${name}`
}

function payloadKey(column: string): string {
  return column.startsWith('payload.') ? column.slice('payload.'.length) : column
}

function parsedFilterValue(value?: string): unknown {
  const source = value ?? ''
  try {
    return JSON.parse(source)
  } catch {
    return source
  }
}

function vectorFields(info: CollectionInfo): QdrantVectorFieldInfo[] {
  const dense = info.config.params.vectors
  const fields: QdrantVectorFieldInfo[] = []
  const denseRecord = dense as Record<string, unknown> | undefined
  if (denseRecord && typeof denseRecord.size === 'number' && typeof denseRecord.distance === 'string') {
    fields.push({ kind: 'dense', size: denseRecord.size, distance: denseRecord.distance })
  } else if (denseRecord) {
    for (const [name, value] of Object.entries(denseRecord)) {
      const params = value as Record<string, unknown> | undefined
      if (params && typeof params.size === 'number' && typeof params.distance === 'string') {
        fields.push({ name, kind: 'dense', size: params.size, distance: params.distance })
      }
    }
  }
  for (const name of Object.keys(info.config.params.sparse_vectors ?? {})) fields.push({ name, kind: 'sparse' })
  return fields
}

function vectorDescription(info: CollectionInfo): string {
  return vectorFields(info).map((field) => field.kind === 'dense'
    ? `${field.name ? `${field.name}` : 'dense'}[${field.size}] ${field.distance}`
    : `${field.name}[sparse]`).join(' · ') || 'no vectors'
}

function parsedFilterArray(value: string | undefined, label: string): unknown[] {
  let parsed: unknown
  try { parsed = JSON.parse(value ?? '') }
  catch { throw new Error(`${label} 必须是有效的 JSON 数组`) }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error(`${label} 必须是非空 JSON 数组`)
  return parsed
}

function nativeFilterCondition(item: QdrantFilterCondition): Record<string, unknown> {
  const field = item.field.trim()
  if (!field) throw new Error('Qdrant 筛选字段不能为空')
  if (field === 'payload' || field === 'vector') throw new Error(`Qdrant ${field} 汇总列不能直接筛选，请输入具体 Payload 路径`)
  if (field === 'id') {
    if (item.op === 'match') return { has_id: [qdrantPointId(parsedFilterValue(item.value))] }
    if (item.op === 'match_any') return { has_id: parsedFilterArray(item.value, 'Qdrant Point ID').map(qdrantPointId) }
    throw new Error('Qdrant Point ID 只支持等于或属于任意值筛选')
  }
  const key = payloadKey(field)
  if (!key) throw new Error('Qdrant Payload 筛选路径不能为空')
  if (item.op === 'empty') return { is_empty: { key } }
  if (item.op === 'null') return { is_null: { key } }
  if (item.op === 'text') return { key, match: { text: item.value ?? '' } }
  if (item.op === 'phrase') return { key, match: { phrase: item.value ?? '' } }
  if (item.op === 'match') return { key, match: { value: parsedFilterValue(item.value) } }
  if (item.op === 'match_any') return { key, match: { any: parsedFilterArray(item.value, `Qdrant ${field} 筛选值`) } }
  const rangeKey = item.op === '>' ? 'gt' : item.op === '>=' ? 'gte' : item.op === '<' ? 'lt' : 'lte'
  return { key, range: { [rangeKey]: parsedFilterValue(item.value) } }
}

function qdrantFilter(
  filters: ColumnFilter[] | undefined,
  nativeFilters: QdrantFilterCondition[] | undefined
): Record<string, unknown> | undefined {
  const must: Record<string, unknown>[] = []
  const mustNot: Record<string, unknown>[] = []
  for (const item of filters ?? []) {
    const target = item.op === '!=' || item.op === 'notlike' || item.op === 'notnull' ? mustNot : must
    if (item.column === 'id') {
      if (item.op !== '=' && item.op !== '!=') throw new Error('Qdrant point id 只支持 = 和 != 筛选')
      target.push({ has_id: [parsedFilterValue(item.value)] })
      continue
    }
    if (item.column === 'payload' || item.column === 'vector') {
      throw new Error(`Qdrant ${item.column} 汇总列不支持网格筛选，请筛选具体 payload 字段或使用查询编辑器`)
    }
    const key = payloadKey(item.column)
    if (item.op === 'null' || item.op === 'notnull') {
      target.push({ is_empty: { key } })
    } else if (item.op === 'like' || item.op === 'notlike') {
      target.push({ key, match: { text: item.value ?? '' } })
    } else if (item.op === '=' || item.op === '!=') {
      target.push({ key, match: { value: parsedFilterValue(item.value) } })
    } else {
      const rangeKey = item.op === '>' ? 'gt' : item.op === '>=' ? 'gte' : item.op === '<' ? 'lt' : 'lte'
      target.push({ key, range: { [rangeKey]: parsedFilterValue(item.value) } })
    }
  }
  for (const item of nativeFilters ?? []) {
    const condition = nativeFilterCondition(item)
    const target = item.clause === 'must_not' ? mustNot : must
    target.push(condition)
  }
  return must.length || mustNot.length
    ? { ...(must.length ? { must } : {}), ...(mustNot.length ? { must_not: mustNot } : {}) }
    : undefined
}

function resultRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) return displayObject(item as Record<string, unknown>)
      return { index, value: item && typeof item === 'object' ? jsonValue(item) : item }
    })
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    if (Array.isArray(object.points)) return object.points.map((point) => displayPoint(point as Record<string, unknown>))
    if (Array.isArray(object.collections)) return object.collections.map((item) => displayObject(item as Record<string, unknown>))
    return [displayObject(object)]
  }
  return [{ result: value ?? null }]
}

function displayObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    item && typeof item === 'object' ? jsonValue(item) : item
  ]))
}

function displayPoint(point: Record<string, unknown>): Record<string, unknown> {
  const payload = point.payload && typeof point.payload === 'object' && !Array.isArray(point.payload)
    ? point.payload as Record<string, unknown>
    : {}
  return {
    id: point.id ?? null,
    ...('score' in point ? { score: point.score } : {}),
    ...Object.fromEntries(Object.entries(payload).map(([key, value]) => [payloadColumn(key), value && typeof value === 'object' ? jsonValue(value) : value])),
    payload: jsonValue(point.payload ?? {}),
    ...('vector' in point ? { vector: jsonValue(point.vector) } : {})
  }
}

function affectedRows(request: QdrantRequestInput): number {
  const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
    ? request.body as Record<string, unknown>
    : {}
  if (Array.isArray(body.points)) return body.points.length
  if (Array.isArray(body.ids)) return body.ids.length
  if (Array.isArray(body.operations)) return body.operations.length
  return 1
}

function qdrantPointId(value: unknown): string | number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string') {
    if (/^(0|[1-9]\d*)$/.test(value)) {
      const number = Number(value)
      if (Number.isSafeInteger(number)) return number
    }
    if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) return value
  }
  throw new Error('Qdrant Point ID 必须是非负安全整数或 UUID')
}

function validatedVectorQuery(info: CollectionInfo, query: QdrantVectorQuery): QdrantVectorQuery {
  if (!Array.isArray(query.vector) || query.vector.length === 0 || query.vector.some((value) => !Number.isFinite(value))) {
    throw new Error('Qdrant 查询向量必须是由有限数字组成的非空数组')
  }
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 500) {
    throw new Error('Qdrant 向量查询返回数量必须在 1 到 500 之间')
  }
  if (query.scoreThreshold !== undefined && !Number.isFinite(query.scoreThreshold)) {
    throw new Error('Qdrant Score 阈值必须是有限数字')
  }
  const denseFields = vectorFields(info).filter((field) => field.kind === 'dense')
  const field = query.using
    ? denseFields.find((item) => item.name === query.using)
    : denseFields.find((item) => item.name === undefined)
  if (!field) {
    throw new Error(query.using
      ? `Qdrant Collection 不存在稠密向量字段：${query.using}`
      : 'Qdrant Collection 没有默认稠密向量，请选择 Named Vector')
  }
  if (field.size !== undefined && query.vector.length !== field.size) {
    throw new Error(`Qdrant 查询向量维度应为 ${field.size}，实际为 ${query.vector.length}`)
  }
  return query
}

function parsedJsonContainer(value: unknown, label: string): unknown[] | Record<string, unknown> {
  let parsed = value
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) }
    catch { throw new Error(`${label} 必须是有效 JSON`) }
  }
  if (!parsed || typeof parsed !== 'object') throw new Error(`${label} 必须是 JSON 数组或对象`)
  return parsed as unknown[] | Record<string, unknown>
}

function parsedPayload(value: unknown): Record<string, unknown> {
  const parsed = parsedJsonContainer(value, 'Qdrant Payload')
  if (Array.isArray(parsed)) throw new Error('Qdrant Payload 必须是 JSON 对象')
  return parsed
}

function mutationPoint(values: Record<string, unknown>): Record<string, unknown> {
  const id = qdrantPointId(values.id)
  const payload = values.payload === undefined ? {} : parsedPayload(values.payload)
  for (const [name, value] of Object.entries(values)) {
    if (name.startsWith('payload.')) payload[payloadKey(name)] = value
  }
  if (values.vector === undefined) throw new Error(`Qdrant Point ${String(id)} 缺少 vector`)
  return { id, vector: parsedJsonContainer(values.vector, 'Qdrant Vector'), payload }
}

export class QdrantDriver implements DbDriver {
  readonly capabilities = capabilitiesForType('qdrant')
  private client: QdrantClient
  private connected = false
  private activeController: AbortController | null = null

  constructor(
    private cfg: {
      host: string
      port: number
      apiKey?: string
      tls?: boolean
      timeoutMs?: number
    }
  ) {
    this.client = this.createClient()
  }

  private createClient(): QdrantClient {
    const client = new QdrantClient({
      host: this.cfg.host,
      port: this.cfg.port,
      https: this.cfg.tls === true,
      apiKey: this.cfg.apiKey || undefined,
      timeout: this.cfg.timeoutMs ?? 30_000
    })
    return new Proxy(client, {
      get(target, property) {
        const value = Reflect.get(target, property, target)
        if (typeof value !== 'function' || typeof property !== 'string') return value
        return (...args: unknown[]) => {
          const request = qdrantSdkRequest(property, args)
          return traceExecution({
            protocol: 'http', driverType: 'qdrant', commandName: `HTTP ${request.method}`,
            sensitive: {
              httpMethod: request.method,
              requestPath: request.path,
              ...(request.body === undefined ? {} : { requestBody: request.body })
            }
          }, () => value.apply(target, args), qdrantMetrics)
        }
      }
    }) as QdrantClient
  }

  private baseUrl(): string {
    return `${this.cfg.tls ? 'https' : 'http'}://${this.cfg.host}:${this.cfg.port}`
  }

  async connect(): Promise<void> {
    if (this.connected) return
    await this.client.getCollections()
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.activeController?.abort()
    this.activeController = null
    this.connected = false
  }

  async cancel(): Promise<void> {
    await this.disconnect()
  }

  async test(): Promise<void> {
    await this.createClient().getCollections()
  }

  async listDatabases(): Promise<string[]> {
    return []
  }

  async listTables(_database?: string, includeStats = false): Promise<TableInfo[]> {
    const collections = (await this.client.getCollections()).collections
    if (!includeStats) return collections.map((collection) => ({
      name: collection.name,
      type: 'table',
      comment: 'Qdrant collection'
    }))
    return Promise.all(collections.map(async (collection): Promise<TableInfo> => {
      const info = await this.client.getCollection(collection.name)
      return {
        name: collection.name,
        type: 'table',
        comment: `${info.status} · ${vectorDescription(info)}`,
        rowCount: info.points_count ?? undefined,
        objectId: info.segments_count
      }
    }))
  }

  async listRoutines(): Promise<RoutineInfo[]> {
    return []
  }

  private columnsFrom(info: CollectionInfo, points: PointLike[]): ColumnInfo[] {
    const payloadTypes = new Map<string, Set<string>>()
    for (const [name, index] of Object.entries(info.payload_schema)) {
      payloadTypes.set(name, new Set([index?.data_type ?? 'unknown']))
    }
    for (const point of points) {
      for (const [name, value] of Object.entries(point.payload ?? {})) {
        const types = payloadTypes.get(name) ?? new Set<string>()
        types.add(inferredType(value))
        payloadTypes.set(name, types)
      }
    }
    const columns: ColumnInfo[] = [{
      name: 'id', dataType: 'uint64 | uuid', nullable: false, isPrimaryKey: true,
      defaultValue: null, ordinal: 0
    }]
    if (points.some((point) => typeof point.score === 'number')) {
      columns.push({
        name: 'score', dataType: 'float', nullable: false, isPrimaryKey: false,
        defaultValue: null, extra: 'vector similarity', ordinal: columns.length
      })
    }
    for (const [name, types] of [...payloadTypes].sort(([left], [right]) => left.localeCompare(right))) {
      columns.push({
        name: payloadColumn(name), dataType: [...types].sort().join(' | '), nullable: true,
        isPrimaryKey: false, defaultValue: null,
        extra: info.payload_schema[name] ? 'payload index' : 'sampled payload', ordinal: columns.length
      })
    }
    columns.push({ name: 'payload', dataType: 'json', nullable: false, isPrimaryKey: false, defaultValue: null, ordinal: columns.length })
    columns.push({
      name: 'vector', dataType: vectorDescription(info), nullable: true, isPrimaryKey: false,
      defaultValue: null, extra: 'hidden by default', ordinal: columns.length
    })
    return columns
  }

  async listColumns(_database: string | undefined, table: string): Promise<ColumnInfo[]> {
    const [info, sample] = await Promise.all([
      this.client.getCollection(table),
      this.client.scroll(table, { limit: 100, with_payload: true, with_vector: false })
    ])
    return this.columnsFrom(info, sample.points)
  }

  async listIndexes(_database: string | undefined, table: string): Promise<IndexInfo[]> {
    const info = await this.client.getCollection(table)
    return [
      { name: 'point_id', columns: ['id'], unique: true, primary: true },
      ...Object.keys(info.payload_schema).sort().map((name) => ({
        name: `payload:${name}`, columns: [payloadColumn(name)], unique: false, primary: false
      }))
    ]
  }

  async listForeignKeys(): Promise<ForeignKeyInfo[]> {
    return []
  }

  async listCheckConstraints(): Promise<CheckConstraintInfo[]> {
    return []
  }

  async getObjectDdl(_database: string | undefined, table: string): Promise<string> {
    const info = await this.client.getCollection(table)
    const params = info.config.params
    return JSON.stringify({
      method: 'PUT',
      path: `/collections/${encodeURIComponent(table)}`,
      body: {
        vectors: params.vectors,
        sparse_vectors: params.sparse_vectors,
        shard_number: params.shard_number,
        sharding_method: params.sharding_method,
        replication_factor: params.replication_factor,
        write_consistency_factor: params.write_consistency_factor,
        on_disk_payload: params.on_disk_payload,
        hnsw_config: info.config.hnsw_config,
        optimizers_config: info.config.optimizer_config,
        wal_config: info.config.wal_config,
        quantization_config: info.config.quantization_config,
        strict_mode_config: info.config.strict_mode_config,
        metadata: info.config.metadata
      }
    }, null, 2)
  }

  async getRoutineDefinition(): Promise<string> {
    throw new Error('Qdrant 不支持 SQL 函数或存储过程')
  }

  async getTableData(query: TableDataQuery): Promise<TableDataResult> {
    const nativeQuery = query.nativeQuery?.type === 'qdrant' ? query.nativeQuery : undefined
    const filter = qdrantFilter(query.filters, nativeQuery?.filter)
    const order = query.orderBy?.[0]
    if (order?.column === 'id' && order.direction === 'desc') {
      throw new Error('Qdrant Point 游标只支持按 id 正序浏览')
    }
    if (order?.column === 'payload' || order?.column === 'vector') {
      throw new Error(`Qdrant ${order.column} 汇总列不支持排序，请选择具体 payload 字段`)
    }
    const infoPromise = this.client.getCollection(query.table)
    if (nativeQuery?.vector) {
      if (order) throw new Error('Qdrant 向量查询固定按相似度排序，不能同时指定字段排序')
      const info = await infoPromise
      const vectorQuery = validatedVectorQuery(info, nativeQuery.vector)
      const result = await this.client.query(query.table, {
        query: vectorQuery.vector,
        ...(vectorQuery.using ? { using: vectorQuery.using } : {}),
        ...(filter ? { filter } : {}),
        ...(vectorQuery.scoreThreshold === undefined ? {} : { score_threshold: vectorQuery.scoreThreshold }),
        limit: vectorQuery.limit,
        with_payload: true,
        with_vector: query.includeVectors === true
      })
      const summary = vectorDescription(info)
      const rows = result.points.map((point) => ({
        id: point.id,
        score: point.score,
        ...Object.fromEntries(Object.entries(point.payload ?? {}).map(([key, value]) => [payloadColumn(key), value && typeof value === 'object' ? jsonValue(value) : value])),
        payload: jsonValue(point.payload ?? {}),
        vector: query.includeVectors ? jsonValue(point.vector) : `<hidden · ${summary}>`
      }))
      return {
        columns: this.columnsFrom(info, result.points),
        rows,
        total: rows.length,
        totalMode: 'returned',
        editable: true,
        keyColumns: ['id'],
        paginationMode: 'none',
        vectorFields: vectorFields(info)
      }
    }
    const scrollRequest: NonNullable<Parameters<QdrantClient['scroll']>[1]> = {
      limit: Math.min(500, Math.max(1, query.pageSize)),
      offset: query.cursor,
      with_payload: true,
      with_vector: query.includeVectors === true,
      ...(filter ? { filter } : {}),
      ...(order && order.column !== 'id' && order.column !== 'payload' && order.column !== 'vector'
        ? { order_by: { key: payloadKey(order.column), direction: order.direction } }
        : {})
    }
    const [info, result, count] = await Promise.all([
      infoPromise,
      this.client.scroll(query.table, scrollRequest),
      this.client.count(query.table, { ...(filter ? { filter } : {}), exact: true })
    ])
    const summary = vectorDescription(info)
    const nextCursor = typeof result.next_page_offset === 'string' || typeof result.next_page_offset === 'number'
      ? result.next_page_offset
      : undefined
    const rows = result.points.map((point) => ({
      id: point.id,
      ...Object.fromEntries(Object.entries(point.payload ?? {}).map(([key, value]) => [payloadColumn(key), value && typeof value === 'object' ? jsonValue(value) : value])),
      payload: jsonValue(point.payload ?? {}),
      vector: query.includeVectors ? jsonValue(point.vector) : `<hidden · ${summary}>`
    }))
    return {
      columns: this.columnsFrom(info, result.points),
      rows,
      total: count.count,
      totalMode: 'exact',
      editable: true,
      keyColumns: ['id'],
      paginationMode: 'cursor',
      nextCursor,
      vectorFields: vectorFields(info)
    }
  }

  private async executeOne(request: QdrantRequestInput): Promise<QueryResult> {
    const path = new URL(request.path, 'http://safe-db.local')
    for (const [key, value] of Object.entries(request.query ?? {})) path.searchParams.set(key, String(value))
    return traceExecution({
      protocol: 'http', driverType: 'qdrant', commandName: `HTTP ${request.method}`,
      sensitive: {
        httpMethod: request.method,
        requestPath: `${path.pathname}${path.search}`,
        ...(request.body === undefined ? {} : { requestBody: request.body })
      }
    }, () => this.executeOneUntraced(request), (result) => result.kind === 'rows'
      ? { returnedRows: result.rows?.length ?? 0 }
      : { affectedRows: result.affectedRows })
  }

  private async executeOneUntraced(request: QdrantRequestInput): Promise<QueryResult> {
    const controller = new AbortController()
    this.activeController = controller
    const timeout = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 30_000)
    try {
      const url = new URL(`${this.baseUrl()}${request.path}`)
      for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, String(value))
      const response = await fetch(url, {
        method: request.method,
        headers: {
          accept: 'application/json',
          ...(request.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(this.cfg.apiKey ? { 'api-key': this.cfg.apiKey } : {})
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: controller.signal
      })
      const text = await response.text()
      let envelope: unknown = text
      if (text) {
        try { envelope = JSON.parse(text) } catch {}
      }
      if (!response.ok) {
        const detail = envelope && typeof envelope === 'object'
          ? (envelope as { status?: { error?: string } }).status?.error ?? jsonValue(envelope)
          : text
        throw new Error(`Qdrant ${response.status}：${detail || response.statusText}`)
      }
      const result = envelope && typeof envelope === 'object' && 'result' in envelope
        ? (envelope as { result: unknown }).result
        : envelope
      if (classifyQdrantRequest(request) !== 'READ') return { kind: 'exec', affectedRows: affectedRows(request) }
      const rows = resultRows(result)
      return { kind: 'rows', columns: Object.keys(rows[0] ?? {}).map((name) => ({ name })), rows }
    } finally {
      clearTimeout(timeout)
      if (this.activeController === controller) this.activeController = null
    }
  }

  private operationRequest(
    method: QdrantRequestInput['method'],
    path: string,
    body?: unknown,
    query?: QdrantRequestInput['query']
  ): QdrantRequestInput {
    const value = { method, path, ...(query ? { query } : {}), ...(body === undefined ? {} : { body }) }
    return { raw: JSON.stringify(value), ...value }
  }

  /** 将 Point/Collection 意图编译为受限 Qdrant REST；多请求时明确返回 best-effort。 */
  async executeOperation(operation: DatabaseOperation): Promise<DriverOperationResult> {
    const requests: QdrantRequestInput[] = []
    let succeeded = 0
    if (operation.kind === 'records.mutate') {
      if (operation.target.kind !== 'collection') throw new Error('Qdrant 结构化操作目标必须是 Collection')
      const path = `/collections/${encodeURIComponent(operation.target.name)}/points`
      const inserts = operation.mutations.filter((item) => item.kind === 'insert')
      for (let offset = 0; offset < inserts.length; offset += 1_000) {
        const points = inserts.slice(offset, offset + 1_000).map((item) => mutationPoint(item.values))
        requests.push(this.operationRequest('PUT', path, { points }, { wait: true }))
      }
      for (const mutation of operation.mutations) {
        if (mutation.kind !== 'update') continue
        const id = qdrantPointId(mutation.key.id)
        const partialPayload: Record<string, unknown> = {}
        for (const [name, value] of Object.entries(mutation.changes)) {
          if (name.startsWith('payload.')) partialPayload[payloadKey(name)] = value
        }
        if (Object.hasOwn(mutation.changes, 'payload')) {
          const payload = parsedPayload(mutation.changes.payload)
          Object.assign(payload, partialPayload)
          requests.push(this.operationRequest('PUT', `${path}/payload`, { payload, points: [id] }, { wait: true }))
        } else if (Object.keys(partialPayload).length) {
          requests.push(this.operationRequest('POST', `${path}/payload`, { payload: partialPayload, points: [id] }, { wait: true }))
        }
        if (Object.hasOwn(mutation.changes, 'vector')) {
          const vector = parsedJsonContainer(mutation.changes.vector, 'Qdrant Vector')
          requests.push(this.operationRequest('PUT', `${path}/vectors`, { points: [{ id, vector }] }, { wait: true }))
        }
        const unsupported = Object.keys(mutation.changes).filter((name) => name === 'id' || (!name.startsWith('payload.') && name !== 'payload' && name !== 'vector'))
        if (unsupported.length) throw new Error(`Qdrant 不支持修改字段：${unsupported.join(', ')}`)
      }
      const deletes = operation.mutations.filter((item) => item.kind === 'delete')
      for (let offset = 0; offset < deletes.length; offset += 1_000) {
        const points = deletes.slice(offset, offset + 1_000).map((item) => qdrantPointId(item.key.id))
        requests.push(this.operationRequest('POST', `${path}/delete`, { points }, { wait: true }))
      }
      succeeded = operation.mutations.length
    } else if (operation.kind === 'records.clear') {
      if (operation.target.kind !== 'collection') throw new Error('Qdrant 清空目标必须是 Collection')
      requests.push(this.operationRequest(
        'POST', `/collections/${encodeURIComponent(operation.target.name)}/points/delete`,
        { filter: {} }, { wait: true }
      ))
      succeeded = 1
    } else if (operation.kind === 'object.create') {
      if (operation.objectType !== 'collection') throw new Error('Qdrant 只能创建 Collection')
      requests.push(this.operationRequest('PUT', `/collections/${encodeURIComponent(operation.name)}`, operation.definition))
      succeeded = 1
    } else if (operation.kind === 'object.drop') {
      if (operation.target.kind !== 'collection') throw new Error('Qdrant 删除目标必须是 Collection')
      requests.push(this.operationRequest('DELETE', `/collections/${encodeURIComponent(operation.target.name)}`))
      succeeded = 1
    } else if (operation.kind === 'index.create') {
      if (operation.target.kind !== 'collection') throw new Error('Qdrant 索引目标必须是 Collection')
      requests.push(this.operationRequest(
        'PUT', `/collections/${encodeURIComponent(operation.target.name)}/index`,
        { field_name: operation.name, field_schema: operation.definition.fieldSchema ?? operation.definition },
        { wait: true }
      ))
      succeeded = 1
    } else if (operation.kind === 'index.drop') {
      if (operation.target.kind !== 'collection') throw new Error('Qdrant 索引目标必须是 Collection')
      requests.push(this.operationRequest(
        'DELETE', `/collections/${encodeURIComponent(operation.target.name)}/index/${encodeURIComponent(operation.name)}`,
        undefined, { wait: true }
      ))
      succeeded = 1
    } else {
      throw new Error('Qdrant 尚未接入该结构化操作')
    }

    let completedRequests = 0
    try {
      for (const request of requests) {
        classifyQdrantRequest(request)
        await this.executeOne(request)
        completedRequests += 1
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (completedRequests > 0) throw new Error(`Qdrant 操作部分完成（${completedRequests}/${requests.length} 个请求）：${detail}`)
      throw error
    }
    return {
      results: [{ kind: 'exec', affectedRows: succeeded }],
      atomicity: requests.length <= 1 ? 'single-request' : 'best-effort',
      succeeded,
      failed: 0
    }
  }

  async run(input: string): Promise<QueryResult[]> {
    const results: QueryResult[] = []
    for (const request of parseQdrantRequests(input)) results.push(await this.executeOne(request))
    return results
  }

  async runInTransaction(inputs: string[]): Promise<QueryResult[]> {
    const requests = inputs.flatMap(parseQdrantRequests)
    const kinds: SqlKind[] = requests.map(classifyQdrantRequest)
    if (requests.length > 1 && kinds.some((kind) => kind !== 'READ')) {
      throw new Error('Qdrant 变更请求每次只能执行一条，多个 REST 请求无法保证整体回滚')
    }
    const results: QueryResult[] = []
    for (const request of requests) results.push(await this.executeOne(request))
    return results
  }
}
