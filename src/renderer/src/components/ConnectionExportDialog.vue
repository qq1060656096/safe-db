<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NCard, NFormItem, NModal, NSelect, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ConnectionMeta, DatabaseExportMode } from '../../../shared/types'

const props = defineProps<{ connection: ConnectionMeta | null; mode: DatabaseExportMode }>()
const emit = defineEmits<{ close: []; connected: [id: string] }>()
const { t } = useI18n()
const message = useMessage()
const loading = ref(false)
const exporting = ref(false)
const loadError = ref(false)
const databases = ref<string[]>([])
const selectedDatabases = ref<string[]>([])
const selectedMode = ref<DatabaseExportMode>('data')
const modeOptions = computed(() => [
  { label: t('sidebar.exportData'), value: 'data' },
  { label: t('sidebar.exportStructure'), value: 'structure' },
  { label: t('sidebar.exportStructureAndData'), value: 'structure-and-data' }
])
const needsDatabase = computed(() => props.connection?.type !== 'qdrant')
let requestId = 0

watch(() => props.connection, async (connection) => {
  const request = ++requestId
  databases.value = []
  selectedDatabases.value = []
  selectedMode.value = props.mode
  loadError.value = false
  if (!connection) return
  loading.value = true
  try {
    const result = await window.api.connect(connection.id)
    if (!result.ok) throw new Error(result.error)
    emit('connected', connection.id)
    const available = connection.type === 'qdrant' ? [] : await window.api.listDatabases(connection.id)
    if (request !== requestId) return
    databases.value = available
    const defaultDatabase = connection.database && available.includes(connection.database) ? connection.database : available[0]
    selectedDatabases.value = defaultDatabase ? [defaultDatabase] : []
  } catch (error) {
    if (request !== requestId) return
    loadError.value = true
    message.error(t('sidebar.exportDatabaseFailed', { error: error instanceof Error ? error.message : String(error) }))
  } finally {
    if (request === requestId) loading.value = false
  }
})

function close(): void { if (!exporting.value) emit('close') }
async function confirmExport(): Promise<void> {
  const connection = props.connection
  if (!connection || loading.value || loadError.value || exporting.value || (needsDatabase.value && !selectedDatabases.value.length)) return
  exporting.value = true
  try {
    const result = await window.api.exportDatabase({
      connectionId: connection.id, databases: [...selectedDatabases.value], mode: selectedMode.value
    })
    if (result) {
      message.success(t('sidebar.exportDatabaseDone', { objects: result.objects, rows: result.rows, path: result.path }), { duration: 8000 })
      emit('close')
    }
  } catch (error) {
    message.error(t('sidebar.exportDatabaseFailed', { error: error instanceof Error ? error.message : String(error) }))
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <NModal :show="!!connection" :mask-closable="!exporting" :close-on-esc="!exporting" @update:show="(show) => { if (!show) close() }">
    <NCard class="copy-table-modal" :title="t('sidebar.exportDatabaseTitle', { name: connection?.name ?? '' })" :closable="!exporting" @close="close">
      <NFormItem :label="t('sidebar.exportMode')">
        <NSelect v-model:value="selectedMode" :options="modeOptions" :disabled="exporting" />
      </NFormItem>
      <NFormItem v-if="needsDatabase" :label="t('sidebar.exportDatabases')" required>
        <div style="width: 100%">
          <NSelect v-model:value="selectedDatabases" multiple filterable :options="databases.map((value) => ({ label: value, value }))" :loading="loading" :disabled="loading || exporting || loadError" />
          <NButton text size="small" :disabled="loading || exporting || loadError" @click="selectedDatabases = [...databases]">{{ t('sidebar.exportSelectAllDatabases') }}</NButton>
        </div>
      </NFormItem>
      <p>{{ t('sidebar.exportDatabaseHint') }}</p>
      <p v-if="exporting" role="status">{{ t('sidebar.exportDatabaseRunning') }}</p>
      <template #footer>
        <div class="modal-actions">
          <NButton :disabled="exporting" @click="close">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="exporting" :disabled="loading || loadError || (needsDatabase && !selectedDatabases.length)" @click="confirmExport">{{ t('common.export') }}</NButton>
        </div>
      </template>
    </NCard>
  </NModal>
</template>
