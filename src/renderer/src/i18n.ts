import { createI18n } from 'vue-i18n'
import deDE from './locales/de-DE'
import enUS from './locales/en-US'
import esES from './locales/es-ES'
import frFR from './locales/fr-FR'
import jaJP from './locales/ja-JP'
import koKR from './locales/ko-KR'
import ptBR from './locales/pt-BR'
import ruRU from './locales/ru-RU'
import zhCN from './locales/zh-CN'
import zhTW from './locales/zh-TW'

export const supportedLocales = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'de-DE', 'fr-FR', 'es-ES', 'pt-BR', 'ru-RU'] as const
export type AppLocale = typeof supportedLocales[number]

export const localeOptions: ReadonlyArray<{ value: AppLocale; label: string; shortLabel: string }> = [
  { value: 'zh-CN', label: '简体中文', shortLabel: '简' },
  { value: 'zh-TW', label: '繁體中文', shortLabel: '繁' },
  { value: 'en-US', label: 'English', shortLabel: 'EN' },
  { value: 'ja-JP', label: '日本語', shortLabel: '日' },
  { value: 'ko-KR', label: '한국어', shortLabel: '한' },
  { value: 'de-DE', label: 'Deutsch', shortLabel: 'DE' },
  { value: 'fr-FR', label: 'Français', shortLabel: 'FR' },
  { value: 'es-ES', label: 'Español', shortLabel: 'ES' },
  { value: 'pt-BR', label: 'Português', shortLabel: 'PT' },
  { value: 'ru-RU', label: 'Русский', shortLabel: 'RU' }
]

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && (supportedLocales as readonly string[]).includes(value)
}

function localeFromBrowser(): AppLocale {
  const browserLocales = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const browserLocale of browserLocales) {
    const normalized = browserLocale.toLowerCase()
    if (normalized.startsWith('zh-tw') || normalized.startsWith('zh-hk') || normalized.startsWith('zh-mo') || normalized.startsWith('zh-hant')) return 'zh-TW'
    if (normalized.startsWith('zh')) return 'zh-CN'
    const match = localeOptions.find(({ value }) => normalized === value.toLowerCase() || normalized.startsWith(value.slice(0, 2).toLowerCase()))
    if (match) return match.value
  }
  return 'zh-CN'
}

const savedLocale = localStorage.getItem('safe-db.locale')
const locale: AppLocale = isAppLocale(savedLocale) ? savedLocale : localeFromBrowser()

export const i18n = createI18n({
  legacy: false,
  locale,
  fallbackLocale: 'en-US',
  messages: {
    'zh-CN': zhCN,
    'zh-TW': zhTW,
    'en-US': enUS,
    'ja-JP': jaJP,
    'ko-KR': koKR,
    'de-DE': deDE,
    'fr-FR': frFR,
    'es-ES': esES,
    'pt-BR': ptBR,
    'ru-RU': ruRU
  }
})
