import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WindowMode } from '../../shared/types'

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface PersistedWindowState {
  version: 1
  lastMode: WindowMode
  normalBounds?: WindowBounds
  displayId?: number
}

const DEFAULT_STATE: PersistedWindowState = { version: 1, lastMode: 'normal' }

function validMode(value: unknown): value is WindowMode {
  return value === 'normal' || value === 'maximized' || value === 'fullscreen'
}

function validBounds(value: unknown): value is WindowBounds {
  if (!value || typeof value !== 'object') return false
  const bounds = value as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every((key) => typeof bounds[key] === 'number' && Number.isFinite(bounds[key]))
    && Number(bounds.width) > 0 && Number(bounds.height) > 0
}

/** 窗口状态保存在主进程，避免全屏尺寸污染普通窗口尺寸。 */
export class WindowStateStore {
  private readonly file: string
  private state: PersistedWindowState = { ...DEFAULT_STATE }

  constructor() {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'window-state.json')
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf-8')) as Record<string, unknown>
      this.state = {
        version: 1,
        lastMode: validMode(value.lastMode) ? value.lastMode : 'normal',
        normalBounds: validBounds(value.normalBounds) ? { ...value.normalBounds } : undefined,
        displayId: typeof value.displayId === 'number' && Number.isFinite(value.displayId) ? value.displayId : undefined
      }
    } catch {
      this.state = { ...DEFAULT_STATE }
    }
  }

  get(): PersistedWindowState {
    return { ...this.state, normalBounds: this.state.normalBounds ? { ...this.state.normalBounds } : undefined }
  }

  update(patch: Partial<Omit<PersistedWindowState, 'version'>>): void {
    this.state = {
      ...this.state,
      ...patch,
      version: 1,
      normalBounds: patch.normalBounds ? { ...patch.normalBounds } : this.state.normalBounds
    }
    writeFileSync(this.file, JSON.stringify(this.state, null, 2), 'utf-8')
  }
}
