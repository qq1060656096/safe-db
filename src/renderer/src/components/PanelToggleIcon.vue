<script setup lang="ts">
defineProps<{ side: 'left' | 'right' }>()
</script>

<template>
  <svg class="panel-toggle-icon" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3.25" y="4.25" width="17.5" height="15.5" rx="3" />
    <path v-if="side === 'left'" d="M8.25 4.75v14.5" />
    <path v-else d="M15.75 4.75v14.5" />
  </svg>
</template>
