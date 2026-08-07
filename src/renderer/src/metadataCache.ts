import { ref } from 'vue'
import type { ColumnInfo, TableInfo } from '../../shared/types'

interface MetadataCacheEntry<T> {
  connectionId: string
  expiresAt: number
  value?: T
  request?: Promise<T>
}

const DATABASES_TTL_MS = 60_000
const TABLES_TTL_MS = 30_000
const COLUMNS_TTL_MS = 60_000

const databases = new Map<string, MetadataCacheEntry<string[]>>()
const tables = new Map<string, MetadataCacheEntry<TableInfo[]>>()
const columns = new Map<string, MetadataCacheEntry<ColumnInfo[]>>()
const connectionRevisions = ref(new Map<string, number>())
const globalRevision = ref(0)

function key(parts: Array<string | boolean | undefined>): string {
  return JSON.stringify(parts)
}

/** 供查询页监听；缓存失效时只刷新对应连接的元数据。 */
export function connectionMetadataRevision(connectionId?: string): string {
  return `${globalRevision.value}:${connectionId ? connectionRevisions.value.get(connectionId) ?? 0 : 0}`
}

function loadCached<T>(
  cache: Map<string, MetadataCacheEntry<T>>,
  cacheKey: string,
  connectionId: string,
  ttl: number,
  loader: () => Promise<T>
): Promise<T> {
  const now = Date.now()
  const existing = cache.get(cacheKey)
  if (existing?.value !== undefined && existing.expiresAt > now) return Promise.resolve(existing.value)
  if (existing?.request) return existing.request

  const revision = connectionMetadataRevision(connectionId)
  let request: Promise<T>
  request = loader().then((value) => {
    // 请求期间若发生 DDL、连接刷新或配置变更，不把旧结果重新写回缓存。
    if (connectionMetadataRevision(connectionId) !== revision) {
      if (cache.get(cacheKey)?.request === request) cache.delete(cacheKey)
      return loadCached(cache, cacheKey, connectionId, ttl, loader)
    }
    cache.set(cacheKey, { connectionId, value, expiresAt: Date.now() + ttl })
    return value
  }).catch((error) => {
    if (cache.get(cacheKey)?.request === request) cache.delete(cacheKey)
    throw error
  })
  cache.set(cacheKey, { connectionId, expiresAt: 0, request })
  return request
}

export function loadDatabaseMetadata(connectionId: string): Promise<string[]> {
  return loadCached(databases, key([connectionId]), connectionId, DATABASES_TTL_MS, () => window.api.listDatabases(connectionId))
}

export function loadTableMetadata(connectionId: string, database?: string): Promise<TableInfo[]> {
  return loadCached(tables, key([connectionId, database]), connectionId, TABLES_TTL_MS, () => window.api.listTables(connectionId, database))
}

export function loadColumnMetadata(connectionId: string, database: string | undefined, table: string, schema?: string): Promise<ColumnInfo[]> {
  return loadCached(
    columns,
    key([connectionId, database, schema, table]),
    connectionId,
    COLUMNS_TTL_MS,
    () => window.api.listColumns(connectionId, database, table, schema)
  )
}

export function invalidateConnectionMetadata(connectionId: string): void {
  const next = new Map(connectionRevisions.value)
  next.set(connectionId, (next.get(connectionId) ?? 0) + 1)
  connectionRevisions.value = next
  for (const cache of [databases, tables, columns]) {
    for (const [cacheKey, entry] of cache) if (entry.connectionId === connectionId) cache.delete(cacheKey)
  }
}

export function invalidateAllMetadata(): void {
  globalRevision.value += 1
  databases.clear()
  tables.clear()
  columns.clear()
}
