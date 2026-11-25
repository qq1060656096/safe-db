import { watch } from 'vue'
import type { AppTab, TabType } from './app'
import type { useAppStore } from './app'

/** 退出时打开的标签（含未保存的 SQL 草稿），下次启动时恢复。只保存在本机。 */
const STORAGE_KEY = 'safe-db.workspace.tabs.v1'
const TAB_TYPES = new Set<TabType>(['query', 'table', 'structure', 'objects', 'audit'])
const MAX_TABS = 200

interface PersistedTabSession {
  version: 1
  tabs: AppTab[]
  activeTabId: string | null
}

type AppStore = ReturnType<typeof useAppStore>

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseTab(value: unknown): AppTab | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.id !== 'string' || !value.id || typeof value.title !== 'string') return undefined
  if (!TAB_TYPES.has(value.type as TabType)) return undefined
  // dirty 由编辑器挂载时重新计算，不信任存档中的值。
  const { dirty: _dirty, ...tab } = value as unknown as AppTab
  return tab
}

function loadSession(): PersistedTabSession | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.tabs)) return undefined
    const seen = new Set<string>()
    const tabs: AppTab[] = []
    for (const item of parsed.tabs.slice(0, MAX_TABS)) {
      const tab = parseTab(item)
      if (!tab || seen.has(tab.id)) continue
      seen.add(tab.id)
      tabs.push(tab)
    }
    return { version: 1, tabs, activeTabId: typeof parsed.activeTabId === 'string' ? parsed.activeTabId : null }
  } catch {
    return undefined
  }
}

function serialize(store: AppStore): string {
  const session: PersistedTabSession = {
    version: 1,
    tabs: store.tabs.map(({ dirty: _dirty, ...tab }) => tab),
    activeTabId: store.activeTabId
  }
  return JSON.stringify(session)
}

/**
 * 启动时恢复上次的标签，并在标签变化后（节流）写回。连接或已保存查询被删除时，
 * 由 loadConnections / loadSavedQueries 负责清理对应标签。
 */
export function setupTabSession(store: AppStore): { flush: () => void } {
  const session = loadSession()
  if (session?.tabs.length) store.restoreTabs(session.tabs, session.activeTabId)

  let lastSerialized = serialize(store)
  let timer: number | undefined
  const flush = (): void => {
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timer = undefined
    }
    const next = serialize(store)
    if (next === lastSerialized) return
    try {
      localStorage.setItem(STORAGE_KEY, next)
      lastSerialized = next
    } catch {
      // 存储已满或不可用时放弃本次保存，不影响正常使用。
    }
  }
  watch(() => [store.tabs, store.activeTabId], () => {
    if (timer !== undefined) window.clearTimeout(timer)
    timer = window.setTimeout(flush, 500)
  }, { deep: true })
  return { flush }
}
