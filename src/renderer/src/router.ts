import { createRouter, createWebHashHistory } from 'vue-router'
import WorkspaceView from './views/WorkspaceView.vue'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/workspace' },
    { path: '/workspace/:tabId?', name: 'workspace', component: WorkspaceView },
    { path: '/:pathMatch(.*)*', redirect: '/workspace' }
  ]
})
