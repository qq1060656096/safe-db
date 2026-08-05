<script setup lang="ts">
import { computed } from 'vue'
import { NAlert, NButton, NCode, NModal, NSpace, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../stores/app'

const store = useAppStore()
const { t } = useI18n()
const kind = computed(() => {
  if (store.pendingApproval?.sqlKind === 'DDL') return { text: t('approval.ddl'), type: 'error' as const }
  return { text: t('approval.write'), type: 'warning' as const }
})
</script>

<template>
  <NModal
    :show="Boolean(store.pendingApproval)"
    preset="card"
    :title="t('approval.title')"
    class="approval-modal"
    :mask-closable="false"
    :close-on-esc="false"
    @close="store.resolveApproval(false)"
  >
    <template v-if="store.pendingApproval">
      <NAlert type="warning" class="approval-warning">
        {{ t('approval.warning', { name: store.pendingApproval.connectionName }) }}
      </NAlert>
      <NSpace class="approval-tags">
        <NTag :type="kind.type">{{ kind.text }}</NTag>
        <NTag v-if="store.pendingApproval.database">
          {{ t('approval.database', { name: store.pendingApproval.database }) }}
        </NTag>
      </NSpace>
      <NCode :code="store.pendingApproval.sql" language="sql" word-wrap class="approval-code" />
    </template>
    <template #footer>
      <NSpace justify="end">
        <NButton @click="store.resolveApproval(false)">{{ t('common.cancel') }}</NButton>
        <NButton type="error" @click="store.resolveApproval(true)">{{ t('approval.confirm') }}</NButton>
      </NSpace>
    </template>
  </NModal>
</template>
