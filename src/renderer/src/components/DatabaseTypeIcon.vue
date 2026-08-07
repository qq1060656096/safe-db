<script setup lang="ts">
import { computed } from 'vue'
import mongodbIcon from 'simple-icons/icons/mongodb.svg'
import mysqlIcon from 'simple-icons/icons/mysql.svg'
import postgresqlIcon from 'simple-icons/icons/postgresql.svg'
import redisIcon from 'simple-icons/icons/redis.svg'
import sqliteIcon from 'simple-icons/icons/sqlite.svg'
import sqlServerIcon from 'simple-icons/icons/microsoftsqlserver.svg'
import type { DbType } from '../../../shared/types'

const props = withDefaults(defineProps<{
  type: DbType
  color?: string
  muted?: boolean
  size?: number
}>(), {
  color: undefined,
  muted: false,
  size: 20
})

const appearances: Record<DbType, { title: string; icon: string; color: string }> = {
  mysql: { title: 'MySQL', icon: mysqlIcon, color: '#45c955' },
  postgres: { title: 'PostgreSQL', icon: postgresqlIcon, color: '#3979e5' },
  sqlite: { title: 'SQLite', icon: sqliteIcon, color: '#58c9c4' },
  sqlserver: { title: 'SQL Server', icon: sqlServerIcon, color: '#f2a000' },
  mongodb: { title: 'MongoDB', icon: mongodbIcon, color: '#bd5900' },
  redis: { title: 'Redis', icon: redisIcon, color: '#fa7076' }
}

const appearance = computed(() => appearances[props.type])
const rootStyle = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  flexBasis: `${props.size}px`,
  backgroundColor: props.color || appearance.value.color,
  opacity: props.muted ? 0.72 : 1
}))
const glyphStyle = computed(() => ({
  width: `${Math.round(props.size * 0.75)}px`,
  height: `${Math.round(props.size * 0.75)}px`,
  '--database-type-icon-image': `url("${appearance.value.icon}")`
}))
</script>

<template>
  <span
    class="database-type-icon"
    role="img"
    :title="appearance.title"
    :aria-label="appearance.title"
    :style="rootStyle"
  >
    <span class="database-type-icon__glyph" :style="glyphStyle" />
  </span>
</template>

<style scoped>
.database-type-icon {
  display: inline-grid;
  flex: 0 0 auto;
  place-items: center;
  overflow: hidden;
  border-radius: 5px;
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 22%);
  transition: opacity 120ms ease;
}

.database-type-icon__glyph {
  display: block;
  background-color: #fff;
  mask: var(--database-type-icon-image) center / contain no-repeat;
  -webkit-mask: var(--database-type-icon-image) center / contain no-repeat;
}
</style>
