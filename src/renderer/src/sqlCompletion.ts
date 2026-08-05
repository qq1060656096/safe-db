import {
  ifNotIn,
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionSource
} from '@codemirror/autocomplete'
import {
  MySQL,
  PostgreSQL,
  SQLite,
  StandardSQL,
  sql,
  type SQLConfig,
  type SQLDialect,
  type SQLNamespace
} from '@codemirror/lang-sql'
import type { Extension } from '@codemirror/state'
import type { DbType } from '../../shared/types'

export interface SqlCompletionColumn {
  name: string
  dataType: string
  isPrimaryKey?: boolean
  comment?: string
}

export interface SqlCompletionTable {
  name: string
  type: 'table' | 'view'
  database?: string
  schema?: string
  comment?: string
  columns: SqlCompletionColumn[]
}

export interface SqlCompletionCatalog {
  dbType?: DbType
  database?: string
  defaultSchema?: string
  databases?: string[]
  tables: SqlCompletionTable[]
  loadColumns?: (table: SqlCompletionTable) => Promise<SqlCompletionColumn[]>
}

interface FunctionSpec {
  label: string
  signature: string
  snippet: string
}

const commonFunctions: FunctionSpec[] = [
  { label: 'COUNT', signature: 'COUNT(expression)', snippet: 'COUNT(${expression})' },
  { label: 'SUM', signature: 'SUM(expression)', snippet: 'SUM(${expression})' },
  { label: 'AVG', signature: 'AVG(expression)', snippet: 'AVG(${expression})' },
  { label: 'MIN', signature: 'MIN(expression)', snippet: 'MIN(${expression})' },
  { label: 'MAX', signature: 'MAX(expression)', snippet: 'MAX(${expression})' },
  { label: 'COALESCE', signature: 'COALESCE(value, ...)', snippet: 'COALESCE(${value}, ${fallback})' },
  { label: 'NULLIF', signature: 'NULLIF(value1, value2)', snippet: 'NULLIF(${value1}, ${value2})' },
  { label: 'CAST', signature: 'CAST(expression AS type)', snippet: 'CAST(${expression} AS ${type})' },
  { label: 'LOWER', signature: 'LOWER(text)', snippet: 'LOWER(${text})' },
  { label: 'UPPER', signature: 'UPPER(text)', snippet: 'UPPER(${text})' },
  { label: 'LENGTH', signature: 'LENGTH(text)', snippet: 'LENGTH(${text})' },
  { label: 'SUBSTRING', signature: 'SUBSTRING(text, start, length)', snippet: 'SUBSTRING(${text}, ${start}, ${length})' },
  { label: 'TRIM', signature: 'TRIM(text)', snippet: 'TRIM(${text})' },
  { label: 'ROUND', signature: 'ROUND(number, digits)', snippet: 'ROUND(${number}, ${digits})' },
  { label: 'ABS', signature: 'ABS(number)', snippet: 'ABS(${number})' }
]

const functionsByDialect: Record<DbType, FunctionSpec[]> = {
  mysql: [
    { label: 'CONCAT', signature: 'CONCAT(value, ...)', snippet: 'CONCAT(${value1}, ${value2})' },
    { label: 'CONCAT_WS', signature: 'CONCAT_WS(separator, value, ...)', snippet: 'CONCAT_WS(${separator}, ${value1}, ${value2})' },
    { label: 'GROUP_CONCAT', signature: 'GROUP_CONCAT(expression)', snippet: 'GROUP_CONCAT(${expression})' },
    { label: 'IFNULL', signature: 'IFNULL(value, fallback)', snippet: 'IFNULL(${value}, ${fallback})' },
    { label: 'DATE_FORMAT', signature: 'DATE_FORMAT(date, format)', snippet: 'DATE_FORMAT(${date}, ${format})' },
    { label: 'STR_TO_DATE', signature: 'STR_TO_DATE(text, format)', snippet: 'STR_TO_DATE(${text}, ${format})' },
    { label: 'NOW', signature: 'NOW()', snippet: 'NOW()' },
    { label: 'CURDATE', signature: 'CURDATE()', snippet: 'CURDATE()' },
    { label: 'DATEDIFF', signature: 'DATEDIFF(date1, date2)', snippet: 'DATEDIFF(${date1}, ${date2})' },
    { label: 'DATE_ADD', signature: 'DATE_ADD(date, INTERVAL value unit)', snippet: 'DATE_ADD(${date}, INTERVAL ${value} ${unit})' },
    { label: 'DATE_SUB', signature: 'DATE_SUB(date, INTERVAL value unit)', snippet: 'DATE_SUB(${date}, INTERVAL ${value} ${unit})' },
    { label: 'UNIX_TIMESTAMP', signature: 'UNIX_TIMESTAMP(date)', snippet: 'UNIX_TIMESTAMP(${date})' },
    { label: 'FROM_UNIXTIME', signature: 'FROM_UNIXTIME(timestamp)', snippet: 'FROM_UNIXTIME(${timestamp})' },
    { label: 'JSON_EXTRACT', signature: 'JSON_EXTRACT(json, path)', snippet: 'JSON_EXTRACT(${json}, ${path})' },
    { label: 'JSON_UNQUOTE', signature: 'JSON_UNQUOTE(json)', snippet: 'JSON_UNQUOTE(${json})' },
    { label: 'JSON_OBJECT', signature: 'JSON_OBJECT(key, value, ...)', snippet: 'JSON_OBJECT(${key}, ${value})' },
    { label: 'FIND_IN_SET', signature: 'FIND_IN_SET(value, list)', snippet: 'FIND_IN_SET(${value}, ${list})' }
  ],
  postgres: [
    { label: 'STRING_AGG', signature: 'STRING_AGG(value, delimiter)', snippet: 'STRING_AGG(${value}, ${delimiter})' },
    { label: 'ARRAY_AGG', signature: 'ARRAY_AGG(expression)', snippet: 'ARRAY_AGG(${expression})' },
    { label: 'JSON_AGG', signature: 'JSON_AGG(expression)', snippet: 'JSON_AGG(${expression})' },
    { label: 'JSONB_AGG', signature: 'JSONB_AGG(expression)', snippet: 'JSONB_AGG(${expression})' },
    { label: 'JSON_BUILD_OBJECT', signature: 'JSON_BUILD_OBJECT(key, value, ...)', snippet: 'JSON_BUILD_OBJECT(${key}, ${value})' },
    { label: 'TO_CHAR', signature: 'TO_CHAR(value, format)', snippet: 'TO_CHAR(${value}, ${format})' },
    { label: 'TO_DATE', signature: 'TO_DATE(text, format)', snippet: 'TO_DATE(${text}, ${format})' },
    { label: 'NOW', signature: 'NOW()', snippet: 'NOW()' },
    { label: 'DATE_TRUNC', signature: 'DATE_TRUNC(field, source)', snippet: 'DATE_TRUNC(${field}, ${source})' },
    { label: 'AGE', signature: 'AGE(timestamp)', snippet: 'AGE(${timestamp})' },
    { label: 'GENERATE_SERIES', signature: 'GENERATE_SERIES(start, stop, step)', snippet: 'GENERATE_SERIES(${start}, ${stop}, ${step})' },
    { label: 'UNNEST', signature: 'UNNEST(array)', snippet: 'UNNEST(${array})' },
    { label: 'REGEXP_REPLACE', signature: 'REGEXP_REPLACE(text, pattern, replacement)', snippet: 'REGEXP_REPLACE(${text}, ${pattern}, ${replacement})' },
    { label: 'SPLIT_PART', signature: 'SPLIT_PART(text, delimiter, field)', snippet: 'SPLIT_PART(${text}, ${delimiter}, ${field})' },
    { label: 'PG_TYPEOF', signature: 'PG_TYPEOF(value)', snippet: 'PG_TYPEOF(${value})' }
  ],
  sqlite: [
    { label: 'GROUP_CONCAT', signature: 'GROUP_CONCAT(expression, separator)', snippet: 'GROUP_CONCAT(${expression}, ${separator})' },
    { label: 'TOTAL', signature: 'TOTAL(expression)', snippet: 'TOTAL(${expression})' },
    { label: 'IFNULL', signature: 'IFNULL(value, fallback)', snippet: 'IFNULL(${value}, ${fallback})' },
    { label: 'IIF', signature: 'IIF(condition, trueValue, falseValue)', snippet: 'IIF(${condition}, ${trueValue}, ${falseValue})' },
    { label: 'PRINTF', signature: 'PRINTF(format, ...)', snippet: 'PRINTF(${format}, ${value})' },
    { label: 'INSTR', signature: 'INSTR(text, substring)', snippet: 'INSTR(${text}, ${substring})' },
    { label: 'REPLACE', signature: 'REPLACE(text, search, replacement)', snippet: 'REPLACE(${text}, ${search}, ${replacement})' },
    { label: 'SUBSTR', signature: 'SUBSTR(text, start, length)', snippet: 'SUBSTR(${text}, ${start}, ${length})' },
    { label: 'RANDOM', signature: 'RANDOM()', snippet: 'RANDOM()' },
    { label: 'DATE', signature: 'DATE(value, modifier, ...)', snippet: 'DATE(${value})' },
    { label: 'TIME', signature: 'TIME(value, modifier, ...)', snippet: 'TIME(${value})' },
    { label: 'DATETIME', signature: 'DATETIME(value, modifier, ...)', snippet: 'DATETIME(${value})' },
    { label: 'JULIANDAY', signature: 'JULIANDAY(value)', snippet: 'JULIANDAY(${value})' },
    { label: 'STRFTIME', signature: 'STRFTIME(format, value)', snippet: 'STRFTIME(${format}, ${value})' },
    { label: 'JSON_EXTRACT', signature: 'JSON_EXTRACT(json, path)', snippet: 'JSON_EXTRACT(${json}, ${path})' },
    { label: 'JSON_OBJECT', signature: 'JSON_OBJECT(key, value, ...)', snippet: 'JSON_OBJECT(${key}, ${value})' },
    { label: 'TYPEOF', signature: 'TYPEOF(value)', snippet: 'TYPEOF(${value})' }
  ]
}

function dialectFor(type?: DbType): SQLDialect {
  if (type === 'mysql') return MySQL
  if (type === 'postgres') return PostgreSQL
  if (type === 'sqlite') return SQLite
  return StandardSQL
}

function columnCompletion(column: SqlCompletionColumn): Completion {
  const detail = [column.dataType, column.isPrimaryKey ? 'PK' : ''].filter(Boolean).join(' · ')
  return {
    label: column.name,
    type: 'property',
    detail,
    info: column.comment
  }
}

function tableNamespace(table: SqlCompletionTable): SQLNamespace {
  return {
    self: {
      label: table.name,
      type: table.type === 'view' ? 'interface' : 'class',
      detail: table.type,
      info: table.comment,
      boost: 2
    },
    children: table.columns.map(columnCompletion)
  }
}

function databaseNamespace(name: string, children: Record<string, SQLNamespace>): SQLNamespace {
  return {
    self: { label: name, type: 'namespace', detail: 'database' },
    children
  }
}

function schemaNamespace(name: string, children: Record<string, SQLNamespace>): SQLNamespace {
  return {
    self: { label: name, type: 'namespace', detail: 'schema' },
    children
  }
}

function buildSchema(catalog: SqlCompletionCatalog): Pick<SQLConfig, 'schema' | 'defaultSchema'> {
  const root: Record<string, SQLNamespace> = Object.create(null)

  if (catalog.dbType === 'postgres') {
    const schemas = new Map<string, Record<string, SQLNamespace>>()
    for (const table of catalog.tables) {
      const schemaName = table.schema ?? 'public'
      const tables = schemas.get(schemaName) ?? Object.create(null) as Record<string, SQLNamespace>
      tables[table.name] = tableNamespace(table)
      schemas.set(schemaName, tables)
    }
    for (const [name, tables] of schemas) root[name] = schemaNamespace(name, tables)
    return { schema: root, defaultSchema: catalog.defaultSchema ?? 'public' }
  }

  const databases = new Map<string, Record<string, SQLNamespace>>()
  for (const name of catalog.databases ?? []) databases.set(name, Object.create(null) as Record<string, SQLNamespace>)
  for (const table of catalog.tables) {
    const database = table.database ?? catalog.database
    if (!database) {
      root[table.name] = tableNamespace(table)
      continue
    }
    const tables = databases.get(database) ?? Object.create(null) as Record<string, SQLNamespace>
    tables[table.name] = tableNamespace(table)
    databases.set(database, tables)
  }
  for (const [name, tables] of databases) root[name] = databaseNamespace(name, tables)
  return { schema: root, defaultSchema: catalog.database }
}

function identifierParts(value: string): string[] {
  return value
    .match(/`[^`]+`|"[^"]+"|\[[^\]]+\]|[A-Za-z_][\w$]*/g)
    ?.map((part) => part.replace(/^([`"\[])(.*)[`"\]]$/, '$2')) ?? []
}

function statementAt(doc: string, position: number): string {
  const start = doc.lastIndexOf(';', Math.max(0, position - 1)) + 1
  const nextEnd = doc.indexOf(';', position)
  return doc.slice(start, nextEnd === -1 ? doc.length : nextEnd)
}

interface RelationReference {
  table: SqlCompletionTable
  alias?: string
}

const aliasStopWords = new Set([
  'where', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'on', 'group', 'order',
  'having', 'limit', 'offset', 'union', 'set', 'values', 'returning'
])

function relationReferences(doc: string, position: number, catalog: SqlCompletionCatalog): RelationReference[] {
  const statement = statementAt(doc, position)
  const identifier = '(?:`[^`]+`|"[^"]+"|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)'
  const relation = new RegExp(`\\b(?:from|join|update|into)\\s+(${identifier}(?:\\s*\\.\\s*${identifier}){0,2})(?:\\s+(?:as\\s+)?(${identifier}))?`, 'gi')
  const result = new Map<string, RelationReference>()

  for (const match of statement.matchAll(relation)) {
    const parts = identifierParts(match[1])
    const tableName = parts.at(-1)?.toLowerCase()
    const qualifier = parts.at(-2)?.toLowerCase()
    const rawAlias = match[2] ? identifierParts(match[2])[0] : undefined
    const alias = rawAlias && !aliasStopWords.has(rawAlias.toLowerCase()) ? rawAlias : undefined
    if (!tableName) continue
    for (const table of catalog.tables) {
      if (table.name.toLowerCase() !== tableName) continue
      if (qualifier && table.schema?.toLowerCase() !== qualifier && table.database?.toLowerCase() !== qualifier) continue
      result.set(`${table.database ?? ''}.${table.schema ?? ''}.${table.name}`, { table, alias })
    }
  }
  return [...result.values()]
}

async function columnsForTable(catalog: SqlCompletionCatalog, table: SqlCompletionTable): Promise<SqlCompletionColumn[]> {
  if (table.columns.length) return table.columns
  return catalog.loadColumns ? catalog.loadColumns(table) : []
}

async function contextualColumnCompletions(context: CompletionContext, catalog: SqlCompletionCatalog): Promise<Completion[]> {
  const found = new Map<string, { column: SqlCompletionColumn; tables: string[] }>()
  const references = relationReferences(context.state.doc.toString(), context.pos, catalog)
  const columns = await Promise.all(references.map(({ table }) => columnsForTable(catalog, table)))
  for (let index = 0; index < references.length; index++) {
    const table = references[index].table
    for (const column of columns[index]) {
      const key = column.name.toLowerCase()
      const existing = found.get(key)
      if (existing) existing.tables.push(table.name)
      else found.set(key, { column, tables: [table.name] })
    }
  }
  return [...found.values()].map(({ column, tables }) => ({
    ...columnCompletion(column),
    detail: `${[...new Set(tables)].join(', ')} · ${column.dataType}`,
    boost: 1
  }))
}

function parentPath(context: CompletionContext, from: number): string[] {
  const before = context.state.sliceDoc(0, from)
  const identifier = '(?:`[^`]+`|"[^"]+"|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)'
  const match = before.match(new RegExp(`(${identifier}(?:\\s*\\.\\s*${identifier})*)\\s*\\.\\s*$`))
  return match ? identifierParts(match[1]) : []
}

function tableForPath(context: CompletionContext, catalog: SqlCompletionCatalog, parents: string[]): SqlCompletionTable | undefined {
  const last = parents.at(-1)?.toLowerCase()
  if (!last) return undefined
  const references = relationReferences(context.state.doc.toString(), context.pos, catalog)
  if (parents.length === 1) {
    const aliased = references.find(({ alias }) => alias?.toLowerCase() === last)
    if (aliased) return aliased.table
  }
  const qualifier = parents.at(-2)?.toLowerCase()
  return catalog.tables.find((table) => {
    if (table.name.toLowerCase() !== last) return false
    if (qualifier && table.schema?.toLowerCase() !== qualifier && table.database?.toLowerCase() !== qualifier) return false
    if (!qualifier && catalog.database && table.database && table.database !== catalog.database) return false
    return true
  })
}

function isRelationPosition(context: CompletionContext, from: number): boolean {
  const before = statementAt(context.state.sliceDoc(0, from), from)
  return /\b(?:from|join|update|into)\s*$/i.test(before)
}

function functionCompletions(type?: DbType): Completion[] {
  const dialectFunctions = type ? functionsByDialect[type] : []
  const unique = new Map<string, FunctionSpec>()
  for (const item of [...commonFunctions, ...dialectFunctions]) unique.set(item.label, item)
  return [...unique.values()].map((item) => snippetCompletion(item.snippet, {
    label: item.label,
    type: 'function',
    detail: item.signature,
    boost: 1
  }))
}

function supplementalCompletionSource(catalog: SqlCompletionCatalog): CompletionSource {
  const functions = functionCompletions(catalog.dbType)
  const source: CompletionSource = async (context) => {
    const word = context.matchBefore(/[A-Za-z_][\w$]*$/)
    const from = word?.from ?? context.pos
    const parents = parentPath(context, from)
    if (!word && !context.explicit && !parents.length) return null
    if (parents.length) {
      const table = tableForPath(context, catalog, parents)
      if (!table) return null
      return {
        from,
        options: (await columnsForTable(catalog, table)).map(columnCompletion),
        validFor: /^[\w$]*$/
      }
    }
    const columns = await contextualColumnCompletions(context, catalog)
    return {
      from,
      options: [...columns, ...(isRelationPosition(context, from) ? [] : functions)],
      validFor: /^[\w$]*$/
    }
  }
  return ifNotIn(['QuotedIdentifier', 'String', 'LineComment', 'BlockComment'], source)
}

export function sqlCompletionExtension(catalog: SqlCompletionCatalog): Extension {
  const dialect = dialectFor(catalog.dbType)
  const schema = buildSchema(catalog)
  return [
    sql({
      dialect,
      ...schema,
      keywordCompletion: (label, type) => ({
        label,
        type,
        detail: type === 'type' ? 'type' : type === 'keyword' ? 'keyword' : 'builtin',
        boost: type === 'keyword' ? -1 : 0
      })
    }),
    dialect.language.data.of({ autocomplete: supplementalCompletionSource(catalog) })
  ]
}
