<script setup lang="ts">
import { Compartment, EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap, placeholder as placeholderExtension } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { sqlCompletionExtension, type SqlCompletionCatalog } from '../sqlCompletion'

const props = defineProps<{ modelValue: string; placeholder: string; completion: SqlCompletionCatalog }>()
interface SqlEditorStatus {
  line: number
  column: number
  selectionLength: number
}

const emit = defineEmits<{
  'update:modelValue': [value: string]
  run: [selectedSql: string]
  status: [status: SqlEditorStatus]
}>()
const host = ref<HTMLDivElement | null>(null)
const sqlLanguage = new Compartment()
let view: EditorView | null = null
let applyingExternalValue = false

function getSelectedText(): string {
  if (!view) return ''
  const { from, to } = view.state.selection.main
  return from === to ? '' : view.state.sliceDoc(from, to)
}

function emitStatus(): void {
  if (!view) return
  const selection = view.state.selection.main
  const line = view.state.doc.lineAt(selection.head)
  emit('status', {
    line: line.number,
    column: selection.head - line.from + 1,
    selectionLength: Math.abs(selection.to - selection.from)
  })
}

function focusLine(lineNumber: number): void {
  if (!view) return
  const safeLine = Math.max(1, Math.min(lineNumber, view.state.doc.lines))
  const line = view.state.doc.line(safeLine)
  view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true })
  view.focus()
}

function replaceText(text: string, selectedOnly: boolean): void {
  if (!view) return
  const selection = view.state.selection.main
  const from = selectedOnly ? selection.from : 0
  const to = selectedOnly ? selection.to : view.state.doc.length
  const anchor = selectedOnly ? from : 0
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor, head: anchor + text.length },
    scrollIntoView: true
  })
  view.focus()
}

defineExpose({ getSelectedText, focusLine, replaceText })

onMounted(() => {
  if (!host.value) return
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        basicSetup,
        sqlLanguage.of(sqlCompletionExtension(props.completion)),
        placeholderExtension(props.placeholder),
        Prec.high(keymap.of([{ key: 'Mod-Enter', run: () => { emit('run', getSelectedText()); return true } }])),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !applyingExternalValue) emit('update:modelValue', update.state.doc.toString())
          if (update.docChanged || update.selectionSet) emitStatus()
        })
      ]
    })
  })
  emitStatus()
})

watch(
  () => props.modelValue,
  (value) => {
    if (!view || view.state.doc.toString() === value) return
    applyingExternalValue = true
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
    applyingExternalValue = false
  }
)

watch(
  () => props.completion,
  (completion) => view?.dispatch({ effects: sqlLanguage.reconfigure(sqlCompletionExtension(completion)) })
)

onBeforeUnmount(() => view?.destroy())
</script>

<template><div ref="host" class="sql-editor-host" /></template>
