<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AppstoreOutlined, CaretRightOutlined, ClearOutlined, DatabaseOutlined, SaveOutlined } from '@vicons/antd'
import { NAlert, NButton, NCard, NFormItem, NIcon, NInput, NModal, NSelect, NSpace, NTooltip, useMessage, type SelectOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ConnectionMeta, ExecuteResponse, TableInfo } from '../../../shared/types'
import type { SqlCompletionCatalog, SqlCompletionTable } from '../sqlCompletion'
import type { AppTab } from '../stores/app'
import { useAppStore } from '../stores/app'
import QueryResultView from './QueryResultView.vue'
import SqlEditor from './SqlEditor.vue'

const props = defineProps<{ tab: AppTab }>()
const store = useAppStore()
const { t } = useI18n()
const message = useMessage()
const value = ref(props.tab.sql ?? '')
const executedSql = ref('')
const response = ref<ExecuteResponse | null>(null)
const running = ref(false)
const queryPage = ref<HTMLElement | null>(null)
const connection = computed(() => store.connections.find((item) => item.id === props.tab.connectionId))
const completion = ref<SqlCompletionCatalog>({ tables: [] })
const databaseOptions = ref<SelectOption[]>([])
const databasesLoading = ref(false)
const saveDialogOpen = ref(false)
const savedName = ref('')
const savedConnectionId = ref('')
const savedDatabase = ref<string | null>(null)
const saveDatabaseOptions = ref<SelectOption[]>([])
const saveDatabasesLoading = ref(false)
const saving = ref(false)
const savedQuery = computed(() => store.savedQueries.find((query) => query.id === props.tab.savedQueryId))
const saveConnectionOptions = computed<SelectOption[]>(() => store.connections.map((item) => ({ label: item.name, value: item.id })))
const saveConnection = computed(() => store.connections.find((item) => item.id === savedConnectionId.value))
let saveDatabaseRequestId = 0
const EDITOR_HEIGHT_KEY = 'safe-db.query.editor-height'
const MIN_EDITOR_HEIGHT = 96
const MAX_EDITOR_HEIGHT = 640
const MIN_RESULTS_HEIGHT = 140
const storedEditorHeight = localStorage.getItem(EDITOR_HEIGHT_KEY)
const parsedEditorHeight = storedEditorHeight === null ? Number.NaN : Number(storedEditorHeight)
const editorHeight = ref(Number.isFinite(parsedEditorHeight)
  ? Math.min(MAX_EDITOR_HEIGHT, Math.max(MIN_EDITOR_HEIGHT, parsedEditorHeight))
  : 160)
const editorResizing = ref(false)
let editorResizeStartY = 0
let editorResizeStartHeight = 0

function maximumEditorHeight(): number {
  const page = queryPage.value
  if (!page || page.clientHeight <= 0) return MAX_EDITOR_HEIGHT
  const toolbarHeight = page.querySelector<HTMLElement>('.module-toolbar')?.offsetHeight ?? 42
  return Math.max(MIN_EDITOR_HEIGHT, Math.min(MAX_EDITOR_HEIGHT, page.clientHeight - toolbarHeight - MIN_RESULTS_HEIGHT - 21))
}

function setEditorHeight(height: number): void {
  editorHeight.value = Math.round(Math.min(maximumEditorHeight(), Math.max(MIN_EDITOR_HEIGHT, height)))
}

function resizeEditor(event: PointerEvent): void {
  if (!editorResizing.value) return
  setEditorHeight(editorResizeStartHeight + event.clientY - editorResizeStartY)
}

function stopEditorResize(): void {
  if (!editorResizing.value) return
  editorResizing.value = false
  localStorage.setItem(EDITOR_HEIGHT_KEY, String(editorHeight.value))
  document.body.classList.remove('query-resizing')
  window.removeEventListener('pointermove', resizeEditor)
  window.removeEventListener('pointerup', stopEditorResize)
  window.removeEventListener('pointercancel', stopEditorResize)
}

function startEditorResize(event: PointerEvent): void {
  if (event.button !== 0) return
  event.preventDefault()
  editorResizing.value = true
  editorResizeStartY = event.clientY
  editorResizeStartHeight = editorHeight.value
  document.body.classList.add('query-resizing')
  window.addEventListener('pointermove', resizeEditor)
  window.addEventListener('pointerup', stopEditorResize)
  window.addEventListener('pointercancel', stopEditorResize)
}

function resizeEditorWithKeyboard(event: KeyboardEvent): void {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
  event.preventDefault()
  setEditorHeight(editorHeight.value + (event.key === 'ArrowDown' ? 10 : -10))
  localStorage.setItem(EDITOR_HEIGHT_KEY, String(editorHeight.value))
}

function normalizeEditorHeight(): void {
  if (queryPage.value?.clientHeight) setEditorHeight(editorHeight.value)
}

onMounted(() => {
  window.addEventListener('resize', normalizeEditorHeight)
  requestAnimationFrame(normalizeEditorHeight)
})
onBeforeUnmount(() => {
  stopEditorResize()
  window.removeEventListener('resize', normalizeEditorHeight)
})

interface CompletionData {
  databases: string[]
  tables: SqlCompletionTable[]
}

const completionRequests = new Map<string, Promise<CompletionData>>()
const completionColumnRequests = new Map<string, Promise<SqlCompletionTable['columns']>>()

watch(
  () => connection.value,
  async (current, _previous, onCleanup) => {
    databaseOptions.value = []
    if (!current) return
    let canceled = false
    onCleanup(() => { canceled = true })
    databasesLoading.value = true
    try {
      const databases = await window.api.listDatabases(current.id)
      if (canceled) return
      databaseOptions.value = databases.map((database) => ({ label: database, value: database }))
      const preferred = props.tab.database ?? current.database ?? (current.type === 'sqlite' ? 'main' : undefined)
      if (preferred && databases.includes(preferred) && props.tab.database !== preferred) {
        store.setTabDatabase(props.tab.id, preferred)
      }
    } catch (error) {
      if (!canceled) message.error(t('query.databasesLoadFailed', { error: error instanceof Error ? error.message : String(error) }))
    } finally {
      if (!canceled) databasesLoading.value = false
    }
  },
  { immediate: true }
)

async function mapConcurrent<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++
      results[index] = await task(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

async function fetchCompletionData(connection: ConnectionMeta, database?: string): Promise<CompletionData> {
  const tablesWithDatabase: (TableInfo & { database?: string })[] = []
  let databases = database ? [database] : []

  if (connection.type === 'mysql' && !database) {
    databases = await window.api.listDatabases(connection.id)
    const groups = await mapConcurrent(databases, 3, async (name) => {
      try {
        return (await window.api.listTables(connection.id, name)).map((table) => ({ ...table, database: name }))
      } catch {
        return []
      }
    })
    tablesWithDatabase.push(...groups.flat())
  } else {
    const targetDatabase = database ?? (connection.type === 'sqlite' ? 'main' : undefined)
    const tables = await window.api.listTables(connection.id, targetDatabase)
    tablesWithDatabase.push(...tables.map((table) => ({ ...table, database: targetDatabase })))
    if (targetDatabase && !databases.includes(targetDatabase)) databases.push(targetDatabase)
  }

  const tables = tablesWithDatabase.map((table): SqlCompletionTable => ({
    name: table.name,
    type: table.type,
    database: table.database,
    schema: table.schema,
    comment: table.comment,
    columns: []
  }))
  return { databases, tables }
}

function completionData(connection: ConnectionMeta, database?: string): Promise<CompletionData> {
  const key = `${connection.id}:${database ?? ''}`
  const existing = completionRequests.get(key)
  if (existing) return existing
  const request = fetchCompletionData(connection, database).finally(() => completionRequests.delete(key))
  completionRequests.set(key, request)
  return request
}

function completionColumns(connection: ConnectionMeta, table: SqlCompletionTable): Promise<SqlCompletionTable['columns']> {
  const key = `${connection.id}:${table.database ?? ''}:${table.schema ?? ''}:${table.name}`
  const existing = completionColumnRequests.get(key)
  if (existing) return existing
  const request = window.api.listColumns(connection.id, table.database, table.name, table.schema)
    .then((columns) => columns.map((column) => ({
      name: column.name,
      dataType: column.dataType,
      isPrimaryKey: column.isPrimaryKey,
      comment: column.comment
    })))
    .catch(() => [])
  completionColumnRequests.set(key, request)
  return request
}

watch(
  [() => connection.value, () => props.tab.database, () => props.tab.schema],
  async ([currentConnection, tabDatabase, tabSchema], _previous, onCleanup) => {
    const current = currentConnection as ConnectionMeta | undefined
    const database = (tabDatabase as string | undefined) ?? current?.database ?? (current?.type === 'sqlite' ? 'main' : undefined)
    let canceled = false
    onCleanup(() => { canceled = true })
    completion.value = {
      dbType: current?.type,
      database,
      defaultSchema: (tabSchema as string | undefined) ?? (current?.type === 'postgres' ? 'public' : undefined),
      databases: database ? [database] : [],
      tables: [],
      loadColumns: current ? (table) => completionColumns(current, table) : undefined
    }
    if (!current) return
    try {
      const data = await completionData(current, database)
      if (!canceled) completion.value = { ...completion.value, ...data }
    } catch {
      // 元数据提示加载失败不影响 SQL 编辑和执行，关键字、函数提示仍然可用。
    }
  },
  { immediate: true }
)

async function run(): Promise<void> {
  const sqlText = value.value.trim()
  if (!sqlText || !props.tab.connectionId) return
  executedSql.value = sqlText
  running.value = true
  try {
    const result = await store.executeWithApproval(props.tab.connectionId, sqlText, props.tab.database)
    response.value = result
    if (result.status === 'denied') message.warning(result.error ?? '')
    else if (result.status === 'error') message.error(result.error ?? '')
  } finally {
    running.value = false
  }
}

function clear(): void {
  value.value = ''
  executedSql.value = ''
  response.value = null
}

function selectDatabase(database: string | null): void {
  store.setTabDatabase(props.tab.id, database ?? undefined)
}

async function loadSaveDatabases(connectionId: string, keepSelection = false): Promise<void> {
  const requestId = ++saveDatabaseRequestId
  saveDatabaseOptions.value = []
  if (!connectionId) return
  saveDatabasesLoading.value = true
  try {
    const databases = await window.api.listDatabases(connectionId)
    if (requestId !== saveDatabaseRequestId || savedConnectionId.value !== connectionId) return
    saveDatabaseOptions.value = databases.map((database) => ({ label: database, value: database }))
    if (!keepSelection || (savedDatabase.value && !databases.includes(savedDatabase.value))) savedDatabase.value = null
  } catch (error) {
    if (requestId !== saveDatabaseRequestId) return
    message.error(t('query.databasesLoadFailed', { error: error instanceof Error ? error.message : String(error) }))
    savedDatabase.value = null
  } finally {
    if (requestId === saveDatabaseRequestId) saveDatabasesLoading.value = false
  }
}
function selectSaveConnection(connectionId: string): void {
  savedConnectionId.value = connectionId
  savedDatabase.value = null
  void loadSaveDatabases(connectionId)
}
function openSaveDialog(): void {
  savedName.value = savedQuery.value?.name ?? t('query.untitledQuery')
  savedConnectionId.value = savedQuery.value?.connectionId ?? props.tab.connectionId ?? store.connections[0]?.id ?? ''
  savedDatabase.value = savedQuery.value?.database ?? props.tab.database ?? null
  saveDialogOpen.value = true
  void loadSaveDatabases(savedConnectionId.value, true)
}

async function saveCurrentQuery(): Promise<void> {
  const name = savedName.value.trim()
  if (!name) { message.warning(t('query.queryNameRequired')); return }
  if (!value.value.trim()) { message.warning(t('query.queryContentRequired')); return }
  if (!savedConnectionId.value) { message.warning(t('query.connectionRequired')); return }
  saving.value = true
  try {
    const saved = await store.saveQuery({
      id: props.tab.savedQueryId,
      name,
      connectionId: savedConnectionId.value,
      database: savedDatabase.value ?? undefined,
      sql: value.value
    })
    store.bindSavedQuery(props.tab.id, saved)
    saveDialogOpen.value = false
    message.success(t('query.querySaved', { name: saved.name }))
  } catch (error) {
    message.error(t('query.querySaveFailed', { error: error instanceof Error ? error.message : String(error) }))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div ref="queryPage" class="module-page query-editor-page">
    <div class="module-toolbar">
      <NButton type="primary" size="small" :loading="running" @click="run">
        <template #icon><NIcon><CaretRightOutlined /></NIcon></template>
        {{ t('query.run') }}
      </NButton>
      <NButton size="small" :disabled="!value.trim()" @click="openSaveDialog">
        <template #icon><NIcon><SaveOutlined /></NIcon></template>
        {{ t('query.saveQuery') }}
      </NButton>
      <span class="query-database-label">{{ t('query.database') }}</span>
      <NSelect
        class="query-database-select"
        size="small"
        filterable
        clearable
        :loading="databasesLoading"
        :value="tab.database ?? null"
        :options="databaseOptions"
        :placeholder="t('query.selectDatabase')"
        @update:value="selectDatabase"
      />
      <NTooltip trigger="hover"><template #trigger><span class="keyboard-hint">⌘⏎</span></template>Cmd/Ctrl + Enter</NTooltip>
      <NTooltip trigger="hover"><template #trigger><span class="keyboard-hint">⌃Space</span></template>{{ t('query.completionShortcut') }}</NTooltip>
      <NButton quaternary size="small" :aria-label="t('common.clear')" @click="clear">
        <template #icon><NIcon><ClearOutlined /></NIcon></template>
      </NButton>
      <span class="toolbar-meta">
        {{ connection?.name }}
        <template v-if="response?.durationMs !== undefined"> · {{ t('common.duration', { value: response.durationMs }) }}</template>
      </span>
    </div>
    <div class="editor-wrap" :style="{ height: `${editorHeight}px` }"><SqlEditor v-model="value" :placeholder="t('query.placeholder')" :completion="completion" @run="run" /></div>
    <div
      class="query-editor-resizer"
      :class="{ active: editorResizing }"
      role="separator"
      tabindex="0"
      aria-orientation="horizontal"
      :aria-label="t('query.resizeEditor')"
      :aria-valuenow="editorHeight"
      :aria-valuemin="MIN_EDITOR_HEIGHT"
      :aria-valuemax="MAX_EDITOR_HEIGHT"
      @pointerdown="startEditorResize"
      @keydown="resizeEditorWithKeyboard"
    />
    <div class="query-results">
      <NAlert v-if="response?.status === 'denied'" type="warning" class="response-alert">{{ response.error }}</NAlert>
      <NAlert v-else-if="response?.status === 'error'" type="error" :title="t('query.failed')" class="response-alert">{{ response.error }}</NAlert>
      <template v-else-if="response?.status === 'ok'">
        <template v-if="response.results?.length">
          <QueryResultView
            v-for="(result, index) in response.results"
            :key="index"
            :result="result"
            :index="index"
            :connection-id="tab.connectionId"
            :db-type="connection?.type"
            :database="tab.database"
            :schema="tab.schema"
            :sql="executedSql"
          />
        </template>
        <div v-else class="empty-result">{{ t('query.noResult') }}</div>
      </template>
    </div>
  </div>
  <NModal v-model:show="saveDialogOpen">
    <NCard class="query-save-modal" :title="t('query.saveQueryTitle')" closable @close="saveDialogOpen = false">
      <NFormItem :label="t('query.queryName')" required>
        <NInput v-model:value="savedName" maxlength="120" :placeholder="t('query.queryNamePlaceholder')" @keyup.enter="saveCurrentQuery" />
      </NFormItem>
      <NFormItem :label="t('query.saveLocation')" required>
        <div class="query-save-location">
          <div class="query-save-selector">
            <span class="query-save-selector-label">{{ t('query.selectConnection') }}</span>
            <NSelect filterable :value="savedConnectionId || null" :options="saveConnectionOptions" :placeholder="t('query.selectConnection')" @update:value="(id) => selectSaveConnection(String(id))" />
          </div>
          <div class="query-save-selector">
            <span class="query-save-selector-label">{{ t('query.selectDatabaseForSave') }}</span>
            <NSelect v-model:value="savedDatabase" filterable clearable :loading="saveDatabasesLoading" :disabled="!savedConnectionId" :options="saveDatabaseOptions" :placeholder="t('query.saveDatabasePlaceholder')" />
          </div>
          <div v-if="saveConnection" class="query-save-target-preview">
            <NIcon><DatabaseOutlined /></NIcon><strong>{{ saveConnection.name }}</strong>
            <template v-if="savedDatabase"><span>/</span><NIcon><AppstoreOutlined /></NIcon><strong>{{ savedDatabase }}</strong></template>
            <span>/</span><span>{{ t(savedDatabase ? 'query.databaseQueries' : 'query.connectionQueries') }}</span>
          </div>
        </div>
      </NFormItem>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="saveDialogOpen = false">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="saving" @click="saveCurrentQuery">{{ t('common.save') }}</NButton>
        </NSpace>
      </template>
    </NCard>
  </NModal>
</template>
