<script setup lang="ts">
import { Compartment, EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap, placeholder as placeholderExtension } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { sqlCompletionExtension, type SqlCompletionCatalog } from '../sqlCompletion'

const props = defineProps<{ modelValue: string; placeholder: string; completion: SqlCompletionCatalog }>()
const emit = defineEmits<{ 'update:modelValue': [value: string]; run: [] }>()
const host = ref<HTMLDivElement | null>(null)
const sqlLanguage = new Compartment()
let view: EditorView | null = null
let applyingExternalValue = false

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
        Prec.high(keymap.of([{ key: 'Mod-Enter', run: () => { emit('run'); return true } }])),
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
