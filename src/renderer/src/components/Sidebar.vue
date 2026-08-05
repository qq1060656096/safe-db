<script setup lang="ts">
import { computed, h, ref, watch } from 'vue'
import { AppstoreOutlined, ClearOutlined, CodeOutlined, CopyOutlined, DatabaseOutlined, DeleteOutlined, DisconnectOutlined, EditOutlined, ExportOutlined, EyeOutlined, FolderOutlined, FunctionOutlined, HistoryOutlined, ImportOutlined, LockOutlined, MoreOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, TableOutlined, UnlockOutlined } from '@vicons/antd'
import { NButton, NDropdown, NIcon, NInput, NTag, NTooltip, NTree, useDialog, useMessage, type DropdownOption, type TreeOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ConnectionMeta, DbType, PermissionMode, RoutineInfo, SavedQuery, TableInfo } from '../../../shared/types'
import { useAppStore } from '../stores/app'
import { useSettingsStore } from '../stores/settings'
import ConnectionDialog from './ConnectionDialog.vue'

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
const settings = useSettingsStore()
const { t } = useI18n()
const dialog = useDialog()
const message = useMessage()
const treeData = ref<DbTreeNode[]>([])
const search = ref('')
const expandedKeys = ref<TreeKey[]>([])
const dialogOpen = ref(false)
const editing = ref<ConnectionMeta | null>(null)
const contextMenuShow = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
const contextMenuNode = ref<DbTreeNode | null>(null)
const permissionChangingId = ref<string | null>(null)

const permissionType: Record<PermissionMode, 'info' | 'warning' | 'success'> = { readonly: 'info', approval: 'warning', full: 'success' }
const languageOptions = computed<DropdownOption[]>(() => [
  { key: 'zh-CN', label: t('common.chinese') }, { key: 'en-US', label: t('common.english') }
])
const queryConnectionOptions = computed<DropdownOption[]>(() => store.connections.length
  ? store.connections.map((connection) => ({
      key: connection.id,
      label: connection.name,
      icon: () => h(NIcon, null, { default: () => h(DatabaseOutlined) })
    }))
  : [{ key: 'empty', label: t('sidebar.noConnections'), disabled: true }]
)
const connectionTransferOptions = computed<DropdownOption[]>(() => [
  { key: 'import', label: t('sidebar.importConnections'), icon: () => h(NIcon, null, { default: () => h(ImportOutlined) }) },
  { key: 'export', label: t('sidebar.exportConnections'), disabled: store.connections.length === 0, icon: () => h(NIcon, null, { default: () => h(ExportOutlined) }) }
])

function connectionKey(id: string): string { return `conn:${id}` }
function databaseKey(id: string, database: string): string { return `db:${id}:${database}` }
function savedQueryGroupKey(id: string, database?: string): string { return `query-group:${id}:${database ?? ''}` }
function sqlLiteral(value: string): string { return `'${value.replace(/'/g, "''")}'` }
function quoteIdentifier(type: DbType | undefined, name: string): string {
  return type === 'mysql' ? '`' + name.replace(/`/g, '``') + '`' : '"' + name.replace(/"/g, '""') + '"'
}
function qualifiedTable(type: DbType | undefined, database: string | undefined, schema: string | undefined, table: string): string {
  if (type === 'postgres') return `${quoteIdentifier(type, schema ?? 'public')}.${quoteIdentifier(type, table)}`
  if (type === 'mysql' && database) return `${quoteIdentifier(type, database)}.${quoteIdentifier(type, table)}`
  return quoteIdentifier(type, table)
}
function connectionNode(connection: ConnectionMeta): DbTreeNode {
  return { key: connectionKey(connection.id), isLeaf: false, label: connection.name, children: withSavedQueryGroup([], connection.id), data: { kind: 'connection', connectionId: connection.id } }
}
function rebuildRoots(): void { treeData.value = store.connections.map(connectionNode) }
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
  const databases = await window.api.listDatabases(connectionId)
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
  if (connection.type !== 'sqlite') groups.push(makeGroup('routines', routines.map((routine) => routineNode(connection.id, database, routine))))
  return groups
}
async function listRoutines(connection: ConnectionMeta, database: string): Promise<RoutineInfo[]> {
  if (connection.type === 'sqlite') return []
  if (typeof window.api.listRoutines === 'function') {
    try {
      return await window.api.listRoutines(connection.id, database)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (!/No handler registered for ['"]?db:routines/.test(detail)) throw error
    }
  }
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
    window.api.listTables(connectionId, database),
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
  try {
    const children = await loadConnectionChildren(connectionId, force)
    if (!store.connectedIds[connectionId]) return
    const key = connectionKey(connectionId)
    setNodeChildren(key, children)
    expandedKeys.value = [...new Set([...expandedKeys.value, key])]
  } catch (error) {
    store.setConnected(connectionId, false)
    clearConnectionTree(connectionId)
    message.error(error instanceof Error ? error.message : String(error))
  }
}
async function refreshTables(connectionId: string, database?: string): Promise<void> {
  if (database === undefined) return
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
  store.openTab({ type: 'query', title: query.name, connectionId: query.connectionId, database: query.database, sql: query.sql, savedQueryId: query.id })
}
function openTable(node: Extract<NodeData, { kind: 'table' }>): void {
  store.openTab({ type: 'table', title: node.table, connectionId: node.connectionId, database: node.database, schema: node.schema, table: node.table })
}
async function runTableAction(connection: ConnectionMeta, node: Extract<NodeData, { kind: 'table' }>, action: string): Promise<void> {
  const name = qualifiedTable(connection.type, node.database, node.schema, node.table)
  if (action === 'copy') {
    await navigator.clipboard.writeText(node.table)
    message.success(t('sidebar.copiedTableName', { name: node.table }))
    return
  }
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
  return [
    { key: 'connect', label: t('sidebar.connect'), disabled: connected, icon: () => h(NIcon, null, { default: () => h(DatabaseOutlined) }) },
    { key: 'query', label: t('sidebar.newQuery'), icon: () => h(NIcon, null, { default: () => h(PlusOutlined) }) },
    { key: 'refresh', label: t('common.refresh'), disabled: !connected, icon: () => h(NIcon, null, { default: () => h(ReloadOutlined) }) },
    { key: 'edit', label: t('sidebar.editConnection'), icon: () => h(NIcon, null, { default: () => h(EditOutlined) }) },
    { key: 'disconnect', label: t('sidebar.disconnect'), disabled: !connected, icon: () => h(NIcon, null, { default: () => h(DisconnectOutlined) }) },
    { type: 'divider', key: 'divider' },
    { key: 'delete', label: t('sidebar.deleteConnection'), icon: () => h(NIcon, { color: '#d03050' }, { default: () => h(DeleteOutlined) }) }
  ]
}
function tableOptions(tableType: 'table' | 'view'): DropdownOption[] {
  const common: DropdownOption[] = [
    { key: 'open', label: t('sidebar.openTable'), icon: () => h(NIcon, null, { default: () => h(TableOutlined) }) },
    { key: 'query', label: t('sidebar.newQuery'), icon: () => h(NIcon, null, { default: () => h(PlusOutlined) }) },
    { key: 'copy', label: t('sidebar.copyObjectName'), icon: () => h(NIcon, null, { default: () => h(CopyOutlined) }) }
  ]
  if (tableType === 'view') return common
  return [
    common[0],
    { key: 'design', label: t('sidebar.designTable'), icon: () => h(NIcon, null, { default: () => h(EditOutlined) }) },
    ...common.slice(1),
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
  if (node.data.kind === 'savedQueryGroup') return
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
  if (node.data.kind === 'savedQueryGroup') return []
  if (node.data.kind === 'database') return [
    { key: 'query', label: t('sidebar.newQuery'), icon: () => h(NIcon, null, { default: () => h(CodeOutlined) }) },
    { key: 'newTable', label: t('sidebar.newTable'), icon: () => h(NIcon, null, { default: () => h(TableOutlined) }) }
  ]
  if (node.data.kind === 'schema') return [{ key: 'newTable', label: t('sidebar.newTable') }]
  if (node.data.kind === 'objectGroup') return node.data.group === 'tables' ? [{ key: 'newTable', label: t('sidebar.newTable') }] : []
  if (node.data.kind === 'routine') return routineOptions()
  return tableOptions(node.data.tableType)
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
function renderLabel({ option }: { option: TreeOption }): ReturnType<typeof h> {
  const node = option as DbTreeNode
  let content: ReturnType<typeof h>
  if (node.data.kind === 'connection') {
    const connection = connectionOf(node.data.connectionId)
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
    content = h('span', { class: 'tree-node-title', onDblclick: (event: MouseEvent) => onNodeDoubleClick(event, node) }, [connection?.name ?? '', permissionControl])
  } else if (node.data.kind === 'objectGroup' || node.data.kind === 'savedQueryGroup') {
    content = h('span', { class: 'tree-node-title', onDblclick: (event: MouseEvent) => onNodeDoubleClick(event, node) }, [
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
  const trigger = h('span', {
    class: 'tree-context-trigger',
    onContextmenu: (event: MouseEvent) => {
      event.preventDefault()
      contextMenuNode.value = node
      contextMenuX.value = event.clientX
      contextMenuY.value = event.clientY
      contextMenuShow.value = true
    }
  }, [content])
  return node.data.kind === 'table' && node.data.comment
    ? h(NTooltip, { placement: 'right', delay: 600 }, { trigger: () => trigger, default: () => node.data.kind === 'table' ? node.data.comment : '' })
    : trigger
}
function renderPrefix({ option }: { option: TreeOption }): ReturnType<typeof h> {
  const node = option as DbTreeNode
  let component = DatabaseOutlined
  let color: string | undefined
  if (node.data.kind === 'connection') { const connection = connectionOf(node.data.connectionId); color = store.connectedIds[node.data.connectionId] ? (connection?.color || '#18a058') : '#999' }
  else if (node.data.kind === 'savedQueryGroup') component = FolderOutlined
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
function openNewConnection(): void { editing.value = null; dialogOpen.value = true }
function closeDialog(): void { dialogOpen.value = false; editing.value = null }
function openNewQuery(connectionId: string | number): void {
  const connection = connectionOf(String(connectionId))
  if (connection) store.openTab({ type: 'query', title: t('sidebar.queryTitle', { name: connection.name }), connectionId: connection.id })
}
async function transferConnections(action: string | number): Promise<void> {
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
      <span>{{ t('sidebar.connections') }}</span>
      <span class="sidebar-actions">
        <NDropdown trigger="click" :options="languageOptions" @select="(locale) => settings.setLocale(locale as 'zh-CN' | 'en-US')"><NButton quaternary size="tiny">{{ settings.locale === 'zh-CN' ? '中' : 'EN' }}</NButton></NDropdown>
        <NButton quaternary size="small" :title="t('sidebar.auditLog')" @click="store.openTab({ type: 'audit', title: t('sidebar.auditLog') })"><template #icon><NIcon><HistoryOutlined /></NIcon></template></NButton>
        <NDropdown trigger="click" :options="queryConnectionOptions" @select="openNewQuery"><NButton quaternary size="small" :title="t('sidebar.newQuery')"><template #icon><NIcon><CodeOutlined /></NIcon></template></NButton></NDropdown>
        <NDropdown trigger="click" :options="connectionTransferOptions" @select="transferConnections"><NButton quaternary size="small" :title="t('sidebar.connectionManagement')"><template #icon><NIcon><MoreOutlined /></NIcon></template></NButton></NDropdown>
        <NButton type="primary" secondary size="small" @click="openNewConnection"><template #icon><NIcon><PlusOutlined /></NIcon></template>{{ t('sidebar.newConnection') }}</NButton>
      </span>
    </header>
    <div class="sidebar-search"><NInput v-model:value="search" clearable size="small" :placeholder="t('sidebar.searchPlaceholder')"><template #prefix><NIcon color="#aaa"><SearchOutlined /></NIcon></template></NInput></div>
    <div class="sidebar-tree"><NTree remote block-line :data="displayData" :expanded-keys="expandedKeys" :selected-keys="[]" :on-load="loadNode" :render-label="renderLabel" :render-prefix="renderPrefix" @update:expanded-keys="updateExpandedKeys" /></div>
    <NDropdown trigger="manual" placement="bottom-start" :show="contextMenuShow" :x="contextMenuX" :y="contextMenuY" :options="contextMenuOptions" @select="selectContextMenu" @clickoutside="contextMenuShow = false" />
    <ConnectionDialog :show="dialogOpen" :initial="editing" @close="closeDialog" />
  </aside>
</template>
