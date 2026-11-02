import type {
  DatabaseObjectRef,
  DatabaseOperation,
  TableColumnDefinition,
  TableColumnChange
} from '../../shared/types'
import { isSystemDatabase } from '../../shared/databasePolicy'

export type RelationalDialect = 'mysql' | 'postgres' | 'sqlite' | 'sqlserver'

export interface ParameterizedCommand {
  sql: string
  params: unknown[]
}

const OPERATION_PREVIEW_COMMAND_LIMIT = 20

function compactPreviewParameter(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…<${value.length} chars>` : value
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((item) => compactPreviewParameter(item, depth + 1))
    return value.length > items.length ? [...items, `<${value.length - items.length} more items>`] : items
  }
  if (value === null || typeof value !== 'object' || depth > 8) return value
  const entries = Object.entries(value)
  const result = Object.fromEntries(entries.slice(0, 50).map(([key, item]) => [key, compactPreviewParameter(item, depth + 1)]))
  if (entries.length > 50) result.__omittedFields = entries.length - 50
  return result
}

function terminateSql(sql: string): string {
  const value = sql.trimEnd()
  return value.endsWith(';') ? value : `${value};`
}

/**
 * 生成与关系型驱动实际执行一致的参数化 SQL 审批文本。
 * 参数单独列出，不伪造成数据库并未真正收到的“内联 SQL”。
 */
export function relationalOperationPreview(
  operation: DatabaseOperation,
  dialect: RelationalDialect,
  fallbackDatabase?: string
): string {
  const commands = compileRelationalOperation(operation, dialect, fallbackDatabase)
  const visible = commands.slice(0, OPERATION_PREVIEW_COMMAND_LIMIT)
  const blocks = visible.map((command, index) => {
    const heading = commands.length > 1 ? `-- SQL ${index + 1}/${commands.length}\n` : ''
    const params = command.params.length
      ? `\n-- 参数: ${JSON.stringify(command.params.map((value) => compactPreviewParameter(value)))}`
      : ''
    return `${heading}${terminateSql(command.sql)}${params}`
  })
  if (commands.length > visible.length) {
    blocks.push(`-- 其余 ${commands.length - visible.length} 条 SQL 未展示，确认后仍会全部执行`)
  }
  return blocks.join('\n\n')
}

export function quoteRelationalIdentifier(dialect: RelationalDialect, name: string): string {
  if (dialect === 'mysql') return '`' + name.replace(/`/g, '``') + '`'
  if (dialect === 'sqlserver') return '[' + name.replace(/]/g, ']]') + ']'
  return '"' + name.replace(/"/g, '""') + '"'
}

export function relationalTable(
  dialect: RelationalDialect,
  target: DatabaseObjectRef,
  fallbackDatabase?: string
): string {
  if (target.kind !== 'table') throw new Error('关系型结构化操作目标必须是表')
  const quote = (name: string): string => quoteRelationalIdentifier(dialect, name)
  if (dialect === 'mysql') {
    const database = target.database || fallbackDatabase
    if (!database) throw new Error('未指定数据库')
    return `${quote(database)}.${quote(target.name)}`
  }
  if (dialect === 'postgres') return `${quote(target.schema ?? 'public')}.${quote(target.name)}`
  if (dialect === 'sqlserver') return `${quote(target.schema ?? 'dbo')}.${quote(target.name)}`
  return `${quote(target.database ?? 'main')}.${quote(target.name)}`
}

function whereClause(
  entries: Array<[string, unknown]>,
  quote: (name: string) => string,
  addParameter: (value: unknown) => string
): string {
  if (!entries.length) throw new Error('修改或删除记录必须提供定位键')
  return entries.map(([name, value]) => value === null
    ? `${quote(name === '__rowid__' ? 'rowid' : name)} IS NULL`
    : `${quote(name === '__rowid__' ? 'rowid' : name)} = ${addParameter(value)}`).join(' AND ')
}

/** 将行级意图编译成参数化 SQL；调用方负责在真实数据库事务中执行全部命令。 */
export function compileRecordCommands(
  operation: Extract<DatabaseOperation, { kind: 'records.mutate' }>,
  dialect: RelationalDialect,
  fallbackDatabase?: string
): ParameterizedCommand[] {
  const table = relationalTable(dialect, operation.target, fallbackDatabase)
  const quote = (name: string): string => quoteRelationalIdentifier(dialect, name)
  return operation.mutations.map((mutation) => {
    const params: unknown[] = []
    const addParameter = (value: unknown): string => {
      params.push(value)
      if (dialect === 'postgres') return `$${params.length}`
      if (dialect === 'sqlserver') return `@p${params.length - 1}`
      return '?'
    }
    if (mutation.kind === 'insert') {
      const entries = Object.entries(mutation.values)
      if (!entries.length) throw new Error('新增记录不能为空')
      const columns = entries.map(([name]) => quote(name)).join(', ')
      const values = entries.map(([, value]) => addParameter(value)).join(', ')
      return { sql: `INSERT INTO ${table} (${columns}) VALUES (${values})`, params }
    }
    const where = whereClause(Object.entries(mutation.key), quote, addParameter)
    if (mutation.kind === 'delete') return { sql: `DELETE FROM ${table} WHERE ${where}`, params }
    const changes = Object.entries(mutation.changes)
    if (!changes.length) throw new Error('记录修改内容不能为空')
    // UPDATE 的参数必须在 WHERE 参数之前，因此重新编译一次。
    params.length = 0
    const set = changes.map(([name, value]) => `${quote(name)} = ${addParameter(value)}`).join(', ')
    const updateWhere = whereClause(Object.entries(mutation.key), quote, addParameter)
    return { sql: `UPDATE ${table} SET ${set} WHERE ${updateWhere}`, params }
  })
}

function safeType(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256 || /;|--|\/\*|\*\//.test(normalized)) throw new Error(`不安全的数据类型：${value}`)
  return normalized
}

function defaultExpression(value: string | undefined): string | null {
  const normalized = value?.trim() ?? ''
  if (!normalized) return null
  if (normalized.length > 2_048 || /;|--|\/\*|\*\//.test(normalized)) throw new Error('默认值表达式无效')
  if (/^-?\d+(?:\.\d+)?$/.test(normalized) || /^'.*'$/.test(normalized) || /^\(.*\)$/.test(normalized)) return normalized
  if (/^(null|true|false|current_timestamp|current_date|current_time|localtimestamp|now\(\)|gen_random_uuid\(\)|uuid_generate_v4\(\)|nextval\(.+\))$/i.test(normalized)) return normalized
  return `'${normalized.replace(/'/g, "''")}'`
}

export function compileDefaultExpression(value: string | undefined): string | null {
  return defaultExpression(value)
}

export function compileColumnDefinition(dialect: RelationalDialect, column: TableColumnDefinition): string {
  const quote = (name: string): string => quoteRelationalIdentifier(dialect, name)
  let result = `${quote(column.name)} ${safeType(column.dataType)}`
  if (column.autoIncrement) {
    if (dialect === 'mysql') result += ' AUTO_INCREMENT'
    else if (dialect === 'postgres') result += ' GENERATED BY DEFAULT AS IDENTITY'
    else if (dialect === 'sqlserver') result += ' IDENTITY(1,1)'
  }
  if (!column.nullable || column.primaryKey) result += ' NOT NULL'
  const defaultValue = defaultExpression(column.defaultValue)
  if (defaultValue !== null) result += ` DEFAULT ${defaultValue}`
  if (dialect === 'mysql' && column.comment?.trim()) result += ` COMMENT '${column.comment.trim().replace(/'/g, "''")}'`
  return result
}

export function compileCreateTable(
  dialect: RelationalDialect,
  target: DatabaseObjectRef,
  columns: TableColumnDefinition[],
  fallbackDatabase?: string
): string {
  if (!Array.isArray(columns)) throw new Error('表定义必须包含 columns 数组')
  if (!columns.length) throw new Error('新表至少需要一列')
  const activeNames = new Set<string>()
  for (const column of columns) {
    const key = column.name.toLocaleLowerCase()
    if (activeNames.has(key)) throw new Error(`列名重复：${column.name}`)
    activeNames.add(key)
  }
  const primary = columns.filter((column) => column.primaryKey)
  const sqliteInline = dialect === 'sqlite' && primary.length === 1 && primary[0].autoIncrement
  const definitions = columns.map((column) => sqliteInline && column === primary[0]
    ? `${quoteRelationalIdentifier(dialect, column.name)} INTEGER PRIMARY KEY AUTOINCREMENT`
    : compileColumnDefinition(dialect, column))
  if (!sqliteInline && primary.length) {
    definitions.push(`PRIMARY KEY (${primary.map((column) => quoteRelationalIdentifier(dialect, column.name)).join(', ')})`)
  }
  return `CREATE TABLE ${relationalTable(dialect, target, fallbackDatabase)} (\n  ${definitions.join(',\n  ')}\n)`
}

function targetWithName(target: DatabaseObjectRef, name: string): DatabaseObjectRef {
  return { ...target, name }
}

/** 编译关系型对象级操作；所有标识符在主进程转义，DDL 表达式经过基础危险片段校验。 */
export function compileRelationalOperation(
  operation: DatabaseOperation,
  dialect: RelationalDialect,
  fallbackDatabase?: string
): ParameterizedCommand[] {
  if (operation.kind === 'database.drop') {
    if (dialect === 'sqlite') throw new Error('SQLite 不支持删除数据库')
    if (isSystemDatabase(dialect, operation.database)) throw new Error('不能删除系统数据库')
    return [{ sql: `DROP DATABASE ${quoteRelationalIdentifier(dialect, operation.database)}`, params: [] }]
  }
  if (operation.kind === 'records.mutate') return compileRecordCommands(operation, dialect, fallbackDatabase)
  if (operation.kind === 'records.clear') {
    return [{ sql: `DELETE FROM ${relationalTable(dialect, operation.target, fallbackDatabase)}`, params: [] }]
  }
  if (operation.kind === 'object.create') {
    if (operation.objectType === 'database') {
      if (dialect === 'sqlite') throw new Error('SQLite 数据库由文件创建流程管理')
      return [{ sql: `CREATE DATABASE ${quoteRelationalIdentifier(dialect, operation.name)}`, params: [] }]
    }
    if (operation.objectType !== 'table') throw new Error('关系型驱动只能创建数据库或表对象')
    const target: DatabaseObjectRef = {
      kind: 'table', name: operation.name, database: operation.database, schema: operation.schema
    }
    return [{
      sql: compileCreateTable(dialect, target, operation.definition.columns as TableColumnDefinition[], fallbackDatabase),
      params: []
    }]
  }
  if (operation.kind === 'object.alter') {
    return compileAlterTable(dialect, operation.target, operation.changes, fallbackDatabase)
      .map((sql) => ({ sql, params: [] }))
  }
  if (operation.kind === 'object.copy') {
    const source = relationalTable(dialect, operation.source, fallbackDatabase)
    const target = relationalTable(dialect, targetWithName(operation.source, operation.targetName), fallbackDatabase)
    if (dialect === 'mysql') return [
      { sql: `CREATE TABLE ${target} LIKE ${source}`, params: [] },
      ...(operation.withData ? [{ sql: `INSERT INTO ${target} SELECT * FROM ${source}`, params: [] }] : [])
    ]
    if (dialect === 'postgres') return [
      { sql: `CREATE TABLE ${target} (LIKE ${source} INCLUDING ALL)`, params: [] },
      ...(operation.withData ? [{ sql: `INSERT INTO ${target} OVERRIDING SYSTEM VALUE SELECT * FROM ${source}`, params: [] }] : [])
    ]
    if (dialect === 'sqlserver') return [{
      sql: `SELECT ${operation.withData ? '*' : 'TOP (0) *'} INTO ${target} FROM ${source}`,
      params: []
    }]
    return [{
      sql: `CREATE TABLE ${target} AS SELECT * FROM ${source}${operation.withData ? '' : ' WHERE 0'}`,
      params: []
    }]
  }
  if (operation.kind === 'object.drop') {
    return [{ sql: `DROP TABLE ${relationalTable(dialect, operation.target, fallbackDatabase)}`, params: [] }]
  }
  const quote = (name: string): string => quoteRelationalIdentifier(dialect, name)
  if (operation.kind === 'index.create') {
    const definition = indexColumns(operation.definition)
    const table = relationalTable(dialect, operation.target, fallbackDatabase)
    let name = quote(operation.name)
    if (dialect === 'postgres') name = `${quote(operation.target.schema ?? 'public')}.${name}`
    if (dialect === 'sqlite') name = `${quote(operation.target.database ?? 'main')}.${name}`
    const onTable = dialect === 'sqlite' ? quote(operation.target.name) : table
    return [{
      sql: `CREATE ${definition.unique ? 'UNIQUE ' : ''}INDEX ${name} ON ${onTable} (${definition.columns.map(quote).join(', ')})`,
      params: []
    }]
  }
  if (operation.kind === 'index.drop') {
    if (dialect === 'mysql') return [{
      sql: `DROP INDEX ${quote(operation.name)} ON ${relationalTable(dialect, operation.target, fallbackDatabase)}`,
      params: []
    }]
    if (dialect === 'sqlserver') return [{
      sql: `DROP INDEX ${quote(operation.name)} ON ${relationalTable(dialect, operation.target, fallbackDatabase)}`,
      params: []
    }]
    const namespace = dialect === 'postgres' ? operation.target.schema ?? 'public' : operation.target.database ?? 'main'
    return [{ sql: `DROP INDEX ${quote(namespace)}.${quote(operation.name)}`, params: [] }]
  }
  throw new Error('关系型驱动尚未接入该结构化操作')
}

export function compileAlterTable(
  dialect: RelationalDialect,
  target: DatabaseObjectRef,
  changes: TableColumnChange[],
  fallbackDatabase?: string
): string[] {
  const table = relationalTable(dialect, target, fallbackDatabase)
  const quote = (name: string): string => quoteRelationalIdentifier(dialect, name)
  const commands: string[] = []
  for (const change of changes) {
    if (change.kind === 'add') {
      commands.push(`ALTER TABLE ${table} ADD${dialect === 'sqlserver' ? '' : ' COLUMN'} ${compileColumnDefinition(dialect, change.column)}`)
      continue
    }
    if (change.kind === 'drop') {
      commands.push(`ALTER TABLE ${table} DROP COLUMN ${quote(change.name)}`)
      continue
    }
    const renamed = change.previousName !== change.column.name
    if (dialect === 'mysql') {
      commands.push(`ALTER TABLE ${table} CHANGE COLUMN ${quote(change.previousName)} ${compileColumnDefinition(dialect, change.column)}`)
    } else if (dialect === 'postgres') {
      if (renamed) commands.push(`ALTER TABLE ${table} RENAME COLUMN ${quote(change.previousName)} TO ${quote(change.column.name)}`)
      commands.push(`ALTER TABLE ${table} ALTER COLUMN ${quote(change.column.name)} TYPE ${safeType(change.column.dataType)}`)
      commands.push(`ALTER TABLE ${table} ALTER COLUMN ${quote(change.column.name)} ${change.column.nullable ? 'DROP' : 'SET'} NOT NULL`)
      const value = defaultExpression(change.column.defaultValue)
      commands.push(value === null
        ? `ALTER TABLE ${table} ALTER COLUMN ${quote(change.column.name)} DROP DEFAULT`
        : `ALTER TABLE ${table} ALTER COLUMN ${quote(change.column.name)} SET DEFAULT ${value}`)
    } else if (dialect === 'sqlserver') {
      if (renamed) {
        const schema = target.schema ?? 'dbo'
        const oldPath = `${schema}.${target.name}.${change.previousName}`.replace(/'/g, "''")
        commands.push(`EXEC sp_rename N'${oldPath}', N'${change.column.name.replace(/'/g, "''")}', 'COLUMN'`)
      }
      commands.push(`ALTER TABLE ${table} ALTER COLUMN ${quote(change.column.name)} ${safeType(change.column.dataType)} ${change.column.nullable ? 'NULL' : 'NOT NULL'}`)
    } else {
      if (!renamed) throw new Error('SQLite 不支持直接修改列类型、默认值或可空性')
      commands.push(`ALTER TABLE ${table} RENAME COLUMN ${quote(change.previousName)} TO ${quote(change.column.name)}`)
    }
  }
  return commands
}

export function indexColumns(definition: Record<string, unknown>): { columns: string[]; unique: boolean } {
  if (!Array.isArray(definition.columns) || !definition.columns.length || !definition.columns.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error('索引定义必须包含非空 columns 数组')
  }
  return { columns: definition.columns as string[], unique: definition.unique === true }
}
