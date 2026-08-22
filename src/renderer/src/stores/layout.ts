import { defineStore } from 'pinia'
import type { WindowMode } from '../../../shared/types'

export interface WorkspaceLayout {
  leftWidth: number
  rightWidth: number
  leftCollapsed: boolean
  rightCollapsed: boolean
}

interface ColumnLayout {
  widths: Record<string, number>
  order: string[]
  updatedAt: number
}

interface PersistedLayoutPreferences {
  version: 1
  workspace: Partial<Record<WindowMode, WorkspaceLayout>>
  columnLayouts: Record<string, ColumnLayout>
}

const STORAGE_KEY = 'safe-db.layout.preferences.v1'
const LEGACY_LEFT_WIDTH_KEY = 'safe-db.layout.left-width'
const LEGACY_RIGHT_WIDTH_KEY = 'safe-db.layout.right-width'
const LEGACY_LEFT_COLLAPSED_KEY = 'safe-db.layout.left-collapsed'
const LEGACY_RIGHT_COLLAPSED_KEY = 'safe-db.layout.right-collapsed'
const MAX_COLUMN_LAYOUTS = 300
export const DEFAULT_COLUMN_WIDTH = 160
export const MIN_COLUMN_WIDTH = 80
export const MAX_COLUMN_WIDTH = 1200

let persistTimer: number | undefined
let pendingSerialized = ''

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : undefined
}

export function defaultWorkspaceLayout(viewportWidth = window.innerWidth): WorkspaceLayout {
  return {
    leftWidth: viewportWidth <= 1000 ? 250 : 300,
    rightWidth: viewportWidth <= 1000 ? 220 : 250,
    leftCollapsed: false,
    rightCollapsed: false
  }
}

function parseWorkspaceLayout(value: unknown): WorkspaceLayout | undefined {
  if (!isRecord(value)) return undefined
  const leftWidth = boundedNumber(value.leftWidth, 220, 640)
  const rightWidth = boundedNumber(value.rightWidth, 200, 720)
  if (leftWidth === undefined || rightWidth === undefined) return undefined
  return {
    leftWidth,
    rightWidth,
    leftCollapsed: value.leftCollapsed === true,
    rightCollapsed: value.rightCollapsed === true
  }
}

function parseColumnLayout(value: unknown): ColumnLayout | undefined {
  if (!isRecord(value) || !isRecord(value.widths)) return undefined
  const widths: Record<string, number> = {}
  for (const [key, width] of Object.entries(value.widths)) {
    const valid = boundedNumber(width, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH)
    if (valid !== undefined) widths[key] = valid
  }
  const order: string[] = []
  const seen = new Set<string>()
  if (Array.isArray(value.order)) {
    for (const item of value.order.slice(0, 2_000)) {
      if (typeof item !== 'string' || !item || item.length > 512 || seen.has(item)) continue
      seen.add(item)
      order.push(item)
    }
  }
  if (!Object.keys(widths).length && !order.length) return undefined
  return {
    widths,
    order,
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0
  }
}

function legacyWorkspaceLayout(): WorkspaceLayout | undefined {
  const keys = [LEGACY_LEFT_WIDTH_KEY, LEGACY_RIGHT_WIDTH_KEY, LEGACY_LEFT_COLLAPSED_KEY, LEGACY_RIGHT_COLLAPSED_KEY]
  if (!keys.some((key) => localStorage.getItem(key) !== null)) return undefined
  const defaults = defaultWorkspaceLayout()
  const left = Number(localStorage.getItem(LEGACY_LEFT_WIDTH_KEY))
  const right = Number(localStorage.getItem(LEGACY_RIGHT_WIDTH_KEY))
  return {
    leftWidth: boundedNumber(left, 220, 640) ?? defaults.leftWidth,
    rightWidth: boundedNumber(right, 200, 720) ?? defaults.rightWidth,
    leftCollapsed: localStorage.getItem(LEGACY_LEFT_COLLAPSED_KEY) === 'true',
    rightCollapsed: localStorage.getItem(LEGACY_RIGHT_COLLAPSED_KEY) === 'true'
  }
}

function loadPreferences(): PersistedLayoutPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const value = JSON.parse(raw) as unknown
      if (isRecord(value) && value.version === 1) {
        const workspace: Partial<Record<WindowMode, WorkspaceLayout>> = {}
        if (isRecord(value.workspace)) {
          for (const mode of ['normal', 'maximized', 'fullscreen'] as const) {
            const profile = parseWorkspaceLayout(value.workspace[mode])
            if (profile) workspace[mode] = profile
          }
        }
        const columnLayouts: Record<string, ColumnLayout> = {}
        if (isRecord(value.columnLayouts)) {
          for (const [key, layout] of Object.entries(value.columnLayouts)) {
            const parsed = parseColumnLayout(layout)
            if (parsed) columnLayouts[key] = parsed
          }
        }
        return { version: 1, workspace, columnLayouts }
      }
    }
  } catch {
    // 配置损坏时使用默认布局；用户仍可在界面中重新调整。
  }
  const legacy = legacyWorkspaceLayout()
  return { version: 1, workspace: legacy ? { normal: legacy } : {}, columnLayouts: {} }
}

function serializedPreferences(value: PersistedLayoutPreferences): string {
  return JSON.stringify({ version: 1, workspace: value.workspace, columnLayouts: value.columnLayouts })
}

function schedulePersist(value: PersistedLayoutPreferences): void {
  pendingSerialized = serializedPreferences(value)
  if (persistTimer !== undefined) window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(flushLayoutPreferences, 250)
}

export function flushLayoutPreferences(): void {
  if (persistTimer !== undefined) window.clearTimeout(persistTimer)
  persistTimer = undefined
  if (!pendingSerialized) return
  try { localStorage.setItem(STORAGE_KEY, pendingSerialized) } catch { /* 配额不足时保留当前内存布局。 */ }
  pendingSerialized = ''
}

function hashText(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

function keyPart(value: string | undefined): string {
  return encodeURIComponent(value ?? '')
}

export function tableColumnLayoutScope(input: {
  connectionId?: string
  database?: string
  schema?: string
  table?: string
}): string {
  return `table:${keyPart(input.connectionId)}:${keyPart(input.database)}:${keyPart(input.schema)}:${keyPart(input.table)}`
}

export function queryColumnLayoutScope(input: {
  connectionId?: string
  database?: string
  savedQueryId?: string
  sql: string
  resultIndex: number
  columns: string[]
}): string {
  const normalizedSql = input.sql.trim().replace(/\s+/g, ' ')
  const owner = input.savedQueryId ? `saved:${keyPart(input.savedQueryId)}` : `sql:${hashText(normalizedSql)}`
  const source = hashText(`${input.connectionId ?? ''}\0${input.database ?? ''}`)
  const signature = hashText(input.columns.join('\0'))
  return `query:${source}:${owner}:${input.resultIndex}:${signature}`
}

export const useLayoutStore = defineStore('layout', {
  state: () => {
    const loaded = loadPreferences()
    return {
      version: 1 as const,
      workspace: loaded.workspace,
      columnLayouts: loaded.columnLayouts,
      activeWindowMode: 'normal' as WindowMode,
      revision: 0
    }
  },
  actions: {
    persist(): void {
      schedulePersist({ version: 1, workspace: this.workspace, columnLayouts: this.columnLayouts })
    },
    setActiveWindowMode(mode: WindowMode): void {
      this.activeWindowMode = mode
    },
    getWorkspaceLayout(mode: WindowMode): WorkspaceLayout | undefined {
      const profile = this.workspace[mode]
      return profile ? { ...profile } : undefined
    },
    setWorkspaceLayout(mode: WindowMode, layout: WorkspaceLayout): void {
      this.workspace = { ...this.workspace, [mode]: { ...layout } }
      this.persist()
    },
    getColumnWidths(scope: string): Record<string, number> {
      return { ...(this.columnLayouts[scope]?.widths ?? {}) }
    },
    getColumnOrder(scope: string): string[] {
      return [...(this.columnLayouts[scope]?.order ?? [])]
    },
    setColumnWidth(scope: string, column: string, width: number): void {
      if (!scope || !column) return
      const next = { ...this.columnLayouts }
      next[scope] = {
        widths: {
          ...(next[scope]?.widths ?? {}),
          [column]: Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(width)))
        },
        order: [...(next[scope]?.order ?? [])],
        updatedAt: Date.now()
      }
      const entries = Object.entries(next)
      if (entries.length > MAX_COLUMN_LAYOUTS) {
        entries.sort((left, right) => left[1].updatedAt - right[1].updatedAt)
        for (const [key] of entries.slice(0, entries.length - MAX_COLUMN_LAYOUTS)) delete next[key]
      }
      this.columnLayouts = next
      this.persist()
    },
    setColumnOrder(scope: string, order: string[]): void {
      if (!scope) return
      const uniqueOrder = [...new Set(order.filter((column) => column && column.length <= 512))].slice(0, 2_000)
      const next = { ...this.columnLayouts }
      next[scope] = {
        widths: { ...(next[scope]?.widths ?? {}) },
        order: uniqueOrder,
        updatedAt: Date.now()
      }
      const entries = Object.entries(next)
      if (entries.length > MAX_COLUMN_LAYOUTS) {
        entries.sort((left, right) => left[1].updatedAt - right[1].updatedAt)
        for (const [key] of entries.slice(0, entries.length - MAX_COLUMN_LAYOUTS)) delete next[key]
      }
      this.columnLayouts = next
      this.persist()
    },
    resetColumnLayout(scope: string): void {
      const next = { ...this.columnLayouts }
      delete next[scope]
      this.columnLayouts = next
      this.revision += 1
      this.persist()
    },
    resetWorkspaceLayout(mode: WindowMode): void {
      this.workspace = { ...this.workspace, [mode]: defaultWorkspaceLayout() }
      this.revision += 1
      this.persist()
    },
    resetAll(): void {
      this.workspace = {}
      this.columnLayouts = {}
      this.revision += 1
      for (const key of [LEGACY_LEFT_WIDTH_KEY, LEGACY_RIGHT_WIDTH_KEY, LEGACY_LEFT_COLLAPSED_KEY, LEGACY_RIGHT_COLLAPSED_KEY, 'safe-db.query.editor-height']) {
        localStorage.removeItem(key)
      }
      this.persist()
    }
  }
})
