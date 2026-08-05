<script setup lang="ts">
import { computed } from 'vue'
import {
  dateDeDE,
  dateEnUS,
  dateEsAR,
  dateFrFR,
  dateJaJP,
  dateKoKR,
  datePtBR,
  dateRuRU,
  dateZhCN,
  dateZhTW,
  deDE,
  enUS,
  esAR,
  frFR,
  jaJP,
  koKR,
  NConfigProvider,
  NDialogProvider,
  NMessageProvider,
  ptBR,
  ruRU,
  zhCN,
  zhTW
} from 'naive-ui'
import { RouterView } from 'vue-router'
import type { AppLocale } from './i18n'
import { useSettingsStore } from './stores/settings'

const settings = useSettingsStore()
const naiveLocales = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'en-US': enUS,
  'ja-JP': jaJP,
  'ko-KR': koKR,
  'de-DE': deDE,
  'fr-FR': frFR,
  'es-ES': esAR,
  'pt-BR': ptBR,
  'ru-RU': ruRU
} satisfies Record<AppLocale, typeof enUS>
const naiveDateLocales = {
  'zh-CN': dateZhCN,
  'zh-TW': dateZhTW,
  'en-US': dateEnUS,
  'ja-JP': dateJaJP,
  'ko-KR': dateKoKR,
  'de-DE': dateDeDE,
  'fr-FR': dateFrFR,
  'es-ES': dateEsAR,
  'pt-BR': datePtBR,
  'ru-RU': dateRuRU
} satisfies Record<AppLocale, typeof dateEnUS>
const naiveLocale = computed(() => naiveLocales[settings.locale])
const naiveDateLocale = computed(() => naiveDateLocales[settings.locale])
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
