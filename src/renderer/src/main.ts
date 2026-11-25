import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { i18n } from './i18n'
import { router } from './router'
import { useAppStore } from './stores/app'
import { flushLayoutPreferences, useLayoutStore } from './stores/layout'
import { setupTabSession } from './stores/tabSession'
import './styles/index.css'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
const appStore = useAppStore(pinia)
// 在挂载前恢复上次打开的标签，避免先渲染空工作区再闪现标签。
const tabSession = setupTabSession(appStore)
if (appStore.activeTabId) void router.replace(`/workspace/${appStore.activeTabId}`)
app.use(router).use(i18n).mount('#app')
document.documentElement.lang = i18n.global.locale.value

appStore.listenForAgentApprovals()
useLayoutStore(pinia)
window.addEventListener('beforeunload', flushLayoutPreferences)
window.addEventListener('beforeunload', tabSession.flush)

if (import.meta.env.DEV) {
  window.__store = { getState: () => appStore }
}
