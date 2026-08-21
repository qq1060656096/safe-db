<script setup lang="ts">
import { computed, h, reactive, ref, watch } from 'vue'
import { FolderOpenOutlined, LockOutlined, UnlockOutlined } from '@vicons/antd'
import { NAlert, NButton, NColorPicker, NForm, NFormItem, NIcon, NInput, NInputGroup, NInputGroupLabel, NInputNumber, NModal, NRadioButton, NRadioGroup, NSelect, NSpace, NSwitch, NTabPane, NTabs, useMessage, type SelectOption, type SelectRenderLabel } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ConnectionConfig, ConnectionMeta, DbType, PermissionMode, SshConfig } from '../../../shared/types'
import { useAppStore } from '../stores/app'
import DatabaseTypeIcon from './DatabaseTypeIcon.vue'

interface SshFormValues extends Partial<SshConfig> {
  enabled: boolean
  authType: 'password' | 'privateKey'
}
interface FormValues {
  name: string
  type: DbType
  permissionMode: PermissionMode
  permissionModeLocked: boolean
  color?: string
  host: string
  port: number | null
  user: string
  password: string
  apiKey: string
  database: string
  authDatabase: string
  tls: boolean
  timeoutMs: number | null
  encrypt: boolean
  trustServerCertificate: boolean
  filePath: string
  sqliteSelectionKind: 'file' | 'directory' | null
  sqliteDirectory: string
  sqliteDatabaseName: string
  ssh: SshFormValues
}

const props = defineProps<{ show: boolean; initial: ConnectionMeta | null }>()
const emit = defineEmits<{ close: [] }>()
const store = useAppStore()
const message = useMessage()
const { t } = useI18n()
const defaultPorts: Record<DbType, number> = { mysql: 3306, postgres: 5432, sqlite: 0, sqlserver: 1433, mongodb: 27017, redis: 6379, qdrant: 6333 }
const databaseTypeOptions: SelectOption[] = [
  { value: 'mysql', label: 'MySQL' }, { value: 'postgres', label: 'PostgreSQL' }, { value: 'sqlite', label: 'SQLite' },
  { value: 'sqlserver', label: 'SQL Server' }, { value: 'mongodb', label: 'MongoDB' }, { value: 'redis', label: 'Redis' },
  { value: 'qdrant', label: 'Qdrant' }
]
const renderDatabaseTypeLabel: SelectRenderLabel = (option) => h('span', { class: 'database-type-select-label' }, [
  h(DatabaseTypeIcon, { type: option.value as DbType }),
  h('span', null, String(option.label ?? ''))
])
const form = reactive<FormValues>(createBlankForm())
const activeSection = ref<'general' | 'ssh'>('general')
const testing = reactive({ value: false })
const saving = reactive({ value: false })

function createBlankSsh(): SshFormValues {
  return { enabled: false, host: '', port: 22, user: '', authType: 'password', password: '', privateKeyPath: '', passphrase: '' }
}
function splitFilePath(filePath: string): { directory: string; databaseName: string } {
  const normalized = filePath.replace(/\\/g, '/')
  const separator = normalized.lastIndexOf('/')
  if (separator < 0) return { directory: '', databaseName: normalized }
  const directory = separator === 0 ? '/' : normalized.slice(0, separator)
  return { directory, databaseName: normalized.slice(separator + 1) }
}
function createBlankForm(): FormValues {
  return { name: '', type: 'mysql', permissionMode: 'readonly', permissionModeLocked: false, host: '127.0.0.1', port: 3306, user: 'root', password: '', apiKey: '', database: '', authDatabase: '', tls: false, timeoutMs: 30000, encrypt: false, trustServerCertificate: true, filePath: '', sqliteSelectionKind: null, sqliteDirectory: '', sqliteDatabaseName: '', ssh: createBlankSsh() }
}
function resetForm(): void {
  const sqliteFile = props.initial?.type === 'sqlite' && props.initial.filePath
    ? splitFilePath(props.initial.filePath)
    : null
  const next = props.initial
    ? {
        ...createBlankForm(),
        ...props.initial,
        permissionModeLocked: props.initial.permissionModeLocked === true,
        port: props.initial.port ?? defaultPorts[props.initial.type],
        password: '',
        apiKey: '',
        ssh: { ...createBlankSsh(), ...props.initial.ssh, password: '', passphrase: '' },
        sqliteSelectionKind: sqliteFile ? 'file' as const : null,
        sqliteDirectory: sqliteFile?.directory ?? '',
        sqliteDatabaseName: sqliteFile?.databaseName ?? ''
      }
    : createBlankForm()
  Object.assign(form, next)
}
watch(() => props.show, (show) => { if (show) { activeSection.value = 'general'; resetForm() } }, { immediate: true })

const permissionHelp = computed(() => {
  const native = form.type === 'mongodb' || form.type === 'redis' || form.type === 'qdrant'
  const mode = form.permissionMode[0].toUpperCase() + form.permissionMode.slice(1)
  return t(`permission.${native ? `native${mode}Help` : `${form.permissionMode}Help`}`)
})

function onTypeChange(type: DbType): void {
  form.type = type
  form.port = defaultPorts[type]
  if (type === 'sqlite') activeSection.value = 'general'
  if (type === 'postgres') form.user = 'postgres'
  if (type === 'mysql') form.user = 'root'
  if (type === 'sqlserver') form.user = 'sa'
  if (type === 'mongodb' || type === 'redis' || type === 'qdrant') form.user = ''
}
async function pickDatabaseFile(): Promise<void> {
  const selection = await window.api.pickSqlitePath()
  if (!selection) return
  form.sqliteSelectionKind = selection.kind
  if (selection.kind === 'file') {
    const { directory, databaseName } = splitFilePath(selection.path)
    form.filePath = selection.path
    form.sqliteDirectory = directory
    form.sqliteDatabaseName = databaseName
  } else {
    form.filePath = ''
    form.sqliteDirectory = selection.path
    form.sqliteDatabaseName = ''
  }
}
async function pickSshKey(): Promise<void> {
  const path = await window.api.pickFile({ title: t('connection.selectSshKey') })
  if (path) form.ssh.privateKeyPath = path
}
function validate(): { message: string; section: 'general' | 'ssh' } | null {
  if (!form.name.trim()) return { message: t('connection.validationName'), section: 'general' }
  if (form.type === 'sqlite') {
    if (!form.sqliteSelectionKind || !form.sqliteDirectory.trim()) return { message: t('connection.validationPath'), section: 'general' }
    if (!form.sqliteDatabaseName.trim()) return { message: t('connection.validationDatabaseName'), section: 'general' }
    return null
  }
  if (!form.host.trim()) return { message: t('connection.validationHost'), section: 'general' }
  if (!form.port || form.port < 1 || form.port > 65535) return { message: t('connection.validationPort'), section: 'general' }
  if (form.type !== 'mongodb' && form.type !== 'redis' && form.type !== 'qdrant' && !form.user.trim()) return { message: t('connection.validationUser'), section: 'general' }
  if (form.type === 'qdrant' && (!form.timeoutMs || form.timeoutMs < 1000 || form.timeoutMs > 300000)) return { message: t('connection.validationTimeout'), section: 'general' }
  if (form.ssh.enabled) {
    if (!form.ssh.host?.trim()) return { message: t('connection.validationSshHost'), section: 'ssh' }
    if (!form.ssh.user?.trim()) return { message: t('connection.validationSshUser'), section: 'ssh' }
    if (form.ssh.authType === 'privateKey' && !form.ssh.privateKeyPath) return { message: t('connection.validationPrivateKey'), section: 'ssh' }
  }
  return null
}
function buildPayload(): ConnectionConfig {
  const ssh = form.type !== 'sqlite' && form.ssh.enabled
    ? {
        enabled: true, host: form.ssh.host ?? '', port: form.ssh.port ?? 22, user: form.ssh.user ?? '', authType: form.ssh.authType,
        password: form.ssh.password ?? '', privateKeyPath: form.ssh.privateKeyPath ?? '', passphrase: form.ssh.passphrase ?? ''
      }
    : undefined
  return {
    id: props.initial?.id ?? '', name: form.name, type: form.type, permissionMode: form.permissionMode, permissionModeLocked: form.permissionModeLocked, color: form.color || undefined,
    host: form.type === 'sqlite' ? undefined : form.host, port: form.type === 'sqlite' ? undefined : (form.port ?? undefined),
    user: form.type === 'sqlite' ? undefined : form.user, password: form.password, database: form.database || undefined,
    apiKey: form.type === 'qdrant' ? form.apiKey : undefined,
    authDatabase: form.type === 'mongodb' ? (form.authDatabase || undefined) : undefined,
    tls: form.type === 'mongodb' || form.type === 'redis' || form.type === 'qdrant' ? form.tls : undefined,
    timeoutMs: form.type === 'qdrant' ? (form.timeoutMs ?? 30000) : undefined,
    encrypt: form.type === 'sqlserver' ? form.encrypt : undefined,
    trustServerCertificate: form.type === 'sqlserver' ? form.trustServerCertificate : undefined,
    filePath: form.type === 'sqlite' && form.sqliteSelectionKind === 'file' ? form.filePath : undefined,
    sqliteCreate: form.type === 'sqlite' && form.sqliteSelectionKind === 'directory'
      ? { directory: form.sqliteDirectory, databaseName: form.sqliteDatabaseName }
      : undefined,
    ssh
  }
}
async function testConnection(): Promise<void> {
  const error = validate()
  if (error) { activeSection.value = error.section; message.warning(error.message); return }
  testing.value = true
  try {
    const result = await window.api.testConnection(buildPayload())
    result.ok ? message.success(t('connection.testSuccess')) : message.error(t('connection.testFailed', { error: result.error }))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally { testing.value = false }
}
async function saveConnection(): Promise<void> {
  const error = validate()
  if (error) { activeSection.value = error.section; message.warning(error.message); return }
  saving.value = true
  try {
    await store.saveConnection(buildPayload())
    message.success(t('common.saved'))
    emit('close')
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally { saving.value = false }
}
</script>

<template>
  <NModal :show="show" preset="card" :title="initial ? t('connection.editTitle') : t('connection.newTitle')" class="connection-modal" @close="emit('close')">
    <NForm label-placement="left" label-align="right" :label-width="148" :show-feedback="false" class="connection-form">
      <NTabs v-model:value="activeSection" type="line" animated class="connection-tabs">
        <NTabPane name="general" :tab="t('connection.generalTab')" class="connection-tab-pane">
          <NFormItem :label="t('connection.databaseType')" required><NSelect :value="form.type" :options="databaseTypeOptions" :render-label="renderDatabaseTypeLabel" @update:value="(value) => onTypeChange(value as DbType)" /></NFormItem>
          <NFormItem :label="t('connection.name')" required><NInput v-model:value="form.name" :placeholder="t('connection.namePlaceholder')" /></NFormItem>
          <NFormItem :label="t('connection.permissionMode')" required>
            <div class="permission-mode-control">
              <NRadioGroup v-model:value="form.permissionMode" :disabled="form.permissionModeLocked"><NRadioButton value="readonly">{{ t('permission.readonly') }}</NRadioButton><NRadioButton value="approval">{{ t('permission.approval') }}</NRadioButton><NRadioButton value="full">{{ t('permission.full') }}</NRadioButton></NRadioGroup>
              <NButton class="permission-mode-lock" size="small" secondary :type="form.permissionModeLocked ? 'warning' : 'default'" @click="form.permissionModeLocked = !form.permissionModeLocked">
                <template #icon><NIcon><UnlockOutlined v-if="form.permissionModeLocked" /><LockOutlined v-else /></NIcon></template>
                {{ form.permissionModeLocked ? t('connection.unlockPermissionMode') : t('connection.lockPermissionMode') }}
              </NButton>
            </div>
          </NFormItem>
          <NAlert :type="form.permissionModeLocked ? 'warning' : 'info'" class="permission-help">{{ permissionHelp }} {{ form.permissionModeLocked ? t('connection.permissionModeLockedHelp') : t('connection.permissionModeUnlockedHelp') }}</NAlert>
          <template v-if="form.type !== 'sqlite'">
            <NFormItem :label="t('connection.host')" required><NInput v-model:value="form.host" placeholder="127.0.0.1" /></NFormItem>
            <NFormItem :label="t('connection.port')" required><NInputNumber v-model:value="form.port" :min="1" :max="65535" /></NFormItem>
            <template v-if="form.type !== 'qdrant'">
              <NFormItem :label="t('connection.user')" :required="form.type !== 'mongodb' && form.type !== 'redis'"><NInput v-model:value="form.user" autocomplete="off" :placeholder="form.type === 'redis' ? 'default' : ''" /></NFormItem>
              <NFormItem :label="t('connection.password')" :show-feedback="Boolean(initial)" :feedback="initial ? t('connection.keepPassword') : undefined"><NInput v-model:value="form.password" type="password" show-password-on="click" autocomplete="new-password" :placeholder="initial ? '••••••••' : ''" /></NFormItem>
              <NFormItem :label="t('connection.defaultDatabase')"><NInput v-model:value="form.database" :placeholder="form.type === 'postgres' ? 'postgres' : form.type === 'sqlserver' ? 'master' : form.type === 'mongodb' ? 'test' : form.type === 'redis' ? '0' : ''" /></NFormItem>
            </template>
            <template v-else>
              <NFormItem :label="t('connection.apiKey')" :show-feedback="Boolean(initial)" :feedback="initial ? t('connection.keepApiKey') : undefined"><NInput v-model:value="form.apiKey" type="password" show-password-on="click" autocomplete="new-password" :placeholder="initial ? '••••••••' : ''" /></NFormItem>
              <NFormItem :label="t('connection.timeoutMs')"><NInputNumber v-model:value="form.timeoutMs" :min="1000" :max="300000" :step="1000" /></NFormItem>
            </template>
            <NFormItem v-if="form.type === 'mongodb'" :label="t('connection.authDatabase')"><NInput v-model:value="form.authDatabase" placeholder="admin" /></NFormItem>
            <NFormItem v-if="form.type === 'mongodb' || form.type === 'redis' || form.type === 'qdrant'" :label="form.type === 'qdrant' ? t('connection.https') : t('connection.tls')"><NSwitch v-model:value="form.tls" /></NFormItem>
            <template v-if="form.type === 'sqlserver'">
              <NFormItem :label="t('connection.encrypt')"><NSwitch v-model:value="form.encrypt" /></NFormItem>
              <NFormItem :label="t('connection.trustCertificate')"><NSwitch v-model:value="form.trustServerCertificate" /></NFormItem>
            </template>
          </template>
          <template v-else>
            <NFormItem :label="t('connection.databaseLocation')" required>
              <NInputGroup><NInput :value="form.sqliteDirectory" readonly :placeholder="t('connection.databaseLocationPlaceholder')" /><NButton @click="pickDatabaseFile"><template #icon><NIcon><FolderOpenOutlined /></NIcon></template>{{ t('connection.choose') }}</NButton></NInputGroup>
            </NFormItem>
            <NFormItem :label="t('connection.databaseName')" required>
              <NInput v-model:value="form.sqliteDatabaseName" :disabled="form.sqliteSelectionKind === 'file'" :placeholder="t('connection.databaseNamePlaceholder')" />
            </NFormItem>
            <div v-if="form.sqliteSelectionKind" class="sqlite-path-help">
              {{ form.sqliteSelectionKind === 'file' ? t('connection.sqliteExistingHelp') : t('connection.sqliteCreateHelp') }}
            </div>
          </template>
          <NFormItem :label="t('connection.markerColor')"><NColorPicker v-model:value="form.color" class="marker-color-picker" clearable :swatches="['#f5222d', '#fa8c16', '#fadb14', '#52c41a', '#1677ff', '#722ed1']" /></NFormItem>
        </NTabPane>
        <NTabPane v-if="form.type !== 'sqlite'" name="ssh" :tab="t('connection.sshTab')" class="connection-tab-pane">
          <div class="ssh-enable-row">
            <strong>{{ t('connection.sshTunnel') }}</strong>
            <NSwitch v-model:value="form.ssh.enabled" />
            <span>{{ t('connection.enable') }}</span>
          </div>
          <div class="ssh-help">{{ t('connection.sshEnabledHelp') }}</div>
          <template v-if="form.ssh.enabled">
            <NFormItem :label="t('connection.sshHost')" required><NInput v-model:value="form.ssh.host" :placeholder="t('connection.sshHostPlaceholder')" /></NFormItem>
            <NFormItem :label="t('connection.port')" required><NInputNumber v-model:value="form.ssh.port" :min="1" :max="65535" /></NFormItem>
            <NFormItem :label="t('connection.sshUser')" required><NInput v-model:value="form.ssh.user" autocomplete="off" /></NFormItem>
            <NFormItem :label="t('connection.authType')" required><NRadioGroup v-model:value="form.ssh.authType"><NRadioButton value="password">{{ t('connection.authPassword') }}</NRadioButton><NRadioButton value="privateKey">{{ t('connection.authPrivateKey') }}</NRadioButton></NRadioGroup></NFormItem>
            <template v-if="form.ssh.authType === 'privateKey'">
              <NFormItem :label="t('connection.privateKeyFile')" required><NInputGroup><NInput v-model:value="form.ssh.privateKeyPath" placeholder="/path/to/id_rsa" /><NButton @click="pickSshKey"><template #icon><NIcon><FolderOpenOutlined /></NIcon></template>{{ t('connection.choose') }}</NButton></NInputGroup></NFormItem>
              <NFormItem :label="t('connection.privateKeyPassphrase')" :show-feedback="Boolean(initial)" :feedback="initial ? t('connection.keepSecret') : undefined"><NInput v-model:value="form.ssh.passphrase" type="password" show-password-on="click" autocomplete="new-password" :placeholder="initial ? '••••••••' : ''" /></NFormItem>
            </template>
            <NFormItem v-else :label="t('connection.sshPassword')" :show-feedback="Boolean(initial)" :feedback="initial ? t('connection.keepSecret') : undefined"><NInput v-model:value="form.ssh.password" type="password" show-password-on="click" autocomplete="new-password" :placeholder="initial ? '••••••••' : ''" /></NFormItem>
          </template>
        </NTabPane>
      </NTabs>
    </NForm>
    <template #footer><NSpace justify="end"><NButton :loading="testing.value" @click="testConnection">{{ t('connection.test') }}</NButton><NButton @click="emit('close')">{{ t('common.cancel') }}</NButton><NButton type="primary" :loading="saving.value" @click="saveConnection">{{ t('common.save') }}</NButton></NSpace></template>
  </NModal>
</template>
