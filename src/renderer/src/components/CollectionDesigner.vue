<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue'
import { DeleteOutlined, PlusOutlined, ReloadOutlined } from '@vicons/antd'
import { NAlert, NButton, NCheckbox, NCode, NDataTable, NFormItem, NIcon, NInput, NSelect, NTag, useDialog, useMessage, type DataTableColumns } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { IndexInfo } from '../../../shared/types'
import type { AppTab } from '../stores/app'
import { useAppStore } from '../stores/app'

const props = defineProps<{ tab: AppTab }>()
const store = useAppStore()
const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()
const connection = computed(() => store.connections.find((item) => item.id === props.tab.connectionId))
const capabilities = computed(() => props.tab.connectionId ? store.driverCapabilities[props.tab.connectionId] : undefined)
const indexes = ref<IndexInfo[]>([])
const definition = ref('')
const fieldName = ref('')
const fieldSchema = ref('keyword')
const uniqueIndex = ref(false)
const loading = ref(false)
const saving = ref(false)
const fieldSchemaOptions = ['keyword', 'integer', 'float', 'bool', 'geo', 'text', 'datetime', 'uuid']
  .map((value) => ({ label: value, value }))

async function load(): Promise<void> {
  if (!props.tab.connectionId || !props.tab.table) return
  loading.value = true
  try {
    const [indexResult, ddl] = await Promise.all([
      window.api.listIndexes(props.tab.connectionId, props.tab.database, props.tab.table, props.tab.schema),
      window.api.getObjectDdl(props.tab.connectionId, props.tab.database, props.tab.table, props.tab.schema)
    ])
    indexes.value = indexResult.filter((index) => !index.primary)
    definition.value = ddl
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    loading.value = false
  }
}

async function createIndex(): Promise<void> {
  const name = fieldName.value.trim()
  if (!props.tab.connectionId || !props.tab.table || !name || saving.value) return
  saving.value = true
  try {
    const result = await store.executeOperationWithApproval(props.tab.connectionId, {
      kind: 'index.create',
      target: {
        kind: capabilities.value?.recordTargetKind ?? 'collection', name: props.tab.table,
        database: props.tab.database, schema: props.tab.schema
      },
      name,
      definition: capabilities.value?.recordModel === 'point'
        ? { fieldSchema: fieldSchema.value }
        : { columns: [name], unique: uniqueIndex.value }
    })
    if (result.status === 'ok') {
      message.success(t('qdrant.indexCreated', { name }))
      fieldName.value = ''
      uniqueIndex.value = false
      await load()
    } else if (result.status === 'denied') message.warning(result.error ?? '')
    else if (result.status === 'error') message.error(result.error ?? '')
  } finally {
    saving.value = false
  }
}

function deleteIndex(index: IndexInfo): void {
  const name = capabilities.value?.recordModel === 'point'
    ? index.columns[0]?.replace(/^payload\./, '') ?? index.name.replace(/^payload:/, '')
    : index.name
  if (!props.tab.connectionId || !props.tab.table || !name) return
  dialog.error({
    title: t('qdrant.deleteIndexTitle', { name }),
    content: t('qdrant.deleteIndexHint'),
    positiveText: t('common.delete'), negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      const result = await store.executeOperationWithApproval(props.tab.connectionId!, {
        kind: 'index.drop',
        target: {
          kind: capabilities.value?.recordTargetKind ?? 'collection', name: props.tab.table!,
          database: props.tab.database, schema: props.tab.schema
        },
        name
      })
      if (result.status === 'ok') {
        message.success(t('qdrant.indexDeleted', { name }))
        await load()
      } else if (result.status === 'denied') message.warning(result.error ?? '')
      else if (result.status === 'error') message.error(result.error ?? '')
    }
  })
}

const columns = computed<DataTableColumns<IndexInfo>>(() => [
  { title: t('structure.indexName'), key: 'name', width: 240 },
  { title: t('structure.indexColumns'), key: 'columns', render: (index) => index.columns.join(', ') },
  {
    title: t('objectList.action'), key: 'action', width: 90, align: 'center',
    render: (index) => h(NButton, {
      size: 'small', quaternary: true, type: 'error', disabled: connection.value?.permissionMode === 'readonly',
      title: t('common.delete'), onClick: () => deleteIndex(index)
    }, { icon: () => h(NIcon, null, { default: () => h(DeleteOutlined) }) })
  }
])

onMounted(load)
</script>

<template>
  <div class="module-page structure-page">
    <div class="module-toolbar">
      <NButton size="small" :loading="loading" @click="load"><template #icon><NIcon><ReloadOutlined /></NIcon></template>{{ t('common.refresh') }}</NButton>
      <NTag type="info">{{ tab.table }}</NTag>
      <span class="toolbar-meta"><NTag v-if="connection?.permissionMode === 'readonly'" type="info">{{ t('permission.readonlyMode') }}</NTag><NTag v-if="connection?.permissionMode === 'approval'" type="warning">{{ t('permission.approvalMode') }}</NTag></span>
    </div>
    <NAlert type="info" class="module-alert">{{ capabilities?.recordModel === 'point' ? t('qdrant.designerHelp') : t('qdrant.documentDesignerHelp') }}</NAlert>
    <div class="index-definition-form padded">
      <NFormItem :label="capabilities?.recordModel === 'point' ? t('qdrant.payloadField') : t('structure.indexColumns')" required><NInput v-model:value="fieldName" :disabled="saving || connection?.permissionMode === 'readonly'" :placeholder="t('qdrant.payloadFieldPlaceholder')" /></NFormItem>
      <NFormItem v-if="capabilities?.recordModel === 'point'" :label="t('qdrant.payloadSchema')" required><NSelect v-model:value="fieldSchema" :options="fieldSchemaOptions" :disabled="saving || connection?.permissionMode === 'readonly'" /></NFormItem>
      <NCheckbox v-else v-model:checked="uniqueIndex" :disabled="saving || connection?.permissionMode === 'readonly'">{{ t('structure.unique') }}</NCheckbox>
      <NButton type="primary" :loading="saving" :disabled="!fieldName.trim() || connection?.permissionMode === 'readonly' || !capabilities?.indexes.create.supported" @click="createIndex"><template #icon><NIcon><PlusOutlined /></NIcon></template>{{ t('qdrant.createIndex') }}</NButton>
    </div>
    <div class="data-table-wrap padded"><NDataTable size="small" bordered :loading="loading" :columns="columns" :data="indexes" :row-key="(index: IndexInfo) => index.name" :pagination="false" /></div>
    <div class="padded"><h3>{{ t('qdrant.collectionDefinition') }}</h3><NCode :code="definition" language="json" word-wrap /></div>
  </div>
</template>
