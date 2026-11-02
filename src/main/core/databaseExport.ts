import { randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { ConnectionMeta, DatabaseExportOptions, DatabaseExportResult, TableInfo } from '../../shared/types'
import type { DbDriver } from '../drivers/base'

/** 导出专用编码；不使用网格的截断二进制/字符串化文档表示。 */
export function exportValue(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (Buffer.isBuffer(value)) return { $safeDbType: 'binary', base64: value.toString('base64') }
  if (typeof value === 'bigint') return { $safeDbType: 'bigint', value: value.toString() }
  if (value instanceof Date) return { $safeDbType: 'date', value: value.toISOString() }
  if (typeof value === 'number' && !Number.isFinite(value)) return { $safeDbType: 'number', value: String(value) }
  if (Array.isArray(value)) return value.map(exportValue)
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, exportValue(item)]))
  return value
}

export function assertDatabaseExportOptions(options: DatabaseExportOptions): void {
  if (!options || typeof options.connectionId !== 'string' || !options.connectionId
    || !['data', 'structure', 'structure-and-data'].includes(options.mode)
    || !Array.isArray(options.databases)
    || options.databases.some((database) => typeof database !== 'string' || !database || database.includes('\0'))
    || new Set(options.databases).size !== options.databases.length) {
    throw new Error('无效的数据库导出选项')
  }
}

/** 顺序分页、逐批写盘，不受单表网格导出的 50000 行上限影响。 */
export async function writeDatabaseExport(
  driver: DbDriver,
  connection: Pick<ConnectionMeta, 'name' | 'type'>,
  options: DatabaseExportOptions,
  write: (chunk: string) => Promise<void>
): Promise<Omit<DatabaseExportResult, 'path'>> {
  assertDatabaseExportOptions(options)
  const structure = options.mode !== 'data'
  const data = options.mode !== 'structure'
  if (connection.type !== 'qdrant' && !options.databases.length) throw new Error('请选择至少一个数据库')
  if (connection.type === 'qdrant' && options.databases.length) throw new Error('Qdrant 没有数据库层级')
  const json = (value: unknown): string => JSON.stringify(exportValue(value))
  const totals = { objects: 0, rows: 0 }
  await write(json({
    format: 'safe-db-database-export', version: 1, exportedAt: new Date().toISOString(),
    connection: { name: connection.name, type: connection.type }, mode: options.mode,
    consistency: 'live', valueEncoding: 'safe-db-typed-json; MongoDB uses canonical Extended JSON'
  }).slice(0, -1) + ',"databases":[\n')

  const databases: (string | undefined)[] = connection.type === 'qdrant' ? [undefined] : options.databases
  for (const [databaseIndex, database] of databases.entries()) {
    if (databaseIndex) await write(',\n')
    await write(`{"name":${json(database ?? null)},"objects":[\n`)
    const tables = (await driver.listTables(database, false, { forExport: true })).filter((table) => structure || table.type !== 'view')
    for (const [objectIndex, table] of tables.entries()) {
      if (objectIndex) await write(',\n')
      const metadata: Record<string, unknown> = { name: table.name, schema: table.schema, type: table.type, comment: table.comment }
      const columns = await driver.listColumns(database, table.name, table.schema)
      if (structure) {
        metadata.definition = await driver.getObjectDdl(database, table.name, table.schema)
        metadata.columns = columns
        if (driver.capabilities.indexes.list.supported) metadata.indexes = await driver.listIndexes(database, table.name, table.schema)
        if (driver.capabilities.recordModel === 'row') {
          metadata.foreignKeys = await driver.listForeignKeys(database, table.name, table.schema)
          metadata.checkConstraints = await driver.listCheckConstraints(database, table.name, table.schema)
        }
      }
      await write(json(metadata).slice(0, -1))
      // 视图导出定义即可；查询结果不是可独立恢复的表数据。
      if (data && table.type !== 'view') {
        await write(',"rows":[\n')
        const orderBy = columns.filter((column) => column.isPrimaryKey).map((column) => ({ column: column.name, direction: 'asc' as const }))
        const count = await writeObjectRows(driver, database, table, orderBy, write, json)
        totals.rows += count
        await write(`\n],"rowCount":${count}`)
      }
      await write('}')
      totals.objects++
    }
    await write('\n]')
    if (structure) {
      const routines = await driver.listRoutines(database)
      await write(',"routines":[')
      for (const [index, routine] of routines.entries()) {
        if (index) await write(',')
        const definition = await driver.getRoutineDefinition(database, routine.name, routine.type, routine.schema, routine.arguments)
        await write(json({ ...routine, definition }))
        totals.objects++
      }
      await write(']')
    }
    await write('}')
  }
  await write(`\n],"totals":${json(totals)}}\n`)
  return totals
}

async function writeObjectRows(
  driver: DbDriver, database: string | undefined, table: TableInfo,
  orderBy: { column: string; direction: 'asc' }[], write: (chunk: string) => Promise<void>,
  json: (value: unknown) => string
): Promise<number> {
  const pageSize = 500
  let count = 0
  let expected: number | undefined
  let cursor: string | number | undefined
  const seenCursors = new Set<string>()
  for (let page = 1; ; page++) {
    const result = await driver.getTableData({
      database, schema: table.schema, table: table.name, page, pageSize, cursor,
      includeVectors: true, ...(orderBy.length ? { orderBy } : {})
    }, { rawValues: true })
    if (result.paginationMode === 'none' || result.totalMode === 'returned') throw new Error('导出需要完整分页数据')
    expected ??= result.total
    if (!Number.isSafeInteger(expected) || expected < 0 || expected !== result.total) {
      throw new Error(`对象“${table.name}”的行数在导出过程中发生变化，请重试`)
    }
    if (result.rows.length) {
      await write((count ? ',\n' : '') + result.rows.map(json).join(',\n'))
      count += result.rows.length
    }
    if (result.paginationMode === 'cursor') {
      if (result.nextCursor === undefined) break
      const key = JSON.stringify(result.nextCursor)
      if (!result.rows.length || seenCursors.has(key)) throw new Error(`对象“${table.name}”返回了无效的分页游标`)
      seenCursors.add(key)
      cursor = result.nextCursor
    } else if (count >= expected || !result.rows.length) break
  }
  if (count !== expected) throw new Error(`对象“${table.name}”导出不完整：预期 ${expected} 行，实际 ${count} 行`)
  return count
}

/** 完整写入临时文件后才替换目标；失败保留原文件，并清理半成品。 */
export async function saveDatabaseExport(
  path: string, driver: DbDriver, connection: Pick<ConnectionMeta, 'name' | 'type'>, options: DatabaseExportOptions
): Promise<DatabaseExportResult> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  const file = await open(temporary, 'wx', 0o600)
  try {
    const totals = await writeDatabaseExport(driver, connection, options, async (chunk) => { await file.writeFile(chunk, 'utf-8') })
    await file.sync()
    await file.close()
    await rename(temporary, path)
    return { path, ...totals }
  } finally {
    await file.close().catch(() => {})
    await unlink(temporary).catch(() => {})
  }
}
