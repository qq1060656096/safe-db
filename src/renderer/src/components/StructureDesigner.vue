<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue'
import { DeleteOutlined, PlusOutlined, ReloadOutlined, SaveOutlined, UndoOutlined } from '@vicons/antd'
import { NAlert, NAutoComplete, NButton, NButtonGroup, NCheckbox, NDataTable, NIcon, NInput, NRadioButton, NRadioGroup, NSelect, NTag, NTooltip, useDialog, useMessage, type DataTableColumns } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ColumnInfo, DatabaseOperation, DbType, IndexInfo, TableColumnChange, TableColumnDefinition } from '../../../shared/types'
import type { AppTab } from '../stores/app'
import { useAppStore } from '../stores/app'

interface ColumnDraft {
  key: string; name: string; dataType: string; nullable: boolean; isPrimaryKey: boolean; autoIncrement: boolean;
  defaultValue: string; comment: string; status: 'existing' | 'added' | 'dropped'; origName?: string
}
const props = defineProps<{ tab: AppTab }>()
const store = useAppStore()
const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()
const isNew = computed(() => !props.tab.table)
const connection = computed(() => store.connections.find((item) => item.id === props.tab.connectionId))
const dialect = computed(() => connection.value?.type)
const columns = ref<ColumnDraft[]>([])
const originalColumns = ref<ColumnDraft[]>([])
const indexes = ref<IndexInfo[]>([])
const tableName = ref('')
const loading = ref(false)
const saving = ref(false)
const savingIndex = ref(false)
const newIndexName = ref('')
const newIndexColumns = ref<string[]>([])
const newIndexUnique = ref(false)
const view = ref<'columns' | 'indexes'>('columns')
const typeSuggestions: Record<DbType, string[]> = {
  mysql: ['INT', 'BIGINT', 'TINYINT(1)', 'VARCHAR(255)', 'CHAR(36)', 'TEXT', 'LONGTEXT', 'DATETIME', 'TIMESTAMP', 'DATE', 'DECIMAL(10,2)', 'DOUBLE', 'JSON'],
  postgres: ['integer', 'bigint', 'smallint', 'varchar(255)', 'char(36)', 'text', 'timestamp', 'timestamptz', 'date', 'numeric(10,2)', 'boolean', 'jsonb', 'uuid'],
  sqlite: ['INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC'],
  sqlserver: ['int', 'bigint', 'smallint', 'tinyint', 'bit', 'nvarchar(255)', 'varchar(255)', 'nvarchar(max)', 'datetime2', 'datetimeoffset', 'date', 'decimal(10,2)', 'float', 'uniqueidentifier', 'varbinary(max)'],
  mongodb: [],
  redis: [],
  qdrant: []
}
const typeOptions = computed(() => typeSuggestions[dialect.value ?? 'mysql'].map((value) => ({ label: value, value })))
function columnDefinition(column: ColumnDraft): TableColumnDefinition {
  return {
    name: column.name.trim(), dataType: column.dataType.trim(), nullable: column.nullable,
    primaryKey: column.isPrimaryKey, autoIncrement: column.autoIncrement,
    defaultValue: column.defaultValue, comment: column.comment
  }
}

function buildOperation(): DatabaseOperation | null {
  if (isNew.value) {
    return {
      kind: 'object.create', objectType: 'table', name: tableName.value.trim(),
      database: props.tab.database, schema: props.tab.schema,
      definition: { columns: columns.value.filter((column) => column.status !== 'dropped' && column.name.trim()).map(columnDefinition) }
    }
  }
  if (!props.tab.table) return null
  const originalByKey = new Map(originalColumns.value.map((column) => [column.key, column]))
  const changes: TableColumnChange[] = []
  for (const column of columns.value) {
    if (column.status === 'added') {
      if (column.name.trim()) changes.push({ kind: 'add', column: columnDefinition(column) })
      continue
    }
    if (column.status === 'dropped') {
      changes.push({ kind: 'drop', name: column.origName ?? column.name })
      continue
    }
    const original = originalByKey.get(column.key)
    if (original && (column.name !== original.name || column.dataType !== original.dataType || column.nullable !== original.nullable || column.defaultValue !== original.defaultValue || column.comment !== original.comment)) {
      changes.push({ kind: 'alter', previousName: original.name, column: columnDefinition(column) })
    }
  }
  return changes.length
    ? { kind: 'object.alter', target: { kind: 'table', name: props.tab.table, database: props.tab.database, schema: props.tab.schema }, changes }
    : null
}
function toDraft(column: ColumnInfo): ColumnDraft {
  return { key: column.name, name: column.name, dataType: column.dataType, nullable: column.nullable, isPrimaryKey: column.isPrimaryKey, autoIncrement: /auto_increment|identity/i.test(column.extra ?? '') || /nextval/i.test(column.defaultValue ?? ''), defaultValue: column.defaultValue ?? '', comment: column.comment ?? '', status: 'existing', origName: column.name }
}
function blankColumn(): ColumnDraft { return { key: crypto.randomUUID(), name: '', dataType: dialect.value === 'postgres' || dialect.value === 'sqlserver' ? 'varchar(255)' : 'VARCHAR(255)', nullable: true, isPrimaryKey: false, autoIncrement: false, defaultValue: '', comment: '', status: 'added' } }
async function load(): Promise<void> {
  if (isNew.value) {
    columns.value = [{ key: crypto.randomUUID(), name: 'id', dataType: dialect.value === 'postgres' ? 'integer' : dialect.value === 'sqlserver' ? 'int' : 'INT', nullable: false, isPrimaryKey: true, autoIncrement: true, defaultValue: '', comment: '', status: 'added' }]
    originalColumns.value = []; indexes.value = []; return
  }
  if (!props.tab.connectionId || !props.tab.table) return
  loading.value = true
  try {
    const [columnResult, indexResult] = await Promise.all([window.api.listColumns(props.tab.connectionId, props.tab.database, props.tab.table, props.tab.schema), window.api.listIndexes(props.tab.connectionId, props.tab.database, props.tab.table, props.tab.schema)])
    columns.value = columnResult.map(toDraft); originalColumns.value = columns.value.map((column) => ({ ...column })); indexes.value = indexResult
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)) }
  finally { loading.value = false }
}
onMounted(load)
function update(key: string, patch: Partial<ColumnDraft>): void { columns.value = columns.value.map((column) => column.key === key ? { ...column, ...patch } : column) }
function addColumn(): void { columns.value = [...columns.value, blankColumn()]; view.value = 'columns' }
function removeColumn(key: string): void {
  const column = columns.value.find((item) => item.key === key)
  if (!column) return
  if (column.status === 'added') columns.value = columns.value.filter((item) => item.key !== key)
  else update(key, { status: column.status === 'dropped' ? 'existing' : 'dropped' })
}
const changeCount = computed(() => {
  if (isNew.value) return 0
  const originalByKey = new Map(originalColumns.value.map((column) => [column.key, column]))
  return columns.value.filter((column) => {
    if (column.status === 'added') return Boolean(column.name.trim())
    if (column.status === 'dropped') return true
    const original = originalByKey.get(column.key)
    return original && (column.name !== original.name || column.dataType !== original.dataType || column.nullable !== original.nullable || column.defaultValue !== original.defaultValue || column.comment !== original.comment)
  }).length
})
const activeColumnCount = computed(() => columns.value.filter((column) => column.status !== 'dropped').length)
const indexColumnOptions = computed(() => columns.value
  .filter((column) => column.status !== 'dropped' && column.name.trim())
  .map((column) => ({ label: column.name, value: column.name })))
function validate(): string | null {
  if (isNew.value && !tableName.value.trim()) return t('structure.enterTableName')
  const active = columns.value.filter((column) => column.status !== 'dropped' && column.name.trim())
  if (isNew.value && active.length === 0) return t('structure.atLeastOneColumn')
  if (new Set(active.map((column) => column.name.trim().toLowerCase())).size !== active.length) return t('structure.duplicateColumns')
  for (const column of active) if (!column.dataType.trim()) return t('structure.missingType', { name: column.name })
  return null
}
async function save(): Promise<void> {
  const error = validate()
  if (error) { message.warning(error); return }
  const operation = buildOperation()
  if (!operation) { message.info(t('structure.noChanges')); return }
  if (!props.tab.connectionId) return
  saving.value = true
  try {
    const result = await store.executeOperationWithApproval(props.tab.connectionId, operation)
    if (result.status === 'ok') { if (isNew.value) { message.success(t('structure.created', { name: tableName.value.trim() })); tableName.value = '' } else message.success(t('structure.structureSaved')); await load() }
    else if (result.status === 'denied') message.warning(result.error ?? '')
    else if (result.status === 'error') message.error(result.error ?? '')
  } finally { saving.value = false }
}
async function createIndex(): Promise<void> {
  const name = newIndexName.value.trim()
  if (!props.tab.connectionId || !props.tab.table || !name || !newIndexColumns.value.length || savingIndex.value) return
  savingIndex.value = true
  try {
    const result = await store.executeOperationWithApproval(props.tab.connectionId, {
      kind: 'index.create',
      target: { kind: 'table', name: props.tab.table, database: props.tab.database, schema: props.tab.schema },
      name,
      definition: { columns: newIndexColumns.value, unique: newIndexUnique.value }
    })
    if (result.status === 'ok') {
      message.success(t('qdrant.indexCreated', { name }))
      newIndexName.value = ''
      newIndexColumns.value = []
      newIndexUnique.value = false
      await load()
    } else if (result.status === 'denied') message.warning(result.error ?? '')
    else if (result.status === 'error') message.error(result.error ?? '')
  } finally { savingIndex.value = false }
}
function deleteIndex(index: IndexInfo): void {
  if (!props.tab.connectionId || !props.tab.table || index.primary) return
  dialog.error({
    title: t('qdrant.deleteIndexTitle', { name: index.name }),
    content: t('qdrant.deleteIndexHint'), positiveText: t('common.delete'), negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      const result = await store.executeOperationWithApproval(props.tab.connectionId!, {
        kind: 'index.drop',
        target: { kind: 'table', name: props.tab.table!, database: props.tab.database, schema: props.tab.schema },
        name: index.name
      })
      if (result.status === 'ok') { message.success(t('qdrant.indexDeleted', { name: index.name })); await load() }
      else if (result.status === 'denied') message.warning(result.error ?? '')
      else if (result.status === 'error') message.error(result.error ?? '')
    }
  })
}
function tooltip(content: string, child: ReturnType<typeof h>): ReturnType<typeof h> { return h(NTooltip, null, { trigger: () => child, default: () => content }) }
const editColumns = computed<DataTableColumns<ColumnDraft>>(() => [
  { title: t('structure.columnName'), key: 'name', width: 190, render: (column) => h(NInput, { size: 'small', value: column.name, placeholder: t('structure.columnName'), disabled: column.status === 'dropped', 'onUpdate:value': (value) => update(column.key, { name: value }) }) },
  { title: t('structure.type'), key: 'dataType', width: 180, render: (column) => h(NAutoComplete, { size: 'small', value: column.dataType, options: typeOptions.value, placeholder: t('structure.type'), disabled: column.status === 'dropped', 'onUpdate:value': (value) => update(column.key, { dataType: value }) }) },
  { title: t('structure.nullable'), key: 'nullable', width: 95, align: 'center', render: (column) => h(NCheckbox, { checked: column.nullable, disabled: column.status === 'dropped', 'onUpdate:checked': (checked) => update(column.key, { nullable: checked }) }) },
  { title: t('structure.primary'), key: 'isPrimaryKey', width: 70, align: 'center', render: (column) => tooltip(isNew.value ? '' : t('structure.primaryOnlyCreate'), h(NCheckbox, { checked: column.isPrimaryKey, disabled: !isNew.value || column.status === 'dropped', 'onUpdate:checked': (checked) => update(column.key, { isPrimaryKey: checked, nullable: checked ? false : column.nullable }) })) },
  { title: t('structure.autoIncrement'), key: 'autoIncrement', width: 75, align: 'center', render: (column) => tooltip(isNew.value ? '' : t('structure.incrementOnlyCreate'), h(NCheckbox, { checked: column.autoIncrement, disabled: !isNew.value || column.status === 'dropped', 'onUpdate:checked': (checked) => update(column.key, { autoIncrement: checked, isPrimaryKey: checked ? true : column.isPrimaryKey, nullable: checked ? false : column.nullable }) })) },
  { title: t('structure.defaultValue'), key: 'defaultValue', width: 170, render: (column) => h(NInput, { size: 'small', value: column.defaultValue, placeholder: t('structure.noDefault'), disabled: column.status === 'dropped', 'onUpdate:value': (value) => update(column.key, { defaultValue: value }) }) },
  ...(dialect.value === 'mysql' ? [{ title: t('structure.comment'), key: 'comment', width: 160, render: (column: ColumnDraft) => h(NInput, { size: 'small', value: column.comment, disabled: column.status === 'dropped', 'onUpdate:value': (value) => update(column.key, { comment: value }) }) }] : []),
  { title: '', key: 'operation', width: 55, align: 'center', render: (column) => h(NButton, { size: 'small', quaternary: true, type: column.status === 'dropped' ? 'default' : 'error', title: column.status === 'dropped' ? t('structure.undoDelete') : column.status === 'added' ? t('structure.removeColumn') : t('structure.deleteColumn'), onClick: () => removeColumn(column.key) }, { icon: () => h(NIcon, null, { default: () => h(column.status === 'dropped' ? UndoOutlined : DeleteOutlined) }) }) }
])
const indexColumns = computed<DataTableColumns<IndexInfo>>(() => [
  { title: t('structure.indexName'), key: 'name', width: 220 },
  { title: t('structure.indexColumns'), key: 'columns', render: (index) => index.columns.join(', ') },
  { title: t('structure.unique'), key: 'unique', width: 80, align: 'center', render: (index) => index.unique ? t('common.yes') : t('common.no') },
  { title: t('structure.primary'), key: 'primary', width: 80, align: 'center', render: (index) => index.primary ? t('common.yes') : t('common.no') },
  { title: t('objectList.action'), key: 'action', width: 70, align: 'center', render: (index) => h(NButton, {
    size: 'small', quaternary: true, type: 'error', disabled: index.primary || connection.value?.permissionMode === 'readonly',
    onClick: () => deleteIndex(index)
  }, { icon: () => h(NIcon, null, { default: () => h(DeleteOutlined) }) }) }
])
function rowClassName(column: ColumnDraft): string { return column.status === 'dropped' ? 'grid-row-deleted' : column.status === 'added' ? 'grid-row-new' : '' }
</script>

<template>
  <div class="module-page structure-page">
    <div class="module-toolbar">
      <template v-if="isNew"><span>{{ t('structure.tableName') }}</span><NInput v-model:value="tableName" size="small" class="table-name-input" :placeholder="t('structure.newTableName')" /></template>
      <template v-else><NButton size="small" :loading="loading" @click="load"><template #icon><NIcon><ReloadOutlined /></NIcon></template>{{ t('common.refresh') }}</NButton><NTag type="info">{{ tab.schema ? `${tab.schema}.` : '' }}{{ tab.table }}</NTag><NRadioGroup v-model:value="view" size="small"><NRadioButton value="columns">{{ t('structure.columns', { count: activeColumnCount }) }}</NRadioButton><NRadioButton value="indexes">{{ t('structure.indexes', { count: indexes.length }) }}</NRadioButton></NRadioGroup></template>
      <NButton size="small" @click="addColumn"><template #icon><NIcon><PlusOutlined /></NIcon></template>{{ t('structure.addColumn') }}</NButton>
      <NButton v-if="!isNew" size="small" :disabled="changeCount === 0" @click="load"><template #icon><NIcon><UndoOutlined /></NIcon></template>{{ t('grid.discard') }}</NButton>
      <NButton size="small" type="primary" :loading="saving" :disabled="!isNew && changeCount === 0" @click="save"><template #icon><NIcon><SaveOutlined /></NIcon></template>{{ isNew ? t('structure.createTable') : changeCount ? t('grid.saveCount', { count: changeCount }) : t('common.save') }}</NButton>
      <span class="toolbar-meta"><NTag v-if="connection?.permissionMode === 'readonly'" type="info">{{ t('permission.readonlyMode') }}</NTag><NTag v-if="connection?.permissionMode === 'approval'" type="warning">{{ t('permission.approvalMode') }}</NTag></span>
    </div>
    <NAlert v-if="dialect === 'sqlite' && !isNew" type="info" class="module-alert">{{ t('structure.sqliteHelp') }}</NAlert>
    <NAlert v-if="dialect === 'postgres' && !isNew" type="info" class="module-alert">{{ t('structure.postgresHelp') }}</NAlert>
    <div class="data-table-wrap padded">
      <NDataTable v-if="view === 'columns' || isNew" size="small" bordered :loading="loading" :columns="editColumns" :data="columns" :row-key="(column: ColumnDraft) => column.key" :pagination="false" :row-class-name="rowClassName" :scroll-x="dialect === 'mysql' ? 1050 : 900" />
      <template v-else>
        <div class="index-definition-form">
          <NInput v-model:value="newIndexName" :placeholder="t('structure.indexName')" :disabled="savingIndex || connection?.permissionMode === 'readonly'" />
          <NSelect v-model:value="newIndexColumns" multiple :options="indexColumnOptions" :placeholder="t('structure.indexColumns')" :disabled="savingIndex || connection?.permissionMode === 'readonly'" />
          <NCheckbox v-model:checked="newIndexUnique" :disabled="savingIndex || connection?.permissionMode === 'readonly'">{{ t('structure.unique') }}</NCheckbox>
          <NButton type="primary" :loading="savingIndex" :disabled="!newIndexName.trim() || !newIndexColumns.length || connection?.permissionMode === 'readonly'" @click="createIndex"><template #icon><NIcon><PlusOutlined /></NIcon></template>{{ t('qdrant.createIndex') }}</NButton>
        </div>
        <NDataTable size="small" bordered :loading="loading" :columns="indexColumns" :data="indexes" :row-key="(index: IndexInfo) => index.name" :pagination="false" :scroll-x="780" />
      </template>
    </div>
  </div>
</template>
