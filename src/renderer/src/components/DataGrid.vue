<script setup lang="ts">
import { computed, h, nextTick, onMounted, ref, watch } from 'vue'
import { ColumnWidthOutlined, CopyOutlined, DeleteOutlined, DownloadOutlined, FilterOutlined, PlusOutlined, ReloadOutlined, SaveOutlined, UndoOutlined } from '@vicons/antd'
import { NAlert, NButton, NCard, NDataTable, NDropdown, NFormItem, NIcon, NInput, NModal, NPagination, NSelect, NTag, NText, useMessage, type DataTableBaseColumn, type DataTableColumns, type DataTableSortState, type DropdownOption, type SelectOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ColumnFilter, ColumnInfo, DatabaseOperation, DbType, RecordMutation, TableDataResult } from '../../../shared/types'
import { useContextMenuDismiss } from '../contextMenu'
import type { AppTab } from '../stores/app'
import { useAppStore } from '../stores/app'
import { DEFAULT_COLUMN_WIDTH, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH, tableColumnLayoutScope, useLayoutStore } from '../stores/layout'
import { isNumericColumn, toCsv, toJson } from '../utils'

interface NewRow { tempId: string; values: Record<string, unknown> }
interface FilterInput { op: ColumnFilter['op']; value: string }

const props = defineProps<{ tab: AppTab }>()
const store = useAppStore()
const layoutStore = useLayoutStore()
const { t } = useI18n()
const message = useMessage()
const data = ref<TableDataResult | null>(null)
const loading = ref(false)
const page = ref(1)
const pageSize = ref(100)
const cursorHistory = ref<Array<string | number | undefined>>([undefined])
const includeVectors = ref(false)
let loadRequest = 0
const orderBy = ref<{ column: string; direction: 'asc' | 'desc' }[]>([])
const edits = ref(new Map<string, Map<string, unknown>>())
const newRows = ref<NewRow[]>([])
const deletedKeys = ref(new Set<string>())
const selectedKeys = ref<Array<string | number>>([])
const lastSelectedRowIndex = ref<number | null>(null)
const rowMenuShow = ref(false)
const rowMenuX = ref(0)
const rowMenuY = ref(0)
const columnMenuShow = ref(false)
const columnMenuX = ref(0)
const columnMenuY = ref(0)
const columnMenuTarget = ref<{ column: string; kind: 'header' | 'cell'; value?: unknown } | null>(null)
const selectedColumns = ref<string[]>([])
const lastSelectedColumnIndex = ref<number | null>(null)
const tableRoot = ref<HTMLElement | null>(null)
useContextMenuDismiss(() => {
  rowMenuShow.value = false
  columnMenuShow.value = false
})
const selectedColumnSet = new Set<string>()
const columnLayoutScope = computed(() => tableColumnLayoutScope({
  connectionId: props.tab.connectionId,
  database: props.tab.database,
  schema: props.tab.schema,
  table: props.tab.table
}))
const columnWidths = ref<Record<string, number>>({})
const tableInstanceKey = ref(0)
const editingCell = ref<{ rowKey: string; column: string } | null>(null)
const saving = ref(false)
const insertPointOpen = ref(false)
const insertingPoint = ref(false)
const pointIdInput = ref('')
const pointVectorInput = ref('')
const pointPayloadInput = ref('{}')
const showFilter = ref(false)
const filterInputs = ref<Record<string, FilterInput>>({})
const appliedFilters = ref<ColumnFilter[]>([])
const exporting = ref(false)
const connection = computed(() => store.connections.find((item) => item.id === props.tab.connectionId))
const capabilities = computed(() => props.tab.connectionId ? store.driverCapabilities[props.tab.connectionId] : undefined)
const isNative = computed(() => capabilities.value?.recordModel !== undefined && capabilities.value.recordModel !== 'row')
const isQdrant = computed(() => capabilities.value?.recordModel === 'point')
const writableConnection = computed(() => connection.value?.permissionMode !== 'readonly')
const canInsert = computed(() => writableConnection.value && capabilities.value?.records.insert.supported === true && data.value?.recordOperations?.insert !== false)
const canUpdate = computed(() => writableConnection.value && capabilities.value?.records.update.supported === true && data.value?.recordOperations?.update !== false)
const canDelete = computed(() => writableConnection.value && capabilities.value?.records.delete.supported === true && data.value?.recordOperations?.delete !== false)
const keyColumns = computed(() => data.value?.keyColumns ?? [])
const baseRows = computed(() => data.value?.rows ?? [])
const columnNames = computed(() => (data.value?.columns ?? []).map((column) => column.name))
const tableScrollX = computed(() => 104 + columnNames.value.reduce((total, name) => total + (columnWidths.value[name] ?? DEFAULT_COLUMN_WIDTH), 0))
const selectedColumnNames = computed(() => {
  const selected = new Set(selectedColumns.value)
  return columnNames.value.filter((column) => selected.has(column))
})
const activeFilterCount = computed(() => appliedFilters.value.length)
const dirtyCount = computed(() => [...edits.value.values()].reduce((count, values) => count + values.size, 0) + newRows.value.reduce((count, row) => count + (Object.keys(row.values).length ? 1 : 0), 0) + deletedKeys.value.size)
const operatorOptions = computed<SelectOption[]>(() => [
  { value: '=', label: '=' }, { value: '!=', label: '!=' }, { value: '>', label: '>' }, { value: '>=', label: '>=' }, { value: '<', label: '<' }, { value: '<=', label: '<=' },
  { value: 'like', label: 'LIKE' }, { value: 'notlike', label: 'NOT LIKE' }, { value: 'null', label: 'IS NULL' }, { value: 'notnull', label: 'IS NOT NULL' }
])
const exportOptions = computed<DropdownOption[]>(() => [
  { key: 'csv-page', label: t('grid.exportPageCsv') }, { key: 'json-page', label: t('grid.exportPageJson') }, { type: 'divider', key: 'divider' },
  { key: 'csv-all', label: t('grid.exportAllCsv') }, { key: 'json-all', label: t('grid.exportAllJson') }
])
const rowCopyOptions = computed<DropdownOption[]>(() => {
  const dataOptions: DropdownOption[] = [
    { key: 'headers-values', label: t('query.copyRowsWithHeaders', { count: selectedKeys.value.length }) },
    { key: 'values', label: t('query.copyColumnValues') },
    { key: 'headers', label: t('query.copyColumnNames') }
  ]
  const copyAsOptions: DropdownOption[] = [
    ...(isNative.value ? [] : [
      { key: 'select', label: 'SELECT' },
      { key: 'insert', label: 'INSERT' },
      { key: 'update', label: 'UPDATE' },
      { key: 'delete', label: 'DELETE' },
      { type: 'divider' as const, key: 'sql-format-divider' }
    ]),
    { key: 'json', label: 'JSON' },
    { key: 'csv', label: 'CSV' }
  ]
  return [
    ...dataOptions,
    { type: 'divider', key: 'divider' },
    { key: 'copy-as', label: t('query.copyAs'), children: copyAsOptions }
  ]
})
const columnCopyOptions = computed<DropdownOption[]>(() => {
  const target = columnMenuTarget.value
  if (!target) return []
  const count = selectedColumnNames.value.length || 1
  return [
    { key: 'headers-values', label: t('query.copyColumnsWithHeaders', { count }) },
    { key: 'values', label: t('query.copyColumnValues') },
    { key: 'headers', label: t('query.copyColumnNames') },
    ...(target.kind === 'cell'
      ? [{ type: 'divider' as const, key: 'divider' }, { key: 'value', label: t('query.copyCellValue') }]
      : [])
  ]
})
const readOnlyHelp = computed(() => isQdrant.value
  ? t('grid.qdrantGridHelp')
  : data.value?.recordOperations?.update === false ? t('grid.partialRecordHelp')
  : isNative.value ? t('grid.nativeReadOnlyHelp') : t('grid.noPrimaryKeyHelp'))

const numericTypes = /^(tinyint|smallint|mediumint|int|integer|bigint|serial|bigserial|decimal|numeric|float|double|real|number|money)/i
function quoteIdentifier(type: DbType | undefined, name: string): string {
  if (type === 'mysql') return '`' + name.replace(/`/g, '``') + '`'
  if (type === 'sqlserver') return '[' + name.replace(/]/g, ']]') + ']'
  return '"' + name.replace(/"/g, '""') + '"'
}
function toLiteral(value: unknown, column: ColumnInfo | undefined, type: DbType | undefined): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return type === 'postgres' ? (value ? 'true' : 'false') : value ? '1' : '0'
  const stringValue = String(value)
  if (column && numericTypes.test(column.dataType) && /^-?\d+(\.\d+)?$/.test(stringValue)) return stringValue
  if (/^(boolean)$/i.test(column?.dataType ?? '') && /^(true|false)$/i.test(stringValue)) return stringValue.toLowerCase()
  return "'" + stringValue.replace(/'/g, "''") + "'"
}
function rowKeyOf(row: Record<string, unknown>): string {
  return JSON.stringify(keyColumns.value.map((key) => row[key] ?? null))
}
function currentFilter(column: ColumnInfo): FilterInput {
  return filterInputs.value[column.name] ?? { op: isNumericColumn(column) ? '=' : 'like', value: '' }
}
function updateFilter(column: ColumnInfo, patch: Partial<FilterInput>): void {
  filterInputs.value = { ...filterInputs.value, [column.name]: { ...currentFilter(column), ...patch } }
}
function buildFilters(): ColumnFilter[] {
  const filters: ColumnFilter[] = []
  for (const column of data.value?.columns ?? []) {
    const input = filterInputs.value[column.name]
    if (!input) continue
    if (input.op === 'null' || input.op === 'notnull') filters.push({ column: column.name, op: input.op })
    else if (input.value.trim()) filters.push({ column: column.name, op: input.op, value: input.value.trim() })
  }
  return filters
}
async function load(): Promise<void> {
  if (!props.tab.connectionId || !props.tab.table) return
  const request = ++loadRequest
  loading.value = true
  try {
    const result = await store.getTableData(props.tab.connectionId, {
      database: props.tab.database, schema: props.tab.schema, table: props.tab.table, page: page.value, pageSize: pageSize.value,
      cursor: cursorHistory.value[page.value - 1], includeVectors: includeVectors.value,
      orderBy: orderBy.value, filters: appliedFilters.value
    })
    if (request !== loadRequest) return
    data.value = result
    if (data.value.paginationMode === 'cursor') {
      const history = cursorHistory.value.slice(0, page.value)
      if (data.value.nextCursor !== undefined) history[page.value] = data.value.nextCursor
      cursorHistory.value = history
    }
    selectedKeys.value = []
    lastSelectedRowIndex.value = null
    rowMenuShow.value = false
    columnMenuShow.value = false
    columnMenuTarget.value = null
    setSelectedColumns(selectedColumns.value.filter((column) => columnNames.value.includes(column)))
    if (selectedColumns.value.length === 0) lastSelectedColumnIndex.value = null
    await nextTick()
    syncColumnHighlights()
  } catch (error) {
    if (request === loadRequest) message.error(error instanceof Error ? error.message : String(error))
  } finally {
    if (request === loadRequest) loading.value = false
  }
}
watch([page, orderBy, appliedFilters], load, { deep: true })
watch(includeVectors, () => {
  cursorHistory.value = [undefined]
  if (page.value === 1) void load()
  else page.value = 1
})
watch(pageSize, () => {
  cursorHistory.value = [undefined]
  if (page.value === 1) void load()
  else page.value = 1
})
watch(
  () => [columnLayoutScope.value, layoutStore.revision],
  () => {
    columnWidths.value = layoutStore.getColumnWidths(columnLayoutScope.value)
    tableInstanceKey.value += 1
  },
  { immediate: true }
)
onMounted(load)
function resetEdits(): void { edits.value = new Map(); newRows.value = []; deletedKeys.value = new Set(); selectedKeys.value = []; lastSelectedRowIndex.value = null; editingCell.value = null }
function commitCell(rowKey: string, column: string, raw: string, isNew: boolean): void {
  const value: unknown = raw.toUpperCase() === 'NULL' ? null : raw
  if (isNew) newRows.value = newRows.value.map((row) => row.tempId === rowKey ? { ...row, values: { ...row.values, [column]: value } } : row)
  else { const next = new Map(edits.value); const values = new Map(next.get(rowKey) ?? []); values.set(column, value); next.set(rowKey, values); edits.value = next }
  editingCell.value = null
}
function addRow(): void { newRows.value = [{ tempId: `new:${crypto.randomUUID()}`, values: {} }, ...newRows.value] }
function openInsertPoint(): void {
  if (!isQdrant.value || connection.value?.permissionMode === 'readonly') return
  pointIdInput.value = crypto.randomUUID()
  pointVectorInput.value = ''
  pointPayloadInput.value = '{}'
  insertPointOpen.value = true
}
function closeInsertPoint(): void {
  if (insertingPoint.value) return
  insertPointOpen.value = false
}
function pointIdValue(): string | number {
  const source = pointIdInput.value.trim()
  if (!source) throw new Error(t('grid.pointIdRequired'))
  if (/^(0|[1-9]\d*)$/.test(source)) {
    const value = Number(source)
    if (!Number.isSafeInteger(value)) throw new Error(t('grid.pointIdUnsafeInteger'))
    return value
  }
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(source)) {
    throw new Error(t('grid.pointIdInvalid'))
  }
  return source
}
function jsonObjectInput(source: string, errorKey: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(source) }
  catch { throw new Error(t(errorKey)) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t(errorKey))
  return value as Record<string, unknown>
}
function vectorValue(): unknown[] | Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(pointVectorInput.value) }
  catch { throw new Error(t('grid.pointVectorInvalid')) }
  if (!value || typeof value !== 'object') throw new Error(t('grid.pointVectorInvalid'))
  return value as unknown[] | Record<string, unknown>
}
async function insertQdrantPoint(): Promise<void> {
  if (!props.tab.connectionId || !props.tab.table || !isQdrant.value) return
  let id: string | number
  let vector: unknown[] | Record<string, unknown>
  let payload: Record<string, unknown>
  try {
    id = pointIdValue()
    vector = vectorValue()
    payload = jsonObjectInput(pointPayloadInput.value.trim() || '{}', 'grid.pointPayloadInvalid')
  } catch (error) {
    message.warning(error instanceof Error ? error.message : String(error))
    return
  }
  insertingPoint.value = true
  try {
    const result = await store.executeOperationWithApproval(props.tab.connectionId, {
      kind: 'records.mutate',
      target: {
        kind: capabilities.value?.recordTargetKind ?? 'collection', name: props.tab.table,
        database: props.tab.database, schema: props.tab.schema
      },
      mutations: [{ kind: 'insert', values: { id, vector, payload } }]
    })
    if (result.status === 'ok') {
      message.success(t('grid.pointInserted', { id: String(id) }))
      insertPointOpen.value = false
      resetCursor()
      await load()
    } else if (result.status === 'denied') message.warning(result.error ?? '')
    else if (result.status === 'error') message.error(t('grid.pointInsertFailed', { error: result.error ?? '' }))
  } catch (error) {
    message.error(t('grid.pointInsertFailed', { error: error instanceof Error ? error.message : String(error) }))
  } finally {
    insertingPoint.value = false
  }
}
function deleteSelected(): void { deletedKeys.value = new Set([...deletedKeys.value, ...selectedKeys.value.map(String)]); selectedKeys.value = [] }
function operationValue(column: string, value: unknown): unknown {
  if (typeof value !== 'string') return value
  if (capabilities.value?.recordModel === 'point'
    && (column.startsWith('payload.') || column === 'payload' || column === 'vector')) {
    try { return JSON.parse(value) }
    catch { return value }
  }
  if (capabilities.value?.recordModel === 'document') {
    const dataType = data.value?.columns.find((item) => item.name === column)?.dataType ?? ''
    if (/(^|\s|\|)(object|array)(\s|\||$)/i.test(dataType)) {
      try { return JSON.parse(value) }
      catch { return value }
    }
  }
  return value
}
function mutationKey(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(keyColumns.value.map((column) => [column, row[column]]))
}
function buildOperation(): DatabaseOperation | null {
  if (!props.tab.table) return null
  const mutations: RecordMutation[] = []
  for (const row of baseRows.value) {
    const key = rowKeyOf(row)
    if (deletedKeys.value.has(key)) mutations.push({ kind: 'delete', key: mutationKey(row) })
  }
  for (const [key, values] of edits.value) {
    if (deletedKeys.value.has(key) || values.size === 0) continue
    const row = baseRows.value.find((item) => rowKeyOf(item) === key)
    if (!row) continue
    mutations.push({
      kind: 'update', key: mutationKey(row),
      changes: Object.fromEntries([...values].map(([column, value]) => [column, operationValue(column, value)]))
    })
  }
  for (const row of newRows.value) {
    const values = Object.fromEntries(Object.entries(row.values)
      .filter(([, value]) => value !== undefined)
      .map(([column, value]) => [column, operationValue(column, value)]))
    if (Object.keys(values).length) mutations.push({ kind: 'insert', values })
  }
  if (!mutations.length) return null
  return {
    kind: 'records.mutate',
    target: {
      kind: capabilities.value?.recordTargetKind ?? 'table', name: props.tab.table,
      database: props.tab.database, schema: props.tab.schema
    },
    mutations
  }
}
async function save(): Promise<void> {
  if (!props.tab.connectionId) return
  saving.value = true
  try {
    if (!capabilities.value?.structuredOperations) throw new Error(t('grid.structuredOperationUnavailable'))
    const operation = buildOperation()
    const result = operation ? await store.executeOperationWithApproval(props.tab.connectionId, operation) : null
    if (!result) return
    if (result.status === 'ok') { message.success(t('common.saved')); resetEdits(); await load() }
    else if (result.status === 'denied') message.warning(result.error ?? '')
    else if (result.status === 'error') message.error(result.error ?? '')
  } finally { saving.value = false }
}
function resetCursor(): void { page.value = 1; cursorHistory.value = [undefined] }
function applyFilters(): void { resetCursor(); appliedFilters.value = buildFilters() }
function clearFilters(): void { filterInputs.value = {}; appliedFilters.value = []; resetCursor() }
function projectRows(columns: ColumnInfo[], rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => Object.fromEntries(columns.map((column) => [column.name, row[column.name]])))
}
async function loadCursorRows(cap: number): Promise<{ columns: ColumnInfo[]; rows: Record<string, unknown>[] }> {
  const rows: Record<string, unknown>[] = []
  let columns = data.value?.columns ?? []
  let cursor: string | number | undefined
  const seen = new Set<string>()
  while (rows.length < cap) {
    const result = await store.getTableData(props.tab.connectionId!, {
      database: props.tab.database, schema: props.tab.schema, table: props.tab.table!, page: 1,
      pageSize: Math.min(500, cap - rows.length), cursor, includeVectors: includeVectors.value,
      orderBy: orderBy.value, filters: appliedFilters.value
    })
    columns = result.columns
    rows.push(...result.rows)
    if (result.nextCursor === undefined) break
    const key = JSON.stringify(result.nextCursor)
    if (seen.has(key)) break
    seen.add(key)
    cursor = result.nextCursor
  }
  return { columns, rows }
}
async function exportData(format: 'csv' | 'json', scope: 'page' | 'all'): Promise<void> {
  if (!data.value || !props.tab.connectionId) return
  exporting.value = true
  try {
    let columns = data.value.columns
    let rows = baseRows.value
    let capped = false
    if (scope === 'all') {
      const cap = 50000
      if (data.value.paginationMode === 'cursor') {
        const result = await loadCursorRows(cap)
        columns = result.columns; rows = result.rows
      } else {
        const result = await store.getTableData(props.tab.connectionId, {
          database: props.tab.database, schema: props.tab.schema, table: props.tab.table!, page: 1,
          pageSize: Math.min(data.value.total, cap), orderBy: orderBy.value, filters: appliedFilters.value
        })
        columns = result.columns; rows = result.rows
      }
      capped = data.value.total > cap
    }
    const projected = projectRows(columns, rows)
    const content = format === 'csv' ? toCsv(columns.map((column) => column.name), projected) : toJson(projected)
    const path = await window.api.exportData({ defaultName: `${props.tab.table}.${format}`, content, fileTypes: [format === 'csv' ? { name: 'CSV', extensions: ['csv'] } : { name: 'JSON', extensions: ['json'] }] })
    if (path) message.success(t('grid.exported', { count: projected.length, path, cap: capped ? t('grid.capped') : '' }))
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)) }
  finally { exporting.value = false }
}
function onExportSelect(key: string | number): void { const [format, scope] = String(key).split('-') as ['csv' | 'json', 'page' | 'all']; void exportData(format, scope) }
function tableCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
function clipboardValue(value: unknown): string {
  if (value === null) return 'NULL'
  if (value === undefined) return ''
  if (typeof value === 'object') {
    try { return JSON.stringify(value) }
    catch { return String(value) }
  }
  return String(value)
}
function escapeHtml(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
function displayedValue(row: Record<string, unknown>, column: string): unknown {
  if (row.__tempId) return row[column]
  const key = String(row.__rowKey)
  const values = edits.value.get(key)
  return values?.has(column) ? values.get(column) : row[column]
}
function selectColumnFromHeader(event: MouseEvent): void {
  if (!(event.target instanceof Element)) return
  if (event.target.closest('[data-data-table-resizable]')) return
  const header = event.target.closest('.n-data-table-th[data-col-key]') as HTMLElement | null
  const column = header?.dataset.colKey
  if (!header || !column || !tableRoot.value?.contains(header) || !columnNames.value.includes(column)) return
  updateColumnSelection(event, column, false)
  if (!event.target.closest('.n-data-table-sorter')) event.stopPropagation()
}

function updateColumnWidth(
  _resizedWidth: number,
  limitedWidth: number,
  column: DataTableBaseColumn<Record<string, unknown>>
): void {
  const key = String(column.key)
  columnWidths.value = { ...columnWidths.value, [key]: limitedWidth }
  layoutStore.setColumnWidth(columnLayoutScope.value, key, limitedWidth)
}
function resetColumnWidths(): void {
  layoutStore.resetColumnLayout(columnLayoutScope.value)
  message.success(t('layout.columnsReset'))
}
function openColumnMenuFromHeader(event: MouseEvent): void {
  if (!(event.target instanceof Element)) return
  const header = event.target.closest('.n-data-table-th[data-col-key]') as HTMLElement | null
  const column = header?.dataset.colKey
  if (!header || !column || !tableRoot.value?.contains(header) || !columnNames.value.includes(column)) return
  openColumnMenu(event, column, 'header')
}
function setSelectedColumns(columns: string[]): void {
  selectedColumns.value = columns
  selectedColumnSet.clear()
  for (const column of columns) selectedColumnSet.add(column)
  syncColumnHighlights()
}
function syncColumnHighlights(): void {
  tableRoot.value?.querySelectorAll<HTMLElement>('[data-col-key]').forEach((cell) => {
    cell.classList.toggle('data-column-selected', selectedColumnSet.has(cell.dataset.colKey ?? ''))
  })
}
function updateColumnSelection(event: MouseEvent, column: string, preserveSelected: boolean): void {
  const index = columnNames.value.indexOf(column)
  if (index < 0) return
  const selected = new Set(selectedColumns.value)
  if (event.shiftKey && lastSelectedColumnIndex.value !== null) {
    const start = Math.min(lastSelectedColumnIndex.value, index)
    const end = Math.max(lastSelectedColumnIndex.value, index)
    for (let current = start; current <= end; current += 1) selected.add(columnNames.value[current])
  } else if (event.metaKey || event.ctrlKey) {
    if (selected.has(column)) selected.delete(column)
    else selected.add(column)
    lastSelectedColumnIndex.value = index
  } else if (!preserveSelected || !selected.has(column)) {
    selected.clear()
    selected.add(column)
    lastSelectedColumnIndex.value = index
  }
  setSelectedColumns(columnNames.value.filter((name) => selected.has(name)))
}
function openColumnMenu(event: MouseEvent, column: string, kind: 'header' | 'cell', value?: unknown): void {
  event.preventDefault()
  event.stopPropagation()
  rowMenuShow.value = false
  updateColumnSelection(event, column, true)
  columnMenuTarget.value = { column, kind, value }
  columnMenuX.value = event.clientX
  columnMenuY.value = event.clientY
  columnMenuShow.value = true
}
async function copyColumns(names: string[], includeHeaders: boolean, includeValues: boolean): Promise<void> {
  const sourceRows = tableRows.value
  const plainRows: string[] = []
  if (includeHeaders) plainRows.push(names.map(tableCell).join('\t'))
  if (includeValues) {
    plainRows.push(...sourceRows.map((row) => names.map((column) => tableCell(clipboardValue(displayedValue(row, column)))).join('\t')))
  }
  const plain = plainRows.join('\n')
  const head = includeHeaders ? `<thead><tr>${names.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead>` : ''
  const body = includeValues ? `<tbody>${sourceRows.map((row) => `<tr>${names.map((column) => `<td>${escapeHtml(clipboardValue(displayedValue(row, column)))}</td>`).join('')}</tr>`).join('')}</tbody>` : ''
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/plain': new Blob([plain], { type: 'text/plain' }),
      'text/html': new Blob([`<table>${head}${body}</table>`], { type: 'text/html' })
    })])
  } catch {
    await navigator.clipboard.writeText(plain)
  }
}
async function copyColumnItem(action: string | number): Promise<void> {
  const target = columnMenuTarget.value
  columnMenuShow.value = false
  if (!target) return
  try {
    if (action === 'value' && target.kind === 'cell') {
      await navigator.clipboard.writeText(clipboardValue(target.value))
      message.success(t('common.copied'))
      return
    }
    const names = selectedColumnNames.value.length ? selectedColumnNames.value : [target.column]
    if (action !== 'headers-values' && action !== 'values' && action !== 'headers') return
    await copyColumns(names, action !== 'values', action !== 'headers')
    message.success(t('query.copiedColumns', { count: names.length }))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}
function selectedDisplayRows(): Record<string, unknown>[] {
  if (!data.value || selectedKeys.value.length === 0) return []
  const selected = new Set(selectedKeys.value.map(String))
  return tableRows.value.filter((row) => !row.__tempId && selected.has(String(row.__rowKey)))
}
async function copySelectedRows(includeHeaders: boolean, includeValues: boolean): Promise<void> {
  if (!data.value) return
  const rows = selectedDisplayRows()
  const names = data.value.columns.map((column) => column.name)
  const plainRows: string[] = []
  if (includeHeaders) plainRows.push(names.map(tableCell).join('\t'))
  if (includeValues) plainRows.push(...rows.map((row) => names.map((column) => tableCell(displayedValue(row, column))).join('\t')))
  const plain = plainRows.join('\n')
  const head = includeHeaders ? `<thead><tr>${names.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead>` : ''
  const body = includeValues ? `<tbody>${rows.map((row) => `<tr>${names.map((column) => `<td>${escapeHtml(displayedValue(row, column))}</td>`).join('')}</tr>`).join('')}</tbody>` : ''
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/plain': new Blob([plain], { type: 'text/plain' }),
      'text/html': new Blob([`<table>${head}${body}</table>`], { type: 'text/html' })
    })])
  } catch {
    await navigator.clipboard.writeText(plain)
  }
}
async function copySelectedRowsAs(format: 'json' | 'csv'): Promise<void> {
  if (!data.value) return
  const names = data.value.columns.map((column) => column.name)
  const projected = selectedDisplayRows().map((row) => Object.fromEntries(names.map((column) => [column, displayedValue(row, column)])))
  const text = format === 'json' ? toJson(projected) : toCsv(names, projected).replace(/^\uFEFF/, '')
  await navigator.clipboard.writeText(text)
}
function copiedSql(kind: 'select' | 'insert' | 'update' | 'delete'): string {
  if (!data.value || !props.tab.table) return ''
  const rows = selectedDisplayRows()
  const type = connection.value?.type
  const qi = (name: string): string => quoteIdentifier(type, name)
  const table = props.tab.table
  const qualified = type === 'postgres'
    ? `${qi(props.tab.schema ?? 'public')}.${qi(table)}`
    : type === 'sqlserver' ? `${qi(props.tab.schema ?? 'dbo')}.${qi(table)}`
    : props.tab.database ? `${qi(props.tab.database)}.${qi(table)}` : qi(table)
  const names = data.value.columns.map((column) => column.name)
  const columnOf = (name: string): ColumnInfo | undefined => data.value?.columns.find((column) => column.name === name)
  if (kind === 'insert') {
    return rows.map((row) => `INSERT INTO ${qualified} (${names.map(qi).join(', ')}) VALUES (${names.map((column) => toLiteral(displayedValue(row, column), columnOf(column), type)).join(', ')});`).join('\n')
  }
  const whereColumns = kind === 'select' ? names : keyColumns.value.length ? keyColumns.value : names
  return rows.map((row) => {
    const where = whereColumns.map((column) => {
      const value = kind !== 'select' && keyColumns.value.includes(column) ? row[column] : displayedValue(row, column)
      const columnSql = qi(column === '__rowid__' ? 'rowid' : column)
      return value === null || value === undefined
        ? `${columnSql} IS NULL`
        : `${columnSql} = ${toLiteral(value, columnOf(column), type)}`
    }).join(' AND ')
    if (kind === 'select') return `SELECT * FROM ${qualified} WHERE ${where};`
    if (kind === 'delete') return `DELETE FROM ${qualified} WHERE ${where};`
    const editableColumns = names.filter((column) => !keyColumns.value.includes(column))
    const setColumns = editableColumns.length ? editableColumns : names
    const set = setColumns.map((column) => `${qi(column)} = ${toLiteral(displayedValue(row, column), columnOf(column), type)}`).join(', ')
    return `UPDATE ${qualified} SET ${set} WHERE ${where};`
  }).join('\n')
}
async function copySelected(kind: string | number): Promise<void> {
  if (selectedKeys.value.length === 0) return
  try {
    if (kind === 'headers-values' || kind === 'values' || kind === 'headers') {
      await copySelectedRows(kind !== 'values', kind !== 'headers')
      message.success(kind === 'headers' ? t('common.copied') : t('query.copiedRows', { count: selectedDisplayRows().length }))
    } else if (kind === 'json' || kind === 'csv') {
      await copySelectedRowsAs(kind)
      message.success(t('query.copiedRows', { count: selectedDisplayRows().length }))
    } else {
      await navigator.clipboard.writeText(copiedSql(String(kind) as 'select' | 'insert' | 'update' | 'delete'))
      message.success(t('query.copiedRows', { count: selectedDisplayRows().length }))
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}
function renderCell(value: unknown, row: Record<string, unknown>, column: ColumnInfo): ReturnType<typeof h> {
  const isNew = typeof row.__tempId === 'string'
  const rowKey = isNew ? String(row.__tempId) : rowKeyOf(row)
  const editedValues = edits.value.get(rowKey)
  const current = isNew
    ? newRows.value.find((item) => item.tempId === rowKey)?.values[column.name]
    : editedValues?.has(column.name) ? editedValues.get(column.name) : value
  if (editingCell.value?.rowKey === rowKey && editingCell.value.column === column.name) {
    return h(NInput, {
      size: 'small', autofocus: true, defaultValue: current == null ? '' : String(current), placeholder: t('grid.inputNull'),
      onBlur: (event: FocusEvent) => commitCell(rowKey, column.name, (event.target as HTMLInputElement).value, isNew),
      onKeyup: (event: KeyboardEvent) => { if (event.key === 'Enter') commitCell(rowKey, column.name, (event.target as HTMLInputElement).value, isNew) }
    })
  }
  const modified = isNew ? newRows.value.find((item) => item.tempId === rowKey)?.values[column.name] !== undefined : edits.value.get(rowKey)?.has(column.name)
  const editable = data.value?.editable && (isNew ? canInsert.value : canUpdate.value) && (isNew || !column.isPrimaryKey)
    && (!isQdrant.value || column.name !== 'vector' || includeVectors.value)
  return h('div', {
    class: [editable && 'grid-cell-editable', modified && 'grid-cell-edited'],
    onContextmenu: (event: MouseEvent) => openColumnMenu(event, column.name, 'cell', current),
    onDblclick: () => { if (editable) editingCell.value = { rowKey, column: column.name } }
  }, current == null ? h(NText, { depth: 3 }, { default: () => t('common.nullValue') }) : String(current))
}
const tableColumns = computed<DataTableColumns<Record<string, unknown>>>(() => {
  if (!data.value) return []
  return [
    {
      title: '#',
      key: '__rowNumber',
      width: 64,
      fixed: 'left' as const,
      align: 'right',
      render: (row: Record<string, unknown>) => h('span', { class: 'table-row-number' }, row.__tempId ? '*' : (page.value - 1) * pageSize.value + Number(row.__rowIndex) + 1)
    },
    { type: 'selection', fixed: 'left' as const, disabled: (row) => Boolean(row.__tempId) },
    ...data.value.columns.map((column) => ({
      title: () => h('span', {
        class: 'result-column-header',
        title: `${column.name}\n${t('query.columnSelectionHelp')}`
      }, [column.isPrimaryKey ? h('span', { class: 'primary-key', title: t('grid.primaryKey') }, '🔑') : null, column.name, h('small', { class: 'column-type' }, column.dataType)]),
      key: column.name,
      width: columnWidths.value[column.name] ?? DEFAULT_COLUMN_WIDTH,
      minWidth: MIN_COLUMN_WIDTH,
      maxWidth: MAX_COLUMN_WIDTH,
      resizable: true,
      fixed: column.isPrimaryKey ? 'left' as const : undefined,
      className: 'copyable-data-column',
      cellProps: () => ({ class: selectedColumnSet.has(column.name) ? 'data-column-selected' : undefined }),
      ellipsis: { tooltip: true },
      sorter: isQdrant.value && ['id', 'payload', 'vector'].includes(column.name) ? false : 'default' as const,
      sortOrder: orderBy.value[0]?.column === column.name ? (orderBy.value[0].direction === 'asc' ? 'ascend' as const : 'descend' as const) : false as const,
      render: (row: Record<string, unknown>) => renderCell(row[column.name], row, column)
    }))
  ]
})
const tableRows = computed<Record<string, unknown>[]>(() => [
  ...newRows.value.map((row) => ({ __tempId: row.tempId, ...row.values })),
  ...baseRows.value.map((row, index) => ({ ...row, __rowIndex: index, __rowKey: keyColumns.value.length ? rowKeyOf(row) : `row:${index}` }))
])
function rowClassName(row: Record<string, unknown>): string {
  const key = String(row.__tempId ?? row.__rowKey)
  const classes: string[] = []
  if (row.__tempId) classes.push('grid-row-new')
  else if (deletedKeys.value.has(key)) classes.push('grid-row-deleted')
  if (selectedKeys.value.map(String).includes(key)) classes.push('result-row-selected')
  return classes.join(' ')
}
function updateSelectedKeys(keys: Array<string | number>): void {
  selectedKeys.value = keys
  const lastKey = keys.at(-1)
  const row = lastKey === undefined ? undefined : tableRows.value.find((item) => String(item.__rowKey) === String(lastKey))
  lastSelectedRowIndex.value = row ? Number(row.__rowIndex) : null
}
function selectTableRow(event: MouseEvent, row: Record<string, unknown>): void {
  if (row.__tempId || (event.target instanceof Element && event.target.closest('button, input, .n-checkbox, .n-select'))) return
  const index = Number(row.__rowIndex)
  const key = String(row.__rowKey)
  const selected = new Set(selectedKeys.value.map(String))
  if (event.shiftKey && lastSelectedRowIndex.value !== null) {
    const start = Math.min(lastSelectedRowIndex.value, index)
    const end = Math.max(lastSelectedRowIndex.value, index)
    selectedKeys.value = tableRows.value
      .filter((item) => !item.__tempId && Number(item.__rowIndex) >= start && Number(item.__rowIndex) <= end)
      .map((item) => String(item.__rowKey))
  } else if (event.metaKey || event.ctrlKey) {
    if (selected.has(key)) selected.delete(key)
    else selected.add(key)
    selectedKeys.value = [...selected]
    lastSelectedRowIndex.value = index
  } else {
    selectedKeys.value = [key]
    lastSelectedRowIndex.value = index
  }
}
function openTableRowMenu(event: MouseEvent, row: Record<string, unknown>): void {
  if (row.__tempId) return
  event.preventDefault()
  const key = String(row.__rowKey)
  if (!selectedKeys.value.map(String).includes(key)) {
    selectedKeys.value = [key]
    lastSelectedRowIndex.value = Number(row.__rowIndex)
  }
  rowMenuX.value = event.clientX
  rowMenuY.value = event.clientY
  rowMenuShow.value = true
}
function selectTableRowMenu(kind: string | number): void {
  rowMenuShow.value = false
  void copySelected(kind)
}
function updateSorter(sorter: DataTableSortState | null): void {
  orderBy.value = sorter?.order && sorter.columnKey ? [{ column: String(sorter.columnKey), direction: sorter.order === 'ascend' ? 'asc' : 'desc' }] : []
  resetCursor()
}
function previousCursorPage(): void { if (page.value > 1) page.value -= 1 }
function nextCursorPage(): void { if (data.value?.nextCursor !== undefined) page.value += 1 }
</script>

<template>
  <div class="module-page data-grid-page">
    <div class="module-toolbar grid-toolbar">
      <NButton size="small" :loading="loading" @click="load"><template #icon><NIcon><ReloadOutlined /></NIcon></template>{{ t('common.refresh') }}</NButton>
      <NButton size="small" :type="showFilter || activeFilterCount ? 'primary' : 'default'" :secondary="activeFilterCount > 0" @click="showFilter = !showFilter"><template #icon><NIcon><FilterOutlined /></NIcon></template>{{ t('grid.filter') }}<template v-if="activeFilterCount"> ({{ activeFilterCount }})</template></NButton>
      <NDropdown :options="exportOptions" :disabled="!data || data.rows.length === 0" @select="onExportSelect"><NButton size="small" :loading="exporting"><template #icon><NIcon><DownloadOutlined /></NIcon></template>{{ t('common.export') }}</NButton></NDropdown>
      <NButton size="small" :title="t('layout.resetColumns')" :aria-label="t('layout.resetColumns')" @click="resetColumnWidths"><template #icon><NIcon><ColumnWidthOutlined /></NIcon></template>{{ t('layout.resetColumns') }}</NButton>
      <NButton v-if="isQdrant" size="small" :type="includeVectors ? 'primary' : 'default'" @click="includeVectors = !includeVectors">{{ t(includeVectors ? 'grid.hideVectors' : 'grid.showVectors') }}</NButton>
      <NDropdown trigger="click" :options="rowCopyOptions" :disabled="selectedKeys.length === 0" @select="copySelected"><NButton size="small" :disabled="selectedKeys.length === 0"><template #icon><NIcon><CopyOutlined /></NIcon></template>{{ t('query.copy') }}<template v-if="selectedKeys.length"> ({{ selectedKeys.length }})</template></NButton></NDropdown>
      <NButton size="small" :disabled="!data?.editable || !canInsert" @click="isQdrant ? openInsertPoint() : addRow()"><template #icon><NIcon><PlusOutlined /></NIcon></template>{{ t(isQdrant ? 'grid.addPoint' : 'grid.addRow') }}</NButton>
      <NButton size="small" type="error" secondary :disabled="!data?.editable || !canDelete || selectedKeys.length === 0" @click="deleteSelected"><template #icon><NIcon><DeleteOutlined /></NIcon></template>{{ t('grid.deleteRow') }}</NButton>
      <NButton size="small" :disabled="dirtyCount === 0" @click="resetEdits"><template #icon><NIcon><UndoOutlined /></NIcon></template>{{ t('grid.discard') }}</NButton>
      <NButton size="small" type="primary" :disabled="dirtyCount === 0 || !data?.editable || (!canUpdate && !canDelete && !canInsert)" :loading="saving" @click="save"><template #icon><NIcon><SaveOutlined /></NIcon></template>{{ dirtyCount ? t('grid.saveCount', { count: dirtyCount }) : t('common.save') }}</NButton>
      <span class="toolbar-meta"><NTag v-if="data && !data.editable">{{ isNative ? t('permission.readonly') : t('grid.noPrimaryKey') }}</NTag><NTag v-if="connection?.permissionMode === 'readonly'" type="info">{{ t('permission.readonlyMode') }}</NTag><NTag v-if="connection?.permissionMode === 'approval'" type="warning">{{ t('permission.approvalMode') }}</NTag></span>
    </div>
    <div v-if="showFilter && data" class="filter-panel">
      <p class="filter-help">{{ t('grid.filterHelp') }}</p>
      <div class="filter-list">
        <div v-for="column in data.columns" :key="column.name" class="filter-item">
          <span class="filter-column" :title="column.name">{{ column.name }}</span>
          <NSelect size="small" class="filter-operator" :aria-label="t('grid.operator')" :options="operatorOptions" :value="currentFilter(column).op" @update:value="(value) => updateFilter(column, { op: value as ColumnFilter['op'] })" />
          <NInput size="small" clearable class="filter-value" :aria-label="t('grid.value')" :placeholder="t('grid.filterValue')" :disabled="['null', 'notnull'].includes(currentFilter(column).op)" :value="currentFilter(column).value" @update:value="(value) => updateFilter(column, { value })" @keyup.enter="applyFilters" />
        </div>
      </div>
      <div class="filter-actions"><NButton size="small" type="primary" @click="applyFilters">{{ t('common.apply') }}</NButton><NButton size="small" :disabled="activeFilterCount === 0 && Object.keys(filterInputs).length === 0" @click="clearFilters">{{ t('common.clear') }}</NButton></div>
    </div>
    <NAlert v-if="data && (!data.editable || isQdrant || data.recordOperations?.update === false)" type="info" class="module-alert">{{ readOnlyHelp }}</NAlert>
    <div ref="tableRoot" class="data-table-wrap padded" @click.capture="selectColumnFromHeader" @contextmenu.capture="openColumnMenuFromHeader">
      <NDataTable :key="tableInstanceKey" remote size="small" bordered :loading="loading" :columns="tableColumns" :data="tableRows" :row-key="(row: Record<string, unknown>) => String(row.__tempId ?? row.__rowKey)" :checked-row-keys="selectedKeys" :row-class-name="rowClassName" :row-props="(row: Record<string, unknown>) => ({ onClick: (event: MouseEvent) => selectTableRow(event, row), onContextmenu: (event: MouseEvent) => openTableRowMenu(event, row) })" :pagination="false" :scroll-x="Math.max(900, tableScrollX)" :on-unstable-column-resize="updateColumnWidth" @update:checked-row-keys="updateSelectedKeys" @update:sorter="updateSorter" />
    </div>
    <NDropdown trigger="manual" placement="bottom-start" :show="rowMenuShow" :x="rowMenuX" :y="rowMenuY" :options="rowCopyOptions" @select="selectTableRowMenu" @clickoutside="rowMenuShow = false" />
    <NDropdown trigger="manual" placement="bottom-start" :show="columnMenuShow" :x="columnMenuX" :y="columnMenuY" :options="columnCopyOptions" @select="copyColumnItem" @clickoutside="columnMenuShow = false" />
    <div v-if="data?.paginationMode === 'cursor'" class="module-pagination cursor-pagination">
      <span>{{ t('common.totalRows', { count: data.total }) }}</span>
      <NSelect v-model:value="pageSize" size="small" :options="[50, 100, 200, 500].map((value) => ({ label: String(value), value }))" class="cursor-page-size" />
      <NButton size="small" :disabled="page <= 1" @click="previousCursorPage">{{ t('grid.previousPage') }}</NButton>
      <span>{{ t('grid.pageNumber', { page }) }}</span>
      <NButton size="small" :disabled="data.nextCursor === undefined" @click="nextCursorPage">{{ t('grid.nextPage') }}</NButton>
    </div>
    <NPagination v-else-if="data" v-model:page="page" v-model:page-size="pageSize" :item-count="data.total + newRows.length" :page-sizes="[50, 100, 200, 500]" show-size-picker class="module-pagination"><template #prefix>{{ t('common.totalRows', { count: data.total + newRows.length }) }}</template></NPagination>
    <NModal :show="insertPointOpen" :mask-closable="!insertingPoint" @update:show="(show) => { if (!show) closeInsertPoint() }">
      <NCard class="copy-table-modal" :title="t('grid.addPointTitle', { collection: tab.table ?? '' })" closable @close="closeInsertPoint">
        <NFormItem :label="t('grid.pointId')" required>
          <NInput v-model:value="pointIdInput" autofocus :disabled="insertingPoint" :placeholder="t('grid.pointIdPlaceholder')" />
        </NFormItem>
        <NFormItem :label="t('grid.pointVector')" required>
          <NInput v-model:value="pointVectorInput" type="textarea" :autosize="{ minRows: 4, maxRows: 10 }" :disabled="insertingPoint" :placeholder="t('grid.pointVectorPlaceholder')" />
        </NFormItem>
        <NFormItem :label="t('grid.pointPayload')">
          <NInput v-model:value="pointPayloadInput" type="textarea" :autosize="{ minRows: 4, maxRows: 10 }" :disabled="insertingPoint" :placeholder="t('grid.pointPayloadPlaceholder')" />
        </NFormItem>
        <template #footer>
          <div class="modal-actions"><NButton :disabled="insertingPoint" @click="closeInsertPoint">{{ t('common.cancel') }}</NButton><NButton type="primary" :loading="insertingPoint" @click="insertQdrantPoint">{{ t('grid.insertPoint') }}</NButton></div>
        </template>
      </NCard>
    </NModal>
  </div>
</template>
