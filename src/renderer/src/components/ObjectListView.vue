<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue'
import { AppstoreOutlined, CodeOutlined, EditOutlined, EyeOutlined, FolderOpenOutlined, FunctionOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, TableOutlined, UnorderedListOutlined } from '@vicons/antd'
import { NButton, NDataTable, NIcon, NInput, NTooltip, useMessage, type DataTableColumns } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { RoutineInfo, SavedQuery, TableInfo } from '../../../shared/types'
import type { AppTab } from '../stores/app'
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
const message = useMessage()
const loading = ref(false)
const keyword = ref('')
const loadedRows = ref<ObjectRow[]>([])
const selectedKey = ref<string | null>(null)
const viewMode = ref<'list' | 'grid'>('list')

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
function iconOf(row: ObjectRow): typeof TableOutlined {
  if (row.type === 'view') return EyeOutlined
  if (row.kind === 'routine') return FunctionOutlined
  if (row.kind === 'query') return CodeOutlined
  return TableOutlined
}

const columns = computed<DataTableColumns<ObjectRow>>(() => [
  {
    title: t('objectList.name'), key: 'name', sorter: 'default', minWidth: 240, ellipsis: { tooltip: true },
    render: (row) => h('span', { class: 'object-name-cell' }, [h(NIcon, { color: '#35aeb5', size: 17 }, { default: () => h(iconOf(row)) }), row.name])
  },
  { title: t('objectList.rows'), key: 'rowCount', width: 120, sorter: (a, b) => (a.rowCount ?? -1) - (b.rowCount ?? -1), render: (row) => formatRows(row.rowCount) },
  { title: t('objectList.createdAt'), key: 'createdAt', width: 190, sorter: 'default', render: (row) => formatDate(row.createdAt) },
  { title: t('objectList.updatedAt'), key: 'updatedAt', width: 190, sorter: 'default', render: (row) => formatDate(row.updatedAt) },
  { title: t('objectList.oid'), key: 'objectId', width: 150, sorter: 'default', ellipsis: { tooltip: true }, render: (row) => row.objectId ?? '-' }
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
    if (selectedKey.value && !loadedRows.value.some((row) => row.key === selectedKey.value)) selectedKey.value = null
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    loading.value = false
  }
}

function openRow(row: ObjectRow): void {
  if (row.kind === 'query' && row.query) {
    store.openTab({ type: 'query', title: row.query.name, connectionId: row.query.connectionId, database: row.query.database, sql: row.query.sql, savedQueryId: row.query.id })
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
function openSelected(): void { if (selectedRow.value) openRow(selectedRow.value) }
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
onMounted(load)
</script>

<template>
  <div class="module-page object-list-page">
    <div class="module-toolbar object-list-toolbar">
      <span class="object-toolbar-actions">
        <NTooltip><template #trigger><NButton quaternary size="small" :disabled="!['tables', 'queries'].includes(tab.objectGroup ?? '') || (tab.objectGroup === 'tables' && !supportsStructure)" @click="createObject"><template #icon><NIcon><PlusOutlined /></NIcon></template></NButton></template>{{ t(tab.objectGroup === 'queries' ? 'sidebar.newQuery' : 'sidebar.newTable') }}</NTooltip>
        <NTooltip><template #trigger><NButton quaternary size="small" :disabled="!selectedRow" @click="openSelected"><template #icon><NIcon><FolderOpenOutlined /></NIcon></template></NButton></template>{{ t('objectList.open') }}</NTooltip>
        <NTooltip><template #trigger><NButton quaternary size="small" :disabled="!supportsStructure || !selectedRow?.table || selectedRow.table.type !== 'table'" @click="designSelected"><template #icon><NIcon><EditOutlined /></NIcon></template></NButton></template>{{ t('sidebar.designTable') }}</NTooltip>
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
        :row-class-name="(row: ObjectRow) => row.key === selectedKey ? 'object-row-selected' : ''"
        :row-props="(row: ObjectRow) => ({ onClick: () => { selectedKey = row.key }, onDblclick: () => openRow(row) })"
        :pagination="false"
        :scroll-x="890"
      />
    </div>
    <div v-else class="object-grid-view">
      <button v-for="row in filteredRows" :key="row.key" type="button" class="object-grid-card" :class="{ selected: row.key === selectedKey }" @click="selectedKey = row.key" @dblclick="openRow(row)">
        <NIcon size="28" color="#35aeb5"><component :is="iconOf(row)" /></NIcon>
        <span class="object-grid-name" :title="row.name">{{ row.name }}</span>
        <small>{{ formatRows(row.rowCount) }} {{ t('objectList.rows').toLocaleLowerCase() }}</small>
      </button>
    </div>
    <footer class="object-list-footer">{{ t('common.totalItems', { count: filteredRows.length }) }}</footer>
  </div>
</template>
