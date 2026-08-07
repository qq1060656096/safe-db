<script setup lang="ts">
import { computed, h, nextTick, onMounted, ref, watch } from 'vue'
import { CopyOutlined, DeleteOutlined, DownloadOutlined, FilterOutlined, PlusOutlined, ReloadOutlined, SaveOutlined, UndoOutlined } from '@vicons/antd'
import { NAlert, NButton, NDataTable, NDropdown, NIcon, NInput, NPagination, NSelect, NTag, NText, useMessage, type DataTableColumns, type DataTableSortState, type DropdownOption, type SelectOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ColumnFilter, ColumnInfo, DbType, TableDataResult } from '../../../shared/types'
import type { AppTab } from '../stores/app'
import { useAppStore } from '../stores/app'
import { isNumericColumn, toCsv, toJson } from '../utils'

interface NewRow { tempId: string; values: Record<string, unknown> }
interface FilterInput { op: ColumnFilter['op']; value: string }

const props = defineProps<{ tab: AppTab }>()
const store = useAppStore()
const { t } = useI18n()
const message = useMessage()
const data = ref<TableDataResult | null>(null)
const loading = ref(false)
const page = ref(1)
const pageSize = ref(100)
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
const selectedColumnSet = new Set<string>()
const editingCell = ref<{ rowKey: string; column: string } | null>(null)
const saving = ref(false)
const showFilter = ref(false)
const filterInputs = ref<Record<string, FilterInput>>({})
const appliedFilters = ref<ColumnFilter[]>([])
const exporting = ref(false)
const connection = computed(() => store.connections.find((item) => item.id === props.tab.connectionId))
const keyColumns = computed(() => data.value?.keyColumns ?? [])
const baseRows = computed(() => data.value?.rows ?? [])
const columnNames = computed(() => (data.value?.columns ?? []).map((column) => column.name))
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
  const native = connection.value?.type === 'mongodb' || connection.value?.type === 'redis'
  const copyAsOptions: DropdownOption[] = [
    ...(native ? [] : [
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
const readOnlyHelp = computed(() => connection.value?.type === 'mongodb' || connection.value?.type === 'redis'
  ? t('grid.nativeReadOnlyHelp') : t('grid.noPrimaryKeyHelp'))

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
function rowKeyOf(row: Record<string, unknown>): string { return keyColumns.value.map((key) => String(row[key] ?? '')).join('') }
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
  loading.value = true
  try {
    data.value = await store.getTableData(props.tab.connectionId, {
      database: props.tab.database, schema: props.tab.schema, table: props.tab.table, page: page.value, pageSize: pageSize.value,
      orderBy: orderBy.value, filters: appliedFilters.value
    })
    selectedKeys.value = []
    lastSelectedRowIndex.value = null
    rowMenuShow.value = false
    columnMenuShow.value = false
    columnMenuTarget.value = null
    setSelectedColumns(selectedColumns.value.filter((column) => columnNames.value.includes(column)))
    if (selectedColumns.value.length === 0) lastSelectedColumnIndex.value = null
    await nextTick()
    syncColumnHighlights()
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)) }
  finally { loading.value = false }
}
watch([page, pageSize, orderBy, appliedFilters], load, { deep: true })
onMounted(load)
function resetEdits(): void { edits.value = new Map(); newRows.value = []; deletedKeys.value = new Set(); selectedKeys.value = []; lastSelectedRowIndex.value = null; editingCell.value = null }
function commitCell(rowKey: string, column: string, raw: string, isNew: boolean): void {
  const value: unknown = raw.toUpperCase() === 'NULL' ? null : raw
  if (isNew) newRows.value = newRows.value.map((row) => row.tempId === rowKey ? { ...row, values: { ...row.values, [column]: value } } : row)
  else { const next = new Map(edits.value); const values = new Map(next.get(rowKey) ?? []); values.set(column, value); next.set(rowKey, values); edits.value = next }
  editingCell.value = null
}
function addRow(): void { newRows.value = [{ tempId: `new:${crypto.randomUUID()}`, values: {} }, ...newRows.value] }
function deleteSelected(): void { deletedKeys.value = new Set([...deletedKeys.value, ...selectedKeys.value.map(String)]); selectedKeys.value = [] }
function buildSql(): string {
  const type = connection.value?.type
  const qi = (name: string): string => quoteIdentifier(type, name)
  const table = props.tab.table!
  const qualified = type === 'postgres' ? `${qi(props.tab.schema ?? 'public')}.${qi(table)}` : type === 'sqlserver' ? `${qi(props.tab.schema ?? 'dbo')}.${qi(table)}` : props.tab.database ? `${qi(props.tab.database)}.${qi(table)}` : qi(table)
  const columnOf = (name: string): ColumnInfo | undefined => data.value?.columns.find((column) => column.name === name)
  const statements: string[] = []
  for (const row of baseRows.value) {
    const key = rowKeyOf(row)
    if (deletedKeys.value.has(key)) {
      const where = keyColumns.value.map((column) => `${qi(column === '__rowid__' ? 'rowid' : column)} = ${toLiteral(row[column], undefined, type)}`).join(' AND ')
      statements.push(`DELETE FROM ${qualified} WHERE ${where};`)
    }
  }
  for (const [key, values] of edits.value) {
    if (deletedKeys.value.has(key) || values.size === 0) continue
    const row = baseRows.value.find((item) => rowKeyOf(item) === key)
    if (!row) continue
    const set = [...values].map(([column, value]) => `${qi(column)} = ${toLiteral(value, columnOf(column), type)}`).join(', ')
    const where = keyColumns.value.map((column) => `${qi(column === '__rowid__' ? 'rowid' : column)} = ${toLiteral(row[column], undefined, type)}`).join(' AND ')
    statements.push(`UPDATE ${qualified} SET ${set} WHERE ${where};`)
  }
  for (const row of newRows.value) {
    const entries = Object.entries(row.values).filter(([, value]) => value !== undefined)
    if (!entries.length) continue
    statements.push(`INSERT INTO ${qualified} (${entries.map(([column]) => qi(column)).join(', ')}) VALUES (${entries.map(([column, value]) => toLiteral(value, columnOf(column), type)).join(', ')});`)
  }
  return statements.join('\n')
}
async function save(): Promise<void> {
  const sql = buildSql()
  if (!sql || !props.tab.connectionId) return
  saving.value = true
  try {
    const result = await store.executeWithApproval(props.tab.connectionId, sql, props.tab.database)
    if (result.status === 'ok') { message.success(t('common.saved')); resetEdits(); await load() }
    else if (result.status === 'denied') message.warning(result.error ?? '')
    else if (result.status === 'error') message.error(result.error ?? '')
  } finally { saving.value = false }
}
function applyFilters(): void { page.value = 1; appliedFilters.value = buildFilters() }
function clearFilters(): void { filterInputs.value = {}; appliedFilters.value = []; page.value = 1 }
function projectRows(columns: ColumnInfo[], rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => Object.fromEntries(columns.map((column) => [column.name, row[column.name]])))
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
      const result = await store.getTableData(props.tab.connectionId, {
        database: props.tab.database, schema: props.tab.schema, table: props.tab.table!, page: 1,
        pageSize: Math.min(data.value.total, cap), orderBy: orderBy.value, filters: appliedFilters.value
      })
      columns = result.columns; rows = result.rows; capped = data.value.total > cap
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
  const header = event.target.closest('.n-data-table-th[data-col-key]') as HTMLElement | null
  const column = header?.dataset.colKey
  if (!header || !column || !tableRoot.value?.contains(header) || !columnNames.value.includes(column)) return
  updateColumnSelection(event, column, false)
  if (!event.target.closest('.n-data-table-sorter')) event.stopPropagation()
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
  return h('div', {
    class: ['grid-cell-editable', modified && 'grid-cell-edited'],
    onContextmenu: (event: MouseEvent) => openColumnMenu(event, column.name, 'cell', current),
    onDblclick: () => { if (data.value?.editable) editingCell.value = { rowKey, column: column.name } }
  }, current == null ? h(NText, { depth: 3 }, { default: () => t('common.nullValue') }) : String(current))
}
const tableColumns = computed<DataTableColumns<Record<string, unknown>>>(() => {
  if (!data.value) return []
  return [
    {
      title: '#',
      key: '__rowNumber',
      width: 64,
      align: 'right',
      render: (row: Record<string, unknown>) => h('span', { class: 'table-row-number' }, row.__tempId ? '*' : (page.value - 1) * pageSize.value + Number(row.__rowIndex) + 1)
    },
    { type: 'selection', disabled: (row) => Boolean(row.__tempId) },
    ...data.value.columns.map((column) => ({
      title: () => h('span', {
        class: 'result-column-header',
        title: `${column.name}\n${t('query.columnSelectionHelp')}`
      }, [column.isPrimaryKey ? h('span', { class: 'primary-key', title: t('grid.primaryKey') }, '🔑') : null, column.name, h('small', { class: 'column-type' }, column.dataType)]),
      key: column.name,
      className: 'copyable-data-column',
      cellProps: () => ({ class: selectedColumnSet.has(column.name) ? 'data-column-selected' : undefined }),
      ellipsis: { tooltip: true }, sorter: 'default' as const,
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
  page.value = 1
}
</script>

<template>
  <div class="module-page data-grid-page">
    <div class="module-toolbar grid-toolbar">
      <NButton size="small" :loading="loading" @click="load"><template #icon><NIcon><ReloadOutlined /></NIcon></template>{{ t('common.refresh') }}</NButton>
      <NButton size="small" :type="showFilter || activeFilterCount ? 'primary' : 'default'" :secondary="activeFilterCount > 0" @click="showFilter = !showFilter"><template #icon><NIcon><FilterOutlined /></NIcon></template>{{ t('grid.filter') }}<template v-if="activeFilterCount"> ({{ activeFilterCount }})</template></NButton>
      <NDropdown :options="exportOptions" :disabled="!data || data.rows.length === 0" @select="onExportSelect"><NButton size="small" :loading="exporting"><template #icon><NIcon><DownloadOutlined /></NIcon></template>{{ t('common.export') }}</NButton></NDropdown>
      <NDropdown trigger="click" :options="rowCopyOptions" :disabled="selectedKeys.length === 0" @select="copySelected"><NButton size="small" :disabled="selectedKeys.length === 0"><template #icon><NIcon><CopyOutlined /></NIcon></template>{{ t('query.copy') }}<template v-if="selectedKeys.length"> ({{ selectedKeys.length }})</template></NButton></NDropdown>
      <NButton size="small" :disabled="!data?.editable" @click="addRow"><template #icon><NIcon><PlusOutlined /></NIcon></template>{{ t('grid.addRow') }}</NButton>
      <NButton size="small" type="error" secondary :disabled="!data?.editable || selectedKeys.length === 0" @click="deleteSelected"><template #icon><NIcon><DeleteOutlined /></NIcon></template>{{ t('grid.deleteRow') }}</NButton>
      <NButton size="small" :disabled="dirtyCount === 0" @click="resetEdits"><template #icon><NIcon><UndoOutlined /></NIcon></template>{{ t('grid.discard') }}</NButton>
      <NButton size="small" type="primary" :disabled="dirtyCount === 0 || !data?.editable" :loading="saving" @click="save"><template #icon><NIcon><SaveOutlined /></NIcon></template>{{ dirtyCount ? t('grid.saveCount', { count: dirtyCount }) : t('common.save') }}</NButton>
      <span class="toolbar-meta"><NTag v-if="data && !data.editable">{{ t('grid.noPrimaryKey') }}</NTag><NTag v-if="connection?.permissionMode === 'readonly'" type="info">{{ t('permission.readonlyMode') }}</NTag><NTag v-if="connection?.permissionMode === 'approval'" type="warning">{{ t('permission.approvalMode') }}</NTag></span>
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
    <NAlert v-if="data && !data.editable" type="info" class="module-alert">{{ readOnlyHelp }}</NAlert>
    <div ref="tableRoot" class="data-table-wrap padded" @click.capture="selectColumnFromHeader" @contextmenu.capture="openColumnMenuFromHeader">
      <NDataTable remote size="small" bordered :loading="loading" :columns="tableColumns" :data="tableRows" :row-key="(row: Record<string, unknown>) => String(row.__tempId ?? row.__rowKey)" :checked-row-keys="selectedKeys" :row-class-name="rowClassName" :row-props="(row: Record<string, unknown>) => ({ onClick: (event: MouseEvent) => selectTableRow(event, row), onContextmenu: (event: MouseEvent) => openTableRowMenu(event, row) })" :pagination="false" :scroll-x="Math.max(900, tableColumns.length * 160)" @update:checked-row-keys="updateSelectedKeys" @update:sorter="updateSorter" />
    </div>
    <NDropdown trigger="manual" placement="bottom-start" :show="rowMenuShow" :x="rowMenuX" :y="rowMenuY" :options="rowCopyOptions" @select="selectTableRowMenu" @clickoutside="rowMenuShow = false" />
    <NDropdown trigger="manual" placement="bottom-start" :show="columnMenuShow" :x="columnMenuX" :y="columnMenuY" :options="columnCopyOptions" @select="copyColumnItem" @clickoutside="columnMenuShow = false" />
    <NPagination v-if="data" v-model:page="page" v-model:page-size="pageSize" :item-count="data.total + newRows.length" :page-sizes="[50, 100, 200, 500]" show-size-picker class="module-pagination"><template #prefix>{{ t('common.totalRows', { count: data.total + newRows.length }) }}</template></NPagination>
  </div>
</template>
