<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { SwitcherOutlined } from '@vicons/antd'
import { NButton, NCard, NDropdown, NEmpty, NIcon, NModal, NSpace, NTabPane, NTabs, NTooltip, useMessage, type DropdownOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import type { WindowMode } from '../../../shared/types'
import ApprovalModal from '../components/ApprovalModal.vue'
import AuditLog from '../components/AuditLog.vue'
import DataGrid from '../components/DataGrid.vue'
import ObjectListView from '../components/ObjectListView.vue'
import PanelToggleIcon from '../components/PanelToggleIcon.vue'
import QueryEditor from '../components/QueryEditor.vue'
import RightPanel from '../components/RightPanel.vue'
import Sidebar from '../components/Sidebar.vue'
import StructureDesigner from '../components/StructureDesigner.vue'
import CollectionDesigner from '../components/CollectionDesigner.vue'
import { useContextMenuDismiss } from '../contextMenu'
import { useAppStore } from '../stores/app'
import { defaultWorkspaceLayout, useLayoutStore } from '../stores/layout'
import { invalidateConnectionMetadata } from '../metadataCache'

const store = useAppStore()
const layoutStore = useLayoutStore()
const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const message = useMessage()
const leftOpen = ref(false)
const rightOpen = ref(false)
const initialLayout = layoutStore.getWorkspaceLayout('normal') ?? defaultWorkspaceLayout()
const leftCollapsed = ref(initialLayout.leftCollapsed)
const rightCollapsed = ref(initialLayout.rightCollapsed)
const tabMenuShow = ref(false)
const tabMenuX = ref(0)
const tabMenuY = ref(0)
const tabMenuId = ref<string | null>(null)
useContextMenuDismiss(() => { tabMenuShow.value = false })
interface QueryEditorHandle { saveForClose(): Promise<boolean> }
const queryEditorRefs = new Map<string, QueryEditorHandle>()
const pendingCloseIds = ref<string[]>([])
const closePromptTab = ref<(typeof store.tabs)[number] | null>(null)
const closeSaving = ref(false)
const MIN_LEFT_WIDTH = 220
const MIN_RIGHT_WIDTH = 200
const MAX_LEFT_WIDTH = 640
const MAX_RIGHT_WIDTH = 720
const leftWidth = ref(initialLayout.leftWidth)
const rightWidth = ref(initialLayout.rightWidth)
const viewportWidth = ref(window.innerWidth)
const currentWindowMode = ref<WindowMode>('normal')
const resizingSide = ref<'left' | 'right' | null>(null)
let stopDataChangedListener: (() => void) | null = null
let stopMetadataChangedListener: (() => void) | null = null
let stopWindowModeListener: (() => void) | null = null
let windowModeInitialized = false
const hasApi = computed(() => typeof window.api !== 'undefined')
const activeTitle = computed(() => store.tabs.find((tab) => tab.id === store.activeTabId)?.title ?? t('app.name'))
function recordModelOf(connectionId?: string) {
  return connectionId ? store.driverCapabilities[connectionId]?.recordModel : undefined
}
const displayedPanelWidths = computed(() => {
  let left = leftCollapsed.value ? 0 : Math.min(MAX_LEFT_WIDTH, Math.max(MIN_LEFT_WIDTH, leftWidth.value))
  let right = rightCollapsed.value ? 0 : Math.min(MAX_RIGHT_WIDTH, Math.max(MIN_RIGHT_WIDTH, rightWidth.value))
  let overflow = Math.max(0, left + right - Math.max(0, viewportWidth.value - minimumCenterWidth()))
  if (overflow && right) {
    const reduction = Math.min(overflow, Math.max(0, right - MIN_RIGHT_WIDTH))
    right -= reduction
    overflow -= reduction
  }
  if (overflow && left) {
    const reduction = Math.min(overflow, Math.max(0, left - MIN_LEFT_WIDTH))
    left -= reduction
  }
  return { left: Math.round(left), right: Math.round(right) }
})
const panelStyle = computed<Record<string, string>>(() => ({
  '--left-panel-width': `${displayedPanelWidths.value.left}px`,
  '--right-panel-width': `${displayedPanelWidths.value.right}px`
}))
const tabMenuOptions = computed<DropdownOption[]>(() => {
  const index = store.tabs.findIndex((tab) => tab.id === tabMenuId.value)
  const current = index >= 0 ? store.tabs[index] : undefined
  const options: DropdownOption[] = [{ key: 'close', label: t('tabs.close'), disabled: index < 0 }]
  if (current?.type === 'query') {
    const otherSavedCount = store.tabs.filter((tab) => tab.id !== current.id && tab.type === 'query' && Boolean(tab.savedQueryId) && !tab.dirty).length
    const unmodifiedCount = store.tabs.filter((tab) => tab.type === 'query' && !tab.dirty).length
    options.push(
      { type: 'divider', key: 'query-divider' },
      { key: 'other-saved-queries', label: t('tabs.closeOtherSavedQueries'), disabled: otherSavedCount === 0 },
      { key: 'unmodified-queries', label: t('tabs.closeUnmodifiedQueries'), disabled: unmodifiedCount === 0 }
    )
  }
  options.push(
    { type: 'divider', key: 'position-divider' },
    { key: 'left', label: t('tabs.closeLeft'), disabled: index <= 0 },
    { key: 'right', label: t('tabs.closeRight'), disabled: index < 0 || index >= store.tabs.length - 1 },
    { key: 'others', label: t('tabs.closeOthers'), disabled: index < 0 || store.tabs.length <= 1 },
    { key: 'all', label: t('tabs.closeAll'), disabled: store.tabs.length === 0 }
  )
  return options
})

function minimumCenterWidth(): number {
  return viewportWidth.value <= 1000 ? 280 : 360
}

function visibleLeftWidth(): number { return displayedPanelWidths.value.left }
function visibleRightWidth(): number { return displayedPanelWidths.value.right }

function normalizeVisiblePanelWidths(): { left: number; right: number } {
  const visible = displayedPanelWidths.value
  // 窗口变窄时 displayedPanelWidths 会临时压缩面板，但保留用户原始偏好。
  // 用户开始主动调整后，应从屏幕上的实际宽度继续，否则隐藏的原始宽度会
  // 抵消拖拽增量，表现为面板无法变宽或在首次移动时突然跳动。
  if (!leftCollapsed.value) leftWidth.value = visible.left
  if (!rightCollapsed.value) rightWidth.value = visible.right
  return visible
}

function setPanelWidth(side: 'left' | 'right', width: number): void {
  if (side === 'left') {
    const available = viewportWidth.value - visibleRightWidth() - minimumCenterWidth()
    leftWidth.value = Math.round(Math.min(MAX_LEFT_WIDTH, Math.max(MIN_LEFT_WIDTH, Math.min(width, available))))
  } else {
    const available = viewportWidth.value - visibleLeftWidth() - minimumCenterWidth()
    rightWidth.value = Math.round(Math.min(MAX_RIGHT_WIDTH, Math.max(MIN_RIGHT_WIDTH, Math.min(width, available))))
  }
}

function persistWorkspaceLayout(): void {
  if (!windowModeInitialized) return
  layoutStore.setWorkspaceLayout(currentWindowMode.value, {
    leftWidth: leftWidth.value,
    rightWidth: rightWidth.value,
    leftCollapsed: leftCollapsed.value,
    rightCollapsed: rightCollapsed.value
  })
}

function applyWorkspaceLayout(mode: WindowMode): void {
  const profile = layoutStore.getWorkspaceLayout(mode)
    ?? (mode === 'normal' ? undefined : layoutStore.getWorkspaceLayout('normal'))
    ?? defaultWorkspaceLayout(viewportWidth.value)
  leftWidth.value = profile.leftWidth
  rightWidth.value = profile.rightWidth
  leftCollapsed.value = profile.leftCollapsed
  rightCollapsed.value = profile.rightCollapsed
}

function changeWindowMode(mode: WindowMode): void {
  if (windowModeInitialized && mode === currentWindowMode.value) return
  if (windowModeInitialized) persistWorkspaceLayout()
  currentWindowMode.value = mode
  layoutStore.setActiveWindowMode(mode)
  applyWorkspaceLayout(mode)
  windowModeInitialized = true
}

function handleWindowResize(): void {
  viewportWidth.value = window.innerWidth
}

function stopResize(): void {
  const side = resizingSide.value
  if (!side) return
  persistWorkspaceLayout()
  resizingSide.value = null
  document.body.classList.remove('panel-resizing')
  window.removeEventListener('pointermove', resizePanel)
  window.removeEventListener('pointerup', stopResize)
  window.removeEventListener('pointercancel', stopResize)
}

let resizeStartX = 0
let resizeStartWidth = 0
function resizePanel(event: PointerEvent): void {
  if (resizingSide.value === 'left') setPanelWidth('left', resizeStartWidth + event.clientX - resizeStartX)
  else if (resizingSide.value === 'right') setPanelWidth('right', resizeStartWidth - event.clientX + resizeStartX)
}

function startResize(side: 'left' | 'right', event: PointerEvent): void {
  if (event.button !== 0 || isCompactLayout()) return
  event.preventDefault()
  const visible = normalizeVisiblePanelWidths()
  resizingSide.value = side
  resizeStartX = event.clientX
  resizeStartWidth = visible[side]
  document.body.classList.add('panel-resizing')
  window.addEventListener('pointermove', resizePanel)
  window.addEventListener('pointerup', stopResize)
  window.addEventListener('pointercancel', stopResize)
}

function resizeWithKeyboard(side: 'left' | 'right', event: KeyboardEvent): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  const visible = normalizeVisiblePanelWidths()
  const direction = event.key === 'ArrowRight' ? 1 : -1
  const delta = side === 'left' ? direction * 10 : direction * -10
  setPanelWidth(side, visible[side] + delta)
  persistWorkspaceLayout()
}

onMounted(async () => {
  viewportWidth.value = window.innerWidth
  window.addEventListener('resize', handleWindowResize)
  if (!hasApi.value) return
  if (typeof window.api.onWindowModeChanged === 'function') {
    stopWindowModeListener = window.api.onWindowModeChanged(changeWindowMode)
  }
  if (typeof window.api.getWindowMode === 'function') changeWindowMode(await window.api.getWindowMode())
  else changeWindowMode('normal')
  stopDataChangedListener = window.api.onDataChanged((resource) => {
    const loads: Promise<void>[] = []
    if (resource === 'connections' || resource === 'all') loads.push(store.loadConnections())
    if (resource === 'queries' || resource === 'all') loads.push(store.loadSavedQueries())
    void Promise.all(loads).catch((error) => message.error(error instanceof Error ? error.message : String(error)))
  })
  // 开发模式主进程尚未重启时兼容旧 preload；正式构建始终提供该事件。
  if (typeof window.api.onMetadataChanged === 'function') {
    stopMetadataChangedListener = window.api.onMetadataChanged((connectionId) => invalidateConnectionMetadata(connectionId))
  }
  try { await Promise.all([store.loadConnections(), store.loadSavedQueries()]) }
  catch (error) { message.error(error instanceof Error ? error.message : String(error)) }
})
onBeforeUnmount(() => {
  persistWorkspaceLayout()
  stopWindowModeListener?.()
  stopWindowModeListener = null
  stopDataChangedListener?.()
  stopDataChangedListener = null
  stopMetadataChangedListener?.()
  stopMetadataChangedListener = null
  stopResize()
  window.removeEventListener('resize', handleWindowResize)
})
watch(() => route.params.tabId, (tabId) => {
  if (typeof tabId === 'string' && store.tabs.some((tab) => tab.id === tabId)) store.setActiveTab(tabId)
})
watch(() => store.activeTabId, (tabId) => {
  const target = tabId ? `/workspace/${tabId}` : '/workspace'
  if (route.path !== target) void router.replace(target)
})
watch(() => layoutStore.revision, () => applyWorkspaceLayout(currentWindowMode.value))
function setQueryEditorRef(tabId: string, instance: unknown): void {
  if (instance) queryEditorRefs.set(tabId, instance as QueryEditorHandle)
  else queryEditorRefs.delete(tabId)
}
function processCloseQueue(): void {
  while (pendingCloseIds.value.length) {
    const id = pendingCloseIds.value[0]
    const tab = store.tabs.find((item) => item.id === id)
    if (!tab) { pendingCloseIds.value.shift(); continue }
    if (tab.type === 'query' && tab.dirty) {
      store.setActiveTab(tab.id)
      closePromptTab.value = tab
      return
    }
    store.closeTab(id)
    pendingCloseIds.value.shift()
  }
  closePromptTab.value = null
}
function requestCloseTabs(ids: string[]): void {
  const available = new Set(store.tabs.map((tab) => tab.id))
  pendingCloseIds.value = [...new Set(ids)].filter((id) => available.has(id))
  closePromptTab.value = null
  processCloseQueue()
}
function closeTab(id: string): void { requestCloseTabs([id]) }
async function saveAndClosePromptedTab(): Promise<void> {
  const tab = closePromptTab.value
  if (!tab || closeSaving.value) return
  closeSaving.value = true
  closePromptTab.value = null
  const saved = await queryEditorRefs.get(tab.id)?.saveForClose() ?? false
  closeSaving.value = false
  if (!saved) { pendingCloseIds.value = []; return }
  store.closeTab(tab.id)
  pendingCloseIds.value.shift()
  processCloseQueue()
}
function discardAndClosePromptedTab(): void {
  const tab = closePromptTab.value
  if (!tab) return
  store.closeTab(tab.id)
  pendingCloseIds.value.shift()
  closePromptTab.value = null
  processCloseQueue()
}
function cancelPendingClose(): void {
  closePromptTab.value = null
  pendingCloseIds.value = []
}
function openTabMenu(event: MouseEvent, id: string): void {
  event.preventDefault()
  event.stopPropagation()
  tabMenuId.value = id
  tabMenuX.value = event.clientX
  tabMenuY.value = event.clientY
  tabMenuShow.value = true
}
function selectTabMenu(action: string | number): void {
  const id = tabMenuId.value
  tabMenuShow.value = false
  if (!id) return
  const index = store.tabs.findIndex((tab) => tab.id === id)
  if (action === 'close') requestCloseTabs([id])
  else if (action === 'other-saved-queries') store.closeOtherSavedQueryTabs(id)
  else if (action === 'unmodified-queries') store.closeUnmodifiedQueryTabs()
  else if (action === 'left') requestCloseTabs(store.tabs.slice(0, index).map((tab) => tab.id))
  else if (action === 'right') requestCloseTabs(store.tabs.slice(index + 1).map((tab) => tab.id))
  else if (action === 'others') requestCloseTabs(store.tabs.filter((tab) => tab.id !== id).map((tab) => tab.id))
  else if (action === 'all') requestCloseTabs(store.tabs.map((tab) => tab.id))
}
function openAudit(): void { store.openTab({ type: 'audit', title: t('sidebar.auditLog') }) }
function openNewWindow(): void { void window.api.openNewWindow() }
function isCompactLayout(): boolean { return window.matchMedia('(max-width: 760px)').matches }
function toggleLeft(): void {
  if (isCompactLayout()) {
    leftOpen.value = !leftOpen.value
    rightOpen.value = false
    return
  }
  leftCollapsed.value = !leftCollapsed.value
  persistWorkspaceLayout()
}
function toggleRight(): void {
  if (isCompactLayout()) {
    rightOpen.value = !rightOpen.value
    leftOpen.value = false
    return
  }
  rightCollapsed.value = !rightCollapsed.value
  persistWorkspaceLayout()
}
function closeOverlayPanels(): void {
  leftOpen.value = false
  rightOpen.value = false
}
</script>

<template>
  <div v-if="!hasApi" class="missing-api"><div><h2>{{ t('app.name') }}</h2><p>{{ t('app.missingApi') }}</p></div></div>
  <div
    v-else
    class="workspace-shell"
    :style="panelStyle"
    :class="{
      'left-collapsed': leftCollapsed,
      'right-collapsed': rightCollapsed,
      'left-open': leftOpen,
      'right-open': rightOpen
    }"
  >
    <button class="sidebar-backdrop" type="button" :aria-label="t('common.close')" @click="closeOverlayPanels" />
    <div class="workspace-sidebar"><Sidebar /></div>
    <div
      v-if="!leftCollapsed"
      class="panel-resizer panel-resizer-left"
      :class="{ active: resizingSide === 'left' }"
      role="separator"
      tabindex="0"
      aria-orientation="vertical"
      :aria-label="t('layout.resizeLeft')"
      :aria-valuenow="leftWidth"
      :aria-valuemin="MIN_LEFT_WIDTH"
      :aria-valuemax="MAX_LEFT_WIDTH"
      @pointerdown="startResize('left', $event)"
      @keydown="resizeWithKeyboard('left', $event)"
    />
    <main class="workspace-main">
      <div class="workspace-layout-bar">
        <NButton quaternary size="small" :title="t(leftCollapsed ? 'layout.showLeft' : 'layout.hideLeft')" :aria-label="t(leftCollapsed ? 'layout.showLeft' : 'layout.hideLeft')" @click="toggleLeft">
          <template #icon><PanelToggleIcon side="left" /></template>
        </NButton>
        <span class="layout-title">{{ activeTitle }}</span>
        <NButton quaternary size="small" :title="t('app.newWindow')" :aria-label="t('app.newWindow')" @click="openNewWindow">
          <template #icon><NIcon><SwitcherOutlined /></NIcon></template>
        </NButton>
        <NButton quaternary size="small" :title="t(rightCollapsed ? 'layout.showRight' : 'layout.hideRight')" :aria-label="t(rightCollapsed ? 'layout.showRight' : 'layout.hideRight')" @click="toggleRight">
          <template #icon><PanelToggleIcon side="right" /></template>
        </NButton>
      </div>
      <div v-if="store.tabs.length === 0" class="empty-workspace">
        <NEmpty :description="t('app.emptyHint')"><template #extra><NButton @click="openAudit">{{ t('sidebar.auditLog') }}</NButton></template></NEmpty>
      </div>
      <NTabs
        v-else
        type="card"
        closable
        :value="store.activeTabId ?? undefined"
        class="workspace-tabs"
        @update:value="(id) => store.setActiveTab(String(id))"
        @close="(id) => closeTab(String(id))"
      >
        <NTabPane v-for="tab in store.tabs" :key="tab.id" :name="tab.id" display-directive="show">
          <template #tab>
            <NTooltip :delay="500">
              <template #trigger>
                <span class="workspace-tab-label" @contextmenu="openTabMenu($event, tab.id)">
                  <span v-if="tab.type === 'query'" class="workspace-tab-kind" :class="tab.savedQueryId ? 'is-saved' : 'is-temporary'" />
                  <span class="workspace-tab-title">{{ tab.title }}</span>
                  <span v-if="tab.dirty" class="workspace-tab-dirty" :aria-label="t('tabs.unsavedChanges')">●</span>
                </span>
              </template>
              <span>{{ tab.title }}<template v-if="tab.connectionId"> · {{ store.connections.find((item) => item.id === tab.connectionId)?.name ?? '-' }}</template><template v-if="tab.database"> / {{ tab.database }}</template> · {{ t(tab.definitionEditor ? 'tabs.objectDefinition' : tab.savedQueryId ? 'tabs.savedQuery' : 'tabs.temporaryQuery') }}</span>
            </NTooltip>
          </template>
          <QueryEditor v-if="tab.type === 'query'" :ref="(instance) => setQueryEditorRef(tab.id, instance)" :tab="tab" />
          <DataGrid v-else-if="tab.type === 'table'" :tab="tab" />
          <CollectionDesigner v-else-if="tab.type === 'structure' && ['point', 'document'].includes(recordModelOf(tab.connectionId) ?? '')" :tab="tab" />
          <StructureDesigner v-else-if="tab.type === 'structure'" :tab="tab" />
          <ObjectListView v-else-if="tab.type === 'objects'" :tab="tab" />
          <AuditLog v-else />
        </NTabPane>
      </NTabs>
      <NDropdown trigger="manual" placement="bottom-start" :show="tabMenuShow" :x="tabMenuX" :y="tabMenuY" :options="tabMenuOptions" @select="selectTabMenu" @clickoutside="tabMenuShow = false" />
    </main>
    <div
      v-if="!rightCollapsed"
      class="panel-resizer panel-resizer-right"
      :class="{ active: resizingSide === 'right' }"
      role="separator"
      tabindex="0"
      aria-orientation="vertical"
      :aria-label="t('layout.resizeRight')"
      :aria-valuenow="rightWidth"
      :aria-valuemin="MIN_RIGHT_WIDTH"
      :aria-valuemax="MAX_RIGHT_WIDTH"
      @pointerdown="startResize('right', $event)"
      @keydown="resizeWithKeyboard('right', $event)"
    />
    <div class="workspace-right"><RightPanel /></div>
    <ApprovalModal />
    <NModal :show="Boolean(closePromptTab)" :mask-closable="false">
      <NCard class="close-query-modal" :title="t(closePromptTab?.definitionEditor ? 'tabs.unsavedDefinitionCloseTitle' : 'tabs.unsavedCloseTitle')" :closable="!closeSaving" @close="cancelPendingClose">
        <p>{{ t(closePromptTab?.definitionEditor ? 'tabs.unsavedDefinitionCloseMessage' : 'tabs.unsavedCloseMessage', { name: closePromptTab?.title ?? '' }) }}</p>
        <template #footer>
          <NSpace justify="end">
            <NButton :disabled="closeSaving" @click="cancelPendingClose">{{ t('common.cancel') }}</NButton>
            <NButton :disabled="closeSaving" @click="discardAndClosePromptedTab">{{ t('tabs.dontSave') }}</NButton>
            <NButton type="primary" :loading="closeSaving" @click="saveAndClosePromptedTab">{{ t('common.save') }}</NButton>
          </NSpace>
        </template>
      </NCard>
    </NModal>
  </div>
</template>
