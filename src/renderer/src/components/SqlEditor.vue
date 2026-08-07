<script setup lang="ts">
import { Compartment, EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap, placeholder as placeholderExtension } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { sqlCompletionExtension, type SqlCompletionCatalog } from '../sqlCompletion'

const props = defineProps<{ modelValue: string; placeholder: string; completion: SqlCompletionCatalog }>()
const emit = defineEmits<{ 'update:modelValue': [value: string]; run: [selectedSql: string] }>()
const host = ref<HTMLDivElement | null>(null)
const sqlLanguage = new Compartment()
let view: EditorView | null = null
let applyingExternalValue = false

function getSelectedText(): string {
  if (!view) return ''
  const { from, to } = view.state.selection.main
  return from === to ? '' : view.state.sliceDoc(from, to)
}

defineExpose({ getSelectedText })

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
        })
      ]
    })
  })
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
