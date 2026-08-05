<script setup lang="ts">
import { computed } from 'vue'
import { dateEnUS, dateZhCN, enUS, NConfigProvider, NDialogProvider, NMessageProvider, zhCN } from 'naive-ui'
import { RouterView } from 'vue-router'
import { useSettingsStore } from './stores/settings'

const settings = useSettingsStore()
const naiveLocale = computed(() => (settings.locale === 'en-US' ? enUS : zhCN))
const naiveDateLocale = computed(() => (settings.locale === 'en-US' ? dateEnUS : dateZhCN))
</script>

<template>
  <NConfigProvider
    class="app-provider"
    :locale="naiveLocale"
    :date-locale="naiveDateLocale"
    :theme-overrides="{ common: { borderRadius: '4px' } }"
  >
    <NDialogProvider>
      <NMessageProvider>
        <RouterView />
      </NMessageProvider>
    </NDialogProvider>
  </NConfigProvider>
</template>
