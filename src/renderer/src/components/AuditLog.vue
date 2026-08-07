<script setup lang="ts">
import { computed, h, reactive, ref, watch } from 'vue'
import { ReloadOutlined, SearchOutlined } from '@vicons/antd'
import { NButton, NCode, NDataTable, NIcon, NInput, NPagination, NSelect, NSpace, NTag, NText, useMessage, type DataTableColumns, type SelectOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ApprovalStatus, AuditEntry, AuditFilter, AuditPage, PermissionMode, SqlKind } from '../../../shared/types'
import { useAppStore } from '../stores/app'
import { useSettingsStore } from '../stores/settings'

const store = useAppStore()
const settings = useSettingsStore()
const { t } = useI18n()
const message = useMessage()
const filter = reactive<Omit<AuditFilter, 'page' | 'pageSize'>>({})
const keyword = ref('')
const data = ref<AuditPage>({ rows: [], total: 0 })
const page = ref(1)
const pageSize = ref(50)
const loading = ref(false)

const connectionOptions = computed<SelectOption[]>(() => store.connections.map((connection) => ({ label: connection.name, value: connection.id })))
const kindOptions = computed<SelectOption[]>(() => ['READ', 'WRITE', 'DDL', 'OTHER'].map((value) => ({ label: value, value })))
const statusOptions = computed<SelectOption[]>(() => [
  { value: 'success', label: t('audit.success') }, { value: 'error', label: t('audit.error') }, { value: 'blocked', label: t('audit.blocked') }
])
const approvalOptions = computed<SelectOption[]>(() => [
  { value: 'approved', label: t('audit.approved') }, { value: 'rejected', label: t('audit.rejected') }, { value: 'not_required', label: t('audit.notRequired') }
])

const kindType: Record<string, 'success' | 'warning' | 'error' | 'default'> = { READ: 'success', WRITE: 'warning', DDL: 'error', OTHER: 'default' }
const connectionTypeLabel = (value: AuditEntry['connectionType']): string => {
  if (value === 'mysql') return 'MySQL'
  if (value === 'postgres') return 'PostgreSQL'
  if (value === 'sqlite') return 'SQLite'
  if (value === 'sqlserver') return 'SQL Server'
  if (value === 'mongodb') return 'MongoDB'
  if (value === 'redis') return 'Redis'
  return t('common.noValue')
}
const modeLabel = (value: PermissionMode): string => t(`permission.${value}`)
const statusLabel = (value: AuditEntry['status']): { text: string; type: 'success' | 'error' | 'default' } => {
  if (value === 'success') return { text: t('audit.success'), type: 'success' }
  if (value === 'error') return { text: t('audit.error'), type: 'error' }
  return { text: t('audit.blocked'), type: 'default' }
}
const approvalLabel = (value: ApprovalStatus): { text: string; type: 'success' | 'error' | 'default' } => {
  if (value === 'approved') return { text: t('audit.approved'), type: 'success' }
  if (value === 'rejected') return { text: t('audit.rejected'), type: 'error' }
  return { text: t('audit.notRequired'), type: 'default' }
}

const columns = computed<DataTableColumns<AuditEntry>>(() => [
  { type: 'expand', renderExpand: (row) => h('div', { class: 'audit-detail' }, [
    h(NCode, { code: row.sqlText, language: 'sql', wordWrap: true }),
    row.error ? h(NText, { type: 'error' }, { default: () => t('audit.errorDetail', { error: row.error }) }) : null
  ]) },
  { title: t('audit.time'), key: 'executedAt', width: 180, render: (row) => new Date(row.executedAt).toLocaleString(settings.locale, { hour12: false }) },
  { title: t('audit.connection'), key: 'connectionName', width: 140, ellipsis: { tooltip: true } },
  { title: t('audit.connectionType'), key: 'connectionType', width: 110, render: (row) => h(NTag, { size: 'small', bordered: false }, { default: () => connectionTypeLabel(row.connectionType) }) },
  { title: t('audit.database'), key: 'databaseName', width: 120, ellipsis: { tooltip: true }, render: (row) => row.databaseName ?? t('common.noValue') },
  { title: t('audit.type'), key: 'sqlKind', width: 80, render: (row) => h(NTag, { type: kindType[row.sqlKind], size: 'small' }, { default: () => row.sqlKind }) },
  { title: t('audit.permissionMode'), key: 'permissionMode', width: 120, render: (row) => modeLabel(row.permissionMode) },
  { title: t('audit.approval'), key: 'approvalStatus', width: 110, render: (row) => { const label = approvalLabel(row.approvalStatus); return h(NTag, { type: label.type, size: 'small' }, { default: () => label.text }) } },
  { title: t('audit.result'), key: 'status', width: 90, render: (row) => { const label = statusLabel(row.status); return h(NTag, { type: label.type, size: 'small', title: row.error ?? '' }, { default: () => label.text }) } },
  { title: t('audit.affectedRows'), key: 'affectedRows', width: 105, align: 'right', render: (row) => row.affectedRows ?? t('common.noValue') },
  { title: t('audit.duration'), key: 'durationMs', width: 90, align: 'right', render: (row) => t('common.duration', { value: row.durationMs }) }
])

async function load(): Promise<void> {
  loading.value = true
  try {
    data.value = await window.api.queryAudit({ ...filter, page: page.value, pageSize: pageSize.value })
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    loading.value = false
  }
}

function updateFilter<K extends keyof Omit<AuditFilter, 'page' | 'pageSize'>>(key: K, value: Omit<AuditFilter, 'page' | 'pageSize'>[K]): void {
  page.value = 1
  filter[key] = value
}

function searchKeyword(): void {
  updateFilter('keyword', keyword.value || undefined)
}

watch([() => filter.connectionId, () => filter.sqlKind, () => filter.status, () => filter.approvalStatus, () => filter.keyword, page, pageSize], load, { immediate: true })
</script>

<template>
  <div class="module-page audit-page">
    <NSpace class="audit-filters" wrap>
      <NSelect clearable :placeholder="t('audit.connection')" :options="connectionOptions" :value="filter.connectionId" @update:value="(value) => updateFilter('connectionId', value as string | undefined)" />
      <NSelect clearable :placeholder="t('audit.statementType')" :options="kindOptions" :value="filter.sqlKind" @update:value="(value) => updateFilter('sqlKind', value as SqlKind | undefined)" />
      <NSelect clearable :placeholder="t('audit.result')" :options="statusOptions" :value="filter.status" @update:value="(value) => updateFilter('status', value as AuditFilter['status'])" />
      <NSelect clearable :placeholder="t('audit.approvalStatus')" :options="approvalOptions" :value="filter.approvalStatus" @update:value="(value) => updateFilter('approvalStatus', value as ApprovalStatus | undefined)" />
      <NInput v-model:value="keyword" clearable :placeholder="t('audit.sqlKeyword')" @keyup.enter="searchKeyword">
        <template #prefix><NIcon><SearchOutlined /></NIcon></template>
      </NInput>
      <NButton :loading="loading" @click="load">
        <template #icon><NIcon><ReloadOutlined /></NIcon></template>{{ t('common.refresh') }}
      </NButton>
    </NSpace>
    <div class="data-table-wrap">
      <NDataTable remote size="small" bordered :loading="loading" :columns="columns" :data="data.rows" :row-key="(row: AuditEntry) => row.id" :pagination="false" :scroll-x="1340" />
    </div>
    <NPagination
      v-model:page="page"
      v-model:page-size="pageSize"
      :item-count="data.total"
      :page-sizes="[20, 50, 100, 200]"
      show-size-picker
      class="module-pagination"
    >
      <template #prefix>{{ t('common.totalItems', { count: data.total }) }}</template>
    </NPagination>
  </div>
</template>
