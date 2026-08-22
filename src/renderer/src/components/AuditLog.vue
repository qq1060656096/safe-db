<script setup lang="ts">
import { computed, h, reactive, ref, watch } from 'vue'
import { ReloadOutlined, SearchOutlined } from '@vicons/antd'
import {
  NButton, NCard, NCode, NDataTable, NIcon, NInput, NInputNumber, NModal, NPagination, NPopconfirm,
  NSelect, NSpace, NTabPane, NTabs, NTag, NText, useMessage,
  type DataTableColumns, type DataTableRowKey, type SelectOption
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type {
  ApprovalLogAction, ApprovalLogEntry, ApprovalLogFilter, ApprovalLogPage,
  OperationCategory, OperationLogEntry, OperationLogFilter, OperationLogPage,
  OperationLogStatus, ExecutionTraceDetail, ExecutionTraceStatus, ExecutionTraceSummary
} from '../../../shared/types'
import { useAppStore } from '../stores/app'
import { useSettingsStore } from '../stores/settings'

const store = useAppStore()
const settings = useSettingsStore()
const { t, te } = useI18n()
const message = useMessage()
const activeLog = ref<'operation' | 'approval'>('operation')
const pageSize = ref(50)

const operationFilter = reactive<Omit<OperationLogFilter, 'page' | 'pageSize'>>({})
const operationKeyword = ref('')
const operationData = ref<OperationLogPage>({ rows: [], total: 0 })
const operationPage = ref(1)
const operationLoading = ref(false)
const expandedOperationKeys = ref<DataTableRowKey[]>([])
const traceCache = reactive(new Map<string, ExecutionTraceSummary[]>())
const traceLoading = reactive(new Set<string>())
const sensitiveDetail = ref<ExecutionTraceDetail | null>(null)
const sensitiveDetailVisible = ref(false)
const sensitiveDetailLoading = ref(false)
const retentionDays = ref(90)
const auditMaintenanceLoading = ref(false)

const approvalFilter = reactive<Omit<ApprovalLogFilter, 'page' | 'pageSize'>>({})
const approvalKeyword = ref('')
const approvalData = ref<ApprovalLogPage>({ rows: [], total: 0 })
const approvalPage = ref(1)
const approvalLoading = ref(false)

const connectionOptions = computed<SelectOption[]>(() => store.connections.map((connection) => ({ label: connection.name, value: connection.id })))
const categoryOptions = computed<SelectOption[]>(() =>
  (['connection', 'metadata', 'data', 'query', 'configuration', 'export', 'system'] as OperationCategory[])
    .map((value) => ({ value, label: t(`audit.categories.${value}`) }))
)
const operationStatusOptions = computed<SelectOption[]>(() =>
  (['success', 'error', 'blocked', 'canceled'] as OperationLogStatus[])
    .map((value) => ({ value, label: t(`audit.statuses.${value}`) }))
)
const approvalActionOptions = computed<SelectOption[]>(() =>
  (['requested', 'approved', 'rejected', 'expired'] as ApprovalLogAction[])
    .map((value) => ({ value, label: t(`audit.approvalActions.${value}`) }))
)

function localizedAction(action: string): string {
  const key = `audit.actions.${action}`
  return te(key) ? t(key) : action
}

function statusType(status: OperationLogStatus): 'success' | 'error' | 'warning' | 'default' {
  if (status === 'success') return 'success'
  if (status === 'error') return 'error'
  if (status === 'blocked') return 'warning'
  return 'default'
}

function approvalType(action: ApprovalLogAction): 'success' | 'error' | 'warning' | 'default' {
  if (action === 'approved') return 'success'
  if (action === 'rejected' || action === 'expired') return 'error'
  return 'warning'
}

function traceStatusType(status: ExecutionTraceStatus): 'success' | 'error' | 'warning' | 'default' {
  if (status === 'success') return 'success'
  if (status === 'error' || status === 'timeout') return 'error'
  return 'warning'
}

function metricSummary(trace: ExecutionTraceSummary): string {
  const values = [
    trace.returnedRows === null ? '' : t('audit.returnedRows', { count: trace.returnedRows }),
    trace.matchedRows === null ? '' : t('audit.matchedRows', { count: trace.matchedRows }),
    trace.affectedRows === null ? '' : t('audit.traceAffectedRows', { count: trace.affectedRows })
  ].filter(Boolean)
  return values.join(' · ')
}

async function loadExecutionTraces(operationId: string): Promise<void> {
  if (traceCache.has(operationId) || traceLoading.has(operationId)) return
  traceLoading.add(operationId)
  try {
    traceCache.set(operationId, await window.api.listExecutionTraces(operationId))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    traceLoading.delete(operationId)
  }
}

function updateExpandedOperationKeys(keys: DataTableRowKey[]): void {
  expandedOperationKeys.value = keys
  for (const key of keys) {
    const row = operationData.value.rows.find((item) => item.id === key)
    if (row) void loadExecutionTraces(row.eventId)
  }
}

async function revealSensitiveDetail(traceId: string): Promise<void> {
  sensitiveDetailLoading.value = true
  try {
    sensitiveDetail.value = await window.api.revealExecutionTrace(traceId)
    sensitiveDetailVisible.value = true
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    sensitiveDetailLoading.value = false
  }
}

function detailJson(): string {
  return JSON.stringify(sensitiveDetail.value, null, 2)
}

async function copySensitiveDetail(): Promise<void> {
  if (!sensitiveDetail.value) return
  try {
    await navigator.clipboard.writeText(detailJson())
    await window.api.recordSensitiveAuditAction('copy', sensitiveDetail.value.id)
    message.success(t('audit.sensitiveCopied'))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}

async function exportSensitiveDetail(): Promise<void> {
  if (!sensitiveDetail.value) return
  try {
    const path = await window.api.exportData({
      defaultName: `safe-db-execution-${sensitiveDetail.value.id}.json`,
      content: detailJson(),
      fileTypes: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (path) {
      await window.api.recordSensitiveAuditAction('export', sensitiveDetail.value.id)
      message.success(t('audit.sensitiveExported'))
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}

async function verifyAuditIntegrity(): Promise<void> {
  auditMaintenanceLoading.value = true
  try {
    const result = await window.api.verifyAuditIntegrity()
    if (result.valid) message.success(t('audit.integrityValid', { count: result.checked }))
    else message.error(t('audit.integrityInvalid', { id: result.failedTraceId ?? '-' }))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    auditMaintenanceLoading.value = false
  }
}

async function rotateAuditKey(): Promise<void> {
  auditMaintenanceLoading.value = true
  try {
    await window.api.rotateAuditEncryptionKey()
    message.success(t('audit.keyRotated'))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    auditMaintenanceLoading.value = false
  }
}

async function purgeExpiredAuditLogs(): Promise<void> {
  auditMaintenanceLoading.value = true
  try {
    const removed = await window.api.purgeAuditLogs(retentionDays.value)
    traceCache.clear()
    await Promise.all([loadOperations(), loadApprovals()])
    message.success(t('audit.logsPurged', { count: removed }))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    auditMaintenanceLoading.value = false
  }
}

function renderTraceList(row: OperationLogEntry) {
  if (traceLoading.has(row.eventId)) return h(NText, { depth: 3 }, { default: () => t('audit.loadingExecutionTraces') })
  const traces = traceCache.get(row.eventId)
  if (!traces) return h(NText, { depth: 3 }, { default: () => t('audit.expandToLoad') })
  if (!traces.length) return h(NText, { depth: 3 }, { default: () => t('audit.noExecutionTraces') })
  return h('div', { class: 'execution-trace-list' }, traces.map((trace) => h('div', { class: 'execution-trace-row' }, [
    h(NText, { strong: true }, { default: () => `#${trace.sequence} ${trace.commandName}` }),
    h(NTag, { size: 'small', bordered: false, type: traceStatusType(trace.status) }, { default: () => t(`audit.traceStatuses.${trace.status}`) }),
    h(NText, { depth: 3 }, { default: () => `${trace.protocol} · ${trace.durationMs} ms${metricSummary(trace) ? ` · ${metricSummary(trace)}` : ''}` }),
    h(NButton, {
      size: 'tiny', secondary: true, loading: sensitiveDetailLoading.value,
      onClick: () => void revealSensitiveDetail(trace.id)
    }, { default: () => t('audit.revealSensitive') })
  ])))
}

const operationColumns = computed<DataTableColumns<OperationLogEntry>>(() => [
  {
    type: 'expand',
    renderExpand: (row) => h('div', { class: 'audit-detail' }, [
      renderTraceList(row),
      row.details ? h(NCode, { code: JSON.stringify(row.details, null, 2), language: 'json', wordWrap: true }) : null,
      row.approvalId ? h(NText, null, { default: () => `${t('audit.approvalId')}：${row.approvalId}` }) : null,
      row.error ? h(NText, { type: 'error' }, { default: () => t('audit.errorDetail', { error: row.error }) }) : null
    ].filter(Boolean))
  },
  { title: t('audit.time'), key: 'occurredAt', width: 180, render: (row) => new Date(row.occurredAt).toLocaleString(settings.locale, { hour12: false }) },
  { title: t('audit.category'), key: 'category', width: 100, render: (row) => h(NTag, { size: 'small', bordered: false }, { default: () => t(`audit.categories.${row.category}`) }) },
  { title: t('audit.action'), key: 'action', width: 160, ellipsis: { tooltip: true }, render: (row) => localizedAction(row.action) },
  { title: t('audit.connection'), key: 'connectionName', width: 140, ellipsis: { tooltip: true }, render: (row) => row.connectionName ?? t('common.noValue') },
  { title: t('audit.database'), key: 'databaseName', width: 120, ellipsis: { tooltip: true }, render: (row) => row.databaseName ?? t('common.noValue') },
  { title: t('audit.target'), key: 'targetName', width: 140, ellipsis: { tooltip: true }, render: (row) => row.targetName ?? t('common.noValue') },
  { title: t('audit.result'), key: 'status', width: 90, render: (row) => h(NTag, { type: statusType(row.status), size: 'small', title: row.error ?? '' }, { default: () => t(`audit.statuses.${row.status}`) }) },
  { title: t('audit.duration'), key: 'durationMs', width: 90, align: 'right', render: (row) => t('common.duration', { value: row.durationMs }) }
])

const approvalColumns = computed<DataTableColumns<ApprovalLogEntry>>(() => [
  {
    type: 'expand',
    renderExpand: (row) => h('div', { class: 'audit-detail' }, [
      h(NCode, { code: row.sqlText, language: 'sql', wordWrap: true }),
      h(NText, null, { default: () => `${t('audit.approvalId')}：${row.approvalId}` }),
      row.message ? h(NText, null, { default: () => row.message }) : null
    ].filter(Boolean))
  },
  { title: t('audit.time'), key: 'occurredAt', width: 180, render: (row) => new Date(row.occurredAt).toLocaleString(settings.locale, { hour12: false }) },
  { title: t('audit.approvalAction'), key: 'action', width: 110, render: (row) => h(NTag, { type: approvalType(row.action), size: 'small' }, { default: () => t(`audit.approvalActions.${row.action}`) }) },
  { title: t('audit.connection'), key: 'connectionName', width: 150, ellipsis: { tooltip: true } },
  { title: t('audit.database'), key: 'databaseName', width: 130, ellipsis: { tooltip: true }, render: (row) => row.databaseName ?? t('common.noValue') },
  { title: t('audit.statementType'), key: 'sqlKind', width: 100, render: (row) => h(NTag, { size: 'small' }, { default: () => row.sqlKind }) },
  { title: t('audit.approvalId'), key: 'approvalId', ellipsis: { tooltip: true } }
])

async function loadOperations(): Promise<void> {
  operationLoading.value = true
  try {
    operationData.value = await window.api.queryOperationLogs({
      ...operationFilter, page: operationPage.value, pageSize: pageSize.value
    })
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    operationLoading.value = false
  }
}

async function loadApprovals(): Promise<void> {
  approvalLoading.value = true
  try {
    approvalData.value = await window.api.queryApprovalLogs({
      ...approvalFilter, page: approvalPage.value, pageSize: pageSize.value
    })
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    approvalLoading.value = false
  }
}

function updateOperationFilter<K extends keyof Omit<OperationLogFilter, 'page' | 'pageSize'>>(
  key: K, value: Omit<OperationLogFilter, 'page' | 'pageSize'>[K]
): void {
  operationPage.value = 1
  operationFilter[key] = value
}

function updateApprovalFilter<K extends keyof Omit<ApprovalLogFilter, 'page' | 'pageSize'>>(
  key: K, value: Omit<ApprovalLogFilter, 'page' | 'pageSize'>[K]
): void {
  approvalPage.value = 1
  approvalFilter[key] = value
}

function searchOperations(): void { updateOperationFilter('keyword', operationKeyword.value || undefined) }
function searchApprovals(): void { updateApprovalFilter('keyword', approvalKeyword.value || undefined) }

watch([
  () => operationFilter.connectionId, () => operationFilter.category, () => operationFilter.status,
  () => operationFilter.keyword, operationPage, pageSize
], () => { if (activeLog.value === 'operation') void loadOperations() }, { immediate: true })
watch([
  () => approvalFilter.connectionId, () => approvalFilter.action,
  () => approvalFilter.keyword, approvalPage, pageSize
], () => { if (activeLog.value === 'approval') void loadApprovals() })
watch(activeLog, (value) => { void (value === 'operation' ? loadOperations() : loadApprovals()) })
</script>

<template>
  <div class="module-page audit-page">
    <NTabs v-model:value="activeLog" type="line" animated>
      <NTabPane name="operation" :tab="t('audit.operationLogs')">
        <NSpace class="audit-filters" wrap>
          <NSelect clearable :placeholder="t('audit.connection')" :options="connectionOptions" :value="operationFilter.connectionId" @update:value="(value) => updateOperationFilter('connectionId', value as string | undefined)" />
          <NSelect clearable :placeholder="t('audit.category')" :options="categoryOptions" :value="operationFilter.category" @update:value="(value) => updateOperationFilter('category', value as OperationCategory | undefined)" />
          <NSelect clearable :placeholder="t('audit.result')" :options="operationStatusOptions" :value="operationFilter.status" @update:value="(value) => updateOperationFilter('status', value as OperationLogStatus | undefined)" />
          <NInput v-model:value="operationKeyword" clearable :placeholder="t('audit.keyword')" @keyup.enter="searchOperations">
            <template #prefix><NIcon><SearchOutlined /></NIcon></template>
          </NInput>
          <NButton :loading="operationLoading" @click="loadOperations"><template #icon><NIcon><ReloadOutlined /></NIcon></template>{{ t('common.refresh') }}</NButton>
          <NButton secondary :loading="auditMaintenanceLoading" @click="verifyAuditIntegrity">{{ t('audit.verifyIntegrity') }}</NButton>
          <NPopconfirm @positive-click="rotateAuditKey">
            <template #trigger><NButton secondary :loading="auditMaintenanceLoading">{{ t('audit.rotateKey') }}</NButton></template>
            {{ t('audit.rotateKeyConfirm') }}
          </NPopconfirm>
          <NInputNumber v-model:value="retentionDays" :min="1" :max="36500" :precision="0" class="audit-retention-days" />
          <NPopconfirm @positive-click="purgeExpiredAuditLogs">
            <template #trigger><NButton type="error" secondary :loading="auditMaintenanceLoading">{{ t('audit.purgeLogs') }}</NButton></template>
            {{ t('audit.purgeLogsConfirm', { days: retentionDays }) }}
          </NPopconfirm>
        </NSpace>
        <div class="data-table-wrap">
          <NDataTable remote size="small" bordered :loading="operationLoading" :columns="operationColumns" :data="operationData.rows" :row-key="(row: OperationLogEntry) => row.id" :expanded-row-keys="expandedOperationKeys" :pagination="false" :scroll-x="1200" @update:expanded-row-keys="updateExpandedOperationKeys" />
        </div>
        <NPagination v-model:page="operationPage" v-model:page-size="pageSize" :item-count="operationData.total" :page-sizes="[20, 50, 100, 200]" show-size-picker class="module-pagination">
          <template #prefix>{{ t('common.totalItems', { count: operationData.total }) }}</template>
        </NPagination>
      </NTabPane>

      <NTabPane name="approval" :tab="t('audit.approvalLogs')">
        <NSpace class="audit-filters" wrap>
          <NSelect clearable :placeholder="t('audit.connection')" :options="connectionOptions" :value="approvalFilter.connectionId" @update:value="(value) => updateApprovalFilter('connectionId', value as string | undefined)" />
          <NSelect clearable :placeholder="t('audit.approvalAction')" :options="approvalActionOptions" :value="approvalFilter.action" @update:value="(value) => updateApprovalFilter('action', value as ApprovalLogAction | undefined)" />
          <NInput v-model:value="approvalKeyword" clearable :placeholder="t('audit.keyword')" @keyup.enter="searchApprovals">
            <template #prefix><NIcon><SearchOutlined /></NIcon></template>
          </NInput>
          <NButton :loading="approvalLoading" @click="loadApprovals"><template #icon><NIcon><ReloadOutlined /></NIcon></template>{{ t('common.refresh') }}</NButton>
        </NSpace>
        <div class="data-table-wrap">
          <NDataTable remote size="small" bordered :loading="approvalLoading" :columns="approvalColumns" :data="approvalData.rows" :row-key="(row: ApprovalLogEntry) => row.id" :pagination="false" :scroll-x="1000" />
        </div>
        <NPagination v-model:page="approvalPage" v-model:page-size="pageSize" :item-count="approvalData.total" :page-sizes="[20, 50, 100, 200]" show-size-picker class="module-pagination">
          <template #prefix>{{ t('common.totalItems', { count: approvalData.total }) }}</template>
        </NPagination>
      </NTabPane>
    </NTabs>
    <NModal v-model:show="sensitiveDetailVisible">
      <NCard class="sensitive-audit-modal" :title="t('audit.sensitiveDetailTitle')" closable @close="sensitiveDetailVisible = false">
        <NText type="warning">{{ t('audit.sensitiveDetailWarning') }}</NText>
        <NCode v-if="sensitiveDetail" :code="detailJson()" language="json" word-wrap class="sensitive-audit-code" />
        <template #footer>
          <NSpace justify="end">
            <NButton @click="copySensitiveDetail">{{ t('audit.copySensitive') }}</NButton>
            <NButton type="primary" @click="exportSensitiveDetail">{{ t('audit.exportSensitive') }}</NButton>
          </NSpace>
        </template>
      </NCard>
    </NModal>
  </div>
</template>
