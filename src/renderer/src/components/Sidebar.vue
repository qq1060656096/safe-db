<script setup lang="ts">
import { computed, h, onBeforeUnmount, ref, watch } from 'vue'
import { AppstoreOutlined, ClearOutlined, CodeOutlined, CopyOutlined, DatabaseOutlined, DeleteOutlined, DisconnectOutlined, EditOutlined, ExportOutlined, EyeOutlined, FolderOutlined, FunctionOutlined, HistoryOutlined, ImportOutlined, LockOutlined, MenuFoldOutlined, MoreOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, TableOutlined, UndoOutlined, UnlockOutlined } from '@vicons/antd'
import { NButton, NCard, NCheckbox, NDropdown, NFormItem, NIcon, NInput, NModal, NTag, NTooltip, NTree, useDialog, useMessage, type DropdownOption, type TreeOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ConnectionMeta, DbType, PermissionMode, RoutineInfo, SavedQuery, TableInfo } from '../../../shared/types'
import { isAppLocale, localeOptions } from '../i18n'
import { invalidateConnectionMetadata, loadColumnMetadata, loadDatabaseMetadata, loadTableMetadata } from '../metadataCache'
import { useAppStore } from '../stores/app'
import { useLayoutStore } from '../stores/layout'
import { useSettingsStore } from '../stores/settings'
import { toCsv, toJson } from '../utils'
import ConnectionDialog from './ConnectionDialog.vue'
import DatabaseTypeIcon from './DatabaseTypeIcon.vue'

type NodeData =
  | { kind: 'connection'; connectionId: string }
  | { kind: 'database'; connectionId: string; database: string }
  | { kind: 'schema'; connectionId: string; database?: string; schema: string }
  | { kind: 'objectGroup'; connectionId: string; database: string; schema?: string; group: 'tables' | 'views' | 'routines'; count: number }
  | { kind: 'savedQueryGroup'; connectionId: string; database?: string; count: number }
  | { kind: 'savedQuery'; query: SavedQuery }
  | { kind: 'table'; connectionId: string; database?: string; schema?: string; table: string; tableType: 'table' | 'view'; comment?: string }
  | { kind: 'routine'; connectionId: string; database: string; schema?: string; routine: string; routineType: 'function' | 'procedure'; arguments?: string }
interface DbTreeNode extends TreeOption { data: NodeData; children?: DbTreeNode[] }
type TreeKey = string | number

const store = useAppStore()
const layoutStore = useLayoutStore()
const settings = useSettingsStore()
const { t } = useI18n()
const dialog = useDialog()
const message = useMessage()
const treeData = ref<DbTreeNode[]>([])
const search = ref('')
const expandedKeys = ref<TreeKey[]>([])
const selectedKeys = ref<TreeKey[]>([])
const dialogOpen = ref(false)
const editing = ref<ConnectionMeta | null>(null)
const contextMenuShow = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
const contextMenuNode = ref<DbTreeNode | null>(null)
const permissionChangingId = ref<string | null>(null)
const duplicatingConnectionId = ref<string | null>(null)
type ConnectionActivity = 'connecting' | 'refreshing'
const connectionActivities = ref<Record<string, ConnectionActivity>>({})
const copyModalOpen = ref(false)
const copySource = ref<Extract<NodeData, { kind: 'table' }> | null>(null)
const copyTargetName = ref('')
const copyWithData = ref(true)
const copyingTable = ref(false)

const permissionType: Record<PermissionMode, 'info' | 'warning' | 'success'> = { readonly: 'info', approval: 'warning', full: 'success' }
function renderConnectionTypeIcon(connection: ConnectionMeta): ReturnType<typeof h> {
  return h(DatabaseTypeIcon, {
    type: connection.type,
    color: connection.color,
    muted: !store.connectedIds[connection.id]
  })
}
const languageOptions = localeOptions.map<DropdownOption>(({ value, label }) => ({ key: value, label }))
function selectLocale(value: string | number): void {
  if (isAppLocale(value)) settings.setLocale(value)
}
const queryConnectionOptions = computed<DropdownOption[]>(() => store.connections.length
  ? store.connections.map((connection) => ({
      key: connection.id,
      label: connection.name,
      icon: () => renderConnectionTypeIcon(connection)
    }))
  : [{ key: 'empty', label: t('sidebar.noConnections'), disabled: true }]
)
const connectionTransferOptions = computed<DropdownOption[]>(() => [
  { key: 'language', label: t('common.language'), children: languageOptions },
  { type: 'divider', key: 'language-divider' },
  { key: 'import', label: t('sidebar.importConnections'), icon: () => h(NIcon, null, { default: () => h(ImportOutlined) }) },
  { key: 'export', label: t('sidebar.exportConnections'), disabled: store.connections.length === 0, icon: () => h(NIcon, null, { default: () => h(ExportOutlined) }) },
  { type: 'divider', key: 'layout-divider' },
  { key: 'reset-current-layout', label: t('layout.resetCurrent'), icon: () => h(NIcon, null, { default: () => h(UndoOutlined) }) },
  { key: 'reset-all-layout', label: t('layout.resetAll'), icon: () => h(NIcon, null, { default: () => h(UndoOutlined) }) }
])

function connectionKey(id: string): string { return `conn:${id}` }
function databaseKey(id: string, database: string): string { return `db:${id}:${database}` }
function savedQueryGroupKey(id: string, database?: string): string { return `query-group:${id}:${database ?? ''}` }
function sqlLiteral(value: string): string { return `'${value.replace(/'/g, "''")}'` }
function quoteIdentifier(type: DbType | undefined, name: string): string {
  if (type === 'mysql') return '`' + name.replace(/`/g, '``') + '`'
  if (type === 'sqlserver') return '[' + name.replace(/]/g, ']]') + ']'
  return '"' + name.replace(/"/g, '""') + '"'
}
function isRelational(type: DbType | undefined): boolean { return type !== 'mongodb' && type !== 'redis' }
function qualifiedTable(type: DbType | undefined, database: string | undefined, schema: string | undefined, table: string): string {
  if (type === 'postgres') return `${quoteIdentifier(type, schema ?? 'public')}.${quoteIdentifier(type, table)}`
  if (type === 'sqlserver') return `${quoteIdentifier(type, schema ?? 'dbo')}.${quoteIdentifier(type, table)}`
  if (type === 'mysql' && database) return `${quoteIdentifier(type, database)}.${quoteIdentifier(type, table)}`
  return quoteIdentifier(type, table)
}
function connectionNode(connection: ConnectionMeta): DbTreeNode {
  return { key: connectionKey(connection.id), isLeaf: false, label: connection.name, children: withSavedQueryGroup([], connection.id), data: { kind: 'connection', connectionId: connection.id } }
}
let renderedConnections = new Map<string, ConnectionMeta>()
function rebuildRoots(): void {
  const existingNodes = new Map(treeData.value
    .filter((node) => node.data.kind === 'connection')
    .map((node) => [node.data.kind === 'connection' ? node.data.connectionId : '', node]))
  treeData.value = store.connections.map((connection) => {
    const existing = existingNodes.get(connection.id)
    return existing && renderedConnections.get(connection.id) === connection ? existing : connectionNode(connection)
  })
  renderedConnections = new Map(store.connections.map((connection) => [connection.id, connection]))
}
watch(() => store.connections, rebuildRoots, { immediate: true })

function setNodeChildren(key: TreeKey, children: DbTreeNode[] | undefined): void {
  const walk = (nodes: DbTreeNode[]): DbTreeNode[] => nodes.map((node) => {
    if (node.key === key) return { ...node, children }
    return node.children ? { ...node, children: walk(node.children) } : node
  })
  treeData.value = walk(treeData.value)
}
function savedQueryGroup(connectionId: string, database?: string): DbTreeNode {
  const queries = store.savedQueries.filter((query) => query.connectionId === connectionId && query.database === database)
  return {
    key: savedQueryGroupKey(connectionId, database),
    isLeaf: queries.length === 0,
    label: 'savedQueries',
    children: queries
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((query) => ({ key: `saved-query:${query.id}`, isLeaf: true, label: query.name, data: { kind: 'savedQuery', query } })),
    data: { kind: 'savedQueryGroup', connectionId, database, count: queries.length }
  }
}
function withSavedQueryGroup(children: DbTreeNode[], connectionId: string, database?: string): DbTreeNode[] {
  const remaining = children.filter((child) => child.data.kind !== 'savedQueryGroup')
  return [savedQueryGroup(connectionId, database), ...remaining]
}
function syncSavedQueryGroups(): void {
  const walk = (nodes: DbTreeNode[]): DbTreeNode[] => nodes.map((node) => {
    let children = node.children ? walk(node.children) : node.children
    if (children && node.data.kind === 'connection') children = withSavedQueryGroup(children, node.data.connectionId)
    else if (children && node.data.kind === 'database') children = withSavedQueryGroup(children, node.data.connectionId, node.data.database)
    return children === node.children ? node : { ...node, children }
  })
  treeData.value = walk(treeData.value)
}
watch(() => store.savedQueries, syncSavedQueryGroups, { deep: true })
function clearConnectionTree(connectionId: string): void {
  const prefixes = [`conn:${connectionId}`, `db:${connectionId}:`, `schema:${connectionId}:`, `group:${connectionId}:`, `table:${connectionId}:`, `routine:${connectionId}:`, `query-group:${connectionId}:`]
  expandedKeys.value = expandedKeys.value.filter((key) => !prefixes.some((prefix) => String(key) === prefix || String(key).startsWith(prefix)))
  setNodeChildren(connectionKey(connectionId), withSavedQueryGroup([], connectionId))
}
function updateExpandedKeys(keys: TreeKey[]): void {
  const previous = new Set(expandedKeys.value)
  expandedKeys.value = keys
  for (const key of keys) {
    const value = String(key)
    if (previous.has(key) || !value.startsWith('conn:')) continue
    const connectionId = value.slice('conn:'.length)
    void openConnection(connectionId)
  }
}
function connectionOf(id: string): ConnectionMeta | undefined { return store.connections.find((connection) => connection.id === id) }
function connectionActivityOf(id: string): ConnectionActivity | undefined { return connectionActivities.value[id] }
function setConnectionActivity(id: string, activity?: ConnectionActivity): void {
  const next = { ...connectionActivities.value }
  if (activity) next[id] = activity
  else delete next[id]
  connectionActivities.value = next
}

async function loadConnectionChildren(connectionId: string, force = false): Promise<DbTreeNode[]> {
  const connection = connectionOf(connectionId)
  if (!connection) return []
  if (!store.connectedIds[connectionId] || force) {
    const result = await window.api.connect(connectionId)
    if (!result.ok) {
      message.error(t('sidebar.connectFailed', { error: result.error }))
      store.setConnected(connectionId, false)
      return []
    }
    store.setConnected(connectionId, true)
  }
  const databases = await loadDatabaseMetadata(connectionId)
  const visibleDatabases = connection.type === 'sqlite' ? databases.filter((name) => name === 'main') : databases
  const databaseNodes: DbTreeNode[] = visibleDatabases.map((database) => ({
    key: databaseKey(connectionId, database), isLeaf: false, label: database,
    data: { kind: 'database', connectionId, database }
  }))
  return withSavedQueryGroup(databaseNodes, connectionId)
}
function tableNode(connectionId: string, database: string, table: TableInfo): DbTreeNode {
  return {
    key: `table:${connectionId}:${database}:${table.schema ?? ''}:${table.name}`, isLeaf: true, label: table.name,
    data: { kind: 'table', connectionId, database, schema: table.schema, table: table.name, tableType: table.type, comment: table.comment }
  }
}
function routineNode(connectionId: string, database: string, routine: RoutineInfo): DbTreeNode {
  return {
    key: `routine:${connectionId}:${database}:${routine.schema ?? ''}:${routine.type}:${routine.name}:${routine.arguments ?? ''}`,
    isLeaf: true,
    label: routine.name,
    data: {
      kind: 'routine', connectionId, database, schema: routine.schema, routine: routine.name,
      routineType: routine.type, arguments: routine.arguments
    }
  }
}
function objectGroups(
  connection: ConnectionMeta,
  database: string,
  schema: string | undefined,
  tables: TableInfo[],
  routines: RoutineInfo[]
): DbTreeNode[] {
  const makeGroup = (group: 'tables' | 'views' | 'routines', children: DbTreeNode[]): DbTreeNode => ({
    key: `group:${connection.id}:${database}:${schema ?? ''}:${group}`,
    isLeaf: children.length === 0,
    label: group,
    children,
    data: { kind: 'objectGroup', connectionId: connection.id, database, schema, group, count: children.length }
  })
  const tableNodes = tables.filter((table) => table.type === 'table').map((table) => tableNode(connection.id, database, table))
  const viewNodes = tables.filter((table) => table.type === 'view').map((table) => tableNode(connection.id, database, table))
  const groups = [makeGroup('tables', tableNodes), makeGroup('views', viewNodes)]
  if (connection.type === 'mysql' || connection.type === 'postgres' || connection.type === 'sqlserver') groups.push(makeGroup('routines', routines.map((routine) => routineNode(connection.id, database, routine))))
  return groups
}
async function listRoutines(connection: ConnectionMeta, database: string): Promise<RoutineInfo[]> {
  if (connection.type === 'sqlite' || connection.type === 'mongodb' || connection.type === 'redis') return []
  if (typeof window.api.listRoutines === 'function') {
    try {
      return await window.api.listRoutines(connection.id, database)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (!/No handler registered for ['"]?db:routines/.test(detail)) throw error
    }
  }
  if (connection.type === 'sqlserver') return []
  const sql = connection.type === 'mysql'
    ? `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ${sqlLiteral(database)} ORDER BY ROUTINE_TYPE, ROUTINE_NAME`
    : `SELECT n.nspname AS schema, p.proname AS name, p.prokind AS kind, pg_get_function_identity_arguments(p.oid) AS arguments
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prokind IN ('f', 'p')
       ORDER BY n.nspname, p.prokind, p.proname, arguments`
  const response = await window.api.executeSql(connection.id, sql, database)
  if (response.status !== 'ok') throw new Error(response.error ?? t('sidebar.routinesLoadFailed'))
  const rows = response.results?.find((result) => result.kind === 'rows')?.rows ?? []
  return rows.map((row) => ({
    name: String(row.name),
    type: connection.type === 'mysql'
      ? (row.type === 'PROCEDURE' ? 'procedure' : 'function')
      : (row.kind === 'p' ? 'procedure' : 'function'),
    schema: row.schema ? String(row.schema) : undefined,
    arguments: row.arguments ? String(row.arguments) : undefined
  }))
}
async function loadDatabaseChildren(connectionId: string, database: string): Promise<DbTreeNode[]> {
  const connection = connectionOf(connectionId)
  if (!connection) return []
  const [tables, routines] = await Promise.all([
    loadTableMetadata(connectionId, database),
    listRoutines(connection, database)
  ])
  const schemaNames = new Set<string>()
  for (const table of tables) if (table.schema) schemaNames.add(table.schema)
  for (const routine of routines) if (routine.schema) schemaNames.add(routine.schema)
  if (schemaNames.size === 0) return withSavedQueryGroup(objectGroups(connection, database, undefined, tables, routines), connectionId, database)
  const schemas = [...schemaNames].sort().map((schema) => ({
    key: `schema:${connectionId}:${database}:${schema}`,
    isLeaf: false,
    label: schema,
    children: objectGroups(
      connection,
      database,
      schema,
      tables.filter((table) => table.schema === schema),
      routines.filter((routine) => routine.schema === schema)
    ),
    data: { kind: 'schema', connectionId, database, schema }
  })) satisfies DbTreeNode[]
  return withSavedQueryGroup(schemas, connectionId, database)
}
async function loadNode(node: TreeOption): Promise<void> {
  const current = node as DbTreeNode
  try {
    if (current.data.kind === 'connection') setNodeChildren(current.key!, await loadConnectionChildren(current.data.connectionId))
    else if (current.data.kind === 'database') setNodeChildren(current.key!, await loadDatabaseChildren(current.data.connectionId, current.data.database))
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)); setNodeChildren(current.key!, []) }
}
async function openConnection(connectionId: string, force = false): Promise<void> {
  if (connectionActivityOf(connectionId)) return
  setConnectionActivity(connectionId, force || store.connectedIds[connectionId] ? 'refreshing' : 'connecting')
  try {
    if (force) invalidateConnectionMetadata(connectionId)
    const children = await loadConnectionChildren(connectionId, force)
    if (!store.connectedIds[connectionId]) return
    const key = connectionKey(connectionId)
    setNodeChildren(key, children)
    expandedKeys.value = [...new Set([...expandedKeys.value, key])]
  } catch (error) {
    store.setConnected(connectionId, false)
    clearConnectionTree(connectionId)
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    setConnectionActivity(connectionId)
  }
}
async function refreshTables(connectionId: string, database?: string): Promise<void> {
  if (database === undefined) return
  invalidateConnectionMetadata(connectionId)
  await loadDatabaseMetadata(connectionId).catch(() => [])
  setNodeChildren(databaseKey(connectionId, database), await loadDatabaseChildren(connectionId, database))
}
async function toggleNodeExpanded(node: DbTreeNode): Promise<void> {
  if (node.isLeaf || node.key === undefined || node.key === null) return
  const key = node.key
  if (expandedKeys.value.includes(key)) {
    expandedKeys.value = expandedKeys.value.filter((item) => item !== key)
    return
  }
  if (node.data.kind === 'connection') {
    await openConnection(node.data.connectionId)
    return
  }
  if (node.data.kind === 'database' && node.children === undefined) await loadNode(node)
  expandedKeys.value = [...new Set([...expandedKeys.value, key])]
}
function onNodeDoubleClick(event: MouseEvent, node: DbTreeNode): void {
  event.stopPropagation()
  if (node.data.kind === 'table') openTable(node.data)
  else if (node.data.kind === 'savedQuery') openSavedQuery(node.data.query)
  else if (node.data.kind === 'routine') {
    const routine = node.data
    store.openTab({ type: 'query', title: t('sidebar.routineTitle', { name: routine.routine }), connectionId: routine.connectionId, database: routine.database, schema: routine.schema, routine: routine.routine, routineType: routine.routineType, routineArguments: routine.arguments })
  } else void toggleNodeExpanded(node)
}
function openSavedQuery(query: SavedQuery): void {
  store.openSavedQuery(query)
}
function openTable(node: Extract<NodeData, { kind: 'table' }>): void {
  store.openTab({ type: 'table', title: node.table, connectionId: node.connectionId, database: node.database, schema: node.schema, table: node.table })
}
function openObjectList(node: Extract<NodeData, { kind: 'objectGroup' | 'savedQueryGroup' }>): void {
  const objectGroup = node.kind === 'savedQueryGroup' ? 'queries' : node.group
  const existing = store.tabs.find((tab) => tab.type === 'objects'
    && tab.connectionId === node.connectionId && tab.database === node.database
    && tab.schema === ('schema' in node ? node.schema : undefined) && tab.objectGroup === objectGroup)
  if (existing) {
    store.setActiveTab(existing.id)
    return
  }
  const location = node.database ?? connectionOf(node.connectionId)?.name ?? ''
  const groupTitle = objectGroup === 'queries' ? t('sidebar.savedQueries') : objectGroupLabel(objectGroup)
  store.openTab({
    type: 'objects', title: `${location} - ${groupTitle}`, connectionId: node.connectionId,
    database: node.database, schema: 'schema' in node ? node.schema : undefined, objectGroup
  })
}
function findNode(key: TreeKey, nodes: DbTreeNode[] = treeData.value): DbTreeNode | undefined {
  for (const node of nodes) {
    if (node.key === key) return node
    const found = node.children ? findNode(key, node.children) : undefined
    if (found) return found
  }
  return undefined
}
function selectTreeNode(keys: TreeKey[]): void {
  selectedKeys.value = keys
  const node = keys.length ? findNode(keys[keys.length - 1]) : undefined
  if (node?.data.kind === 'objectGroup' || node?.data.kind === 'savedQueryGroup') openObjectList(node.data)
}
function importRowsFromCsv(content: string, delimiter: string): Record<string, unknown>[] {
  const matrix: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') { cell += '"'; index += 1 }
      else if (character === '"') quoted = false
      else cell += character
    } else if (character === '"' && cell.length === 0) quoted = true
    else if (character === delimiter) { row.push(cell); cell = '' }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && content[index + 1] === '\n') index += 1
      row.push(cell); matrix.push(row); row = []; cell = ''
    } else cell += character
  }
  if (cell.length || row.length) { row.push(cell); matrix.push(row) }
  const headers = (matrix.shift() ?? []).map((header, index) => (index === 0 ? header.replace(/^\uFEFF/, '') : header).trim())
  if (!headers.length || headers.some((header) => !header)) throw new Error(t('sidebar.importMissingHeaders'))
  if (new Set(headers.map((header) => header.toLocaleLowerCase())).size !== headers.length) throw new Error(t('sidebar.importDuplicateHeaders'))
  return matrix
    .filter((values) => values.some((value) => value !== ''))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])))
}
function parseImportRows(name: string, content: string): Record<string, unknown>[] {
  const lowerName = name.toLocaleLowerCase()
  if (lowerName.endsWith('.json')) {
    const parsed = JSON.parse(content.replace(/^\uFEFF/, '')) as unknown
    const values = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { data?: unknown }).data) ? (parsed as { data: unknown[] }).data : null)
    if (!values) throw new Error(t('sidebar.importJsonArrayRequired'))
    if (values.some((value) => !value || typeof value !== 'object' || Array.isArray(value))) throw new Error(t('sidebar.importObjectRowsRequired'))
    return values as Record<string, unknown>[]
  }
  const firstLine = content.split(/\r?\n/, 1)[0] ?? ''
  const delimiter = lowerName.endsWith('.tsv') ? '\t' : ([',', '\t', ';'] as const)
    .map((value) => ({ value, count: firstLine.split(value).length - 1 }))
    .sort((left, right) => right.count - left.count)[0].value
  return importRowsFromCsv(content, delimiter)
}
function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return `'${text.replace(/'/g, "''")}'`
}
async function importTableData(connection: ConnectionMeta, node: Extract<NodeData, { kind: 'table' }>): Promise<void> {
  try {
    const file = await window.api.pickDataFile()
    if (!file) return
    const rows = parseImportRows(file.name, file.content)
    if (!rows.length) throw new Error(t('sidebar.importNoRows'))
    if (rows.length > 50000) throw new Error(t('sidebar.importTooManyRows'))
    const columns = await loadColumnMetadata(connection.id, node.database, node.table, node.schema)
    const knownColumns = new Map(columns.map((column) => [column.name.toLocaleLowerCase(), column.name]))
    const sourceColumns = new Set(rows.flatMap((row) => Object.keys(row).map((key) => key.toLocaleLowerCase())))
    const matchedColumns = [...knownColumns].filter(([lowerName]) => sourceColumns.has(lowerName)).map(([, name]) => name)
    if (!matchedColumns.length) throw new Error(t('sidebar.importNoMatchingColumns'))
    const target = qualifiedTable(connection.type, node.database, node.schema, node.table)
    const groupedRows = new Map<string, { columns: string[]; values: unknown[][] }>()
    for (const row of rows) {
      const rowValues = new Map(Object.entries(row).map(([key, value]) => [key.toLocaleLowerCase(), value]))
      const presentColumns = matchedColumns.filter((column) => rowValues.has(column.toLocaleLowerCase()))
      if (!presentColumns.length) continue
      const key = presentColumns.join('\u0000')
      const group = groupedRows.get(key) ?? { columns: presentColumns, values: [] }
      group.values.push(presentColumns.map((column) => rowValues.get(column.toLocaleLowerCase())))
      groupedRows.set(key, group)
    }
    const statements: string[] = []
    let importCount = 0
    for (const group of groupedRows.values()) {
      importCount += group.values.length
      for (let offset = 0; offset < group.values.length; offset += 500) {
        const batch = group.values.slice(offset, offset + 500)
        statements.push(`INSERT INTO ${target} (${group.columns.map((column) => quoteIdentifier(connection.type, column)).join(', ')}) VALUES\n${batch.map((values) => `(${values.map(sqlValue).join(', ')})`).join(',\n')};`)
      }
    }
    dialog.warning({
      title: t('sidebar.importDataTitle', { name: node.table }),
      content: t('sidebar.importDataHint', { file: file.name, count: importCount, columns: matchedColumns.join(', ') }),
      positiveText: t('sidebar.importDataConfirm'), negativeText: t('common.cancel'),
      onPositiveClick: async () => {
        const result = await store.executeWithApproval(connection.id, statements.join('\n'), node.database)
        if (result.status === 'ok') message.success(t('sidebar.importedData', { count: importCount, name: node.table }))
        else if (result.status === 'denied') message.warning(result.error ?? '')
        else if (result.status === 'error') message.error(result.error ?? '')
      }
    })
  } catch (error) {
    message.error(t('sidebar.importDataFailed', { error: error instanceof Error ? error.message : String(error) }))
  }
}
async function exportTableData(connection: ConnectionMeta, node: Extract<NodeData, { kind: 'table' }>, format: 'csv' | 'json'): Promise<void> {
  try {
    const first = await store.getTableData(connection.id, { database: node.database, schema: node.schema, table: node.table, page: 1, pageSize: 1 })
    const cap = 50000
    const result = first.total > 1
      ? await store.getTableData(connection.id, { database: node.database, schema: node.schema, table: node.table, page: 1, pageSize: Math.min(first.total, cap) })
      : first
    const rows = result.rows.map((row) => Object.fromEntries(result.columns.map((column) => [column.name, row[column.name]])))
    const content = format === 'csv' ? toCsv(result.columns.map((column) => column.name), rows) : toJson(rows)
    const path = await window.api.exportData({
      defaultName: `${node.table}.${format}`, content,
      fileTypes: [format === 'csv' ? { name: 'CSV', extensions: ['csv'] } : { name: 'JSON', extensions: ['json'] }]
    })
    if (path) message.success(t('sidebar.exportedData', { count: rows.length, path, cap: first.total > cap ? t('grid.capped') : '' }))
  } catch (error) {
    message.error(t('sidebar.exportDataFailed', { error: error instanceof Error ? error.message : String(error) }))
  }
}
function openCopyTable(node: Extract<NodeData, { kind: 'table' }>): void {
  copySource.value = node
  copyTargetName.value = `${node.table}_copy`
  copyWithData.value = true
  copyModalOpen.value = true
}
function closeCopyTable(): void {
  if (copyingTable.value) return
  copyModalOpen.value = false
  copySource.value = null
}
async function confirmCopyTable(): Promise<void> {
  const source = copySource.value
  const targetName = copyTargetName.value.trim()
  if (!source || !targetName) { message.warning(t('sidebar.copyTableNameRequired')); return }
  const connection = connectionOf(source.connectionId)
  if (!connection) return
  copyingTable.value = true
  try {
    const sourceSql = qualifiedTable(connection.type, source.database, source.schema, source.table)
    const targetSql = qualifiedTable(connection.type, source.database, source.schema, targetName)
    let createSql: string
    if (connection.type === 'mysql') createSql = `CREATE TABLE ${targetSql} LIKE ${sourceSql};`
    else if (connection.type === 'postgres') createSql = `CREATE TABLE ${targetSql} (LIKE ${sourceSql} INCLUDING ALL);`
    else if (connection.type === 'sqlserver') {
      createSql = `SELECT ${copyWithData.value ? '*' : 'TOP (0) *'} INTO ${targetSql} FROM ${sourceSql};`
      const result = await store.executeWithApproval(connection.id, createSql, source.database)
      if (result.status === 'ok') {
        message.success(t('sidebar.tableCopied', { source: source.table, target: targetName }))
        copyModalOpen.value = false
        copySource.value = null
        await refreshTables(connection.id, source.database)
      } else if (result.status === 'denied') message.warning(result.error ?? '')
      else if (result.status === 'error') message.error(result.error ?? '')
      return
    }
    else {
      const ddl = await window.api.getObjectDdl(connection.id, source.database, source.table, source.schema)
      const prefix = /^(\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]+\]|[^\s(]+)/i
      if (!prefix.test(ddl)) throw new Error(t('sidebar.copyTableDdlUnsupported'))
      createSql = ddl.replace(prefix, `$1${targetSql}`)
    }
    const insertPrefix = connection.type === 'postgres' ? `INSERT INTO ${targetSql} OVERRIDING SYSTEM VALUE` : `INSERT INTO ${targetSql}`
    const sql = `${createSql.replace(/;?\s*$/, ';')}${copyWithData.value ? `\n${insertPrefix} SELECT * FROM ${sourceSql};` : ''}`
    const result = await store.executeWithApproval(connection.id, sql, source.database)
    if (result.status === 'ok') {
      message.success(t('sidebar.tableCopied', { source: source.table, target: targetName }))
      copyModalOpen.value = false
      copySource.value = null
      await refreshTables(connection.id, source.database)
    } else if (result.status === 'denied') message.warning(result.error ?? '')
    else if (result.status === 'error') message.error(result.error ?? '')
  } catch (error) {
    message.error(t('sidebar.copyTableFailed', { error: error instanceof Error ? error.message : String(error) }))
  } finally {
    copyingTable.value = false
  }
}
async function runTableAction(connection: ConnectionMeta, node: Extract<NodeData, { kind: 'table' }>, action: string): Promise<void> {
  const name = qualifiedTable(connection.type, node.database, node.schema, node.table)
  if (action === 'copy') {
    await navigator.clipboard.writeText(node.table)
    message.success(t('sidebar.copiedTableName', { name: node.table }))
    return
  }
  if (action === 'duplicate') { openCopyTable(node); return }
  if (action === 'import-data') { await importTableData(connection, node); return }
  if (action === 'export-csv' || action === 'export-json') { await exportTableData(connection, node, action === 'export-csv' ? 'csv' : 'json'); return }
  if (action === 'truncate') {
    const sql = connection.type === 'sqlite' ? `DELETE FROM ${name};` : `TRUNCATE TABLE ${name};`
    dialog.warning({
      title: t('sidebar.truncateTitle', { name: node.table }), content: t('sidebar.truncateHint', { sql }), positiveText: t('sidebar.truncateOk'), negativeText: t('common.cancel'),
      onPositiveClick: async () => {
        const result = await store.executeWithApproval(connection.id, sql, node.database)
        if (result.status === 'ok') message.success(t('sidebar.truncated', { name: node.table }))
        else if (result.status === 'denied') message.warning(result.error ?? '')
        else if (result.status === 'error') message.error(result.error ?? '')
      }
    })
  } else if (action === 'drop') {
    const sql = `DROP TABLE ${name};`
    dialog.error({
      title: t('sidebar.dropTitle', { name: node.table }), content: t('sidebar.dropHint', { sql }), positiveText: t('common.delete'), negativeText: t('common.cancel'),
      onPositiveClick: async () => {
        const result = await store.executeWithApproval(connection.id, sql, node.database)
        if (result.status === 'ok') { message.success(t('sidebar.dropped', { name: node.table })); await refreshTables(connection.id, node.database) }
        else if (result.status === 'denied') message.warning(result.error ?? '')
        else if (result.status === 'error') message.error(result.error ?? '')
      }
    })
  }
}
async function onConnectionAction(connection: ConnectionMeta, action: string): Promise<void> {
  if (action === 'connect') await openConnection(connection.id)
  else if (action === 'query') store.openTab({ type: 'query', title: t('sidebar.queryTitle', { name: connection.name }), connectionId: connection.id })
  else if (action === 'refresh') await openConnection(connection.id, true)
  else if (action === 'edit') { editing.value = connection; dialogOpen.value = true }
  else if (action === 'duplicate') {
    if (duplicatingConnectionId.value) return
    duplicatingConnectionId.value = connection.id
    try {
      const existingNames = new Set(store.connections.map((item) => item.name))
      const baseName = t('sidebar.connectionCopyName', { name: connection.name })
      let copiedName = baseName
      let suffix = 2
      while (existingNames.has(copiedName)) copiedName = `${baseName} ${suffix++}`
      const copied = await store.duplicateConnection(connection.id, copiedName)
      message.success(t('sidebar.connectionCopied', { name: copied.name }))
    } catch (error) {
      message.error(t('sidebar.copyConnectionFailed', { error: error instanceof Error ? error.message : String(error) }))
    } finally {
      duplicatingConnectionId.value = null
    }
  }
  else if (action === 'disconnect') { await window.api.disconnect(connection.id); store.setConnected(connection.id, false); clearConnectionTree(connection.id) }
  else if (action === 'delete') {
    dialog.error({
      title: t('sidebar.deleteConnectionTitle', { name: connection.name }), content: t('sidebar.deleteConnectionHint'), positiveText: t('common.delete'), negativeText: t('common.cancel'),
      onPositiveClick: async () => { await store.removeConnection(connection.id); message.success(t('common.deleted')) }
    })
  }
}
function connectionOptions(connection: ConnectionMeta): DropdownOption[] {
  const connected = Boolean(store.connectedIds[connection.id])
  const busy = Boolean(connectionActivityOf(connection.id))
  return [
    { key: 'connect', label: t('sidebar.connect'), disabled: connected || busy, icon: () => h(NIcon, null, { default: () => h(DatabaseOutlined) }) },
    { key: 'query', label: t('sidebar.newQuery'), icon: () => h(NIcon, null, { default: () => h(PlusOutlined) }) },
    { key: 'refresh', label: t('common.refresh'), disabled: !connected || busy, icon: () => h(NIcon, null, { default: () => h(ReloadOutlined) }) },
    { key: 'edit', label: t('sidebar.editConnection'), disabled: busy, icon: () => h(NIcon, null, { default: () => h(EditOutlined) }) },
    { key: 'duplicate', label: t('sidebar.copyConnection'), disabled: duplicatingConnectionId.value !== null, icon: () => h(NIcon, null, { default: () => h(CopyOutlined) }) },
    { key: 'disconnect', label: t('sidebar.disconnect'), disabled: !connected || busy, icon: () => h(NIcon, null, { default: () => h(DisconnectOutlined) }) },
    { type: 'divider', key: 'divider' },
    { key: 'delete', label: t('sidebar.deleteConnection'), disabled: busy, icon: () => h(NIcon, { color: '#d03050' }, { default: () => h(DeleteOutlined) }) }
  ]
}
function tableOptions(tableType: 'table' | 'view', connection?: ConnectionMeta): DropdownOption[] {
  const common: DropdownOption[] = [
    { key: 'open', label: t('sidebar.openTable'), icon: () => h(NIcon, null, { default: () => h(TableOutlined) }) },
    { key: 'query', label: t('sidebar.newQuery'), icon: () => h(NIcon, null, { default: () => h(PlusOutlined) }) },
    { key: 'copy', label: t('sidebar.copyObjectName'), icon: () => h(NIcon, null, { default: () => h(CopyOutlined) }) }
  ]
  if (tableType === 'view') return common
  if (!isRelational(connection?.type)) return [
    common[0], ...common.slice(1),
    { key: 'export-data', label: t('sidebar.exportData'), icon: () => h(NIcon, null, { default: () => h(ExportOutlined) }), children: [
      { key: 'export-csv', label: t('sidebar.exportCsv') }, { key: 'export-json', label: t('sidebar.exportJson') }
    ] }
  ]
  return [
    common[0],
    { key: 'design', label: t('sidebar.designTable'), icon: () => h(NIcon, null, { default: () => h(EditOutlined) }) },
    ...common.slice(1),
    { key: 'duplicate', label: t('sidebar.copyTable'), icon: () => h(NIcon, null, { default: () => h(CopyOutlined) }) },
    { type: 'divider', key: 'data-divider' },
    { key: 'import-data', label: t('sidebar.importData'), icon: () => h(NIcon, null, { default: () => h(ImportOutlined) }) },
    {
      key: 'export-data', label: t('sidebar.exportData'), icon: () => h(NIcon, null, { default: () => h(ExportOutlined) }),
      children: [
        { key: 'export-csv', label: t('sidebar.exportCsv') },
        { key: 'export-json', label: t('sidebar.exportJson') }
      ]
    },
    { type: 'divider', key: 'divider' },
    { key: 'truncate', label: t('sidebar.truncateTable'), icon: () => h(NIcon, { color: '#d03050' }, { default: () => h(ClearOutlined) }) },
    { key: 'drop', label: t('sidebar.dropTable'), icon: () => h(NIcon, { color: '#d03050' }, { default: () => h(DeleteOutlined) }) }
  ]
}
function routineOptions(): DropdownOption[] {
  return [
    { key: 'query', label: t('sidebar.newQuery'), icon: () => h(NIcon, null, { default: () => h(PlusOutlined) }) },
    { key: 'copy', label: t('sidebar.copyObjectName'), icon: () => h(NIcon, null, { default: () => h(CopyOutlined) }) }
  ]
}
function onNodeAction(node: DbTreeNode, action: string | number): void {
  const key = String(action)
  if (node.data.kind === 'connection') { const connection = connectionOf(node.data.connectionId); if (connection) void onConnectionAction(connection, key); return }
  if (node.data.kind === 'savedQuery') {
    if (key === 'open') openSavedQuery(node.data.query)
    else if (key === 'delete') {
      const query = node.data.query
      dialog.error({
        title: t('sidebar.deleteSavedQueryTitle', { name: query.name }),
        content: t('sidebar.deleteSavedQueryHint'),
        positiveText: t('common.delete'),
        negativeText: t('common.cancel'),
        onPositiveClick: async () => { await store.deleteSavedQuery(query.id); message.success(t('sidebar.savedQueryDeleted', { name: query.name })) }
      })
    }
    return
  }
  if (node.data.kind === 'savedQueryGroup') {
    if (key === 'newQuery') {
      const connection = connectionOf(node.data.connectionId)
      const title = node.data.database ?? connection?.name ?? ''
      store.openTab({
        type: 'query',
        title: t('sidebar.queryTitle', { name: title }),
        connectionId: node.data.connectionId,
        database: node.data.database
      })
    }
    return
  }
  if (node.data.kind === 'database') {
    if (key === 'query') store.openTab({ type: 'query', title: t('sidebar.queryTitle', { name: node.data.database }), connectionId: node.data.connectionId, database: node.data.database })
    else if (key === 'newTable') store.openTab({ type: 'structure', title: t('sidebar.newTable'), connectionId: node.data.connectionId, database: node.data.database })
    return
  }
  if (node.data.kind === 'schema') { if (key === 'newTable') store.openTab({ type: 'structure', title: t('sidebar.newTable'), connectionId: node.data.connectionId, database: node.data.database, schema: node.data.schema }); return }
  if (node.data.kind === 'objectGroup') { if (key === 'newTable') store.openTab({ type: 'structure', title: t('sidebar.newTable'), connectionId: node.data.connectionId, database: node.data.database, schema: node.data.schema }); return }
  if (node.data.kind === 'table') {
    if (key === 'open') openTable(node.data)
    else if (key === 'design') store.openTab({ type: 'structure', title: t('sidebar.designTitle', { name: node.data.table }), connectionId: node.data.connectionId, database: node.data.database, schema: node.data.schema, table: node.data.table })
    else if (key === 'query') store.openTab({ type: 'query', title: t('sidebar.queryTitle', { name: node.data.table }), connectionId: node.data.connectionId, database: node.data.database, schema: node.data.schema })
    else { const connection = connectionOf(node.data.connectionId); if (connection) void runTableAction(connection, node.data, key) }
    return
  }
  if (node.data.kind === 'routine') {
    const routine = node.data
    if (key === 'query') store.openTab({ type: 'query', title: t('sidebar.routineTitle', { name: routine.routine }), connectionId: routine.connectionId, database: routine.database, schema: routine.schema, routine: routine.routine, routineType: routine.routineType, routineArguments: routine.arguments })
    else if (key === 'copy') void navigator.clipboard.writeText(routine.routine).then(() => message.success(t('sidebar.copiedObjectName', { name: routine.routine })))
  }
}
function nodeOptions(node: DbTreeNode): DropdownOption[] {
  if (node.data.kind === 'connection') return connectionOptions(connectionOf(node.data.connectionId)!)
  if (node.data.kind === 'savedQuery') return [
    { key: 'open', label: t('sidebar.openSavedQuery'), icon: () => h(NIcon, null, { default: () => h(CodeOutlined) }) },
    { type: 'divider', key: 'divider' },
    { key: 'delete', label: t('sidebar.deleteSavedQuery'), icon: () => h(NIcon, { color: '#d03050' }, { default: () => h(DeleteOutlined) }) }
  ]
  if (node.data.kind === 'savedQueryGroup') return [
    { key: 'newQuery', label: t('sidebar.newQuery'), icon: () => h(NIcon, null, { default: () => h(PlusOutlined) }) }
  ]
  if (node.data.kind === 'database') {
    const connection = connectionOf(node.data.connectionId)
    return [
      { key: 'query', label: t('sidebar.newQuery'), icon: () => h(NIcon, null, { default: () => h(CodeOutlined) }) },
      ...(isRelational(connection?.type) ? [{ key: 'newTable', label: t('sidebar.newTable'), icon: () => h(NIcon, null, { default: () => h(TableOutlined) }) }] : [])
    ]
  }
  if (node.data.kind === 'schema') return [{ key: 'newTable', label: t('sidebar.newTable') }]
  if (node.data.kind === 'objectGroup') return node.data.group === 'tables' && isRelational(connectionOf(node.data.connectionId)?.type) ? [{ key: 'newTable', label: t('sidebar.newTable') }] : []
  if (node.data.kind === 'routine') return routineOptions()
  return tableOptions(node.data.tableType, connectionOf(node.data.connectionId))
}
function objectGroupLabel(group: Extract<NodeData, { kind: 'objectGroup' }>['group']): string {
  return t(`sidebar.objectGroups.${group}`)
}
function permissionModeOptions(connection: ConnectionMeta): DropdownOption[] {
  return (['readonly', 'approval', 'full'] as PermissionMode[]).map((mode) => ({
    key: mode,
    label: t(`permission.${mode}`),
    disabled: mode === connection.permissionMode || permissionChangingId.value === connection.id
  }))
}
async function changePermissionMode(connection: ConnectionMeta, value: string | number): Promise<void> {
  const permissionMode = String(value) as PermissionMode
  if (connection.permissionModeLocked || permissionChangingId.value || !['readonly', 'approval', 'full'].includes(permissionMode)) return
  permissionChangingId.value = connection.id
  try {
    const saved = await store.updateConnectionPermissionMode(connection.id, permissionMode)
    if (saved?.permissionMode === permissionMode) {
      message.success(t('sidebar.permissionModeChanged', { name: connection.name, mode: t(`permission.${permissionMode}`) }))
    }
  } catch (error) {
    message.error(t('sidebar.permissionModeChangeFailed', { error: error instanceof Error ? error.message : String(error) }))
  } finally {
    permissionChangingId.value = null
  }
}
function openNodeContextMenu(event: MouseEvent, node: DbTreeNode): void {
  event.preventDefault()
  event.stopPropagation()
  contextMenuNode.value = node
  contextMenuX.value = event.clientX
  contextMenuY.value = event.clientY
  contextMenuShow.value = true
}
function treeNodeProps({ option }: { option: TreeOption }): { onContextmenu: (event: MouseEvent) => void } {
  const node = option as DbTreeNode
  return { onContextmenu: (event: MouseEvent) => openNodeContextMenu(event, node) }
}
function renderLabel({ option }: { option: TreeOption }): ReturnType<typeof h> {
  const node = option as DbTreeNode
  let content: ReturnType<typeof h>
  if (node.data.kind === 'connection') {
    const connection = connectionOf(node.data.connectionId)
    const activity = connectionActivityOf(node.data.connectionId)
    const permissionTag = connection
      ? h(NTag, { type: permissionType[connection.permissionMode], size: 'tiny' }, { default: () => t(`permission.${connection.permissionMode}`) })
      : null
    const permissionControl = connection?.permissionModeLocked
      ? [
          permissionTag,
          h('span', { class: 'connection-permission-lock', title: t('connection.permissionModeLockedHelp'), 'aria-label': t('connection.permissionModeLockedHelp') }, [h(NIcon, { size: 13 }, { default: () => h(LockOutlined) })])
        ]
      : connection
        ? h(NDropdown, {
            trigger: 'click',
            options: permissionModeOptions(connection),
            onSelect: (value: string | number) => { void changePermissionMode(connection, value) }
          }, {
            default: () => h('span', {
              class: 'connection-permission-editable',
              title: t('sidebar.changePermissionMode'),
              onClick: (event: MouseEvent) => event.stopPropagation(),
              onDblclick: (event: MouseEvent) => event.stopPropagation()
            }, [
              permissionTag,
              h('span', { class: 'connection-permission-lock connection-permission-lock--open', 'aria-label': t('connection.permissionModeUnlockedHelp') }, [h(NIcon, { size: 13 }, { default: () => h(UnlockOutlined) })])
            ])
          })
        : null
    content = h('span', { class: 'tree-node-title', onDblclick: (event: MouseEvent) => onNodeDoubleClick(event, node) }, [
      h('span', { class: 'connection-name', title: connection?.name ?? '' }, connection?.name ?? ''),
      activity ? h('span', { class: 'connection-activity-status', 'aria-live': 'polite' }, t(`sidebar.${activity}`)) : null,
      permissionControl
    ])
  } else if (node.data.kind === 'objectGroup' || node.data.kind === 'savedQueryGroup') {
    content = h('span', {
      class: 'tree-node-title',
      onClick: () => openObjectList(node.data as Extract<NodeData, { kind: 'objectGroup' | 'savedQueryGroup' }>),
      onDblclick: (event: MouseEvent) => onNodeDoubleClick(event, node)
    }, [
      node.data.kind === 'objectGroup' ? objectGroupLabel(node.data.group) : t('sidebar.savedQueries'),
      h('span', { class: 'tree-object-count' }, String(node.data.count))
    ])
  } else if (node.data.kind === 'savedQuery') {
    content = h('span', { class: 'tree-node-title', onDblclick: (event: MouseEvent) => onNodeDoubleClick(event, node) }, node.data.query.name)
  } else if (node.data.kind === 'routine') {
    const routine = node.data
    const routineName = routine.arguments !== undefined ? `${routine.routine}(${routine.arguments})` : routine.routine
    content = h('span', {
      class: 'tree-node-title',
      onDblclick: (event: MouseEvent) => onNodeDoubleClick(event, node)
    }, [routineName, h(NTag, { size: 'tiny', bordered: false }, { default: () => t(`sidebar.routineTypes.${routine.routineType}`) })])
  } else {
    const label = node.data.kind === 'database' ? node.data.database : node.data.kind === 'schema' ? node.data.schema : node.data.table
    content = h('span', { class: 'tree-node-title', onDblclick: (event: MouseEvent) => onNodeDoubleClick(event, node) }, label)
  }
  const trigger = h('span', { class: 'tree-context-trigger' }, [content])
  return node.data.kind === 'table' && node.data.comment
    ? h(NTooltip, { placement: 'right', delay: 600 }, { trigger: () => trigger, default: () => node.data.kind === 'table' ? node.data.comment : '' })
    : trigger
}
function renderPrefix({ option }: { option: TreeOption }): ReturnType<typeof h> {
  const node = option as DbTreeNode
  let component = DatabaseOutlined
  let color: string | undefined
  if (node.data.kind === 'connection') {
    const connection = connectionOf(node.data.connectionId)
    if (!connection) return h(NIcon, { color: '#999' }, { default: () => h(DatabaseOutlined) })
    const activity = connectionActivityOf(connection.id)
    return h('span', {
      class: 'connection-prefix-state',
      title: activity ? t(`sidebar.${activity}`) : undefined,
      'aria-busy': activity ? 'true' : undefined
    }, [
      renderConnectionTypeIcon(connection),
      activity
        ? h(NIcon, { class: 'connection-prefix-spinner', size: 12 }, { default: () => h(ReloadOutlined) })
        : null
    ])
  } else if (node.data.kind === 'savedQueryGroup') component = FolderOutlined
  else if (node.data.kind === 'savedQuery') component = CodeOutlined
  else if (node.data.kind === 'database') component = AppstoreOutlined
  else if (node.data.kind === 'schema') component = FolderOutlined
  else if (node.data.kind === 'objectGroup') component = node.data.group === 'tables' ? TableOutlined : node.data.group === 'views' ? EyeOutlined : FunctionOutlined
  else if (node.data.kind === 'routine') component = FunctionOutlined
  else component = node.data.tableType === 'view' ? EyeOutlined : TableOutlined
  return h(NIcon, { color }, { default: () => h(component) })
}
function nodeLabel(node: DbTreeNode): string {
  if (node.data.kind === 'connection') return connectionOf(node.data.connectionId)?.name ?? ''
  if (node.data.kind === 'savedQueryGroup') return t('sidebar.savedQueries')
  if (node.data.kind === 'savedQuery') return node.data.query.name
  if (node.data.kind === 'database') return node.data.database
  if (node.data.kind === 'schema') return node.data.schema
  if (node.data.kind === 'objectGroup') return objectGroupLabel(node.data.group)
  if (node.data.kind === 'routine') return `${node.data.routine} ${node.data.arguments ?? ''}`
  return node.data.table
}
const displayData = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  if (!keyword) return treeData.value
  const forced = new Set<TreeKey>()
  const walk = (nodes: DbTreeNode[]): DbTreeNode[] => nodes.flatMap((node) => {
    if (nodeLabel(node).toLowerCase().includes(keyword)) { if (!node.isLeaf) forced.add(node.key!); return [node] }
    const children = node.children ? walk(node.children) : []
    if (children.length) { forced.add(node.key!); return [{ ...node, children }] }
    return []
  })
  const result = walk(treeData.value)
  expandedKeys.value = [...new Set([...expandedKeys.value, ...forced])]
  return result
})
let searchMetadataTimer: ReturnType<typeof setTimeout> | null = null
let searchMetadataRequest = 0
watch(search, (keyword) => {
  if (searchMetadataTimer) clearTimeout(searchMetadataTimer)
  const request = ++searchMetadataRequest
  if (!keyword.trim()) return
  searchMetadataTimer = setTimeout(() => {
    const loads = store.connections
      .filter((connection) => store.connectedIds[connection.id])
      .map(async (connection) => {
        const root = treeData.value.find((node) => node.key === connectionKey(connection.id))
        if (root?.children?.some((node) => node.data.kind === 'database')) return
        const children = await loadConnectionChildren(connection.id)
        if (request === searchMetadataRequest) setNodeChildren(connectionKey(connection.id), children)
      })
    void Promise.all(loads).catch(() => undefined)
  }, 250)
})
onBeforeUnmount(() => { if (searchMetadataTimer) clearTimeout(searchMetadataTimer) })
function collapseAll(): void { expandedKeys.value = [] }
function openNewConnection(): void { editing.value = null; dialogOpen.value = true }
function closeDialog(): void { dialogOpen.value = false; editing.value = null }
function openNewQuery(connectionId: string | number): void {
  const connection = connectionOf(String(connectionId))
  if (connection) store.openTab({ type: 'query', title: t('sidebar.queryTitle', { name: connection.name }), connectionId: connection.id })
}
async function transferConnections(action: string | number): Promise<void> {
  if (isAppLocale(action)) { selectLocale(action); return }
  if (action === 'reset-current-layout' || action === 'reset-all-layout') {
    const resetAll = action === 'reset-all-layout'
    dialog.warning({
      title: t(resetAll ? 'layout.resetAllTitle' : 'layout.resetCurrentTitle'),
      content: t(resetAll ? 'layout.resetAllHint' : 'layout.resetCurrentHint'),
      positiveText: t('layout.reset'),
      negativeText: t('common.cancel'),
      onPositiveClick: () => {
        if (resetAll) layoutStore.resetAll()
        else layoutStore.resetWorkspaceLayout(layoutStore.activeWindowMode)
        message.success(t(resetAll ? 'layout.resetAllDone' : 'layout.resetCurrentDone'))
      }
    })
    return
  }
  try {
    if (action === 'export') {
      const path = await window.api.exportConnections()
      if (path) message.success(t('sidebar.exportedConnections', { path }))
      return
    }
    if (action !== 'import') return
    const result = await window.api.importConnections()
    if (result.canceled) return
    await Promise.all([store.loadConnections(), store.loadSavedQueries()])
    if (result.imported > 0) {
      message.success(t('sidebar.importedConnections', { count: result.imported, skipped: result.skipped, queryCount: result.queriesImported, querySkipped: result.queriesSkipped }))
    } else if (result.queriesImported > 0) {
      message.success(t('sidebar.importedQueries', { queryCount: result.queriesImported, skipped: result.skipped, querySkipped: result.queriesSkipped }))
    } else {
      message.warning(t('sidebar.noConnectionsImported', { skipped: result.skipped, querySkipped: result.queriesSkipped }))
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    message.error(t(action === 'export' ? 'sidebar.exportConnectionsFailed' : 'sidebar.importConnectionsFailed', { error: detail }))
  }
}
const contextMenuOptions = computed(() => contextMenuNode.value ? nodeOptions(contextMenuNode.value) : [])
function selectContextMenu(key: string | number): void {
  if (contextMenuNode.value) onNodeAction(contextMenuNode.value, key)
  contextMenuShow.value = false
}
</script>

<template>
  <aside class="app-sidebar">
    <header class="sidebar-header">
      <span class="sidebar-actions">
        <NButton quaternary size="small" :title="t('sidebar.auditLog')" @click="store.openTab({ type: 'audit', title: t('sidebar.auditLog') })"><template #icon><NIcon><HistoryOutlined /></NIcon></template></NButton>
        <NDropdown trigger="click" :options="queryConnectionOptions" @select="openNewQuery"><NButton quaternary size="small" :title="t('sidebar.newQuery')"><template #icon><NIcon><CodeOutlined /></NIcon></template></NButton></NDropdown>
        <NDropdown trigger="click" :options="connectionTransferOptions" @select="transferConnections"><NButton quaternary size="small" :title="t('sidebar.connectionManagement')"><template #icon><NIcon><MoreOutlined /></NIcon></template></NButton></NDropdown>
        <NButton type="primary" secondary size="small" @click="openNewConnection"><template #icon><NIcon><PlusOutlined /></NIcon></template>{{ t('sidebar.newConnection') }}</NButton>
      </span>
    </header>
    <div class="sidebar-search">
      <NInput v-model:value="search" clearable size="small" :placeholder="t('sidebar.searchPlaceholder')"><template #prefix><NIcon color="#aaa"><SearchOutlined /></NIcon></template></NInput>
      <NButton quaternary size="small" :title="t('sidebar.collapseAll')" :aria-label="t('sidebar.collapseAll')" @click="collapseAll"><template #icon><NIcon><MenuFoldOutlined /></NIcon></template></NButton>
    </div>
    <div class="sidebar-tree"><NTree remote virtual-scroll block-line :data="displayData" :expanded-keys="expandedKeys" :selected-keys="selectedKeys" :on-load="loadNode" :render-label="renderLabel" :render-prefix="renderPrefix" :node-props="treeNodeProps" @update:expanded-keys="updateExpandedKeys" @update:selected-keys="selectTreeNode" /></div>
    <NDropdown trigger="manual" placement="bottom-start" :show="contextMenuShow" :x="contextMenuX" :y="contextMenuY" :options="contextMenuOptions" @select="selectContextMenu" @clickoutside="contextMenuShow = false" />
    <ConnectionDialog :show="dialogOpen" :initial="editing" @close="closeDialog" />
    <NModal :show="copyModalOpen" :mask-closable="!copyingTable" @update:show="(show) => { if (!show) closeCopyTable() }">
      <NCard class="copy-table-modal" :title="t('sidebar.copyTableTitle', { name: copySource?.table ?? '' })" closable @close="closeCopyTable">
        <NFormItem :label="t('sidebar.copyTableTarget')" required>
          <NInput v-model:value="copyTargetName" autofocus :disabled="copyingTable" @keyup.enter="confirmCopyTable" />
        </NFormItem>
        <NCheckbox v-model:checked="copyWithData" :disabled="copyingTable">{{ t('sidebar.copyTableWithData') }}</NCheckbox>
        <template #footer>
          <div class="modal-actions"><NButton :disabled="copyingTable" @click="closeCopyTable">{{ t('common.cancel') }}</NButton><NButton type="primary" :loading="copyingTable" @click="confirmCopyTable">{{ t('sidebar.copyTableConfirm') }}</NButton></div>
        </template>
      </NCard>
    </NModal>
  </aside>
</template>
