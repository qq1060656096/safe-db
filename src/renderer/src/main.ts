import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { i18n } from './i18n'
import { router } from './router'
import { useAppStore } from './stores/app'
import './styles/index.css'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia).use(router).use(i18n).mount('#app')
document.documentElement.lang = i18n.global.locale.value

const appStore = useAppStore(pinia)
appStore.listenForAgentApprovals()

if (import.meta.env.DEV) {
  window.__store = { getState: () => appStore }
}
