<script setup lang="ts">
import { computed, h, ref, watch } from 'vue'
import { CopyOutlined, DownloadOutlined } from '@vicons/antd'
import { NButton, NDataTable, NDropdown, NIcon, NTag, NText, useMessage, type DataTableColumns, type DropdownOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { DbType, QueryResult } from '../../../shared/types'
import { toCsv, toJson } from '../utils'

const props = defineProps<{
  result: QueryResult
  index: number
  connectionId?: string
  dbType?: DbType
  database?: string
  schema?: string
  sql: string
}>()
const { t } = useI18n()
const message = useMessage()
const selectedKeys = ref<Array<string | number>>([])
const lastSelectedIndex = ref<number | null>(null)
const rowMenuShow = ref(false)
const rowMenuX = ref(0)
const rowMenuY = ref(0)
const rows = computed(() => (props.result.rows ?? []).map((row, index) => ({ ...row, __resultKey: index })))
const columnNames = computed(() => (props.result.columns ?? []).map((column) => column.name))
const columns = computed<DataTableColumns<Record<string, unknown>>>(() =>
  [
    { type: 'selection' },
    ...(props.result.columns ?? []).map((column) => ({
      title: column.name,
      key: column.name,
      ellipsis: { tooltip: true },
      render: (row: Record<string, unknown>) => row[column.name] === null
        ? h(NText, { depth: 3 }, { default: () => t('common.nullValue') })
        : String(row[column.name] ?? '')
    }))
  ]
)
const exportOptions = computed(() => [
  { key: 'csv', label: t('query.exportCsv') },
  { key: 'json', label: t('query.exportJson') }
])
interface SqlTarget { qualified: string; table: string; database?: string; schema?: string }
const sqlTarget = computed<SqlTarget | null>(() => inferSqlTarget(props.sql))
const copyOptions = computed<DropdownOption[]>(() => [
  { key: 'table', label: t('query.copyAsTable') },
  { type: 'divider', key: 'divider' },
  { key: 'select', label: t('query.copyAsSelect'), disabled: !sqlTarget.value },
  { key: 'insert', label: t('query.copyAsInsert'), disabled: !sqlTarget.value },
  { key: 'update', label: t('query.copyAsUpdate'), disabled: !sqlTarget.value },
  { key: 'delete', label: t('query.copyAsDelete'), disabled: !sqlTarget.value }
])
const selectedRows = computed(() => {
  const sourceRows = props.result.rows ?? []
  if (!selectedKeys.value.length) return sourceRows
  const selected = new Set(selectedKeys.value.map(Number))
  return sourceRows.filter((_row, index) => selected.has(index))
})

watch(() => props.result.rows, () => { selectedKeys.value = []; lastSelectedIndex.value = null; rowMenuShow.value = false })

function updateSelectedKeys(keys: Array<string | number>): void {
  selectedKeys.value = keys
  const last = keys.at(-1)
  lastSelectedIndex.value = last === undefined ? null : Number(last)
}

function selectResultRow(event: MouseEvent, row: Record<string, unknown>): void {
  if (event.target instanceof Element && event.target.closest('button, input, .n-checkbox')) return
  const index = Number(row.__resultKey)
  const key = String(index)
  const selected = new Set(selectedKeys.value.map(String))
  if (event.shiftKey && lastSelectedIndex.value !== null) {
    const start = Math.min(lastSelectedIndex.value, index)
    const end = Math.max(lastSelectedIndex.value, index)
    selectedKeys.value = Array.from({ length: end - start + 1 }, (_item, offset) => String(start + offset))
  } else if (event.metaKey || event.ctrlKey) {
    if (selected.has(key)) selected.delete(key)
    else selected.add(key)
    selectedKeys.value = [...selected]
    lastSelectedIndex.value = index
  } else {
    selectedKeys.value = [key]
    lastSelectedIndex.value = index
  }
}

function resultRowClassName(row: Record<string, unknown>): string {
  return selectedKeys.value.map(String).includes(String(row.__resultKey)) ? 'result-row-selected' : ''
}

function openResultRowMenu(event: MouseEvent, row: Record<string, unknown>): void {
  event.preventDefault()
  const index = Number(row.__resultKey)
  const key = String(index)
  if (!selectedKeys.value.map(String).includes(key)) {
    selectedKeys.value = [key]
    lastSelectedIndex.value = index
  }
  rowMenuX.value = event.clientX
  rowMenuY.value = event.clientY
  rowMenuShow.value = true
}

function selectRowMenu(kind: string | number): void {
  rowMenuShow.value = false
  void copyResult(kind)
}

function quoteIdentifier(name: string): string {
  return props.dbType === 'mysql'
    ? '`' + name.replace(/`/g, '``') + '`'
    : '"' + name.replace(/"/g, '""') + '"'
}

function identifierParts(value: string): string[] {
  const parts = value.match(/`(?:``|[^`])+`|"(?:""|[^"])+"|[A-Za-z_][\w$]*/g) ?? []
  return parts.map((part) => {
    if (part.startsWith('`')) return part.slice(1, -1).replace(/``/g, '`')
    if (part.startsWith('"')) return part.slice(1, -1).replace(/""/g, '"')
    return part
  })
}

function inferSqlTarget(sql: string): SqlTarget | null {
  const identifier = '(?:`(?:``|[^`])+`|"(?:""|[^"])+"|[A-Za-z_][\\w$]*)'
  const match = sql.match(new RegExp(`\\bfrom\\s+(${identifier}(?:\\s*\\.\\s*${identifier}){0,2})`, 'i'))
  if (!match) return null
  const parts = identifierParts(match[1])
  const table = parts.at(-1)
  if (!table) return null
  let database = props.database
  let schema = props.schema
  if (props.dbType === 'mysql' && parts.length >= 2) database = parts.at(-2)
  else if (props.dbType === 'postgres' && parts.length >= 2) schema = parts.at(-2)
  else if (props.dbType === 'sqlite' && parts.length >= 2) database = parts.at(-2)
  const qualified = props.dbType === 'postgres'
    ? `${quoteIdentifier(schema ?? 'public')}.${quoteIdentifier(table)}`
    : database
      ? `${quoteIdentifier(database)}.${quoteIdentifier(table)}`
      : quoteIdentifier(table)
  return { qualified, table, database, schema }
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return props.dbType === 'postgres' ? (value ? 'TRUE' : 'FALSE') : (value ? '1' : '0')
  return "'" + String(value).replace(/'/g, "''") + "'"
}

function whereCondition(column: string, value: unknown): string {
  return value === null || value === undefined
    ? `${quoteIdentifier(column)} IS NULL`
    : `${quoteIdentifier(column)} = ${sqlLiteral(value)}`
}

async function keyColumns(target: SqlTarget): Promise<string[]> {
  if (!props.connectionId) return []
  try {
    const columnsInfo = await window.api.listColumns(props.connectionId, target.database, target.table, target.schema)
    const resultColumns = new Set(columnNames.value)
    const primary = columnsInfo.filter((column) => column.isPrimaryKey).map((column) => column.name)
    return primary.length > 0 && primary.every((column) => resultColumns.has(column)) ? primary : []
  } catch {
    return []
  }
}

async function buildSql(kind: 'select' | 'insert' | 'update' | 'delete'): Promise<string> {
  const target = sqlTarget.value
  if (!target) throw new Error(t('query.copySqlNeedsTable'))
  const sourceRows = selectedRows.value
  const names = columnNames.value
  if (kind === 'insert') {
    const columnsSql = names.map(quoteIdentifier).join(', ')
    return sourceRows.map((row) => `INSERT INTO ${target.qualified} (${columnsSql}) VALUES (${names.map((column) => sqlLiteral(row[column])).join(', ')});`).join('\n')
  }
  const primary = kind === 'select' ? [] : await keyColumns(target)
  const whereColumns = kind === 'select' ? names : primary.length ? primary : names
  return sourceRows.map((row) => {
    const where = whereColumns.map((column) => whereCondition(column, row[column])).join(' AND ')
    if (kind === 'select') return `SELECT * FROM ${target.qualified} WHERE ${where};`
    if (kind === 'delete') return `DELETE FROM ${target.qualified} WHERE ${where};`
    const setColumns = names.filter((column) => !primary.includes(column))
    const effectiveSet = setColumns.length ? setColumns : names
    const set = effectiveSet.map((column) => `${quoteIdentifier(column)} = ${sqlLiteral(row[column])}`).join(', ')
    return `UPDATE ${target.qualified} SET ${set} WHERE ${where};`
  }).join('\n')
}

function tableCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function escapeHtml(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

async function copyTable(): Promise<void> {
  const sourceRows = selectedRows.value
  const plain = [columnNames.value.join('\t'), ...sourceRows.map((row) => columnNames.value.map((column) => tableCell(row[column])).join('\t'))].join('\n')
  const html = `<table><thead><tr>${columnNames.value.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead><tbody>${sourceRows.map((row) => `<tr>${columnNames.value.map((column) => `<td>${escapeHtml(row[column])}</td>`).join('')}</tr>`).join('')}</tbody></table>`
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/plain': new Blob([plain], { type: 'text/plain' }),
      'text/html': new Blob([html], { type: 'text/html' })
    })])
  } catch {
    await navigator.clipboard.writeText(plain)
  }
}

async function copyResult(kind: string | number): Promise<void> {
  try {
    if (kind === 'table') await copyTable()
    else await navigator.clipboard.writeText(await buildSql(String(kind) as 'select' | 'insert' | 'update' | 'delete'))
    message.success(t('query.copiedRows', { count: selectedRows.value.length }))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}

async function exportResult(format: string): Promise<void> {
  const sourceRows = props.result.rows ?? []
  try {
    const content = format === 'csv' ? toCsv(columnNames.value, sourceRows) : toJson(sourceRows)
    const path = await window.api.exportData({
      defaultName: `result-${props.index + 1}.${format}`,
      content,
      fileTypes: [format === 'csv' ? { name: 'CSV', extensions: ['csv'] } : { name: 'JSON', extensions: ['json'] }]
    })
    if (path) message.success(t('query.exported', { count: sourceRows.length, path }))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}
</script>

<template>
  <div v-if="result.kind === 'exec'" class="result-exec">
    <NTag type="info">#{{ index + 1 }}</NTag>
    {{ t('query.affectedRows', { count: result.affectedRows ?? 0 }) }}
  </div>
  <section v-else class="query-result">
    <div class="result-meta">
      <span><NTag type="info">#{{ index + 1 }}</NTag> {{ t('common.rows', { count: rows.length }) }}</span>
      <NDropdown trigger="click" :options="copyOptions" :disabled="rows.length === 0" @select="copyResult">
        <NButton quaternary size="small">
          <template #icon><NIcon><CopyOutlined /></NIcon></template>
          {{ t('query.copy') }}<template v-if="selectedKeys.length"> ({{ selectedKeys.length }})</template>
        </NButton>
      </NDropdown>
      <NDropdown trigger="click" :options="exportOptions" :disabled="rows.length === 0" @select="exportResult">
        <NButton quaternary size="small" :aria-label="t('common.export')">
          <template #icon><NIcon><DownloadOutlined /></NIcon></template>
        </NButton>
      </NDropdown>
    </div>
    <NDataTable
      size="small"
      bordered
      :columns="columns"
      :data="rows"
      :row-key="(row: Record<string, unknown>) => String(row.__resultKey)"
      :checked-row-keys="selectedKeys"
      :row-class-name="resultRowClassName"
      :row-props="(row: Record<string, unknown>) => ({ onClick: (event: MouseEvent) => selectResultRow(event, row), onContextmenu: (event: MouseEvent) => openResultRowMenu(event, row) })"
      :pagination="false"
      :scroll-x="Math.max(700, columns.length * 160 + 44)"
      @update:checked-row-keys="updateSelectedKeys"
    />
    <NDropdown trigger="manual" placement="bottom-start" :show="rowMenuShow" :x="rowMenuX" :y="rowMenuY" :options="copyOptions" @select="selectRowMenu" @clickoutside="rowMenuShow = false" />
  </section>
</template>
