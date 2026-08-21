<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AppstoreOutlined, CaretRightOutlined, ClearOutlined, CopyOutlined, DatabaseOutlined, FormatPainterOutlined, PlusOutlined, SaveOutlined, StopOutlined } from '@vicons/antd'
import { NAlert, NButton, NCard, NFormItem, NIcon, NInput, NModal, NSelect, NSpace, NTabPane, NTabs, NTooltip, useDialog, useMessage, type SelectOption } from 'naive-ui'
import { format as formatSql, type SqlLanguage } from 'sql-formatter'
import { useI18n } from 'vue-i18n'
import type { ConnectionMeta, DbType, ExecuteResponse, SavedQueryInput } from '../../../shared/types'
import {
  connectionMetadataRevision,
  loadColumnMetadata,
  loadDatabaseMetadata,
  loadTableMetadata
} from '../metadataCache'
import type { SqlCompletionCatalog, SqlCompletionTable } from '../sqlCompletion'
import type { AppTab } from '../stores/app'
import { useAppStore } from '../stores/app'
import QueryResultView from './QueryResultView.vue'
import SqlEditor from './SqlEditor.vue'

interface SqlEditorHandle {
  getSelectedText(): string
  focusLine(line: number): void
  replaceText(text: string, selectedOnly: boolean): void
}
interface EditorStatus { line: number; column: number; selectionLength: number }

const props = defineProps<{ tab: AppTab }>()
const store = useAppStore()
const { t } = useI18n()
const dialog = useDialog()
const message = useMessage()
const value = ref(props.tab.sql ?? '')
const sqlEditor = ref<SqlEditorHandle | null>(null)
const executedSql = ref('')
const response = ref<ExecuteResponse | null>(null)
const lastSuccessfulResponse = ref<ExecuteResponse | null>(null)
const lastSuccessfulSql = ref('')
const editorStatus = ref<EditorStatus>({ line: 1, column: 1, selectionLength: 0 })
const activeResultIndex = ref(0)
const running = ref(false)
const stopping = ref(false)
const stopStatus = ref<'stopping' | 'stopped' | null>(null)
const queryPage = ref<HTMLElement | null>(null)
const connection = computed(() => store.connections.find((item) => item.id === props.tab.connectionId))
const isQdrant = computed(() => connection.value?.type === 'qdrant')
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
let closeSaveResolver: ((saved: boolean) => void) | null = null
const savedQuery = computed(() => store.savedQueries.find((query) => query.id === props.tab.savedQueryId))
const isDefinitionEditor = computed(() => Boolean(props.tab.definitionEditor))
const isReadonlyDefinition = computed(() => isDefinitionEditor.value && Boolean(props.tab.definitionReadOnly))
const savedSqlBaseline = ref(props.tab.savedQueryId ? props.tab.sql ?? '' : '')
const definitionSqlBaseline = ref(props.tab.definitionEditor ? props.tab.sql ?? '' : '')
const isDirty = computed(() => value.value !== (isDefinitionEditor.value
  ? definitionSqlBaseline.value
  : props.tab.savedQueryId ? savedSqlBaseline.value : ''))
const canSave = computed(() => isDirty.value && Boolean(value.value.trim()) && !saving.value)
const canApplyDefinition = computed(() => !isReadonlyDefinition.value && canSave.value && connection.value?.permissionMode !== 'readonly' && !running.value && !stopping.value)
const displayedResponse = computed(() => response.value?.status === 'ok' ? response.value : lastSuccessfulResponse.value)
const displayedSql = computed(() => response.value?.status === 'ok' ? executedSql.value : lastSuccessfulSql.value)
const resultRowCount = computed(() => displayedResponse.value?.results?.reduce((count, result) => count + (result.rows?.length ?? 0), 0) ?? 0)
const hasRowResult = computed(() => displayedResponse.value?.results?.some((result) => result.kind === 'rows') ?? false)
const errorLine = computed(() => {
  const error = response.value?.status === 'error' ? response.value.error ?? '' : ''
  const match = /(?:at|on)\s+line\s+(\d+)/i.exec(error) ?? /第\s*(\d+)\s*行/.exec(error)
  return match ? Number(match[1]) : null
})
const errorSuggestion = computed(() => {
  const error = response.value?.status === 'error' ? response.value.error ?? '' : ''
  const variable = /Unknown system variable ['"]?([A-Za-z_][\w$]*)/i.exec(error)?.[1]
  return variable ? t('query.mysqlVariableSuggestion', { name: variable }) : ''
})
const saveConnectionOptions = computed<SelectOption[]>(() => store.connections.map((item) => ({ label: item.name, value: item.id })))
const saveConnection = computed(() => store.connections.find((item) => item.id === savedConnectionId.value))
const editorPlaceholder = computed(() => connection.value?.type === 'mongodb'
  ? t('query.mongodbPlaceholder')
  : connection.value?.type === 'redis' ? t('query.redisPlaceholder')
    : connection.value?.type === 'qdrant' ? t('query.qdrantPlaceholder') : t('query.placeholder'))
const canFormat = computed(() => Boolean(value.value.trim()) && !['mongodb', 'redis', 'qdrant'].includes(connection.value?.type ?? ''))
let saveDatabaseRequestId = 0
let databaseOptionsRequestId = 0
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
let runGeneration = 0

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

function handleSaveShortcut(event: KeyboardEvent): void {
  if (event.key.toLowerCase() !== 's' || (!event.metaKey && !event.ctrlKey) || event.altKey || store.activeTabId !== props.tab.id) return
  event.preventDefault()
  if (isReadonlyDefinition.value) return
  if (isDefinitionEditor.value) void applyDefinition()
  else if (saveDialogOpen.value) void saveCurrentQuery()
  else void requestSave()
}

onMounted(() => {
  window.addEventListener('resize', normalizeEditorHeight)
  window.addEventListener('keydown', handleSaveShortcut)
  requestAnimationFrame(normalizeEditorHeight)
})
onBeforeUnmount(() => {
  closeSaveResolver?.(false)
  closeSaveResolver = null
  stopEditorResize()
  window.removeEventListener('resize', normalizeEditorHeight)
  window.removeEventListener('keydown', handleSaveShortcut)
})

watch(isDirty, (dirty) => store.setTabDirty(props.tab.id, dirty), { immediate: true, flush: 'sync' })

async function refreshDatabaseOptions(clear = false): Promise<void> {
  const requestId = ++databaseOptionsRequestId
  const current = connection.value
  if (clear) databaseOptions.value = []
  if (!current) { databasesLoading.value = false; return }
  if (current.type === 'qdrant') {
    store.setTabDatabase(props.tab.id, undefined)
    databasesLoading.value = false
    return
  }
  databasesLoading.value = true
  try {
    const databases = await loadDatabaseMetadata(current.id)
    if (requestId !== databaseOptionsRequestId || connection.value?.id !== current.id) return
    databaseOptions.value = databases.map((database) => ({ label: database, value: database }))
    completion.value = { ...completion.value, databases }
    const preferred = props.tab.database ?? current.database ?? (current.type === 'sqlite' ? 'main' : current.type === 'redis' ? '0' : undefined)
    if (preferred && databases.includes(preferred) && props.tab.database !== preferred) {
      store.setTabDatabase(props.tab.id, preferred)
    }
  } catch (error) {
    if (requestId === databaseOptionsRequestId) message.error(t('query.databasesLoadFailed', { error: error instanceof Error ? error.message : String(error) }))
  } finally {
    if (requestId === databaseOptionsRequestId) databasesLoading.value = false
  }
}

function onDatabaseSelectShow(show: boolean): void {
  // 展开时重新经过 TTL 校验；有效缓存立即复用，过期缓存才访问数据库。
  if (show) void refreshDatabaseOptions()
}

watch(
  [() => connection.value, () => connectionMetadataRevision(connection.value?.id)],
  () => { void refreshDatabaseOptions(true) },
  { immediate: true }
)

function completionColumns(connection: ConnectionMeta, table: SqlCompletionTable): Promise<SqlCompletionTable['columns']> {
  return loadColumnMetadata(connection.id, table.database, table.name, table.schema)
    .then((columns) => columns.map((column) => ({
      name: column.name,
      dataType: column.dataType,
      isPrimaryKey: column.isPrimaryKey,
      comment: column.comment
    })))
    .catch(() => [])
}

watch(
  [() => connection.value, () => props.tab.database, () => props.tab.schema, () => connectionMetadataRevision(connection.value?.id)],
  async ([currentConnection, tabDatabase, tabSchema], _previous, onCleanup) => {
    const current = currentConnection as ConnectionMeta | undefined
    const database = (tabDatabase as string | undefined) ?? current?.database ?? (current?.type === 'sqlite' ? 'main' : current?.type === 'redis' ? '0' : undefined)
    let canceled = false
    onCleanup(() => { canceled = true })
    completion.value = {
      dbType: current?.type,
      database,
      defaultSchema: (tabSchema as string | undefined) ?? (current?.type === 'postgres' ? 'public' : current?.type === 'sqlserver' ? 'dbo' : undefined),
      databases: database ? [database] : [],
      tables: [],
      loadColumns: current ? (table) => completionColumns(current, table) : undefined
    }
    // 连接级查询只加载数据库名；选定数据库后才加载该库的表，避免遍历全部库。
    if (!current || current.type === 'mongodb' || current.type === 'qdrant' || !database) return
    try {
      // 数据库下拉框复用同一请求并先完成；提示元数据不会抢在它前面占用连接。
      await loadDatabaseMetadata(current.id).catch(() => [])
      if (canceled) return
      const tables = await loadTableMetadata(current.id, database)
      if (!canceled) completion.value = {
        ...completion.value,
        tables: tables.map((table): SqlCompletionTable => ({
          name: table.name,
          type: table.type,
          database,
          schema: table.schema,
          comment: table.comment,
          columns: []
        }))
      }
    } catch {
      // 元数据提示加载失败不影响 SQL 编辑和执行，关键字、函数提示仍然可用。
    }
  },
  { immediate: true }
)

async function run(selectedSql?: string): Promise<boolean> {
  if (running.value || stopping.value) return false
  const selection = typeof selectedSql === 'string' ? selectedSql : sqlEditor.value?.getSelectedText() ?? ''
  const sqlText = (selection.trim() || value.value.trim())
  if (!sqlText || !props.tab.connectionId) return false
  executedSql.value = sqlText
  const generation = ++runGeneration
  running.value = true
  stopStatus.value = null
  try {
    const result = await store.executeWithApproval(props.tab.connectionId, sqlText, props.tab.database)
    if (generation !== runGeneration) return false
    response.value = result
    if (result.status === 'ok') {
      activeResultIndex.value = 0
      lastSuccessfulResponse.value = result
      lastSuccessfulSql.value = sqlText
    }
    if (result.status === 'denied') message.warning(result.error ?? '')
    else if (result.status === 'error') message.error(result.error ?? '')
    return result.status === 'ok'
  } finally {
    if (generation === runGeneration) running.value = false
  }
}

async function applyDefinition(confirmed = false): Promise<boolean> {
  if (!isDefinitionEditor.value || isReadonlyDefinition.value) return false
  if (!value.value.trim()) {
    message.warning(t('query.queryContentRequired'))
    return false
  }
  if (!canApplyDefinition.value) {
    if (connection.value?.permissionMode === 'readonly') message.warning(t('objectList.definitionReadonly'))
    return false
  }
  if (props.tab.definitionReplaceMode === 'drop-create' && !confirmed) {
    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (result: boolean): void => {
        if (settled) return
        settled = true
        resolve(result)
      }
      dialog.warning({
        title: t('objectList.replaceDefinitionTitle'),
        content: t('objectList.replaceDefinitionWarning', { name: props.tab.table ?? props.tab.routine ?? props.tab.title }),
        positiveText: t('objectList.continueApplyDefinition'),
        negativeText: t('common.cancel'),
        onPositiveClick: async () => finish(await applyDefinition(true)),
        onNegativeClick: () => finish(false),
        onClose: () => finish(false)
      })
    })
  }
  const applied = await run(value.value)
  if (!applied) return false
  definitionSqlBaseline.value = value.value
  message.success(t('objectList.definitionApplied', { name: props.tab.table ?? props.tab.routine ?? props.tab.title }))
  return true
}

function runFromEditor(selectedSql: string): void {
  if (isReadonlyDefinition.value) return
  if (isDefinitionEditor.value) void applyDefinition()
  else void run(selectedSql)
}

async function stop(): Promise<void> {
  const connectionId = props.tab.connectionId
  if (!connectionId || !running.value || stopping.value) return
  runGeneration++
  stopping.value = true
  stopStatus.value = 'stopping'
  response.value = null
  try {
    const approvalCanceled = await store.cancelPendingQueryApproval(connectionId)
    if (!approvalCanceled) await window.api.cancelSql(connectionId)
    stopStatus.value = 'stopped'
    message.info(t('query.stopped'))
  } catch (error) {
    stopStatus.value = null
    message.error(t('query.stopFailed', { error: error instanceof Error ? error.message : String(error) }))
  } finally {
    running.value = false
    stopping.value = false
  }
}

function clear(): void {
  value.value = ''
  executedSql.value = ''
  response.value = null
  lastSuccessfulResponse.value = null
  lastSuccessfulSql.value = ''
  activeResultIndex.value = 0
  stopStatus.value = null
}

function createQueryFromCurrent(): void {
  if (!props.tab.connectionId) return
  const location = props.tab.database ?? connection.value?.name ?? ''
  store.openTab({
    type: 'query',
    title: t('sidebar.queryTitle', { name: location }),
    connectionId: props.tab.connectionId,
    database: props.tab.database
  })
}

function selectDatabase(database: string | null): void {
  store.setTabDatabase(props.tab.id, database ?? undefined)
}

async function loadSaveDatabases(connectionId: string, keepSelection = false): Promise<void> {
  const requestId = ++saveDatabaseRequestId
  saveDatabaseOptions.value = []
  if (!connectionId) return
  if (store.connections.find((item) => item.id === connectionId)?.type === 'qdrant') {
    savedDatabase.value = null
    saveDatabasesLoading.value = false
    return
  }
  saveDatabasesLoading.value = true
  try {
    const databases = await loadDatabaseMetadata(connectionId)
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

async function persistCurrentQuery(input: SavedQueryInput): Promise<boolean> {
  if (saving.value) return false
  saving.value = true
  try {
    const saved = await store.saveQuery(input)
    savedSqlBaseline.value = saved.sql
    store.bindSavedQuery(props.tab.id, saved)
    saveDialogOpen.value = false
    message.success(t('query.querySaved', { name: saved.name }))
    closeSaveResolver?.(true)
    closeSaveResolver = null
    return true
  } catch (error) {
    message.error(t('query.querySaveFailed', { error: error instanceof Error ? error.message : String(error) }))
    return false
  } finally {
    saving.value = false
  }
}

async function saveCurrentQuery(): Promise<void> {
  const name = savedName.value.trim()
  if (!name) { message.warning(t('query.queryNameRequired')); return }
  if (!value.value.trim()) { message.warning(t('query.queryContentRequired')); return }
  if (!savedConnectionId.value) { message.warning(t('query.connectionRequired')); return }
  await persistCurrentQuery({
    id: props.tab.savedQueryId,
    name,
    connectionId: savedConnectionId.value,
    database: savedDatabase.value ?? undefined,
    sql: value.value
  })
}

async function requestSave(): Promise<void> {
  if (!canSave.value) return
  const existing = savedQuery.value
  if (!existing) {
    openSaveDialog()
    return
  }
  await persistCurrentQuery({
    id: existing.id,
    name: existing.name,
    connectionId: existing.connectionId,
    database: existing.database,
    sql: value.value
  })
}

function closeSaveDialog(): void {
  if (saving.value) return
  saveDialogOpen.value = false
  closeSaveResolver?.(false)
  closeSaveResolver = null
}

async function saveForClose(): Promise<boolean> {
  if (!isDirty.value) return true
  if (isReadonlyDefinition.value) return true
  if (isDefinitionEditor.value) return applyDefinition()
  if (!value.value.trim()) {
    message.warning(t('query.queryContentRequired'))
    return false
  }
  const existing = savedQuery.value
  if (existing) {
    return persistCurrentQuery({
      id: existing.id,
      name: existing.name,
      connectionId: existing.connectionId,
      database: existing.database,
      sql: value.value
    })
  }
  if (closeSaveResolver) return false
  openSaveDialog()
  return new Promise<boolean>((resolve) => { closeSaveResolver = resolve })
}

async function copyError(): Promise<void> {
  if (response.value?.status !== 'error' || !response.value.error) return
  await navigator.clipboard.writeText(response.value.error)
  message.success(t('common.copied'))
}

function locateError(): void {
  if (errorLine.value) sqlEditor.value?.focusLine(errorLine.value)
}

function sqlFormatterLanguage(type?: DbType): SqlLanguage {
  if (type === 'mysql') return 'mysql'
  if (type === 'postgres') return 'postgresql'
  if (type === 'sqlite') return 'sqlite'
  if (type === 'sqlserver') return 'transactsql'
  return 'sql'
}

function formatQuery(): void {
  if (!canFormat.value) return
  const selectedText = sqlEditor.value?.getSelectedText() ?? ''
  const selectedOnly = Boolean(selectedText.trim())
  const source = selectedOnly ? selectedText : value.value
  try {
    const formatted = formatSql(source, {
      language: sqlFormatterLanguage(connection.value?.type),
      tabWidth: 2,
      keywordCase: 'upper'
    })
    if (sqlEditor.value) sqlEditor.value.replaceText(formatted, selectedOnly)
    else value.value = formatted
    message.success(t('query.formatted'))
  } catch (error) {
    message.error(t('query.formatFailed', { error: error instanceof Error ? error.message : String(error) }))
  }
}

defineExpose({ saveForClose })
</script>

<template>
  <div ref="queryPage" class="module-page query-editor-page">
    <div class="module-toolbar query-toolbar">
      <NButton v-if="!isReadonlyDefinition" type="primary" size="small" :loading="running" :disabled="isDefinitionEditor ? !canApplyDefinition : stopping" :title="t(isDefinitionEditor ? 'objectList.applyDefinitionHelp' : 'query.runSelectionHelp')" @click="isDefinitionEditor ? applyDefinition() : run()">
        <template #icon><NIcon><component :is="isDefinitionEditor ? SaveOutlined : CaretRightOutlined" /></NIcon></template>
        {{ t(isDefinitionEditor ? 'objectList.applyDefinition' : 'query.run') }}
      </NButton>
      <NButton v-if="!isReadonlyDefinition" type="error" secondary size="small" :disabled="!running || stopping" :loading="stopping" @click="stop">
        <template #icon><NIcon><StopOutlined /></NIcon></template>
        {{ t('query.stop') }}
      </NButton>
      <NButton v-if="!isDefinitionEditor" size="small" :loading="saving" :disabled="!canSave" :title="`${t('query.saveQuery')} (Cmd/Ctrl+S)`" @click="requestSave">
        <template #icon><NIcon><SaveOutlined /></NIcon></template>
        {{ t('query.saveQuery') }}
      </NButton>
      <NButton size="small" :disabled="!canFormat" :title="t('query.formatHelp')" @click="formatQuery">
        <template #icon><NIcon><FormatPainterOutlined /></NIcon></template>
        {{ t('query.format') }}
      </NButton>
      <span class="query-toolbar-divider" />
      <span v-if="!isQdrant" class="query-database-label">{{ t('query.database') }}</span>
      <NSelect
        v-if="!isQdrant"
        class="query-database-select"
        size="small"
        filterable
        clearable
        :disabled="isDefinitionEditor"
        :loading="databasesLoading"
        :value="tab.database ?? null"
        :options="databaseOptions"
        :placeholder="t('query.selectDatabase')"
        @update:value="selectDatabase"
        @update:show="onDatabaseSelectShow"
      />
      <NTooltip v-if="!isReadonlyDefinition" trigger="hover"><template #trigger><span class="keyboard-hint">⌘⏎</span></template>Cmd/Ctrl + Enter</NTooltip>
      <NTooltip trigger="hover"><template #trigger><span class="keyboard-hint">⌃Space</span></template>{{ t('query.completionShortcut') }}</NTooltip>
      <NButton v-if="!isReadonlyDefinition" quaternary size="small" :aria-label="t('common.clear')" @click="clear">
        <template #icon><NIcon><ClearOutlined /></NIcon></template>
      </NButton>
      <span class="query-toolbar-spacer" />
      <NButton size="small" :disabled="!tab.connectionId" @click="createQueryFromCurrent">
        <template #icon><NIcon><PlusOutlined /></NIcon></template>
        {{ t('sidebar.newQuery') }}
      </NButton>
    </div>
    <div class="editor-wrap" :style="{ height: `${editorHeight}px` }"><SqlEditor ref="sqlEditor" v-model="value" :placeholder="editorPlaceholder" :completion="completion" :read-only="isReadonlyDefinition" @run="runFromEditor" @status="editorStatus = $event" /></div>
    <div class="query-status-bar">
      <span class="query-status-location"><i class="query-status-dot" :style="{ background: connection?.color || '#18a058' }" />{{ connection?.name ?? '-' }}<template v-if="tab.database"> / {{ tab.database }}</template></span>
      <span>{{ t('query.cursorPosition', { line: editorStatus.line, column: editorStatus.column }) }}</span>
      <span v-if="editorStatus.selectionLength">{{ t('query.selectedCharacters', { count: editorStatus.selectionLength }) }}</span>
      <span v-if="isReadonlyDefinition">{{ t('objectList.definitionViewMode') }}</span>
      <span v-else-if="connection">{{ t(`permission.${connection.permissionMode}`) }}</span>
      <span v-if="displayedResponse?.durationMs !== undefined">{{ t('common.duration', { value: displayedResponse.durationMs }) }}</span>
      <span v-if="hasRowResult">{{ t('query.rowsCount', { count: resultRowCount }) }}</span>
      <span class="query-status-spacer" />
      <span :class="isDirty ? 'query-state-dirty' : 'query-state-saved'">{{ t(isDirty ? 'query.modified' : 'query.unmodified') }}</span>
    </div>
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
      <NAlert v-if="stopStatus" type="info" class="response-alert">{{ t(stopStatus === 'stopping' ? 'query.stopping' : 'query.stopped') }}</NAlert>
      <NAlert v-else-if="response?.status === 'denied'" type="warning" class="response-alert">{{ response.error }}</NAlert>
      <NAlert v-else-if="response?.status === 'error'" type="error" :title="t('query.failed')" class="response-alert">
        <div>{{ response.error }}</div>
        <div v-if="errorSuggestion" class="query-error-suggestion">{{ errorSuggestion }}</div>
        <NSpace class="query-error-actions" size="small">
          <NButton v-if="errorLine" text size="tiny" @click="locateError">{{ t('query.locateError') }}</NButton>
          <NButton text size="tiny" @click="copyError"><template #icon><NIcon><CopyOutlined /></NIcon></template>{{ t('query.copyError') }}</NButton>
        </NSpace>
      </NAlert>
      <div v-if="response?.status === 'error' && displayedResponse" class="query-last-result-hint">{{ t('query.showingLastSuccessfulResult') }}</div>
      <template v-if="displayedResponse?.status === 'ok'">
        <NTabs v-if="displayedResponse.results?.length" v-model:value="activeResultIndex" type="line" size="small" class="query-result-tabs">
          <NTabPane v-for="(result, index) in displayedResponse.results" :key="index" :name="index" display-directive="show:lazy">
            <template #tab>{{ result.kind === 'rows' ? t('query.resultTabRows', { index: index + 1, count: result.rows?.length ?? 0 }) : t('query.resultTab', { index: index + 1 }) }}</template>
            <QueryResultView
              :result="result"
              :index="index"
              :connection-id="tab.connectionId"
              :saved-query-id="tab.savedQueryId"
              :db-type="connection?.type"
              :database="tab.database"
              :schema="tab.schema"
              :sql="displayedSql"
            />
          </NTabPane>
        </NTabs>
        <div v-else class="empty-result">{{ t('query.noResult') }}</div>
      </template>
    </div>
  </div>
  <NModal :show="saveDialogOpen" @update:show="(show) => { if (!show) closeSaveDialog() }">
    <NCard class="query-save-modal" :title="t('query.saveQueryTitle')" closable @close="closeSaveDialog">
      <NFormItem :label="t('query.queryName')" required>
        <NInput v-model:value="savedName" maxlength="120" :placeholder="t('query.queryNamePlaceholder')" @keyup.enter="saveCurrentQuery" />
      </NFormItem>
      <NFormItem :label="t('query.saveLocation')" required>
        <div class="query-save-location">
          <div v-if="saveConnection?.type !== 'qdrant'" class="query-save-selector">
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
          <NButton @click="closeSaveDialog">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="saving" @click="saveCurrentQuery">{{ t('common.save') }}</NButton>
        </NSpace>
      </template>
    </NCard>
  </NModal>
</template>
