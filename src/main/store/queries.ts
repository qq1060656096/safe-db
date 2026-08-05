import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SavedQuery, SavedQueryInput } from '../../shared/types'

function validQuery(value: unknown): value is SavedQuery {
  if (typeof value !== 'object' || value === null) return false
  const query = value as Record<string, unknown>
  return typeof query.id === 'string'
    && typeof query.name === 'string'
    && typeof query.connectionId === 'string'
    && (query.database === undefined || typeof query.database === 'string')
    && typeof query.sql === 'string'
    && typeof query.createdAt === 'string'
    && typeof query.updatedAt === 'string'
}

/** 保存到 userData/queries.json；查询内容不进入数据库，也不经过 SQL 执行通道。 */
export class QueryStore {
  private readonly file: string
  private queries: SavedQuery[] = []

  constructor() {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'queries.json')
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf-8')) as unknown
      this.queries = Array.isArray(value) ? value.filter(validQuery) : []
    } catch {
      this.queries = []
    }
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.queries, null, 2), 'utf-8')
  }

  list(): SavedQuery[] {
    return this.queries.map((query) => ({ ...query }))
  }

  save(input: SavedQueryInput): SavedQuery {
    const name = input.name.trim()
    if (!name) throw new Error('查询名称不能为空')
    if (!input.connectionId) throw new Error('未指定连接')
    const now = new Date().toISOString()
    const existing = input.id ? this.queries.find((query) => query.id === input.id) : undefined
    const query: SavedQuery = {
      id: existing?.id ?? input.id ?? randomUUID(),
      name,
      connectionId: input.connectionId,
      database: input.database?.trim() || undefined,
      sql: input.sql,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    if (existing) Object.assign(existing, query)
    else this.queries.push(query)
    this.persist()
    return { ...query }
  }

  /** 导入连接包内的查询；仅接收已成功导入或已匹配到本地连接的内容。 */
  importPortable(value: unknown, connectionIdMap: ReadonlyMap<string, string>): { queriesImported: number; queriesSkipped: number } {
    const record = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
    const source = record && Array.isArray(record.queries) ? record.queries : []
    const existingIds = new Set(this.queries.map((query) => query.id))
    const signature = (query: Pick<SavedQuery, 'connectionId' | 'database' | 'name' | 'sql'>): string => JSON.stringify([
      query.connectionId,
      query.database ?? '',
      query.name,
      query.sql
    ])
    const signatures = new Set(this.queries.map(signature))
    let queriesImported = 0
    let queriesSkipped = 0

    for (const item of source) {
      if (!validQuery(item)) {
        queriesSkipped += 1
        continue
      }
      const connectionId = connectionIdMap.get(item.connectionId)
      if (!connectionId) {
        queriesSkipped += 1
        continue
      }
      const query: SavedQuery = {
        ...item,
        id: existingIds.has(item.id) ? randomUUID() : item.id,
        name: item.name.trim(),
        connectionId,
        database: item.database?.trim() || undefined
      }
      const querySignature = signature(query)
      if (!query.name || signatures.has(querySignature)) {
        queriesSkipped += 1
        continue
      }
      this.queries.push(query)
      existingIds.add(query.id)
      signatures.add(querySignature)
      queriesImported += 1
    }

    if (queriesImported) this.persist()
    return { queriesImported, queriesSkipped }
  }

  delete(id: string): void {
    const next = this.queries.filter((query) => query.id !== id)
    if (next.length === this.queries.length) return
    this.queries = next
    this.persist()
  }

  deleteByConnection(connectionId: string): void {
    const next = this.queries.filter((query) => query.connectionId !== connectionId)
    if (next.length === this.queries.length) return
    this.queries = next
    this.persist()
  }
}
