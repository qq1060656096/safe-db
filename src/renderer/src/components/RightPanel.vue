<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { CopyOutlined, HistoryOutlined, ReloadOutlined } from '@vicons/antd'
import { NButton, NEmpty, NIcon, NSpin, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ConnectionMeta, QueryResult } from '../../../shared/types'
import { useAppStore } from '../stores/app'

const store = useAppStore()
const { t } = useI18n()
const message = useMessage()
const activeTab = computed(() => store.tabs.find((tab) => tab.id === store.activeTabId))
const connection = computed(() => store.connections.find((item) => item.id === activeTab.value?.connectionId))
const savedQuery = computed(() => store.savedQueries.find((query) => query.id === activeTab.value?.savedQueryId))
const permissionType = computed<'info' | 'warning' | 'success'>(() => {
  if (connection.value?.permissionMode === 'approval') return 'warning'
  if (connection.value?.permissionMode === 'full') return 'success'
  return 'info'
})
const objectName = computed(() => activeTab.value?.table ?? activeTab.value?.routine ?? activeTab.value?.title)
const ddl = ref('')
const ddlError = ref('')
const ddlLoading = ref(false)
let ddlRequestId = 0

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function quoteIdentifier(connection: ConnectionMeta, name: string): string {
  if (connection.type === 'mysql') return '`' + name.replace(/`/g, '``') + '`'
  if (connection.type === 'sqlserver') return '[' + name.replace(/]/g, ']]') + ']'
  return '"' + name.replace(/"/g, '""') + '"'
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function rowsOf(results: QueryResult[] | undefined): Record<string, unknown>[] {
  return results?.find((result) => result.kind === 'rows')?.rows ?? []
}

async function readRows(connectionId: string, sql: string, database?: string): Promise<Record<string, unknown>[]> {
  const response = await window.api.executeSql(connectionId, sql, database)
  if (response.status !== 'ok') throw new Error(response.error ?? t('query.failed'))
  return rowsOf(response.results)
}

/** 开发期间主进程尚未重启时，使用既有只读查询通道兼容加载 DDL。 */
async function loadDdlWithReadQuery(tab: NonNullable<typeof activeTab.value>, currentConnection: ConnectionMeta): Promise<string> {
  const table = tab.table!
  if (currentConnection.type === 'mysql') {
    const database = tab.database ?? currentConnection.database
    if (!database) throw new Error(t('panel.databaseRequired'))
    const rows = await readRows(
      currentConnection.id,
      `SHOW CREATE TABLE ${quoteIdentifier(currentConnection, database)}.${quoteIdentifier(currentConnection, table)}`,
      database
    )
    const row = rows[0]
    const value = row?.['Create Table'] ?? row?.['Create View'] ?? (row ? Object.values(row)[1] : undefined)
    if (typeof value !== 'string' || !value.trim()) throw new Error(t('panel.ddlUnavailable'))
    return `${value.trim().replace(/;\s*$/, '')};`
  }

  if (currentConnection.type === 'sqlite') {
    const database = tab.database ?? 'main'
    const rows = await readRows(
      currentConnection.id,
      `SELECT sql FROM ${quoteIdentifier(currentConnection, database)}.sqlite_master WHERE name = ${sqlLiteral(table)} AND type IN ('table', 'view')`
    )
    const value = rows[0]?.sql
    if (typeof value !== 'string' || !value.trim()) throw new Error(t('panel.ddlUnavailable'))
    return `${value.trim().replace(/;\s*$/, '')};`
  }

  if (currentConnection.type === 'sqlserver' || currentConnection.type === 'mongodb' || currentConnection.type === 'redis') {
    throw new Error(t('panel.ddlUnavailable'))
  }

  const schema = tab.schema ?? 'public'
  const objectRows = await readRows(
    currentConnection.id,
    `SELECT c.relkind, CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END AS "viewDefinition"
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${sqlLiteral(schema)} AND c.relname = ${sqlLiteral(table)} AND c.relkind IN ('r', 'p', 'v', 'm')`,
    tab.database
  )
  const object = objectRows[0]
  if (!object) throw new Error(t('panel.ddlUnavailable'))
  const qualified = `${quoteIdentifier(currentConnection, schema)}.${quoteIdentifier(currentConnection, table)}`
  if (object.relkind === 'v' || object.relkind === 'm') {
    const definition = typeof object.viewDefinition === 'string' ? object.viewDefinition.trim().replace(/;\s*$/, '') : ''
    if (!definition) throw new Error(t('panel.ddlUnavailable'))
    return `CREATE ${object.relkind === 'm' ? 'MATERIALIZED VIEW' : 'VIEW'} ${qualified} AS\n${definition};`
  }

  const [columns, indexes] = await Promise.all([
    window.api.listColumns(currentConnection.id, tab.database, table, schema),
    window.api.listIndexes(currentConnection.id, tab.database, table, schema)
  ])
  const definitions = columns.map((column) => {
    let definition = `${quoteIdentifier(currentConnection, column.name)} ${column.dataType}`
    if (column.defaultValue) definition += ` DEFAULT ${column.defaultValue}`
    if (!column.nullable) definition += ' NOT NULL'
    return definition
  })
  const primaryColumns = columns.filter((column) => column.isPrimaryKey).map((column) => quoteIdentifier(currentConnection, column.name))
  if (primaryColumns.length) definitions.push(`PRIMARY KEY (${primaryColumns.join(', ')})`)
  const createTable = `CREATE TABLE ${qualified} (\n  ${definitions.join(',\n  ')}\n);`
  const indexDdl = indexes
    .filter((index) => !index.primary)
    .map((index) => `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdentifier(currentConnection, index.name)} ON ${qualified} (${index.columns.map((column) => quoteIdentifier(currentConnection, column)).join(', ')});`)
    .join('\n')
  return indexDdl ? `${createTable}\n\n${indexDdl}` : createTable
}

async function loadRoutineWithReadQuery(tab: NonNullable<typeof activeTab.value>, currentConnection: ConnectionMeta): Promise<string> {
  const routine = tab.routine!
  const routineType = tab.routineType ?? 'function'
  if (currentConnection.type === 'sqlite') throw new Error(t('panel.routineDefinitionUnavailable'))
  if (currentConnection.type === 'sqlserver' || currentConnection.type === 'mongodb' || currentConnection.type === 'redis') throw new Error(t('panel.routineDefinitionUnavailable'))
  if (currentConnection.type === 'mysql') {
    const database = tab.database ?? currentConnection.database
    if (!database) throw new Error(t('panel.databaseRequired'))
    const keyword = routineType === 'procedure' ? 'PROCEDURE' : 'FUNCTION'
    const rows = await readRows(
      currentConnection.id,
      `SHOW CREATE ${keyword} ${quoteIdentifier(currentConnection, database)}.${quoteIdentifier(currentConnection, routine)}`,
      database
    )
    const value = rows[0]?.[`Create ${routineType === 'procedure' ? 'Procedure' : 'Function'}`]
    if (typeof value !== 'string' || !value.trim()) throw new Error(t('panel.routineDefinitionUnavailable'))
    const normalized = value.trim()
    return /;\s*$/.test(normalized) ? normalized : `${normalized};`
  }

  const schema = tab.schema ?? 'public'
  const argumentsFilter = tab.routineArguments === undefined
    ? ''
    : ` AND pg_get_function_identity_arguments(p.oid) = ${sqlLiteral(tab.routineArguments)}`
  const rows = await readRows(
    currentConnection.id,
    `SELECT pg_get_functiondef(p.oid) AS definition
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = ${sqlLiteral(schema)} AND p.proname = ${sqlLiteral(routine)}
       AND p.prokind = ${sqlLiteral(routineType === 'procedure' ? 'p' : 'f')}${argumentsFilter}
     ORDER BY p.oid LIMIT 1`,
    tab.database
  )
  const value = rows[0]?.definition
  if (typeof value !== 'string' || !value.trim()) throw new Error(t('panel.routineDefinitionUnavailable'))
  return value.trim()
}

async function loadDdl(): Promise<void> {
  const tab = activeTab.value
  const requestId = ++ddlRequestId
  ddl.value = ''
  ddlError.value = ''
  if (!tab?.connectionId || (!tab.table && !tab.routine)) { ddlLoading.value = false; return }
  ddlLoading.value = true
  try {
    let result: string
    if (tab.routine) {
      if (typeof window.api.getRoutineDefinition !== 'function') {
        const currentConnection = connection.value
        if (!currentConnection) throw new Error(t('panel.routineDefinitionUnavailable'))
        result = await loadRoutineWithReadQuery(tab, currentConnection)
      } else {
        try {
          result = await window.api.getRoutineDefinition(tab.connectionId, tab.database, tab.routine, tab.routineType ?? 'function', tab.schema, tab.routineArguments)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          const currentConnection = connection.value
          if (!currentConnection || !/No handler registered for ['"]?db:routineDefinition/.test(detail)) throw error
          result = await loadRoutineWithReadQuery(tab, currentConnection)
        }
      }
    } else {
      result = await window.api.getObjectDdl(tab.connectionId, tab.database, tab.table!, tab.schema)
    }
    if (requestId === ddlRequestId) ddl.value = result
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const currentConnection = connection.value
    if (currentConnection && /No handler registered for ['"]?db:ddl/.test(detail)) {
      try {
        const result = await loadDdlWithReadQuery(tab, currentConnection)
        if (requestId === ddlRequestId) ddl.value = result
      } catch (fallbackError) {
        if (requestId === ddlRequestId) ddlError.value = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      }
    } else if (requestId === ddlRequestId) ddlError.value = detail
  } finally {
    if (requestId === ddlRequestId) ddlLoading.value = false
  }
}

async function copyDdl(): Promise<void> {
  if (!ddl.value) return
  await navigator.clipboard.writeText(ddl.value)
  message.success(t('common.copied'))
}

watch(
  () => [activeTab.value?.connectionId, activeTab.value?.database, activeTab.value?.schema, activeTab.value?.table, activeTab.value?.routine, activeTab.value?.routineType, activeTab.value?.routineArguments],
  () => { void loadDdl() },
  { immediate: true }
)

function openAudit(): void {
  store.openTab({ type: 'audit', title: t('sidebar.auditLog') })
}
</script>

<template>
  <aside class="right-panel">
    <header class="right-panel-header">{{ t('panel.details') }}</header>
    <div class="right-panel-body">
      <NEmpty v-if="!activeTab" size="small" :description="t('panel.noSelection')" />
      <template v-else>
        <section class="detail-section">
          <h3>{{ objectName }}</h3>
          <dl class="detail-list">
            <div><dt>{{ t('panel.type') }}</dt><dd>{{ t(`panel.tabTypes.${activeTab.routine ? 'routine' : activeTab.type}`) }}</dd></div>
            <div v-if="connection"><dt>{{ t('panel.connection') }}</dt><dd><span v-if="connection.color" class="connection-color" :style="{ background: connection.color }" />{{ connection.name }}</dd></div>
            <div v-if="activeTab.database"><dt>{{ t('panel.database') }}</dt><dd>{{ activeTab.database }}</dd></div>
            <div v-if="activeTab.schema"><dt>{{ t('panel.schema') }}</dt><dd>{{ activeTab.schema }}</dd></div>
            <div v-if="activeTab.table"><dt>{{ t('panel.table') }}</dt><dd>{{ activeTab.table }}</dd></div>
            <div v-if="activeTab.routine"><dt>{{ t('panel.routine') }}</dt><dd>{{ activeTab.routine }}<template v-if="activeTab.routineArguments !== undefined">({{ activeTab.routineArguments }})</template></dd></div>
            <div v-if="activeTab.routineType"><dt>{{ t('panel.routineType') }}</dt><dd>{{ t(`sidebar.routineTypes.${activeTab.routineType}`) }}</dd></div>
            <div v-if="connection"><dt>{{ t('panel.permission') }}</dt><dd><NTag size="small" :type="permissionType">{{ t(`permission.${connection.permissionMode}`) }}</NTag></dd></div>
            <div v-if="activeTab.type === 'query'"><dt>{{ t('panel.queryState') }}</dt><dd><NTag size="small" :type="activeTab.savedQueryId ? 'success' : 'default'">{{ t(activeTab.savedQueryId ? 'panel.savedQuery' : 'panel.temporaryQuery') }}</NTag></dd></div>
            <div v-if="activeTab.type === 'query'"><dt>{{ t('panel.modificationState') }}</dt><dd><NTag size="small" :type="activeTab.dirty ? 'warning' : 'default'">{{ t(activeTab.dirty ? 'query.modified' : 'query.unmodified') }}</NTag></dd></div>
            <div v-if="savedQuery"><dt>{{ t('panel.updatedAt') }}</dt><dd>{{ formatDate(savedQuery.updatedAt) }}</dd></div>
          </dl>
        </section>
        <section v-if="activeTab.table || activeTab.routine" class="ddl-section">
          <header class="ddl-section-header">
            <h3>{{ t(activeTab.routine ? 'panel.routineDefinition' : 'panel.ddl') }}</h3>
            <span class="ddl-actions">
              <NButton quaternary circle size="tiny" :title="t('common.refresh')" :loading="ddlLoading" @click="loadDdl">
                <template #icon><NIcon><ReloadOutlined /></NIcon></template>
              </NButton>
              <NButton quaternary circle size="tiny" :title="t(activeTab.routine ? 'panel.copyDefinition' : 'panel.copyDdl')" :disabled="!ddl" @click="copyDdl">
                <template #icon><NIcon><CopyOutlined /></NIcon></template>
              </NButton>
            </span>
          </header>
          <div v-if="ddlLoading" class="ddl-loading"><NSpin size="small" /></div>
          <div v-else-if="ddlError" class="ddl-error">{{ t(activeTab.routine ? 'panel.routineDefinitionLoadFailed' : 'panel.ddlLoadFailed', { error: ddlError }) }}</div>
          <pre v-else-if="ddl" class="ddl-code"><code>{{ ddl }}</code></pre>
        </section>
      </template>
      <NButton class="right-panel-audit" block secondary @click="openAudit">
        <template #icon><NIcon><HistoryOutlined /></NIcon></template>
        {{ t('sidebar.auditLog') }}
      </NButton>
    </div>
  </aside>
</template>
