<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AppstoreOutlined, ClearOutlined, CodeOutlined, CopyOutlined, DeleteOutlined, EditOutlined, EyeOutlined, FolderOpenOutlined, FunctionOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, TableOutlined, UnorderedListOutlined } from '@vicons/antd'
import { NButton, NCard, NCheckbox, NDataTable, NDropdown, NFormItem, NIcon, NInput, NModal, NTooltip, useDialog, useMessage, type DataTableColumns, type DropdownOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { RoutineInfo, SavedQuery, TableInfo } from '../../../shared/types'
import { connectionMetadataRevision } from '../metadataCache'
import type { AppTab, ObjectSelection } from '../stores/app'
import { useAppStore } from '../stores/app'

type ObjectRow = {
  key: string
  kind: 'table' | 'routine' | 'query'
  name: string
  schema?: string
  type: 'table' | 'view' | 'function' | 'procedure' | 'query'
  rowCount?: number
  createdAt?: string
  updatedAt?: string
  objectId?: string | number
  detail?: string
  table?: TableInfo
  routine?: RoutineInfo
  query?: SavedQuery
}

const props = defineProps<{ tab: AppTab }>()
const store = useAppStore()
const { t } = useI18n()
const dialog = useDialog()
const message = useMessage()
const loading = ref(false)
const dropping = ref(false)
const truncating = ref(false)
const copyModalOpen = ref(false)
const copySource = ref<ObjectRow | null>(null)
const copyTargetName = ref('')
const copyWithData = ref(true)
const copyingTable = ref(false)
const batchCopyModalOpen = ref(false)
const batchCopyRows = ref<ObjectRow[]>([])
const batchCopyWithData = ref(true)
const keyword = ref('')
const loadedRows = ref<ObjectRow[]>([])
const pageRef = ref<HTMLElement | null>(null)
const selectedKey = ref<string | null>(null)
const selectedKeys = ref<string[]>([])
const lastSelectedIndex = ref<number | null>(null)
const viewMode = ref<'list' | 'grid'>('list')
const tableContextShow = ref(false)
const tableContextX = ref(0)
const tableContextY = ref(0)
const tableContextRow = ref<ObjectRow | null>(null)
let shortcutScopeActive = false

const queryRows = computed<ObjectRow[]>(() => store.savedQueries
  .filter((query) => query.connectionId === props.tab.connectionId && query.database === props.tab.database)
  .map((query) => ({
    key: `query:${query.id}`, kind: 'query', name: query.name, type: 'query',
    createdAt: query.createdAt, updatedAt: query.updatedAt, objectId: query.id, query
  })))
const rows = computed(() => props.tab.objectGroup === 'queries' ? queryRows.value : loadedRows.value)
const selectedRow = computed(() => rows.value.find((row) => row.key === selectedKey.value))
const connection = computed(() => store.connections.find((item) => item.id === props.tab.connectionId))
const supportsStructure = computed(() => connection.value?.type !== 'mongodb' && connection.value?.type !== 'redis')
const tableContextOptions = computed<DropdownOption[]>(() => {
  const row = tableContextRow.value
  if (!row?.table) return []
  return [
    { key: 'open', label: t('sidebar.openTable'), icon: () => h(NIcon, null, { default: () => h(TableOutlined) }) },
    ...(row.table.type === 'table' && supportsStructure.value ? [
      { key: 'copy', label: t('sidebar.copyTable'), icon: () => h(NIcon, null, { default: () => h(CopyOutlined) }) },
      { type: 'divider' as const, key: 'table-action-divider' },
      { key: 'clear-table', label: t('sidebar.truncateTable'), icon: () => h(NIcon, { color: '#d03050' }, { default: () => h(ClearOutlined) }) },
      { key: 'clear-data', label: t('objectList.clearData'), icon: () => h(NIcon, { color: '#d03050' }, { default: () => h(ClearOutlined) }) },
      { key: 'drop', label: t('sidebar.dropTable'), icon: () => h(NIcon, { color: '#d03050' }, { default: () => h(DeleteOutlined) }) }
    ] : [])
  ]
})
const filteredRows = computed(() => {
  const value = keyword.value.trim().toLocaleLowerCase()
  if (!value) return rows.value
  return rows.value.filter((row) => [row.name, row.schema, row.type, row.detail, row.objectId]
    .some((field) => String(field ?? '').toLocaleLowerCase().includes(value)))
})

function formatDate(value?: string): string {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
function formatRows(value?: number): string {
  return value === undefined || !Number.isFinite(value) ? '-' : Math.max(0, value).toLocaleString()
}
function quoteIdentifier(type: NonNullable<typeof connection.value>['type'], name: string): string {
  if (type === 'mysql') return '`' + name.replace(/`/g, '``') + '`'
  if (type === 'sqlserver') return '[' + name.replace(/]/g, ']]') + ']'
  return '"' + name.replace(/"/g, '""') + '"'
}
function qualifiedTable(type: NonNullable<typeof connection.value>['type'], database: string, schema: string | undefined, table: string): string {
  if (type === 'postgres') return `${quoteIdentifier(type, schema ?? 'public')}.${quoteIdentifier(type, table)}`
  if (type === 'sqlserver') return `${quoteIdentifier(type, schema ?? 'dbo')}.${quoteIdentifier(type, table)}`
  if (type === 'mysql') return `${quoteIdentifier(type, database)}.${quoteIdentifier(type, table)}`
  return quoteIdentifier(type, table)
}
function iconOf(row: ObjectRow): typeof TableOutlined {
  if (row.type === 'view') return EyeOutlined
  if (row.kind === 'routine') return FunctionOutlined
  if (row.kind === 'query') return CodeOutlined
  return TableOutlined
}

const columns = computed<DataTableColumns<ObjectRow>>(() => [
  { type: 'selection', fixed: 'left' as const },
  {
    title: t('objectList.name'), key: 'name', sorter: 'default', minWidth: 240, ellipsis: true,
    render: (row) => h('span', { class: 'object-name-cell' }, [h(NIcon, { color: '#35aeb5', size: 17 }, { default: () => h(iconOf(row)) }), row.name])
  },
  { title: t('objectList.rows'), key: 'rowCount', width: 120, sorter: (a, b) => (a.rowCount ?? -1) - (b.rowCount ?? -1), render: (row) => formatRows(row.rowCount) },
  { title: t('objectList.createdAt'), key: 'createdAt', width: 190, sorter: 'default', render: (row) => formatDate(row.createdAt) },
  { title: t('objectList.updatedAt'), key: 'updatedAt', width: 190, sorter: 'default', render: (row) => formatDate(row.updatedAt) },
  { title: t('objectList.oid'), key: 'objectId', width: 150, sorter: 'default', ellipsis: true, render: (row) => row.objectId ?? '-' }
])

async function load(): Promise<void> {
  if (!props.tab.connectionId || !props.tab.database || props.tab.objectGroup === 'queries') return
  loading.value = true
  try {
    if (props.tab.objectGroup === 'routines') {
      const routines = await window.api.listRoutines(props.tab.connectionId, props.tab.database)
      loadedRows.value = routines
        .filter((routine) => !props.tab.schema || routine.schema === props.tab.schema)
        .map((routine) => ({
          key: `routine:${routine.schema ?? ''}:${routine.type}:${routine.name}:${routine.arguments ?? ''}`,
          kind: 'routine', name: routine.name, schema: routine.schema, type: routine.type,
          createdAt: routine.createdAt, updatedAt: routine.updatedAt, objectId: routine.objectId,
          detail: routine.arguments === undefined ? undefined : `(${routine.arguments})`, routine
        }))
    } else {
      const expectedType = props.tab.objectGroup === 'views' ? 'view' : 'table'
      const tables = await window.api.listTables(props.tab.connectionId, props.tab.database, true)
      loadedRows.value = tables
        .filter((table) => table.type === expectedType && (!props.tab.schema || table.schema === props.tab.schema))
        .map((table) => ({
          key: `table:${table.schema ?? ''}:${table.type}:${table.name}`, kind: 'table', name: table.name,
          schema: table.schema, type: table.type, rowCount: table.rowCount, createdAt: table.createdAt,
          updatedAt: table.updatedAt, objectId: table.objectId, detail: table.comment, table
        }))
    }
    const validKeys = new Set(loadedRows.value.map((row) => row.key))
    selectedKeys.value = selectedKeys.value.filter((key) => validKeys.has(key))
    if (selectedKey.value && !validKeys.has(selectedKey.value)) {
      selectedKey.value = null
      store.setObjectSelection(props.tab.id)
    }
    const selection = props.tab.objectSelection
    const selectionStillExists = selection && loadedRows.value.some((row) => {
      if (selection.kind === 'table') return row.kind === 'table' && row.name === selection.name && row.schema === selection.schema
      return row.kind === 'routine' && row.name === selection.name && row.schema === selection.schema
        && row.routine?.type === selection.routineType && row.routine?.arguments === selection.routineArguments
    })
    if (selection && !selectionStillExists) store.setObjectSelection(props.tab.id)
    if (!selectedKey.value) lastSelectedIndex.value = null
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    loading.value = false
  }
}

watch(
  () => connectionMetadataRevision(props.tab.connectionId),
  () => {
    if (props.tab.objectGroup !== 'queries') void load()
  }
)

function openRow(row: ObjectRow): void {
  if (row.kind === 'query' && row.query) {
    store.openSavedQuery(row.query)
  } else if (row.kind === 'routine' && row.routine) {
    store.openTab({
      type: 'query', title: t('sidebar.routineTitle', { name: row.routine.name }), connectionId: props.tab.connectionId,
      database: props.tab.database, schema: row.routine.schema, routine: row.routine.name,
      routineType: row.routine.type, routineArguments: row.routine.arguments
    })
  } else if (row.table) {
    store.openTab({ type: 'table', title: row.table.name, connectionId: props.tab.connectionId, database: props.tab.database, schema: row.table.schema, table: row.table.name })
  }
}
function selectObjectRow(row: ObjectRow): void {
  selectedKey.value = row.key
  selectedKeys.value = [row.key]
  lastSelectedIndex.value = filteredRows.value.findIndex((item) => item.key === row.key)
  setObjectSelection(row)
}
function setObjectSelection(row: ObjectRow | undefined): void {
  let selection: ObjectSelection | undefined
  if (row?.kind === 'table' && row.table) selection = { kind: 'table', name: row.table.name, schema: row.table.schema }
  else if (row?.kind === 'routine' && row.routine) {
    selection = {
      kind: 'routine', name: row.routine.name, schema: row.routine.schema,
      routineType: row.routine.type, routineArguments: row.routine.arguments
    }
  }
  store.setObjectSelection(props.tab.id, selection)
}
function selectObjectRowFromEvent(event: MouseEvent, row: ObjectRow): void {
  if (event.target instanceof Element && event.target.closest('button, input, .n-checkbox')) return
  const index = filteredRows.value.findIndex((item) => item.key === row.key)
  const selected = new Set(selectedKeys.value)
  if (event.shiftKey && lastSelectedIndex.value !== null) {
    const start = Math.min(lastSelectedIndex.value, index)
    const end = Math.max(lastSelectedIndex.value, index)
    selectedKeys.value = filteredRows.value.slice(start, end + 1).map((item) => item.key)
  } else if (event.metaKey || event.ctrlKey) {
    if (selected.has(row.key)) selected.delete(row.key)
    else selected.add(row.key)
    selectedKeys.value = [...selected]
  } else {
    selectedKeys.value = [row.key]
  }
  selectedKey.value = row.key
  lastSelectedIndex.value = index
  setObjectSelection(row)
}
function updateSelectedKeys(keys: Array<string | number>): void {
  selectedKeys.value = keys.map(String)
  if (selectedKey.value && selectedKeys.value.includes(selectedKey.value)) return
  selectedKey.value = selectedKeys.value.at(-1) ?? null
  setObjectSelection(rows.value.find((row) => row.key === selectedKey.value))
}
function selectedCopyRows(): ObjectRow[] {
  const keys = new Set(selectedKeys.value.length ? selectedKeys.value : selectedKey.value ? [selectedKey.value] : [])
  return rows.value.filter((row) => keys.has(row.key) && row.table?.type === 'table' && supportsStructure.value)
}
function selectedDropRows(): ObjectRow[] {
  const keys = new Set(selectedKeys.value.length ? selectedKeys.value : selectedKey.value ? [selectedKey.value] : [])
  return rows.value.filter((row) => keys.has(row.key) && row.table?.type === 'table' && supportsStructure.value)
}
function updateShortcutScope(event: Event): void {
  const target = event.target
  shortcutScopeActive = target instanceof Node && Boolean(pageRef.value?.contains(target))
}
function isObjectListShortcut(event: KeyboardEvent): boolean {
  if (!shortcutScopeActive || store.activeTabId !== props.tab.id) return false
  const target = event.target
  return !(target instanceof Node && target !== document.body && !pageRef.value?.contains(target))
}
function handleSelectAll(event: KeyboardEvent): void {
  if (event.key.toLowerCase() !== 'a' || (!event.metaKey && !event.ctrlKey) || event.altKey || !isObjectListShortcut(event)) return
  const target = event.target
  if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"]')) return
  const visibleKeys = filteredRows.value.map((row) => row.key)
  if (!visibleKeys.length) return
  event.preventDefault()
  selectedKeys.value = visibleKeys
  selectedKey.value = visibleKeys[0]
  lastSelectedIndex.value = 0
  setObjectSelection(filteredRows.value[0])
}
function handleCopyShortcut(event: KeyboardEvent): void {
  if (event.key.toLowerCase() !== 'c' || (!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey || !isObjectListShortcut(event)) return
  const target = event.target
  if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"]')) return
  const rowsToCopy = selectedCopyRows()
  if (!rowsToCopy.length) return
  event.preventDefault()
  openCopyTables(rowsToCopy)
}
function openSelected(): void { if (selectedRow.value) openRow(selectedRow.value) }
function openTableContext(event: MouseEvent, row: ObjectRow): void {
  if (!row.table) return
  event.preventDefault()
  event.stopPropagation()
  if (selectedKeys.value.includes(row.key)) {
    selectedKey.value = row.key
    setObjectSelection(row)
  }
  else selectObjectRow(row)
  tableContextRow.value = row
  tableContextX.value = event.clientX
  tableContextY.value = event.clientY
  tableContextShow.value = true
}
function clearRow(row: ObjectRow, action: 'table' | 'data'): void {
  const table = row.table
  const currentConnection = connection.value
  if (truncating.value || !currentConnection || !props.tab.database || !table || table.type !== 'table' || !supportsStructure.value) return
  const tableName = table.name
  const qualifiedName = qualifiedTable(currentConnection.type, props.tab.database, table.schema, tableName)
  const sql = action === 'table' && currentConnection.type !== 'sqlite'
    ? `TRUNCATE TABLE ${qualifiedName};`
    : `DELETE FROM ${qualifiedName};`
  const title = action === 'table' ? t('sidebar.truncateTitle', { name: tableName }) : t('objectList.clearDataTitle', { name: tableName })
  const hint = action === 'table' ? t('sidebar.truncateHint', { sql }) : t('objectList.clearDataHint', { sql })
  const confirmText = action === 'table' ? t('sidebar.truncateOk') : t('objectList.clearDataOk')
  const successText = action === 'table' ? t('sidebar.truncated', { name: tableName }) : t('objectList.clearedData', { name: tableName })
  dialog.warning({
    title,
    content: hint,
    positiveText: confirmText,
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      truncating.value = true
      try {
        const result = await store.executeWithApproval(currentConnection.id, sql, props.tab.database)
        if (result.status === 'ok') {
          message.success(successText)
          await load()
        } else if (result.status === 'denied') message.warning(result.error ?? '')
        else if (result.status === 'error') message.error(result.error ?? '')
      } finally {
        truncating.value = false
      }
    }
  })
}
function truncateRow(row: ObjectRow): void { clearRow(row, 'table') }
function clearDataRow(row: ObjectRow): void { clearRow(row, 'data') }
function openCopyTable(row: ObjectRow): void {
  if (!row.table || row.table.type !== 'table' || !supportsStructure.value) return
  copySource.value = row
  copyTargetName.value = `${row.table.name}_copy`
  copyWithData.value = true
  copyModalOpen.value = true
}
function openCopyTables(rowsToCopy: ObjectRow[]): void {
  const validRows = rowsToCopy.filter((row) => row.table?.type === 'table' && supportsStructure.value)
  if (validRows.length === 1) {
    openCopyTable(validRows[0])
    return
  }
  if (!validRows.length) return
  batchCopyRows.value = validRows
  batchCopyWithData.value = true
  batchCopyModalOpen.value = true
}
function closeCopyTable(): void {
  if (copyingTable.value) return
  copyModalOpen.value = false
  copySource.value = null
}
function closeBatchCopyTable(): void {
  if (copyingTable.value) return
  batchCopyModalOpen.value = false
  batchCopyRows.value = []
}
async function buildCopySql(row: ObjectRow, targetName: string, withData: boolean): Promise<string> {
  const source = row.table
  const currentConnection = connection.value
  if (!source || source.type !== 'table' || !currentConnection || !props.tab.database) throw new Error(t('sidebar.copyTableFailed', { error: 'Invalid table target' }))
  const sourceSql = qualifiedTable(currentConnection.type, props.tab.database, source.schema, source.name)
  const targetSql = qualifiedTable(currentConnection.type, props.tab.database, source.schema, targetName)
  let createSql: string
  if (currentConnection.type === 'mysql') createSql = `CREATE TABLE ${targetSql} LIKE ${sourceSql};`
  else if (currentConnection.type === 'postgres') createSql = `CREATE TABLE ${targetSql} (LIKE ${sourceSql} INCLUDING ALL);`
  else if (currentConnection.type === 'sqlserver') {
    createSql = `SELECT ${withData ? '*' : 'TOP (0) *'} INTO ${targetSql} FROM ${sourceSql};`
  } else {
    const ddl = await window.api.getObjectDdl(currentConnection.id, props.tab.database, source.name, source.schema)
    const prefix = /^(\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]+\]|[^\s(]+)/i
    if (!prefix.test(ddl)) throw new Error(t('sidebar.copyTableDdlUnsupported'))
    createSql = ddl.replace(prefix, `$1${targetSql}`)
  }
  const insertPrefix = currentConnection.type === 'postgres' ? `INSERT INTO ${targetSql} OVERRIDING SYSTEM VALUE` : `INSERT INTO ${targetSql}`
  return `${createSql.replace(/;?\s*$/, ';')}${withData && currentConnection.type !== 'sqlserver' ? `\n${insertPrefix} SELECT * FROM ${sourceSql};` : ''}`
}
async function confirmCopyTable(): Promise<void> {
  const source = copySource.value?.table
  const targetName = copyTargetName.value.trim()
  if (!source || source.type !== 'table' || !targetName) {
    message.warning(t('sidebar.copyTableNameRequired'))
    return
  }
  copyingTable.value = true
  try {
    const currentConnection = connection.value
    if (!currentConnection || !props.tab.database) return
    const sql = await buildCopySql(copySource.value!, targetName, copyWithData.value)
    const result = await store.executeWithApproval(currentConnection.id, sql, props.tab.database)
    if (result.status === 'ok') {
      message.success(t('sidebar.tableCopied', { source: source.name, target: targetName }))
      copyModalOpen.value = false
      copySource.value = null
      await load()
    } else if (result.status === 'denied') message.warning(result.error ?? '')
    else if (result.status === 'error') message.error(result.error ?? '')
  } catch (error) {
    message.error(t('sidebar.copyTableFailed', { error: error instanceof Error ? error.message : String(error) }))
  } finally {
    copyingTable.value = false
  }
}
async function confirmBatchCopyTables(): Promise<void> {
  const rowsToCopy = batchCopyRows.value
  const currentConnection = connection.value
  if (!rowsToCopy.length || !currentConnection || !props.tab.database) return
  copyingTable.value = true
  let copied = 0
  try {
    for (const row of rowsToCopy) {
      const source = row.table
      if (!source || source.type !== 'table') continue
      const result = await store.executeWithApproval(
        currentConnection.id,
        await buildCopySql(row, `${source.name}_copy`, batchCopyWithData.value),
        props.tab.database
      )
      if (result.status !== 'ok') {
        if (result.status === 'denied') message.warning(result.error ?? '')
        else if (result.status === 'error') message.error(result.error ?? '')
        return
      }
      copied += 1
    }
    message.success(t('sidebar.tablesCopied', { count: copied }))
    batchCopyModalOpen.value = false
    batchCopyRows.value = []
    await load()
  } catch (error) {
    message.error(t('sidebar.copyTableFailed', { error: error instanceof Error ? error.message : String(error) }))
  } finally {
    copyingTable.value = false
  }
}
function selectTableContextAction(action: string | number): void {
  const row = tableContextRow.value
  tableContextShow.value = false
  tableContextRow.value = null
  if (!row) return
  if (action === 'open') openRow(row)
  else if (action === 'copy') openCopyTables(selectedCopyRows().length ? selectedCopyRows() : [row])
  else if (action === 'clear-table') truncateRow(row)
  else if (action === 'clear-data') clearDataRow(row)
  else if (action === 'drop') dropRows(selectedDropRows().length ? selectedDropRows() : [row])
}
function createObject(): void {
  if (props.tab.objectGroup === 'tables' && supportsStructure.value) {
    store.openTab({ type: 'structure', title: t('sidebar.newTable'), connectionId: props.tab.connectionId, database: props.tab.database, schema: props.tab.schema })
  } else if (props.tab.objectGroup === 'queries' && props.tab.connectionId) {
    const connectionName = store.connections.find((item) => item.id === props.tab.connectionId)?.name ?? ''
    store.openTab({
      type: 'query', title: t('sidebar.queryTitle', { name: props.tab.database ?? connectionName }),
      connectionId: props.tab.connectionId, database: props.tab.database
    })
  }
}
function designSelected(): void {
  const row = selectedRow.value
  if (!supportsStructure.value || !row?.table || row.table.type !== 'table') return
  store.openTab({ type: 'structure', title: t('sidebar.designTitle', { name: row.table.name }), connectionId: props.tab.connectionId, database: props.tab.database, schema: row.table.schema, table: row.table.name })
}
function dropRows(rowsToDrop: ObjectRow[]): void {
  const currentConnection = connection.value
  const database = props.tab.database
  if (dropping.value || !currentConnection || !database || !supportsStructure.value) return
  const tableRows = rowsToDrop.filter((row) => row.table?.type === 'table')
  if (!tableRows.length) return
  const sql = tableRows
    .map((row) => `DROP TABLE ${qualifiedTable(currentConnection.type, database, row.table!.schema, row.table!.name)};`)
    .join('\n')
  const batch = tableRows.length > 1
  const tableName = tableRows[0].table!.name
  dialog.error({
    title: batch ? t('sidebar.dropTablesTitle', { count: tableRows.length }) : t('sidebar.dropTitle', { name: tableName }),
    content: batch ? t('sidebar.dropTablesHint', { sql }) : t('sidebar.dropHint', { sql }),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      dropping.value = true
      try {
        const result = await store.executeWithApproval(currentConnection.id, sql, database)
        if (result.status === 'ok') {
          message.success(batch ? t('sidebar.tablesDropped', { count: tableRows.length }) : t('sidebar.dropped', { name: tableName }))
          selectedKey.value = null
          selectedKeys.value = []
          store.setObjectSelection(props.tab.id)
          await load()
        } else if (result.status === 'denied') message.warning(result.error ?? '')
        else if (result.status === 'error') message.error(result.error ?? '')
      } finally {
        dropping.value = false
      }
    }
  })
}
function dropSelected(): void {
  dropRows(selectedDropRows())
}
onMounted(() => {
  void load()
  document.addEventListener('pointerdown', updateShortcutScope, true)
  document.addEventListener('focusin', updateShortcutScope, true)
  window.addEventListener('keydown', handleSelectAll)
  window.addEventListener('keydown', handleCopyShortcut)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', updateShortcutScope, true)
  document.removeEventListener('focusin', updateShortcutScope, true)
  window.removeEventListener('keydown', handleSelectAll)
  window.removeEventListener('keydown', handleCopyShortcut)
})
</script>

<template>
  <div ref="pageRef" class="module-page object-list-page">
    <div class="module-toolbar object-list-toolbar">
      <span class="object-toolbar-actions">
        <NTooltip><template #trigger><NButton quaternary size="small" :disabled="!['tables', 'queries'].includes(tab.objectGroup ?? '') || (tab.objectGroup === 'tables' && !supportsStructure)" @click="createObject"><template #icon><NIcon><PlusOutlined /></NIcon></template></NButton></template>{{ t(tab.objectGroup === 'queries' ? 'sidebar.newQuery' : 'sidebar.newTable') }}</NTooltip>
        <NTooltip><template #trigger><NButton quaternary size="small" :disabled="!selectedRow" @click="openSelected"><template #icon><NIcon><FolderOpenOutlined /></NIcon></template></NButton></template>{{ t('objectList.open') }}</NTooltip>
        <NTooltip><template #trigger><NButton quaternary size="small" :disabled="!supportsStructure || !selectedRow?.table || selectedRow.table.type !== 'table'" @click="designSelected"><template #icon><NIcon><EditOutlined /></NIcon></template></NButton></template>{{ t('sidebar.designTable') }}</NTooltip>
        <NTooltip><template #trigger><NButton quaternary type="error" size="small" :loading="dropping" :disabled="selectedDropRows().length === 0" @click="dropSelected"><template #icon><NIcon><DeleteOutlined /></NIcon></template></NButton></template>{{ t('sidebar.dropTable') }}</NTooltip>
        <span class="object-toolbar-separator" />
        <NTooltip><template #trigger><NButton quaternary size="small" :loading="loading" :disabled="tab.objectGroup === 'queries'" @click="load"><template #icon><NIcon><ReloadOutlined /></NIcon></template></NButton></template>{{ t('common.refresh') }}</NTooltip>
      </span>
      <span class="object-view-switcher">
        <NButton quaternary size="small" :type="viewMode === 'list' ? 'primary' : 'default'" :title="t('objectList.listView')" @click="viewMode = 'list'"><template #icon><NIcon><UnorderedListOutlined /></NIcon></template></NButton>
        <NButton quaternary size="small" :type="viewMode === 'grid' ? 'primary' : 'default'" :title="t('objectList.gridView')" @click="viewMode = 'grid'"><template #icon><NIcon><AppstoreOutlined /></NIcon></template></NButton>
      </span>
      <NInput v-model:value="keyword" clearable size="small" :placeholder="t('common.search')">
        <template #prefix><NIcon color="#aaa"><SearchOutlined /></NIcon></template>
      </NInput>
    </div>
    <div v-if="viewMode === 'list'" class="object-list-table-wrap">
      <NDataTable
        size="small"
        :loading="loading"
        :columns="columns"
        :data="filteredRows"
        :row-key="(row: ObjectRow) => row.key"
        :row-class-name="(row: ObjectRow) => row.key === selectedKey || selectedKeys.includes(row.key) ? 'object-row-selected' : ''"
        :row-props="(row: ObjectRow) => ({ onClick: (event: MouseEvent) => selectObjectRowFromEvent(event, row), onDblclick: () => openRow(row), onContextmenu: (event: MouseEvent) => openTableContext(event, row) })"
        :pagination="false"
        :scroll-x="890"
        :checked-row-keys="selectedKeys"
        @update:checked-row-keys="updateSelectedKeys"
      />
    </div>
    <div v-else class="object-grid-view">
      <button v-for="row in filteredRows" :key="row.key" type="button" class="object-grid-card" :class="{ selected: row.key === selectedKey || selectedKeys.includes(row.key) }" @click="selectObjectRowFromEvent($event, row)" @dblclick="openRow(row)" @contextmenu="openTableContext($event, row)">
        <NIcon size="28" color="#35aeb5"><component :is="iconOf(row)" /></NIcon>
        <span class="object-grid-name" :title="row.name">{{ row.name }}</span>
        <small>{{ formatRows(row.rowCount) }} {{ t('objectList.rows').toLocaleLowerCase() }}</small>
      </button>
    </div>
    <NDropdown trigger="manual" placement="bottom-start" :show="tableContextShow" :x="tableContextX" :y="tableContextY" :options="tableContextOptions" @select="selectTableContextAction" @clickoutside="tableContextShow = false" />
    <NModal :show="copyModalOpen" :mask-closable="!copyingTable" @update:show="(show) => { if (!show) closeCopyTable() }">
      <NCard class="copy-table-modal" :title="t('sidebar.copyTableTitle', { name: copySource?.table?.name ?? '' })" closable @close="closeCopyTable">
        <NFormItem :label="t('sidebar.copyTableTarget')" required>
          <NInput v-model:value="copyTargetName" autofocus :disabled="copyingTable" @keyup.enter="confirmCopyTable" />
        </NFormItem>
        <NCheckbox v-model:checked="copyWithData" :disabled="copyingTable">{{ t('sidebar.copyTableWithData') }}</NCheckbox>
        <template #footer>
          <div class="modal-actions"><NButton :disabled="copyingTable" @click="closeCopyTable">{{ t('common.cancel') }}</NButton><NButton type="primary" :loading="copyingTable" @click="confirmCopyTable">{{ t('sidebar.copyTableConfirm') }}</NButton></div>
        </template>
      </NCard>
    </NModal>
    <NModal :show="batchCopyModalOpen" :mask-closable="!copyingTable" @update:show="(show) => { if (!show) closeBatchCopyTable() }">
      <NCard class="copy-table-modal" :title="t('sidebar.copyTableBatchTitle', { count: batchCopyRows.length })" closable @close="closeBatchCopyTable">
        <p class="copy-table-batch-hint">{{ t('sidebar.copyTableBatchHint') }}</p>
        <div class="copy-table-batch-list">
          <div v-for="row in batchCopyRows" :key="row.key"><code>{{ row.table?.name }}</code> → <code>{{ row.table?.name }}_copy</code></div>
        </div>
        <NCheckbox v-model:checked="batchCopyWithData" :disabled="copyingTable">{{ t('sidebar.copyTableWithData') }}</NCheckbox>
        <template #footer>
          <div class="modal-actions"><NButton :disabled="copyingTable" @click="closeBatchCopyTable">{{ t('common.cancel') }}</NButton><NButton type="primary" :loading="copyingTable" @click="confirmBatchCopyTables">{{ t('sidebar.copyTableConfirm') }}</NButton></div>
        </template>
      </NCard>
    </NModal>
    <footer class="object-list-footer">{{ t('common.totalItems', { count: filteredRows.length }) }}</footer>
  </div>
</template>
