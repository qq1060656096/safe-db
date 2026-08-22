import { computed, ref, watch, type ComputedRef, type HTMLAttributes } from 'vue'
import { useLayoutStore } from './stores/layout'

type DropSide = 'before' | 'after'

export function reconcileColumnOrder(source: string[], saved: string[]): string[] {
  const available = new Set(source)
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const column of saved) {
    if (!available.has(column) || seen.has(column)) continue
    seen.add(column)
    ordered.push(column)
  }
  for (const column of source) {
    if (seen.has(column)) continue
    seen.add(column)
    ordered.push(column)
  }
  return ordered
}

export function moveColumn(order: string[], source: string, target: string, side: DropSide): string[] {
  if (source === target || !order.includes(source) || !order.includes(target)) return order
  const next = order.filter((column) => column !== source)
  const targetIndex = next.indexOf(target)
  next.splice(targetIndex + (side === 'after' ? 1 : 0), 0, source)
  return next
}

/** 查询结果和数据表共用的表头拖拽排序行为；只改变本地显示顺序。 */
export function useColumnOrder(sourceColumns: ComputedRef<string[]>, layoutScope: ComputedRef<string>) {
  const layoutStore = useLayoutStore()
  const savedOrder = ref<string[]>([])
  const draggingColumn = ref<string | null>(null)
  const dropTarget = ref<{ column: string; side: DropSide } | null>(null)
  const suppressColumnClick = ref(false)
  const orderedColumns = computed(() => reconcileColumnOrder(sourceColumns.value, savedOrder.value))

  watch(
    () => [layoutScope.value, layoutStore.revision, sourceColumns.value.join('\0')],
    () => { savedOrder.value = layoutStore.getColumnOrder(layoutScope.value) },
    { immediate: true }
  )

  function clearDragState(): void {
    draggingColumn.value = null
    dropTarget.value = null
  }

  function dragStart(event: DragEvent, column: string): void {
    draggingColumn.value = column
    dropTarget.value = null
    suppressColumnClick.value = true
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', column)
    }
  }

  function dragOver(event: DragEvent, column: string): void {
    const source = draggingColumn.value
    if (!source || source === column) {
      dropTarget.value = null
      return
    }
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    const element = event.currentTarget as HTMLElement | null
    const bounds = element?.getBoundingClientRect()
    const side: DropSide = bounds && event.clientX > bounds.left + bounds.width / 2 ? 'after' : 'before'
    if (dropTarget.value?.column !== column || dropTarget.value.side !== side) dropTarget.value = { column, side }
  }

  function drop(event: DragEvent, column: string): void {
    const source = draggingColumn.value
    if (!source || source === column) {
      clearDragState()
      return
    }
    event.preventDefault()
    const side = dropTarget.value?.column === column ? dropTarget.value.side : 'before'
    const next = moveColumn(orderedColumns.value, source, column, side)
    savedOrder.value = next
    layoutStore.setColumnOrder(layoutScope.value, next)
    clearDragState()
  }

  function dragEnd(): void {
    clearDragState()
    window.setTimeout(() => { suppressColumnClick.value = false }, 0)
  }

  function columnDragProps(column: string): HTMLAttributes {
    return {
      draggable: true,
      onDragstart: (event) => dragStart(event, column),
      onDragover: (event) => dragOver(event, column),
      onDrop: (event) => drop(event, column),
      onDragend: dragEnd
    }
  }

  function columnDragClass(column: string): Record<string, boolean> {
    return {
      'is-column-dragging': draggingColumn.value === column,
      'is-column-drop-before': dropTarget.value?.column === column && dropTarget.value.side === 'before',
      'is-column-drop-after': dropTarget.value?.column === column && dropTarget.value.side === 'after'
    }
  }

  return { orderedColumns, suppressColumnClick, columnDragProps, columnDragClass }
}
