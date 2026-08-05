import { defineStore } from 'pinia'
import { i18n, type AppLocale } from '../i18n'

export const useSettingsStore = defineStore('settings', {
  state: () => ({ locale: i18n.global.locale.value as AppLocale }),
  actions: {
    setLocale(locale: AppLocale): void {
      this.locale = locale
      i18n.global.locale.value = locale
      localStorage.setItem('safe-db.locale', locale)
      document.documentElement.lang = locale
    }
  }
})
