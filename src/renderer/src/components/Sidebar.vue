<script setup lang="ts">
import { computed, h, onBeforeUnmount, ref, watch } from 'vue'
import { AppstoreOutlined, ClearOutlined, CodeOutlined, CopyOutlined, DatabaseOutlined, DeleteOutlined, DisconnectOutlined, EditOutlined, ExportOutlined, EyeOutlined, FolderOutlined, FunctionOutlined, HistoryOutlined, HolderOutlined, ImportOutlined, LockOutlined, MenuFoldOutlined, MoreOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, TableOutlined, UndoOutlined, UnlockOutlined } from '@vicons/antd'
import { NButton, NCard, NCheckbox, NDropdown, NFormItem, NIcon, NInput, NInputNumber, NModal, NSelect, NTag, NTooltip, NTree, useDialog, useMessage, type DropdownOption, type TreeOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ConnectionMeta, DatabaseExportMode, DatabaseOperation, PermissionMode, RoutineInfo, SavedQuery, TableInfo } from '../../../shared/types'
import { isSystemDatabase } from '../../../shared/databasePolicy'
import { useContextMenuDismiss } from '../contextMenu'
import { isAppLocale, localeOptions } from '../i18n'
import { invalidateConnectionMetadata, loadColumnMetadata, loadDatabaseMetadata, loadTableMetadata } from '../metadataCache'
import { loadObjectDefinition, openObjectDefinitionTab, type ObjectDefinitionTarget } from '../objectDefinition'
import { useAppStore } from '../stores/app'
import { useLayoutStore } from '../stores/layout'
import { useSettingsStore } from '../stores/settings'
import { toCsv, toJson } from '../utils'
import ConnectionDialog from './ConnectionDialog.vue'
import ConnectionExportDialog from './ConnectionExportDialog.vue'
import DatabaseTypeIcon from './DatabaseTypeIcon.vue'

type NodeData =
  | { kind: 'connection'; connectionId: string }
  | { kind: 'database'; connectionId: string; database: string }
  | { kind: 'schema'; connectionId: string; database?: string; schema: string }
  | { kind: 'objectGroup'; connectionId: string; database?: string; schema?: string; group: 'tables' | 'views' | 'routines' | 'collections' | 'keys'; count: number }
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
const exportConnection = ref<ConnectionMeta | null>(null)
const exportMode = ref<DatabaseExportMode>('data')
const contextMenuShow = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
const contextMenuNode = ref<DbTreeNode | null>(null)
const permissionChangingId = ref<string | null>(null)
const duplicatingConnectionId = ref<string | null>(null)
const draggingConnectionId = ref<string | null>(null)
const connectionDropTarget = ref<{ id: string; position: 'before' | 'after' } | null>(null)
const reorderingConnections = ref(false)
interface ArmedConnectionRowDrag {
  element: HTMLElement
  start: (event: DragEvent) => void
  end: () => void
  cancel: () => void
}
let armedConnectionRowDrag: ArmedConnectionRowDrag | null = null
type ConnectionActivity = 'connecting' | 'refreshing'
const connectionActivities = ref<Record<string, ConnectionActivity>>({})
const copyModalOpen = ref(false)
const copySource = ref<Extract<NodeData, { kind: 'table' }> | null>(null)
const copyTargetName = ref('')
const copyWithData = ref(true)
const copyingTable = ref(false)
const createDatabaseModalOpen = ref(false)
const createDatabaseConnectionId = ref<string | null>(null)
const createDatabaseName = ref('')
const creatingDatabase = ref(false)
const dropDatabaseTarget = ref<Extract<NodeData, { kind: 'database' }> | null>(null)
const dropDatabaseConfirmation = ref('')
const droppingDatabase = ref(false)
const dropDatabaseConnection = computed(() => dropDatabaseTarget.value ? connectionOf(dropDatabaseTarget.value.connectionId) : undefined)
const createCollectionModalOpen = ref(false)
const createCollectionConnectionId = ref<string | null>(null)
const createCollectionDatabase = ref<string | undefined>()
const createCollectionName = ref('')
const createCollectionVectorSize = ref(1536)
const createCollectionDistance = ref<'Cosine' | 'Euclid' | 'Dot' | 'Manhattan'>('Cosine')
const creatingCollection = ref(false)
const createKeyModalOpen = ref(false)
const createKeyConnectionId = ref<string | null>(null)
const createKeyDatabase = ref<string | undefined>()
const createKeyName = ref('')
const createKeyType = ref<'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream'>('string')
const createKeyValue = ref('')
const creatingKey = ref(false)
const redisTypeOptions = ['string', 'hash', 'list', 'set', 'zset', 'stream'].map((value) => ({ label: value, value }))
const databaseTypeLabels: Record<ConnectionMeta['type'], string> = {
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
  sqlite: 'SQLite',
  sqlserver: 'SQL Server',
  mongodb: 'MongoDB',
  redis: 'Redis',
  qdrant: 'Qdrant'
}
const createDatabaseConnection = computed(() => {
  const id = createDatabaseConnectionId.value
  return id ? connectionOf(id) : undefined
})
const createCollectionIsPoint = computed(() => {
  const id = createCollectionConnectionId.value
  return id ? store.driverCapabilities[id]?.recordModel === 'point' : false
})
const qdrantDistanceOptions = ['Cosine', 'Euclid', 'Dot', 'Manhattan'].map((value) => ({ label: value, value }))
let definitionRequest = 0

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
watch(() => store.connections.slice(), rebuildRoots, { immediate: true })

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
function connectionEndpoint(connection: ConnectionMeta): string {
  const rawHost = connection.host?.trim()
  if (!rawHost) return '—'
  const host = rawHost.includes(':') && !rawHost.startsWith('[') ? `[${rawHost}]` : rawHost
  return connection.port === undefined ? host : `${host}:${connection.port}`
}
function capabilitiesOf(connection: ConnectionMeta | undefined) {
  return connection ? store.driverCapabilities[connection.id] : undefined
}
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
  if (capabilitiesOf(connection)?.recordModel === 'point') {
    const collections = await loadTableMetadata(connectionId)
    return withSavedQueryGroup(objectGroups(connection, undefined, undefined, collections, []), connectionId)
  }
  const databases = await loadDatabaseMetadata(connectionId)
  const visibleDatabases = connection.type === 'sqlite' ? databases.filter((name) => name === 'main') : databases
  const databaseNodes: DbTreeNode[] = visibleDatabases.map((database) => ({
    key: databaseKey(connectionId, database), isLeaf: false, label: database,
    data: { kind: 'database', connectionId, database }
  }))
  return withSavedQueryGroup(databaseNodes, connectionId)
}
function tableNode(connectionId: string, database: string | undefined, table: TableInfo): DbTreeNode {
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
  database: string | undefined,
  schema: string | undefined,
  tables: TableInfo[],
  routines: RoutineInfo[]
): DbTreeNode[] {
  const makeGroup = (group: 'tables' | 'views' | 'routines' | 'collections' | 'keys', children: DbTreeNode[]): DbTreeNode => ({
    key: `group:${connection.id}:${database}:${schema ?? ''}:${group}`,
    isLeaf: children.length === 0,
    label: group,
    children,
    data: { kind: 'objectGroup', connectionId: connection.id, database, schema, group, count: children.length }
  })
  const tableNodes = tables.filter((table) => table.type === 'table').map((table) => tableNode(connection.id, database, table))
  const viewNodes = tables.filter((table) => table.type === 'view').map((table) => tableNode(connection.id, database, table))
  const capabilities = capabilitiesOf(connection)
  if (capabilities?.objectKinds.includes('collection') && !capabilities.objectKinds.includes('table')) return [makeGroup('collections', tableNodes)]
  if (capabilities?.objectKinds.includes('key')) return [makeGroup('keys', tableNodes)]
  const groups = [makeGroup('tables', tableNodes), makeGroup('views', viewNodes)]
  if (!database) return groups
  if (capabilities?.objectKinds.includes('routine')) groups.push(makeGroup('routines', routines.map((routine) => routineNode(connection.id, database, routine))))
  return groups
}
async function listRoutines(connection: ConnectionMeta, database: string): Promise<RoutineInfo[]> {
  if (!capabilitiesOf(connection)?.objectKinds.includes('routine')) return []
  return window.api.listRoutines(connection.id, database)
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
  if (database === undefined) {
    if (capabilitiesOf(connectionOf(connectionId))?.recordModel === 'point') await openConnection(connectionId, true)
    return
  }
  invalidateConnectionMetadata(connectionId)
  await loadDatabaseMetadata(connectionId).catch(() => [])
  setNodeChildren(databaseKey(connectionId, database), await loadDatabaseChildren(connectionId, database))
}
function refreshDatabaseTree(connectionId: string, database?: string): void {
  void refreshTables(connectionId, database).catch((error) => {
    message.error(error instanceof Error ? error.message : String(error))
  })
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
async function importTableData(connection: ConnectionMeta, node: Extract<NodeData, { kind: 'table' }>): Promise<void> {
  try {
    const file = await window.api.pickDataFile()
    if (!file) return
    const rows = parseImportRows(file.name, file.content)
    if (!rows.length) throw new Error(t('sidebar.importNoRows'))
    if (rows.length > 50000) throw new Error(t('sidebar.importTooManyRows'))
    const capabilities = capabilitiesOf(connection)
    if (capabilities?.structuredOperations && capabilities.records.bulkImport.supported) {
      const targetKind = capabilities.recordTargetKind
      let values: Record<string, unknown>[]
      if (capabilities.recordModel === 'point') {
        values = rows.map((row) => {
          const normalized = { ...row }
          if (typeof normalized.payload === 'string') {
            try { normalized.payload = JSON.parse(normalized.payload) }
            catch { throw new Error(t('grid.pointPayloadInvalid')) }
          }
          if (typeof normalized.vector === 'string') {
            try { normalized.vector = JSON.parse(normalized.vector) }
            catch { throw new Error(t('grid.pointVectorInvalid')) }
          }
          return normalized
        })
        if (values.some((row) => row.id === undefined || row.vector === undefined)) {
          throw new Error(t('sidebar.qdrantImportRequiresPoint'))
        }
      } else if (capabilities.recordModel === 'document') {
        values = rows
      } else {
        const columns = await loadColumnMetadata(connection.id, node.database, node.table, node.schema)
        const knownColumns = new Map(columns.map((column) => [column.name.toLocaleLowerCase(), column.name]))
        values = rows.map((row) => Object.fromEntries(Object.entries(row)
          .map(([name, value]) => [knownColumns.get(name.toLocaleLowerCase()), value] as const)
          .filter((entry): entry is [string, unknown] => Boolean(entry[0]))))
        if (values.every((row) => Object.keys(row).length === 0)) throw new Error(t('sidebar.importNoMatchingColumns'))
      }
      const operation: DatabaseOperation = {
        kind: 'records.mutate',
        target: { kind: targetKind, name: node.table, database: node.database, schema: node.schema },
        mutations: values.filter((row) => Object.keys(row).length).map((row) => ({ kind: 'insert', values: row }))
      }
      const importCount = operation.mutations.length
      const importedColumns = [...new Set(values.flatMap((row) => Object.keys(row)))].join(', ')
      dialog.warning({
        title: t('sidebar.importDataTitle', { name: node.table }),
        content: t('sidebar.importDataHint', { file: file.name, count: importCount, columns: importedColumns }),
        positiveText: t('sidebar.importDataConfirm'), negativeText: t('common.cancel'),
        onPositiveClick: async () => {
          const result = await store.executeOperationWithApproval(connection.id, operation)
          if (result.status === 'ok') message.success(t('sidebar.importedData', { count: importCount, name: node.table }))
          else if (result.status === 'denied') message.warning(result.error ?? '')
          else if (result.status === 'error') message.error(result.error ?? '')
        }
      })
      return
    }
    throw new Error(capabilities?.records.bulkImport.supported === false
      ? capabilities.records.bulkImport.reason
      : t('grid.structuredOperationUnavailable'))
  } catch (error) {
    message.error(t('sidebar.importDataFailed', { error: error instanceof Error ? error.message : String(error) }))
  }
}
async function exportTableData(connection: ConnectionMeta, node: Extract<NodeData, { kind: 'table' }>, format: 'csv' | 'json'): Promise<void> {
  try {
    const first = await store.getTableData(connection.id, { database: node.database, schema: node.schema, table: node.table, page: 1, pageSize: 1 })
    const cap = 50000
    let columns = first.columns
    let sourceRows = first.rows
    if (first.paginationMode === 'cursor') {
      sourceRows = []
      let cursor: string | number | undefined
      const seen = new Set<string>()
      while (sourceRows.length < cap) {
        const pageResult = await store.getTableData(connection.id, {
          database: node.database, schema: node.schema, table: node.table, page: 1,
          pageSize: Math.min(500, cap - sourceRows.length), cursor,
          includeVectors: capabilitiesOf(connection)?.recordModel === 'point'
        })
        columns = pageResult.columns
        sourceRows.push(...pageResult.rows)
        if (pageResult.nextCursor === undefined) break
        const key = JSON.stringify(pageResult.nextCursor)
        if (seen.has(key)) break
        seen.add(key)
        cursor = pageResult.nextCursor
      }
    } else if (first.total > 1) {
      const result = await store.getTableData(connection.id, { database: node.database, schema: node.schema, table: node.table, page: 1, pageSize: Math.min(first.total, cap) })
      columns = result.columns
      sourceRows = result.rows
    }
    const rows = sourceRows.map((row) => Object.fromEntries(columns.map((column) => [column.name, row[column.name]])))
    const content = format === 'csv' ? toCsv(columns.map((column) => column.name), rows) : toJson(rows)
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
    const capabilities = capabilitiesOf(connection)
    if (!capabilities?.structuredOperations || !capabilities.objects.copy.supported) throw new Error('当前驱动不支持结构化复制')
    const result = await store.executeOperationWithApproval(connection.id, {
      kind: 'object.copy',
      source: {
        kind: capabilities.recordTargetKind, name: source.table,
        database: source.database, schema: source.schema
      },
      targetName,
      withData: copyWithData.value
    })
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
  const capabilities = capabilitiesOf(connection)
  if (!capabilities) return
  const target = {
    kind: capabilities.recordTargetKind,
    name: node.table, database: node.database, schema: node.schema
  }
  if (action === 'copy') {
    await navigator.clipboard.writeText(node.table)
    message.success(t('sidebar.copiedTableName', { name: node.table }))
    return
  }
  if (action === 'duplicate') { openCopyTable(node); return }
  if (action === 'import-data') { await importTableData(connection, node); return }
  if (action === 'export-csv' || action === 'export-json') { await exportTableData(connection, node, action === 'export-csv' ? 'csv' : 'json'); return }
  if (action === 'truncate') {
    const operation: DatabaseOperation = { kind: 'records.clear', target }
    const preview = JSON.stringify(operation, null, 2)
    dialog.warning({
      title: t('sidebar.truncateTitle', { name: node.table }), content: t('sidebar.truncateHint', { sql: preview }), positiveText: t('sidebar.truncateOk'), negativeText: t('common.cancel'),
      onPositiveClick: async () => {
        const result = await store.executeOperationWithApproval(connection.id, operation)
        if (result.status === 'ok') message.success(t('sidebar.truncated', { name: node.table }))
        else if (result.status === 'denied') message.warning(result.error ?? '')
        else if (result.status === 'error') message.error(result.error ?? '')
      }
    })
  } else if (action === 'drop') {
    const operation: DatabaseOperation = { kind: 'object.drop', target }
    const preview = JSON.stringify(operation, null, 2)
    dialog.error({
      title: t('sidebar.dropTitle', { name: node.table }), content: t('sidebar.dropHint', { sql: preview }), positiveText: t('common.delete'), negativeText: t('common.cancel'),
      onPositiveClick: async () => {
        const result = await store.executeOperationWithApproval(connection.id, operation)
        if (result.status === 'ok') { message.success(t('sidebar.dropped', { name: node.table })); await refreshTables(connection.id, node.database) }
        else if (result.status === 'denied') message.warning(result.error ?? '')
        else if (result.status === 'error') message.error(result.error ?? '')
      }
    })
  }
}
async function onConnectionAction(connection: ConnectionMeta, action: string): Promise<void> {
  if (['export-data', 'export-structure', 'export-structure-and-data'].includes(action)) {
    exportMode.value = action.slice('export-'.length) as DatabaseExportMode
    exportConnection.value = connection
  }
  else if (action === 'connect') await openConnection(connection.id)
  else if (action === 'query') store.openTab({ type: 'query', title: t('sidebar.queryTitle', { name: connection.name }), connectionId: connection.id })
  else if (action === 'newCollection') openCreateCollection(connection)
  else if (action === 'newKey') openCreateKey(connection, connection.database)
  else if (action === 'newDatabase') openCreateDatabase(connection)
  else if (action === 'refresh') await openConnection(connection.id, true)
  else if (action === 'edit') { editing.value = connection; dialogOpen.value = true }
  else if (action === 'copy-name') {
    await navigator.clipboard.writeText(connection.name)
    message.success(t('sidebar.copiedObjectName', { name: connection.name }))
  }
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
  const capabilities = capabilitiesOf(connection)
  return [
    { key: 'connect', label: t('sidebar.connect'), disabled: connected || busy, icon: () => h(NIcon, null, { default: () => h(DatabaseOutlined) }) },
    { key: 'query', label: t('sidebar.newQuery'), icon: () => h(NIcon, null, { default: () => h(PlusOutlined) }) },
    ...(capabilities?.objectKinds.includes('collection') && capabilities.objects.create.supported ? [{
      key: 'newCollection',
      label: t('sidebar.newCollection'),
      disabled: busy || connection.permissionMode === 'readonly',
      icon: () => h(NIcon, null, { default: () => h(TableOutlined) })
    }] : []),
    ...(capabilities?.objectKinds.includes('key') && capabilities.objects.create.supported ? [{
      key: 'newKey', label: t('sidebar.newKey'), disabled: busy || connection.permissionMode === 'readonly',
      icon: () => h(NIcon, null, { default: () => h(PlusOutlined) })
    }] : []),
    ...(capabilities?.databases.create.supported ? [{
      key: 'newDatabase',
      label: t('sidebar.newDatabase'),
      disabled: busy || connection.permissionMode === 'readonly',
      icon: () => h(NIcon, null, { default: () => h(AppstoreOutlined) })
    }] : []),
    { key: 'refresh', label: t('common.refresh'), disabled: !connected || busy, icon: () => h(NIcon, null, { default: () => h(ReloadOutlined) }) },
    { key: 'edit', label: t('sidebar.editConnection'), disabled: busy, icon: () => h(NIcon, null, { default: () => h(EditOutlined) }) },
    { key: 'copy-name', label: t('sidebar.copyObjectName'), icon: () => h(NIcon, null, { default: () => h(CopyOutlined) }) },
    { key: 'duplicate', label: t('sidebar.copyConnection'), disabled: duplicatingConnectionId.value !== null, icon: () => h(NIcon, null, { default: () => h(CopyOutlined) }) },
    { type: 'divider', key: 'export-divider' },
    ...(['data', 'structure', 'structure-and-data'] as DatabaseExportMode[]).map((mode) => ({
      key: `export-${mode}`, label: t(mode === 'data' ? 'sidebar.exportData' : mode === 'structure' ? 'sidebar.exportStructure' : 'sidebar.exportStructureAndData'),
      disabled: busy || exportConnection.value !== null,
      icon: () => h(NIcon, null, { default: () => h(ExportOutlined) })
    })),
    { key: 'disconnect', label: t('sidebar.disconnect'), disabled: !connected || busy, icon: () => h(NIcon, null, { default: () => h(DisconnectOutlined) }) },
    { type: 'divider', key: 'divider' },
    { key: 'delete', label: t('sidebar.deleteConnection'), disabled: busy, icon: () => h(NIcon, { color: '#d03050' }, { default: () => h(DeleteOutlined) }) }
  ]
}
function tableOptions(tableType: 'table' | 'view', connection?: ConnectionMeta): DropdownOption[] {
  const capabilities = capabilitiesOf(connection)
  const common: DropdownOption[] = [
    { key: 'open', label: t('sidebar.openTable'), icon: () => h(NIcon, null, { default: () => h(TableOutlined) }) },
    { key: 'query', label: t('sidebar.newQuery'), icon: () => h(NIcon, null, { default: () => h(PlusOutlined) }) },
    { key: 'refresh', label: t('common.refresh'), icon: () => h(NIcon, null, { default: () => h(ReloadOutlined) }) },
    { key: 'copy', label: t('sidebar.copyObjectName'), icon: () => h(NIcon, null, { default: () => h(CopyOutlined) }) }
  ]
  if (tableType === 'view') return [
    common[0],
    { key: 'view-definition', label: t('objectList.viewViewDefinition'), icon: () => h(NIcon, null, { default: () => h(CodeOutlined) }) },
    { key: 'edit-definition', label: t('objectList.editViewDefinition'), disabled: connection?.permissionMode === 'readonly', icon: () => h(NIcon, null, { default: () => h(EditOutlined) }) },
    ...common.slice(1)
  ]
  if (capabilities && capabilities.recordModel !== 'row') return [
    common[0],
    ...(['point', 'document'].includes(capabilities?.recordModel ?? '') && (capabilities?.indexes.create.supported || capabilities?.indexes.drop.supported)
      ? [{ key: 'design', label: t('qdrant.manageIndexes'), icon: () => h(NIcon, null, { default: () => h(EditOutlined) }) }]
      : []),
    ...(capabilities?.definition.read.supported ? [{ key: 'view-definition', label: t('objectList.viewDefinition'), icon: () => h(NIcon, null, { default: () => h(CodeOutlined) }) }] : []),
    ...common.slice(1),
    ...(capabilities.objects.copy.supported ? [{
      key: 'duplicate', label: t('sidebar.copyTable'), disabled: connection?.permissionMode === 'readonly',
      icon: () => h(NIcon, null, { default: () => h(CopyOutlined) })
    }] : []),
    ...(capabilities?.objectKinds.includes('collection') && capabilities.objects.create.supported ? [{
      key: 'newCollection',
      label: t('sidebar.newCollection'),
      disabled: connection?.permissionMode === 'readonly',
      icon: () => h(NIcon, null, { default: () => h(TableOutlined) })
    }] : []),
    ...(capabilities?.records.bulkImport.supported ? [
      { type: 'divider' as const, key: 'data-divider' },
      { key: 'import-data', label: t('sidebar.importData'), icon: () => h(NIcon, null, { default: () => h(ImportOutlined) }) }
    ] : []),
    { key: 'export-data', label: t('sidebar.exportData'), icon: () => h(NIcon, null, { default: () => h(ExportOutlined) }), children: [
      { key: 'export-csv', label: t('sidebar.exportCsv') }, { key: 'export-json', label: t('sidebar.exportJson') }
    ] },
    ...(capabilities?.records.clear.supported || capabilities?.objects.drop.supported ? [{ type: 'divider' as const, key: 'destructive-divider' }] : []),
    ...(capabilities?.records.clear.supported ? [{ key: 'truncate', label: t(capabilities.recordModel === 'point' ? 'sidebar.clearCollection' : 'sidebar.truncateTable'), icon: () => h(NIcon, { color: '#d03050' }, { default: () => h(ClearOutlined) }) }] : []),
    ...(capabilities?.objects.drop.supported ? [{ key: 'drop', label: t(capabilities.recordModel === 'point' ? 'sidebar.dropCollection' : 'sidebar.dropTable'), icon: () => h(NIcon, { color: '#d03050' }, { default: () => h(DeleteOutlined) }) }] : [])
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
function routineOptions(node: Extract<NodeData, { kind: 'routine' }>, connection?: ConnectionMeta): DropdownOption[] {
  return [
    {
      key: 'view-definition',
      label: t(node.routineType === 'procedure' ? 'objectList.viewProcedureDefinition' : 'objectList.viewFunctionDefinition'),
      icon: () => h(NIcon, null, { default: () => h(CodeOutlined) })
    },
    {
      key: 'edit-definition',
      label: t(node.routineType === 'procedure' ? 'objectList.editProcedureDefinition' : 'objectList.editFunctionDefinition'),
      disabled: connection?.permissionMode === 'readonly',
      icon: () => h(NIcon, null, { default: () => h(EditOutlined) })
    },
    { key: 'query', label: t('sidebar.newQuery'), icon: () => h(NIcon, null, { default: () => h(PlusOutlined) }) },
    { key: 'refresh', label: t('common.refresh'), icon: () => h(NIcon, null, { default: () => h(ReloadOutlined) }) },
    { key: 'copy', label: t('sidebar.copyObjectName'), icon: () => h(NIcon, null, { default: () => h(CopyOutlined) }) }
  ]
}
function definitionTargetOf(node: Extract<NodeData, { kind: 'table' | 'routine' }>): ObjectDefinitionTarget | null {
  if (node.kind === 'table') {
    const connection = connectionOf(node.connectionId)
    const capabilities = capabilitiesOf(connection)
    if (capabilities && capabilities.recordModel !== 'row') {
      return {
        connectionId: node.connectionId,
        database: node.database,
        schema: node.schema,
        name: node.table,
        kind: capabilities.recordTargetKind === 'key' ? 'key' : 'collection'
      }
    }
    if (node.tableType !== 'view' || !node.database) return null
    return {
      connectionId: node.connectionId,
      database: node.database,
      schema: node.schema,
      name: node.table,
      kind: 'view'
    }
  }
  return {
    connectionId: node.connectionId,
    database: node.database,
    schema: node.schema,
    name: node.routine,
    kind: node.routineType,
    arguments: node.arguments
  }
}
function definitionTabTitle(target: ObjectDefinitionTarget, readOnly: boolean): string {
  if (target.kind === 'collection') return t('objectList.collectionDefinitionTitle', { name: target.name })
  if (target.kind === 'key') return t('objectList.keyDefinitionTitle', { name: target.name })
  if (readOnly) {
    const key = target.kind === 'view'
      ? 'objectList.viewDefinitionTitle'
      : target.kind === 'procedure' ? 'objectList.procedureDefinitionTitle' : 'objectList.functionDefinitionTitle'
    return t(key, { name: target.name })
  }
  const key = target.kind === 'view'
    ? 'objectList.editViewTitle'
    : target.kind === 'procedure' ? 'objectList.editProcedureTitle' : 'objectList.editFunctionTitle'
  return t(key, { name: target.name })
}
async function openDefinition(node: Extract<NodeData, { kind: 'table' | 'routine' }>, readOnly: boolean): Promise<void> {
  const target = definitionTargetOf(node)
  const connection = connectionOf(node.connectionId)
  if (!target || !connection) return
  const request = ++definitionRequest
  try {
    const code = await loadObjectDefinition(target)
    if (request !== definitionRequest) return
    openObjectDefinitionTab(store, connection, target, code, readOnly, definitionTabTitle(target, readOnly))
  } catch (error) {
    if (request === definitionRequest) {
      message.error(t('objectList.definitionLoadFailed', { error: error instanceof Error ? error.message : String(error) }))
    }
  }
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
    else if (key === 'newCollection') { const connection = connectionOf(node.data.connectionId); if (connection) openCreateCollection(connection, node.data.database) }
    else if (key === 'newKey') { const connection = connectionOf(node.data.connectionId); if (connection) openCreateKey(connection, node.data.database) }
    else if (key === 'refresh') refreshDatabaseTree(node.data.connectionId, node.data.database)
    else if (key === 'dropDatabase') {
      dropDatabaseTarget.value = node.data
      dropDatabaseConfirmation.value = ''
    }
    return
  }
  if (node.data.kind === 'schema') {
    if (key === 'newTable') store.openTab({ type: 'structure', title: t('sidebar.newTable'), connectionId: node.data.connectionId, database: node.data.database, schema: node.data.schema })
    else if (key === 'refresh') refreshDatabaseTree(node.data.connectionId, node.data.database)
    return
  }
  if (node.data.kind === 'objectGroup') {
    if (key === 'query') {
      const connection = connectionOf(node.data.connectionId)
      store.openTab({
        type: 'query',
        title: t('sidebar.queryTitle', { name: connection?.name ?? objectGroupLabel(node.data.group) }),
        connectionId: node.data.connectionId,
        database: node.data.database
      })
    } else if (key === 'newCollection') {
      const connection = connectionOf(node.data.connectionId)
      if (connection) openCreateCollection(connection, node.data.database)
    } else if (key === 'newKey') {
      const connection = connectionOf(node.data.connectionId)
      if (connection) openCreateKey(connection, node.data.database)
    } else if (key === 'newTable') store.openTab({ type: 'structure', title: t('sidebar.newTable'), connectionId: node.data.connectionId, database: node.data.database, schema: node.data.schema })
    else if (key === 'refresh') refreshDatabaseTree(node.data.connectionId, node.data.database)
    return
  }
  if (node.data.kind === 'table') {
    if (key === 'open') openTable(node.data)
    else if (key === 'design') store.openTab({ type: 'structure', title: t('sidebar.designTitle', { name: node.data.table }), connectionId: node.data.connectionId, database: node.data.database, schema: node.data.schema, table: node.data.table })
    else if (key === 'view-definition') void openDefinition(node.data, true)
    else if (key === 'edit-definition') void openDefinition(node.data, false)
    else if (key === 'query') store.openTab({ type: 'query', title: t('sidebar.queryTitle', { name: node.data.table }), connectionId: node.data.connectionId, database: node.data.database, schema: node.data.schema })
    else if (key === 'newCollection') { const connection = connectionOf(node.data.connectionId); if (connection) openCreateCollection(connection, node.data.database) }
    else if (key === 'refresh') refreshDatabaseTree(node.data.connectionId, node.data.database)
    else { const connection = connectionOf(node.data.connectionId); if (connection) void runTableAction(connection, node.data, key) }
    return
  }
  if (node.data.kind === 'routine') {
    const routine = node.data
    if (key === 'view-definition') void openDefinition(routine, true)
    else if (key === 'edit-definition') void openDefinition(routine, false)
    else if (key === 'query') store.openTab({ type: 'query', title: t('sidebar.routineTitle', { name: routine.routine }), connectionId: routine.connectionId, database: routine.database, schema: routine.schema, routine: routine.routine, routineType: routine.routineType, routineArguments: routine.arguments })
    else if (key === 'copy') void navigator.clipboard.writeText(routine.routine).then(() => message.success(t('sidebar.copiedObjectName', { name: routine.routine })))
    else if (key === 'refresh') refreshDatabaseTree(routine.connectionId, routine.database)
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
    const systemDatabase = connection && isSystemDatabase(connection.type, node.data.database)
    return [
      { key: 'query', label: t('sidebar.newQuery'), icon: () => h(NIcon, null, { default: () => h(CodeOutlined) }) },
      { key: 'refresh', label: t('common.refresh'), icon: () => h(NIcon, null, { default: () => h(ReloadOutlined) }) },
      ...(capabilitiesOf(connection)?.objectKinds.includes('table') && capabilitiesOf(connection)?.objects.create.supported ? [{ key: 'newTable', label: t('sidebar.newTable'), icon: () => h(NIcon, null, { default: () => h(TableOutlined) }) }] : []),
      ...(capabilitiesOf(connection)?.objectKinds.includes('collection') && capabilitiesOf(connection)?.objects.create.supported ? [{ key: 'newCollection', label: t('sidebar.newCollection'), icon: () => h(NIcon, null, { default: () => h(TableOutlined) }) }] : []),
      ...(capabilitiesOf(connection)?.objectKinds.includes('key') && capabilitiesOf(connection)?.objects.create.supported ? [{ key: 'newKey', label: t('sidebar.newKey'), icon: () => h(NIcon, null, { default: () => h(PlusOutlined) }) }] : []),
      { type: 'divider', key: 'database-drop-divider' },
      {
        key: 'dropDatabase', label: t('sidebar.dropDatabase'),
        disabled: !capabilitiesOf(connection)?.databases.drop.supported || connection?.permissionMode === 'readonly' || systemDatabase || droppingDatabase.value,
        props: { title: systemDatabase ? t('sidebar.dropSystemDatabaseBlocked') : !capabilitiesOf(connection)?.databases.drop.supported ? t('sidebar.dropDatabaseUnsupported') : '' },
        icon: () => h(NIcon, { color: '#d03050' }, { default: () => h(DeleteOutlined) })
      }
    ]
  }
  if (node.data.kind === 'schema') return [
    { key: 'refresh', label: t('common.refresh'), icon: () => h(NIcon, null, { default: () => h(ReloadOutlined) }) },
    { key: 'newTable', label: t('sidebar.newTable') }
  ]
  if (node.data.kind === 'objectGroup') {
    const connection = connectionOf(node.data.connectionId)
    return [
      ...(node.data.group === 'collections' && capabilitiesOf(connection)?.objectKinds.includes('collection')
        ? [
            { key: 'query', label: t('sidebar.newQuery'), icon: () => h(NIcon, null, { default: () => h(CodeOutlined) }) },
            {
              key: 'newCollection', label: t('sidebar.newCollection'),
              disabled: connection?.permissionMode === 'readonly',
              icon: () => h(NIcon, null, { default: () => h(TableOutlined) })
            }
          ]
        : []),
      ...(node.data.group === 'keys' && capabilitiesOf(connection)?.objectKinds.includes('key')
        ? [{ key: 'newKey', label: t('sidebar.newKey'), disabled: connection?.permissionMode === 'readonly', icon: () => h(NIcon, null, { default: () => h(PlusOutlined) }) }]
        : []),
      { key: 'refresh', label: t('common.refresh'), icon: () => h(NIcon, null, { default: () => h(ReloadOutlined) }) },
      ...(node.data.group === 'tables' && capabilitiesOf(connection)?.objectKinds.includes('table') ? [{ key: 'newTable', label: t('sidebar.newTable') }] : [])
    ]
  }
  if (node.data.kind === 'routine') return routineOptions(node.data, connectionOf(node.data.connectionId))
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
function startConnectionDrag(event: DragEvent, connectionId: string): void {
  if (reorderingConnections.value || store.connections.length < 2) {
    event.preventDefault()
    return
  }
  draggingConnectionId.value = connectionId
  connectionDropTarget.value = null
  contextMenuShow.value = false
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', connectionId)
  }
}
function finishConnectionDrag(): void {
  draggingConnectionId.value = null
  connectionDropTarget.value = null
}
function disarmConnectionRowDrag(): void {
  const armed = armedConnectionRowDrag
  if (!armed) return
  armed.element.draggable = false
  armed.element.removeEventListener('dragstart', armed.start)
  armed.element.removeEventListener('dragend', armed.end)
  window.removeEventListener('mouseup', armed.cancel)
  window.removeEventListener('blur', armed.cancel)
  armedConnectionRowDrag = null
}
function armConnectionRowDrag(event: MouseEvent, connectionId: string): void {
  if (event.button !== 0 || reorderingConnections.value || store.connections.length < 2) return
  if (event.target instanceof Element && event.target.closest('.n-tree-node-switcher, button, input, textarea, select, .connection-permission-editable')) return

  disarmConnectionRowDrag()
  const element = event.currentTarget as HTMLElement
  const start = (dragEvent: DragEvent): void => startConnectionDrag(dragEvent, connectionId)
  const end = (): void => {
    finishConnectionDrag()
    disarmConnectionRowDrag()
  }
  const cancel = (): void => disarmConnectionRowDrag()
  armedConnectionRowDrag = { element, start, end, cancel }
  element.draggable = true
  element.addEventListener('dragstart', start)
  element.addEventListener('dragend', end)
  window.addEventListener('mouseup', cancel)
  window.addEventListener('blur', cancel)
}
function connectionDropPosition(event: DragEvent): 'before' | 'after' {
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
  return event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
}
function dragConnectionOver(event: DragEvent, targetId: string): void {
  const sourceId = draggingConnectionId.value
  if (!sourceId || sourceId === targetId || reorderingConnections.value) return
  event.preventDefault()
  event.stopPropagation()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  connectionDropTarget.value = { id: targetId, position: connectionDropPosition(event) }
}
function leaveConnectionDropTarget(event: DragEvent, targetId: string): void {
  const current = event.currentTarget as HTMLElement
  if (event.relatedTarget instanceof Node && current.contains(event.relatedTarget)) return
  if (connectionDropTarget.value?.id === targetId) connectionDropTarget.value = null
}
async function dropConnection(event: DragEvent, targetId: string): Promise<void> {
  const sourceId = draggingConnectionId.value
  if (!sourceId || sourceId === targetId || reorderingConnections.value) return
  event.preventDefault()
  event.stopPropagation()
  const position = connectionDropTarget.value?.id === targetId
    ? connectionDropTarget.value.position
    : connectionDropPosition(event)
  finishConnectionDrag()

  const currentIds = store.connections.map((connection) => connection.id)
  const reorderedIds = currentIds.filter((id) => id !== sourceId)
  const targetIndex = reorderedIds.indexOf(targetId)
  if (targetIndex < 0) return
  reorderedIds.splice(targetIndex + (position === 'after' ? 1 : 0), 0, sourceId)
  if (reorderedIds.every((id, index) => id === currentIds[index])) return

  reorderingConnections.value = true
  try {
    await store.reorderConnections(reorderedIds)
  } catch (error) {
    await store.loadConnections().catch(() => undefined)
    message.error(t('sidebar.reorderConnectionsFailed', { error: error instanceof Error ? error.message : String(error) }))
  } finally {
    reorderingConnections.value = false
  }
}
function treeNodeProps({ option }: { option: TreeOption }): Record<string, unknown> {
  const node = option as DbTreeNode
  const props: Record<string, unknown> = { onContextmenu: (event: MouseEvent) => openNodeContextMenu(event, node) }
  if (node.data.kind !== 'connection') return props
  const connectionId = node.data.connectionId
  return {
    ...props,
    class: [
      'connection-tree-node',
      {
        'is-connection-dragging': draggingConnectionId.value === connectionId,
        'is-connection-drop-before': connectionDropTarget.value?.id === connectionId && connectionDropTarget.value.position === 'before',
        'is-connection-drop-after': connectionDropTarget.value?.id === connectionId && connectionDropTarget.value.position === 'after'
      }
    ],
    onMousedown: (event: MouseEvent) => armConnectionRowDrag(event, connectionId),
    onDragover: (event: DragEvent) => dragConnectionOver(event, connectionId),
    onDragleave: (event: DragEvent) => leaveConnectionDropTarget(event, connectionId),
    onDrop: (event: DragEvent) => { void dropConnection(event, connectionId) }
  }
}
function renderLabel({ option }: { option: TreeOption }): ReturnType<typeof h> {
  const node = option as DbTreeNode
  let content: ReturnType<typeof h>
  if (node.data.kind === 'connection') {
    const connectionId = node.data.connectionId
    const connection = connectionOf(connectionId)
    const activity = connectionActivityOf(connectionId)
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
    const canReorder = store.connections.length > 1 && !reorderingConnections.value
    content = h('span', { class: 'tree-node-title', onDblclick: (event: MouseEvent) => onNodeDoubleClick(event, node) }, [
      h('span', {
        class: ['connection-drag-handle', { 'is-disabled': !canReorder }],
        title: t('sidebar.connectionDragHandle'),
        'aria-label': t('sidebar.connectionDragHandle'),
        onDblclick: (event: MouseEvent) => event.stopPropagation()
      }, [h(NIcon, { size: 13 }, { default: () => h(HolderOutlined) })]),
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
  else if (node.data.kind === 'objectGroup') component = node.data.group === 'tables' || node.data.group === 'collections' ? TableOutlined : node.data.group === 'views' ? EyeOutlined : FunctionOutlined
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
onBeforeUnmount(() => {
  if (searchMetadataTimer) clearTimeout(searchMetadataTimer)
  disarmConnectionRowDrag()
})
function collapseAll(): void { expandedKeys.value = [] }
function openNewConnection(): void { editing.value = null; dialogOpen.value = true }
function closeDialog(): void { dialogOpen.value = false; editing.value = null }
function openCreateDatabase(connection: ConnectionMeta): void {
  if (!capabilitiesOf(connection)?.databases.create.supported || connection.permissionMode === 'readonly') return
  createDatabaseConnectionId.value = connection.id
  createDatabaseName.value = ''
  createDatabaseModalOpen.value = true
}
function closeCreateDatabase(): void {
  if (creatingDatabase.value) return
  createDatabaseModalOpen.value = false
  createDatabaseConnectionId.value = null
  createDatabaseName.value = ''
}
function openCreateCollection(connection: ConnectionMeta, database?: string): void {
  const capabilities = capabilitiesOf(connection)
  if (!capabilities?.objectKinds.includes('collection') || !capabilities.objects.create.supported || connection.permissionMode === 'readonly') return
  createCollectionConnectionId.value = connection.id
  createCollectionDatabase.value = database ?? connection.database
  createCollectionName.value = ''
  createCollectionVectorSize.value = 1536
  createCollectionDistance.value = 'Cosine'
  createCollectionModalOpen.value = true
}
function closeCreateCollection(): void {
  if (creatingCollection.value) return
  createCollectionModalOpen.value = false
  createCollectionConnectionId.value = null
  createCollectionDatabase.value = undefined
  createCollectionName.value = ''
}
function openCreateKey(connection: ConnectionMeta, database?: string): void {
  const capabilities = capabilitiesOf(connection)
  if (!capabilities?.objectKinds.includes('key') || !capabilities.objects.create.supported || connection.permissionMode === 'readonly') return
  createKeyConnectionId.value = connection.id
  createKeyDatabase.value = database ?? connection.database
  createKeyName.value = ''
  createKeyType.value = 'string'
  createKeyValue.value = ''
  createKeyModalOpen.value = true
}
function closeCreateKey(): void {
  if (creatingKey.value) return
  createKeyModalOpen.value = false
  createKeyConnectionId.value = null
  createKeyDatabase.value = undefined
  createKeyName.value = ''
}
async function confirmCreateKey(): Promise<void> {
  const connection = createKeyConnectionId.value ? connectionOf(createKeyConnectionId.value) : undefined
  const database = createKeyDatabase.value
  const name = createKeyName.value.trim()
  if (!connection || !name) { message.warning(t('sidebar.keyNameRequired')); return }
  creatingKey.value = true
  try {
    const definition: Record<string, unknown> = { type: createKeyType.value }
    if (createKeyType.value === 'hash') Object.assign(definition, { field: 'field', value: createKeyValue.value })
    else if (createKeyType.value === 'set') Object.assign(definition, { member: createKeyValue.value || 'member' })
    else if (createKeyType.value === 'zset') Object.assign(definition, { member: createKeyValue.value || 'member', score: 0 })
    else if (createKeyType.value === 'stream') Object.assign(definition, { value: { value: createKeyValue.value } })
    else Object.assign(definition, { value: createKeyValue.value })
    const result = await store.executeOperationWithApproval(connection.id, {
      kind: 'object.create', objectType: 'key', name, database, definition
    })
    if (result.status === 'ok') {
      message.success(t('sidebar.keyCreated', { name }))
      createKeyModalOpen.value = false
      createKeyConnectionId.value = null
      createKeyDatabase.value = undefined
      createKeyName.value = ''
      await refreshTables(connection.id, database)
    } else if (result.status === 'denied') message.warning(result.error ?? '')
    else if (result.status === 'error') message.error(result.error ?? '')
  } finally { creatingKey.value = false }
}
async function confirmCreateCollection(): Promise<void> {
  const connection = createCollectionConnectionId.value ? connectionOf(createCollectionConnectionId.value) : undefined
  const database = createCollectionDatabase.value
  const name = createCollectionName.value.trim()
  if (!connection) return
  const capabilities = capabilitiesOf(connection)
  if (!capabilities?.objectKinds.includes('collection') || !capabilities.objects.create.supported) return
  if (!name) { message.warning(t('sidebar.collectionNameRequired')); return }
  if (capabilities.recordModel === 'point' && (!Number.isInteger(createCollectionVectorSize.value) || createCollectionVectorSize.value < 1)) {
    message.warning(t('sidebar.collectionVectorSizeRequired'))
    return
  }
  creatingCollection.value = true
  try {
    const result = await store.executeOperationWithApproval(connection.id, {
      kind: 'object.create', objectType: 'collection', name, database,
      definition: capabilities.recordModel === 'point'
        ? { vectors: { size: createCollectionVectorSize.value, distance: createCollectionDistance.value } }
        : {}
    })
    if (result.status === 'ok') {
      message.success(t('sidebar.collectionCreated', { name }))
      createCollectionModalOpen.value = false
      createCollectionConnectionId.value = null
      createCollectionDatabase.value = undefined
      createCollectionName.value = ''
      if (database === undefined) await openConnection(connection.id, true)
      else await refreshTables(connection.id, database)
    } else if (result.status === 'denied') message.warning(result.error ?? '')
    else if (result.status === 'error') message.error(t('sidebar.createCollectionFailed', { error: result.error ?? '' }))
  } catch (error) {
    message.error(t('sidebar.createCollectionFailed', { error: error instanceof Error ? error.message : String(error) }))
  } finally {
    creatingCollection.value = false
  }
}
async function confirmCreateDatabase(): Promise<void> {
  const connection = createDatabaseConnectionId.value ? connectionOf(createDatabaseConnectionId.value) : undefined
  const name = createDatabaseName.value.trim()
  if (!connection || !capabilitiesOf(connection)?.databases.create.supported) return
  if (!name) { message.warning(t('sidebar.databaseNameRequired')); return }
  creatingDatabase.value = true
  try {
    const result = await store.executeOperationWithApproval(connection.id, {
      kind: 'object.create', objectType: 'database', name, definition: {}
    })
    if (result.status === 'ok') {
      message.success(t('sidebar.databaseCreated', { name }))
      createDatabaseModalOpen.value = false
      createDatabaseConnectionId.value = null
      createDatabaseName.value = ''
      await openConnection(connection.id, true)
    } else if (result.status === 'denied') message.warning(result.error ?? '')
    else if (result.status === 'error') message.error(t('sidebar.createDatabaseFailed', { error: result.error ?? '' }))
  } catch (error) {
    message.error(t('sidebar.createDatabaseFailed', { error: error instanceof Error ? error.message : String(error) }))
  } finally {
    creatingDatabase.value = false
  }
}
function openNewQuery(connectionId: string | number): void {
  const connection = connectionOf(String(connectionId))
  if (connection) store.openTab({ type: 'query', title: t('sidebar.queryTitle', { name: connection.name }), connectionId: connection.id })
}
function closeDropDatabase(): void {
  if (droppingDatabase.value) return
  dropDatabaseTarget.value = null
  dropDatabaseConfirmation.value = ''
}
async function confirmDropDatabase(): Promise<void> {
  const target = dropDatabaseTarget.value
  const connection = target ? connectionOf(target.connectionId) : undefined
  if (!target || !connection || droppingDatabase.value || dropDatabaseConfirmation.value !== target.database) return
  droppingDatabase.value = true
  try {
    const result = await store.executeOperationWithApproval(connection.id, { kind: 'database.drop', database: target.database })
    if (result.status === 'ok') {
      dropDatabaseTarget.value = null
      dropDatabaseConfirmation.value = ''
      message.success(t('sidebar.databaseDropped', { name: target.database }))
    } else if (result.status === 'denied') message.warning(result.error ?? '')
    else if (result.status === 'error') message.error(t('sidebar.dropDatabaseFailed', { error: result.error ?? '' }))
  } catch (error) {
    message.error(t('sidebar.dropDatabaseFailed', { error: error instanceof Error ? error.message : String(error) }))
  } finally {
    droppingDatabase.value = false
  }
}

// 删除事件也可能来自其他窗口；及时移除已不存在的数据库节点并刷新连接。
const stopDatabaseDropListener = window.api.onMetadataChanged?.((connectionId, droppedDatabase) => {
  if (droppedDatabase === undefined) return
  const connection = connectionOf(connectionId)
  const remove = (nodes: DbTreeNode[]): DbTreeNode[] => nodes
    .filter((node) => !(node.data.kind === 'database' && node.data.connectionId === connectionId && (connection?.type === 'sqlserver' ? node.data.database.toLowerCase() === droppedDatabase.toLowerCase() : node.data.database === droppedDatabase)))
    .map((node) => node.children ? { ...node, children: remove(node.children) } : node)
  treeData.value = remove(treeData.value)
  void store.loadConnections().then(() => openConnection(connectionId, true)).catch((error) => message.error(error instanceof Error ? error.message : String(error)))
}) ?? (() => {})
onBeforeUnmount(stopDatabaseDropListener)
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
useContextMenuDismiss(() => { contextMenuShow.value = false })
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
    <div class="sidebar-tree"><NTree remote block-line :data="displayData" :expanded-keys="expandedKeys" :selected-keys="selectedKeys" :on-load="loadNode" :render-label="renderLabel" :render-prefix="renderPrefix" :node-props="treeNodeProps" @update:expanded-keys="updateExpandedKeys" @update:selected-keys="selectTreeNode" /></div>
    <NDropdown trigger="manual" placement="bottom-start" :show="contextMenuShow" :x="contextMenuX" :y="contextMenuY" :options="contextMenuOptions" @select="selectContextMenu" @clickoutside="contextMenuShow = false" />
    <ConnectionDialog :show="dialogOpen" :initial="editing" @close="closeDialog" />
    <NModal :show="!!dropDatabaseTarget" :mask-closable="!droppingDatabase" :close-on-esc="!droppingDatabase" @update:show="(show) => { if (!show) closeDropDatabase() }">
      <NCard class="copy-table-modal" :title="t('sidebar.dropDatabaseTitle', { name: dropDatabaseTarget?.database ?? '' })" :closable="!droppingDatabase" @close="closeDropDatabase">
        <p>{{ t('sidebar.targetConnectionName') }}：{{ dropDatabaseConnection?.name }}</p>
        <p v-if="dropDatabaseConnection">{{ t('sidebar.targetServerAddress') }}：{{ connectionEndpoint(dropDatabaseConnection) }}</p>
        <p>{{ t('sidebar.dropDatabaseHint') }}</p>
        <NFormItem :label="t('sidebar.dropDatabaseConfirmLabel', { name: dropDatabaseTarget?.database ?? '' })" required>
          <NInput v-model:value="dropDatabaseConfirmation" autofocus :disabled="droppingDatabase" @keyup.enter="confirmDropDatabase" />
        </NFormItem>
        <template #footer><div class="modal-actions">
          <NButton :disabled="droppingDatabase" @click="closeDropDatabase">{{ t('common.cancel') }}</NButton>
          <NButton type="error" :loading="droppingDatabase" :disabled="dropDatabaseConfirmation !== dropDatabaseTarget?.database" @click="confirmDropDatabase">{{ t('sidebar.dropDatabase') }}</NButton>
        </div></template>
      </NCard>
    </NModal>
    <ConnectionExportDialog :connection="exportConnection" :mode="exportMode" @close="exportConnection = null" @connected="(id) => store.setConnected(id, true)" />
    <NModal :show="createDatabaseModalOpen" :mask-closable="!creatingDatabase" @update:show="(show) => { if (!show) closeCreateDatabase() }">
      <NCard class="copy-table-modal" :title="t('sidebar.newDatabase')" closable @close="closeCreateDatabase">
        <NFormItem v-if="createDatabaseConnection" :label="t('sidebar.targetInstance')">
          <div class="create-database-target">
            <div class="create-database-target-row">
              <span class="create-database-target-label">{{ t('sidebar.targetConnectionName') }}</span>
              <span class="create-database-target-value create-database-target-name">
                <DatabaseTypeIcon :type="createDatabaseConnection.type" :color="createDatabaseConnection.color" :size="18" />
                <strong>{{ createDatabaseConnection.name }}</strong>
              </span>
            </div>
            <div class="create-database-target-row">
              <span class="create-database-target-label">{{ t('sidebar.targetDatabaseType') }}</span>
              <span class="create-database-target-value">{{ databaseTypeLabels[createDatabaseConnection.type] }}</span>
            </div>
            <div class="create-database-target-row">
              <span class="create-database-target-label">{{ t('sidebar.targetServerAddress') }}</span>
              <span class="create-database-target-value create-database-target-endpoint">{{ connectionEndpoint(createDatabaseConnection) }}</span>
            </div>
          </div>
        </NFormItem>
        <NFormItem :label="t('sidebar.databaseName')" required>
          <NInput v-model:value="createDatabaseName" autofocus :disabled="creatingDatabase" :placeholder="t('sidebar.databaseNamePlaceholder')" @keyup.enter="confirmCreateDatabase" />
        </NFormItem>
        <template #footer>
          <div class="modal-actions"><NButton :disabled="creatingDatabase" @click="closeCreateDatabase">{{ t('common.cancel') }}</NButton><NButton type="primary" :loading="creatingDatabase" @click="confirmCreateDatabase">{{ t('sidebar.createDatabase') }}</NButton></div>
        </template>
      </NCard>
    </NModal>
    <NModal :show="createCollectionModalOpen" :mask-closable="!creatingCollection" @update:show="(show) => { if (!show) closeCreateCollection() }">
      <NCard class="copy-table-modal" :title="t('sidebar.newCollection')" closable @close="closeCreateCollection">
        <NFormItem :label="t('sidebar.collectionName')" required>
          <NInput v-model:value="createCollectionName" autofocus :disabled="creatingCollection" :placeholder="t('sidebar.collectionNamePlaceholder')" />
        </NFormItem>
        <NFormItem v-if="createCollectionIsPoint" :label="t('sidebar.collectionVectorSize')" required>
          <NInputNumber v-model:value="createCollectionVectorSize" :min="1" :max="65536" :disabled="creatingCollection" />
        </NFormItem>
        <NFormItem v-if="createCollectionIsPoint" :label="t('sidebar.collectionDistance')" required>
          <NSelect v-model:value="createCollectionDistance" :options="qdrantDistanceOptions" :disabled="creatingCollection" />
        </NFormItem>
        <template #footer>
          <div class="modal-actions"><NButton :disabled="creatingCollection" @click="closeCreateCollection">{{ t('common.cancel') }}</NButton><NButton type="primary" :loading="creatingCollection" @click="confirmCreateCollection">{{ t('sidebar.createCollection') }}</NButton></div>
        </template>
      </NCard>
    </NModal>
    <NModal :show="createKeyModalOpen" :mask-closable="!creatingKey" @update:show="(show) => { if (!show) closeCreateKey() }">
      <NCard class="copy-table-modal" :title="t('sidebar.newKey')" closable @close="closeCreateKey">
        <NFormItem :label="t('sidebar.keyName')" required><NInput v-model:value="createKeyName" autofocus :disabled="creatingKey" /></NFormItem>
        <NFormItem :label="t('sidebar.keyType')" required><NSelect v-model:value="createKeyType" :options="redisTypeOptions" :disabled="creatingKey" /></NFormItem>
        <NFormItem :label="t('sidebar.initialValue')"><NInput v-model:value="createKeyValue" :disabled="creatingKey" /></NFormItem>
        <template #footer>
          <div class="modal-actions"><NButton :disabled="creatingKey" @click="closeCreateKey">{{ t('common.cancel') }}</NButton><NButton type="primary" :loading="creatingKey" @click="confirmCreateKey">{{ t('sidebar.createKey') }}</NButton></div>
        </template>
      </NCard>
    </NModal>
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
