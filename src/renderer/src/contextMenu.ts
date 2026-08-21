import { onBeforeUnmount, onMounted } from 'vue'

/**
 * 在新的右键请求到达目标组件前关闭当前组件的菜单。
 * 这样各组件仍可独立维护菜单内容，同时保证全局只显示最新打开的右键菜单。
 */
export function useContextMenuDismiss(dismiss: () => void): void {
  const handleContextMenu = (): void => dismiss()
  onMounted(() => window.addEventListener('contextmenu', handleContextMenu, true))
  onBeforeUnmount(() => window.removeEventListener('contextmenu', handleContextMenu, true))
}
